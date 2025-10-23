#!/usr/bin/env node

const fs = require('fs')
const async = require('async')
const minimist = require('minimist')
const Mastodon = require('mastodon')
const Mustache = require('mustache')
const puppeteer = require('puppeteer')
const { WikiChanges } = require('wikichanges')
const { Address4, Address6 } = require('ip-address')
const { BskyAgent } = require('@atproto/api')
const https = require('https')
const { saveDraft } = require('./lib/draft-manager')

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false,
    config: './config.json'
  }
})

function getConfig(path) {
  const config = loadJson(path)
  // see if ranges are externally referenced as a separate .json files
  if (config.accounts) {
    for (let account of Array.from(config.accounts)) {
      if (typeof account.ranges === 'string') {
        account.ranges = loadJson(account.ranges)
      }
    }
  }
  console.log("loaded config from", path)
  return config
}

function loadJson(path) {
  if ((path[0] !== '/') && (path.slice(0, 2) !== './')) {
    path = `./${path}`
  }
  return require(path)
}

// Builds Wikipedia article URL from edit URL. Returns null if URL is malformed.
function getArticleUrl(editUrl, pageName) {
  try {
    const url = new URL(editUrl)
    const lang = url.hostname.split('.')[0]
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pageName)}`
  } catch {
    return null
  }
}

// Builds Wikipedia contributions URL from edit URL. Returns null if URL is malformed.
function getUserContributionsUrl(editUrl, username) {
  try {
    const url = new URL(editUrl)
    const lang = url.hostname.split('.')[0]
    return `https://${lang}.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(username)}`
  } catch {
    return null
  }
}

// Creates Bluesky facets for article name, username, and diff URL
function buildFacets(text, page, name, pageUrl, userUrl) {
  const facets = []
  let searchOffset = 0

  // Article name facet (appears first in template)
  if (pageUrl) {
    const pageIndex = text.indexOf(page, searchOffset)
    if (pageIndex !== -1) {
      const byteStart = Buffer.byteLength(text.substring(0, pageIndex), 'utf8')
      const byteEnd = byteStart + Buffer.byteLength(page, 'utf8')
      facets.push({
        index: { byteStart, byteEnd },
        features: [{
          $type: 'app.bsky.richtext.facet#link',
          uri: pageUrl
        }]
      })
      searchOffset = pageIndex + page.length
    }
  }

  // Username facet (appears after page name in template)
  if (userUrl) {
    const nameIndex = text.indexOf(name, searchOffset)
    if (nameIndex !== -1) {
      const byteStart = Buffer.byteLength(text.substring(0, nameIndex), 'utf8')
      const byteEnd = byteStart + Buffer.byteLength(name, 'utf8')
      facets.push({
        index: { byteStart, byteEnd },
        features: [{
          $type: 'app.bsky.richtext.facet#link',
          uri: userUrl
        }]
      })
    }
  }

  // Diff URL facet
  const urlPattern = /https?:\/\/[^\s]+/g
  let match
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0]
    const byteStart = Buffer.byteLength(text.substring(0, match.index), 'utf8')
    const byteEnd = byteStart + Buffer.byteLength(url, 'utf8')
    facets.push({
      index: { byteStart, byteEnd },
      features: [{
        $type: 'app.bsky.richtext.facet#link',
        uri: url
      }]
    })
  }

  return facets
}

/**
 * Extract text content from Wikipedia diff HTML
 */
async function extractDiffText(diffUrl) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'sfedits-bot/1.0 (https://github.com/edsu/anon; Contact via GitHub issues)'
      }
    }
    https.get(diffUrl, options, (res) => {
      let html = ''

      res.on('data', (chunk) => html += chunk)
      res.on('end', () => {
        // Extract text from diff table cells
        const diffMatches = html.match(/<td[^>]*class="[^"]*diff-[^"]*"[^>]*>(.*?)<\/td>/gs)

        if (!diffMatches) {
          resolve('')
          return
        }

        let diffText = ''
        for (const match of diffMatches) {
          // Remove HTML tags and decode entities
          let text = match
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim()

          diffText += text + ' '
        }

        resolve(diffText.trim())
      })
    }).on('error', reject)
  })
}

/**
 * Analyze diff text for PII using PII microservice
 */
async function analyzeForPII(text, blockedEntityTypes = null) {
  try {
    const body = { text }
    if (blockedEntityTypes) {
      body.blocked_entity_types = blockedEntityTypes
    }

    const response = await fetch('http://pii-service:5000/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    })

    if (!response.ok) {
      throw new Error(`PII service returned ${response.status}`)
    }

    return await response.json()
  } catch (error) {
    // On timeout/error, log but allow post through
    // Blocking every post on infrastructure issues defeats the purpose
    console.error('PII analysis error:', error.message)
    console.error('⚠ Allowing post through - PII screening unavailable')
    return {
      has_pii: false,
      entities: []
    }
  }
}

/**
 * Log blocked edit to file for manual review
 */
function logBlockedEdit(edit, statusData, piiResult) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    article: edit.page,
    editor: statusData.name,
    diff_url: edit.url,
    post_text: statusData.text,
    detected_pii: piiResult.entities
  }

  const logLine = JSON.stringify(logEntry) + '\n'
  fs.appendFileSync('pii-blocks.log', logLine)
}

