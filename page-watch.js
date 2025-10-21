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
  sendStatus
}