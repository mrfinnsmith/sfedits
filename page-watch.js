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

function getStatus(edit, name, template) {
  return Mustache.render(template, {
    name,
    url: edit.url,
    page: edit.page
  })
}

const lastChange = {}

async function takeScreenshot(url) {

  // write the screenshot to this file
  const filename = Date.now() + '.png'

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

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

  await browser.close()
  return filename
}

async function sendStatus(account, status, edit) {
  try {
    console.log(status)

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

        await agent.post({
          text: status,
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
      const status = getStatus(edit, edit.user, account.template)
      sendStatus(account, status, edit)
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
  takeScreenshot
}