/**
 * Send DM alert via Bluesky
 * Uses api.bsky.chat service directly (not routed through bsky.social PDS)
 */
async function sendBlueskyAlert(account, edit, statusData, piiResult, screenshot) {
  if (!account.pii_alerts?.bluesky_recipient) return

  try {
    const agent = new BskyAgent({
      service: account.bluesky.service || 'https://bsky.social'
    })

    await agent.login(account.bluesky)

    const accessJwt = agent.session.accessJwt

    // Upload screenshot
    const imageData = fs.readFileSync(screenshot)
    const uploadResult = await agent.uploadBlob(imageData, {
      encoding: 'image/png'
    })

    // Build facets for clickable links (same as regular post)
    const alertText = `PII: ${statusData.text}`
    const facets = buildFacets(
      alertText,
      statusData.page,
      statusData.name,
      statusData.pageUrl,
      statusData.userUrl
    )

    // Get conversation - chat API is at api.bsky.chat
    const convoResponse = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=100', {
      headers: {
        'Authorization': `Bearer ${accessJwt}`
      }
    })

    const convosData = await convoResponse.json()

    if (convosData.error) {
      console.error('Failed to list Bluesky conversations:', convosData.error)
      return
    }

    const convo = convosData.convos.find(c =>
      c.members.some(m => m.handle === account.pii_alerts.bluesky_recipient)
    )

    if (!convo) {
      console.error(`No existing Bluesky conversation with ${account.pii_alerts.bluesky_recipient}`)
      return
    }

    // Send message with image - chat API is at api.bsky.chat
    await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessJwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        convoId: convo.id,
        message: {
          text: alertText,
          facets: facets,
          embed: {
            $type: 'app.bsky.embed.images',
            images: [{
              alt: `Screenshot of edit to ${edit.page}`,
              image: uploadResult.data.blob
            }]
          }
        }
      })
    })

    console.log('✓ Bluesky alert sent')
  } catch (error) {
    console.error('Bluesky alert failed:', error.message)
  }
}

/**
 * Send DM alert via Mastodon
 */
async function sendMastodonAlert(account, edit, statusData, piiResult, screenshot) {
  if (!account.pii_alerts?.mastodon_recipient) return

  try {
    const M = new Mastodon({
      access_token: account.mastodon.access_token,
      api_url: account.mastodon.instance + '/api/v1/'
    })

    // Upload screenshot
    const imageData = fs.createReadStream(screenshot)
    const mediaData = await M.post('media', {
      file: imageData,
      description: `Screenshot of edit to ${edit.page}`
    })

    // Same message as regular post, just prefixed with "PII: "
    const alertText = `PII: ${statusData.text}`

    await M.post('statuses', {
      status: `@${account.pii_alerts.mastodon_recipient} ${alertText}`,
      media_ids: [mediaData.data.id],
      visibility: 'direct'
    })

    console.log('✓ Mastodon alert sent')
  } catch (error) {
    console.error('Mastodon alert failed:', error.message)
  }
}

/**
 * Screen edit for PII before posting
 */
async function screenForPII(account, edit, statusData) {
  try {
    // Check if PII blocking is enabled
    if (account.pii_blocking && !account.pii_blocking.enabled) {
      return { safe: true }
    }

    // Extract diff text from Wikipedia
    const diffText = await extractDiffText(edit.url)

    if (!diffText) {
      console.error('⚠ Could not extract diff text - blocking as precaution')
      return { safe: false, reason: 'Could not extract diff text' }
    }

    // Get blocked entity types from config
    const blockedTypes = account.pii_blocking?.blocked_entity_types || null

    // Analyze for PII
    const piiResult = await analyzeForPII(diffText, blockedTypes)

    if (piiResult.has_pii) {
      console.error('🚫 PII DETECTED - Blocking post')
      console.error(`   Article: ${edit.page}`)
      console.error(`   Detected: ${piiResult.entities.map(e => e.type).join(', ')}`)

      // Take screenshot for alerts and drafts
      await new Promise(r => setTimeout(r, 2000))
      const screenshot = await takeScreenshot(edit.url)

      // Get PII types and max confidence
      const piiTypes = [...new Set(piiResult.entities.map(e => e.type))]
      const maxConfidence = Math.max(...piiResult.entities.map(e => e.score))

      // Save draft
      saveDraft({
        text: statusData.text,
        screenshot: screenshot,
        diffUrl: edit.url,
        article: edit.page,
        editor: statusData.name,
        piiDetected: piiTypes,
        piiConfidence: maxConfidence,
        statusData: statusData
      })

      // Log and send alerts
      logBlockedEdit(edit, statusData, piiResult)
      await sendBlueskyAlert(account, edit, statusData, piiResult, screenshot)
      await sendMastodonAlert(account, edit, statusData, piiResult, screenshot)

      // Clean up original screenshot (copy was made for draft)
      fs.unlinkSync(screenshot)

      return { safe: false, reason: 'PII detected', piiResult }
    }

    return { safe: true }
  } catch (error) {
    // Fail-safe: block on any error
    console.error('⚠ PII screening error - blocking as precaution:', error.message)
    return { safe: false, reason: 'Screening error' }
  }
}

