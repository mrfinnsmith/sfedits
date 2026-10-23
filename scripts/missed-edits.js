// Finds watched-page revisions the bot never posted and DMs a summary (sfedits#44).
// Runs every 15 minutes via scripts/missed-edits-cron.sh in a throwaway container of
// the bot image. It must not load page-watch.js or puppeteer: it only talks to the
// Wikipedia API, the DM senders and healthchecks.io.
const fs = require('fs')
const path = require('path')
const { getConfig } = require('../lib/config')
const { getLatestRevisions, listRevisions } = require('../lib/wikipedia-api')
const { readOutcomes, DEFAULT_OUTCOMES_PATH } = require('../lib/edit-outcomes')
const { appendJsonl } = require('../lib/jsonl-log')
const missedEdits = require('../lib/missed-edits')

const DATA_DIR = path.join(__dirname, '..', 'data')
const PING_TIMEOUT_MS = 10000
const BLUESKY_MAX_LENGTH = 1000
const MASTODON_MAX_LENGTH = 500

function statePath() {
  return process.env.MISSED_EDITS_STATE_PATH || path.join(DATA_DIR, 'missed-edits-state.json')
}

function logPath() {
  return process.env.MISSED_EDITS_LOG_PATH || path.join(DATA_DIR, 'missed-edits.jsonl')
}

function outcomesPath() {
  return process.env.EDIT_OUTCOMES_PATH || DEFAULT_OUTCOMES_PATH
}

// Missing file -> fresh baseline. An unparseable file throws: guessing a new baseline
// would silently forget pending alerts, so the run fails and the wrapper pings /fail.
function loadState(file, now) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { baselineAt: now, lastSuccessAt: null, missed: {} }
    throw err
  }
  let state
  try {
    state = JSON.parse(text)
  } catch (err) {
    throw new Error(`State file ${file} is not valid JSON: ${err.message}`)
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`State file ${file} is not a JSON object`)
  }
  return { baselineAt: null, lastSuccessAt: null, ...state, missed: state.missed || {} }
}

// tmp + rename so a crash never leaves a half-written state file.
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

function watchedTitles(pages) {
  return Object.keys(pages || {}).filter(title => pages[title] === true)
}

// Missed edits for one wiki. Throws on any API error; the caller marks the wiki failed.
async function checkWiki(lang, titles, ctx) {
  const latest = await ctx.getLatestRevisions(lang, titles)
  const missed = []
  for (const title of titles) {
    const rev = latest[title]
    if (!rev || !(Date.parse(rev.timestamp) >= ctx.windowStart)) continue
    const { revisions, older } = await ctx.listRevisions(lang, title, { since: ctx.windowStart })
    missed.push(...missedEdits.findMissedEdits({
      lang,
      title,
      revisions,
      older,
      outcomeIndex: ctx.outcomeIndex,
      now: ctx.now,
      windowStart: ctx.windowStart,
      known: ctx.known
    }))
  }
  return missed
}

// Wikis are checked one after another (the API client is serial anyway). One wiki
// failing must not hide the others, so errors are collected, not thrown.
async function collectMissed(watchlist, ctx) {
  const missed = []
  const failedWikis = []
  let checked = 0
  for (const lang of Object.keys(watchlist || {})) {
    const titles = watchedTitles(watchlist[lang])
    if (titles.length === 0) continue
    checked++
    try {
      missed.push(...await checkWiki(lang, titles, ctx))
    } catch (err) {
      console.error(`[missed-edits] ${lang} check failed: ${err.message}`)
      failedWikis.push(lang)
    }
  }
  return { missed, failedWikis, checked }
}

function recordNewMissed(state, missed, now, file) {
  for (const edit of missed) {
    appendJsonl(file, { ...edit, detected_at: new Date(now).toISOString() })
    state.missed[edit.key] = { ...edit, detectedAt: now, alertedAt: null }
  }
}

function blueskyPayload(pending) {
  const { RichText } = require('@atproto/api')
  const text = missedEdits.buildAlertMessage(pending, BLUESKY_MAX_LENGTH)
  const rt = new RichText({ text })
  rt.detectFacetsWithoutResolution()
  return { text, facets: rt.facets }
}

