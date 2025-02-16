#!/usr/bin/env node

const fs                   = require('fs')
const async                = require('async')
const minimist             = require('minimist')
const Mastodon             = require('mastodon')
const Mustache             = require('mustache')
const puppeteer            = require('puppeteer')
const {WikiChanges}        = require('wikichanges')
const {Address4, Address6} = require('ip-address')
const { BskyAgent }        = require('@atproto/api')

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

function getStatusLength(edit, name, template) {
  // https://support.twitter.com/articles/78124-posting-links-in-a-tweet
  const fakeUrl = 'https://t.co/BzHLWr31Ce'
  const status = Mustache.render(template, {name, url: fakeUrl, page: edit.page})
  return status.length
}

function getStatus(edit, name, template) {
  let page = edit.page
  const len = getStatusLength(edit, name, template)
  if (len > 280) {
    const newLength = edit.page.length - (len - 279)
    page = edit.page.slice(0, +newLength + 1 || undefined)
  }
  return Mustache.render(template, {
    name,
    url: edit.url,
    page
  })
}

const lastChange = {}

function isRepeat(edit) {
  const k = `${edit.wikipedia}`
  const v = `${edit.page}:${edit.user}`
  const r = lastChange[k] === v
  lastChange[k] = v
  return r
}

async function takeScreenshot(url) {

  // write the screenshot to this file
  const filename = Date.now() + '.png'

  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    headless: true,
    defaultViewport: {
      width: 1024,
      height: 768,
    }
  })

  const page = await browser.newPage()
  await page.goto(url, {waitUntil: 'networkidle0'})

  // get the diff portion of the page
  const box = await page.evaluate(() => {
    const element = document.querySelector('table.diff.diff-contentalign-left')
    // need to unpack values because DOMRect object isn't returnable
    const {x, y, width, height} = element.getBoundingClientRect()
    return {x, y, width, height}
  })

  // resize viewport in case the diff element isn't fully visible
  await page.setViewport({
    width: 1024,
    height: parseInt(box.y + box.height + 20)
  })

  // take the screenshot!
  await page.screenshot({
    path: filename,
    clip: box
  })

  await browser.close()
  return filename
}

async function sendStatus(account, status, edit) {
  console.log(status)

  if (!argv.noop && (!account.throttle || !isRepeat(edit))) {

    // wait a couple seconds and get a screenshot of the diff
    await new Promise(r => setTimeout(r, 2000));  
    const screenshot = await takeScreenshot(edit.url)

    // Mastodon
    if (account.mastodon) {
      const mastodon = new Mastodon(account.mastodon)
      const response = await mastodon.post('media', {file: fs.createReadStream(screenshot)})
      if (!response.data.id) {
        console.log('error uploading screenshot to mastodon')
        return
      }

      await mastodon.post(
        'statuses', 
        {'status': status, media_ids: [response.data.id]},
        err => {
          if (err) {
            console.log(`mastodon post failed: ${err}`)
          }
        }
      )
    }

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

    // screenshot no longer needed
    fs.unlinkSync(screenshot)
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
  return checkConfig(config, function(err) {
    if (!err) {
      const wikipedia = new WikiChanges({ircNickname: config.nick})
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