function getStatus(edit, name, template) {
  const pageUrl = getArticleUrl(edit.url, edit.page)
  const userUrl = getUserContributionsUrl(edit.url, name)

  const text = Mustache.render(template, {
    name,
    url: edit.url,
    page: edit.page
  })

  return {
    text,
    pageUrl,
    userUrl,
    page: edit.page,
    name
  }
}

const lastChange = {}

async function takeScreenshot(url) {

  // write the screenshot to this file
  const filename = Date.now() + '.png'

  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--font-render-hinting=none'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  });

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(url, { waitUntil: 'networkidle0' })

    // get the diff portion of the page
    const element = await page.$('table.diff.diff-type-table.diff-contentalign-left');
    const box = await element.boundingBox();

    await page.screenshot({
      path: filename,
      clip: box
    });

    return filename
  } finally {
    // Always close browser, even if there's an error
    await browser.close()
  }
}

async function sendStatus(account, statusData, edit) {
  try {
    console.log(statusData.text)

    if (!argv.noop) {
      // PII screening before posting
      const screeningResult = await screenForPII(account, edit, statusData)

      if (!screeningResult.safe) {
        console.error(`Post blocked: ${screeningResult.reason}`)
        return
      }

      await new Promise(r => setTimeout(r, 2000));
      const screenshot = await takeScreenshot(edit.url)

      // Bluesky
      if (account.bluesky) {
        const agent = new BskyAgent({
          service: account.bluesky.service || 'https://bsky.social'
        })

        await agent.login(account.bluesky)

        const imageData = fs.readFileSync(screenshot)
        const uploadResult = await agent.uploadBlob(imageData, {
          encoding: 'image/png'
        })

        const facets = buildFacets(
          statusData.text,
          statusData.page,
          statusData.name,
          statusData.pageUrl,
          statusData.userUrl
        )

        await agent.post({
          text: statusData.text,
          facets: facets,
          embed: {
            $type: 'app.bsky.embed.images',
            images: [{
              alt: `Screenshot of edit to ${edit.page}`,
              image: uploadResult.data.blob
            }]
          },
          createdAt: new Date().toISOString()
        })
      }

      // Mastodon
      if (account.mastodon) {
        const M = new Mastodon({
          access_token: account.mastodon.access_token,
          api_url: account.mastodon.instance + '/api/v1/'
        })

        const imageData = fs.createReadStream(screenshot)
        const mediaData = await M.post('media', {
          file: imageData,
          description: `Screenshot of edit to ${edit.page}`
        })

        await M.post('statuses', {
          status: statusData.text,
          media_ids: [mediaData.data.id]
        })
      }

      fs.unlinkSync(screenshot)
    }
  } catch (error) {
    console.error('Posting failed:', error)
    throw error // Preserve stack trace
  }
}

function inspect(account, edit) {
  if (edit.url) {
    if (account.watchlist && account.watchlist[edit.wikipedia]
      && account.watchlist[edit.wikipedia][edit.page]) {
      const statusData = getStatus(edit, edit.user, account.template)
      sendStatus(account, statusData, edit)
    }
  }
}

function checkConfig(config, error) {
  if (config.accounts) {
    return async.each(config.accounts, (account, callback) => callback(), error)
  } else {
    return error("missing accounts stanza in config")
  }
}

function main() {
  const config = getConfig(argv.config)
  return checkConfig(config, function (err) {
    if (!err) {
      const wikipedia = new WikiChanges({ ircNickname: config.nick })
      return wikipedia.listen(edit => {
        if (argv.verbose) {
          console.log(JSON.stringify(edit))
        }
        Array.from(config.accounts).map((account) =>
          inspect(account, edit))
      })
    } else {
      return console.log(err)
    }
  })
}

if (require.main === module) {
  main()
}

module.exports = {
  main,
  getConfig,
  getStatus,
  getArticleUrl,
  getUserContributionsUrl,
  buildFacets,
  takeScreenshot,
  inspect,
  sendStatus,
  extractDiffText,
  analyzeForPII,
  screenForPII
}