// Both platforms are tried; one delivery is enough to call the alert delivered.
// The DM libraries are required here, not at the top: together they add ~65MB,
// and most runs have nothing to send, so they stay well under the 96MB cap.
async function sendAlerts(account, pending, deps = {}) {
  const dm = deps.sendBlueskyDm && deps.sendMastodonDm ? {} : require('../lib/dm-alert')
  const sendBluesky = deps.sendBlueskyDm || dm.sendBlueskyDm
  const sendMastodon = deps.sendMastodonDm || dm.sendMastodonDm
  const recipient = (account.pii_alerts && account.pii_alerts.mastodon_recipient) || ''
  const bsky = blueskyPayload(pending)
  const mastodonText = missedEdits.buildAlertMessage(pending, MASTODON_MAX_LENGTH - ('@' + recipient + ' ').length)
  const [bskyOk, mastodonOk] = await Promise.all([
    sendBluesky(account, bsky.text, bsky.facets),
    sendMastodon(account, mastodonText)
  ])
  return { delivered: bskyOk === true || mastodonOk === true }
}

// Never throws and never prints the URL (it is a secret).
async function ping(url, ok, body, fetchFn = fetch) {
  if (!url) return false
  const target = ok ? url : url.replace(/\/+$/, '') + '/fail'
  try {
    const res = await fetchFn(target, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    })
    if (res && res.ok === false) throw new Error(`HTTP ${res.status}`)
    console.log('[missed-edits] pinged ok')
    return true
  } catch (err) {
    console.error(`[missed-edits] pinged fail: ${err.message}`)
    return false
  }
}

function pingBody(failedWikis, dmFailed) {
  const parts = []
  if (failedWikis.length > 0) parts.push(`wiki check failed: ${failedWikis.join(', ')}`)
  if (dmFailed) parts.push('DM delivery failed')
  return parts.join('; ')
}

async function runCheck({ now = Date.now(), config, deps = {}, pingUrl = process.env.HEALTHCHECKS_PING_URL } = {}) {
  const account = config.accounts[0]
  const state = loadState(statePath(), now)
  const windowStart = missedEdits.computeWindowStart(now, state)
  const ctx = {
    getLatestRevisions: deps.getLatestRevisions || getLatestRevisions,
    listRevisions: deps.listRevisions || listRevisions,
    outcomeIndex: missedEdits.indexOutcomes(readOutcomes(outcomesPath())),
    known: state.missed,
    now,
    windowStart
  }

  const { missed, failedWikis, checked } = await collectMissed(account.watchlist, ctx)
  recordNewMissed(state, missed, now, logPath())

  const pending = Object.values(state.missed).filter(entry => !entry.alertedAt)
  let delivered = false
  if (pending.length > 0) {
    delivered = (await sendAlerts(account, pending, deps)).delivered
    if (delivered) pending.forEach(entry => { entry.alertedAt = now })
  }
  const dmFailed = pending.length > 0 && !delivered

  if (failedWikis.length === 0) state.lastSuccessAt = now
  saveState(statePath(), missedEdits.pruneState(state, now))

  const ok = failedWikis.length === 0 && !dmFailed
  if (!pingUrl) console.log('[missed-edits] HEALTHCHECKS_PING_URL not set, skipping ping')
  const pinged = pingUrl ? await ping(pingUrl, ok, pingBody(failedWikis, dmFailed), deps.fetch) : false

  const summary = {
    time: new Date(now).toISOString(),
    windowStart: new Date(windowStart).toISOString(),
    wikisChecked: checked,
    failedWikis,
    newMissed: missed.length,
    pending: pending.length,
    delivered,
    dmFailed,
    pinged
  }
  console.log(`[missed-edits] ${summary.time} window=${summary.windowStart} wikis=${checked} failed=${failedWikis.length}${failedWikis.length ? `(${failedWikis.join(',')})` : ''} new=${missed.length} pending=${pending.length} delivered=${delivered}`)
  return summary
}

async function main() {
  const config = getConfig(process.env.CONFIG_PATH || './config.json', null, { silent: true })
  await runCheck({ config })
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(`[missed-edits] run failed: ${err.stack || err.message}`)
      process.exit(1)
    }
  )
}

module.exports = {
  loadState,
  saveState,
  checkWiki,
  collectMissed,
  recordNewMissed,
  sendAlerts,
  ping,
  runCheck,
  main
}
