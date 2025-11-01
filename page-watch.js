#!/usr/bin/env node

const fs = require('fs')
const async = require('async')
const minimist = require('minimist')
const Mastodon = require('mastodon')
const Mustache = require('mustache')
const { WikiChanges } = require('wikichanges')
const https = require('https')
const { saveDraft } = require('./lib/draft-manager')
const { enrichIPsInText, initializeReader } = require('./lib/geolocation')
const { takeScreenshot } = require('./lib/screenshot')
const { buildFacets } = require('./lib/bluesky-utils')
const { createAuthenticatedAgent } = require('./lib/bluesky-client')
const bluesky = require('./lib/bluesky-platform')
const mastodon = require('./lib/mastodon-platform')

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
async function sendBlueskyAlert(account, edit, statusData, _piiResult) {
  if (!account.pii_alerts?.bluesky_recipient) return

  try {
    const agent = await createAuthenticatedAgent(account.bluesky)
    const accessJwt = agent.session.accessJwt

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

    // Send message - chat API is at api.bsky.chat
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
          facets: facets
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
async function sendMastodonAlert(account, edit, statusData, _piiResult) {
  if (!account.pii_alerts?.mastodon_recipient) return

  try {
    const M = new Mastodon({
      access_token: account.mastodon.access_token,
      api_url: account.mastodon.instance + '/api/v1/'
    })

    // Same message as regular post, just prefixed with "PII: "
    const alertText = `PII: ${statusData.text}`

    await M.post('statuses', {
      status: `@${account.pii_alerts.mastodon_recipient} ${alertText}`,
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

      // Get PII types and max confidence
      const piiTypes = [...new Set(piiResult.entities.map(e => e.type))]
      const maxConfidence = Math.max(...piiResult.entities.map(e => e.score))

      // Save draft (screenshot taken later if admin chooses to post)
      saveDraft({
        text: statusData.text,
        diffUrl: edit.url,
        article: edit.page,
        editor: statusData.name,
        piiDetected: piiTypes,
        piiConfidence: maxConfidence,
        statusData: statusData
      })

      // Log and send text-only alerts
      logBlockedEdit(edit, statusData, piiResult)
      await sendBlueskyAlert(account, edit, statusData, piiResult)
      await sendMastodonAlert(account, edit, statusData, piiResult)

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

      // Enrich IP addresses with country flags
      const enrichedText = await enrichIPsInText(statusData.text)

      // Wait for Wikipedia diff table to fully render
      await new Promise(r => setTimeout(r, 2000));
      const screenshot = await takeScreenshot(edit.url)

      if (!screenshot) {
        throw new Error('Failed to capture screenshot')
      }

      try {
        // Prepare metadata for posting
        const metadata = {
          page: edit.page,
          name: statusData.name,
          pageUrl: statusData.pageUrl,
          userUrl: statusData.userUrl
        }

        // Post to Bluesky
        if (account.bluesky) {
          await bluesky.post({
            account: account.bluesky,
            text: enrichedText,
            screenshot,
            metadata
          })
        }

        // Post to Mastodon
        if (account.mastodon) {
          await mastodon.post({
            account: account.mastodon,
            text: enrichedText,
            screenshot,
            metadata
          })
        }
      } finally {
        // Always clean up screenshot, even if posting fails
        if (screenshot && fs.existsSync(screenshot)) {
          fs.unlinkSync(screenshot)
        }
      }
    }
  } catch (error) {
    console.error('Posting failed:', error)
    throw error // Preserve stack trace
  }
}

async function inspect(account, edit) {
  if (edit.url) {
    if (account.watchlist && account.watchlist[edit.wikipedia]
      && account.watchlist[edit.wikipedia][edit.page]) {
      const statusData = getStatus(edit, edit.user, account.template)
      await sendStatus(account, statusData, edit)
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

async function main() {
  const config = getConfig(argv.config)

  // Initialize geolocation database before listening for edits
  await initializeReader()

  return checkConfig(config, function (err) {
    if (!err) {
      const wikipedia = new WikiChanges({ ircNickname: config.nick })
      return wikipedia.listen(edit => {
        if (argv.verbose) {
          console.log(JSON.stringify(edit))
        }
        Array.from(config.accounts).forEach((account) => {
          inspect(account, edit).catch(error => console.error('Inspect error:', error))
        })
      })
    } else {
      return console.log(err)
    }
  })
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

module.exports = {
  main,
  getConfig,
  getStatus,
  getArticleUrl,
  getUserContributionsUrl,
  buildFacets,
  inspect,
  sendStatus,
  extractDiffText,
  analyzeForPII,
  screenForPII
}