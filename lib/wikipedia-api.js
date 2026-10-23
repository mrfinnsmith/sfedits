// Minimal MediaWiki API client following Wikimedia API etiquette: descriptive
// User-Agent, one request at a time, maxlag=5, and Retry-After is honoured.
// Verified against the live API: maxlag errors arrive as HTTP 200 with a
// Retry-After header and {"error":{"code":"maxlag"}}; 429/503 carry the header too.

const USER_AGENT = 'sfedits/1.0 (https://github.com/mrfinnsmith/sfedits; contact via GitHub issues)'
const MAX_RETRIES = 3
const DEFAULT_RETRY_WAIT_MS = 5000
const REQUEST_TIMEOUT_MS = 30000
const TITLE_BATCH_SIZE = 50

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Every request in the process waits for the previous one to settle.
let queue = Promise.resolve()

function retryWaitMs(res) {
  const header = res.headers.get('retry-after')
  if (header && /^\d+$/.test(header.trim())) return parseInt(header, 10) * 1000
  return DEFAULT_RETRY_WAIT_MS
}

function buildUrl(lang, params) {
  const query = new URLSearchParams({ ...params, format: 'json', formatversion: '2', maxlag: '5' })
  return `https://${lang}.wikipedia.org/w/api.php?${query}`
}

// One HTTP attempt. Returns { retry: true, waitMs } or { retry: false, json }.
async function attempt(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (res.status === 429 || res.status === 503) {
    await res.text().catch(() => {})
    return { retry: true, waitMs: retryWaitMs(res), why: `HTTP ${res.status}` }
  }
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status} for ${url}`)
  const json = await res.json()
  if (json.error && json.error.code === 'maxlag') {
    return { retry: true, waitMs: retryWaitMs(res), why: 'maxlag' }
  }
  if (json.error) throw new Error(`Wikipedia API error ${json.error.code}: ${json.error.info}`)
  return { retry: false, json }
}

async function requestWithRetries(url, sleep) {
  for (let retries = 0; ; retries++) {
    const result = await attempt(url)
    if (!result.retry) return result.json
    if (retries >= MAX_RETRIES) {
      throw new Error(`Wikipedia API still returning ${result.why} after ${MAX_RETRIES} retries for ${url}`)
    }
    await sleep(result.waitMs)
  }
}

function apiGet(lang, params, options = {}) {
  const sleep = options.sleep || realSleep
  const url = buildUrl(lang, params)
  const run = queue.then(() => requestWithRetries(url, sleep))
  queue = run.catch(() => {})
  return run
}

// Latest revision of each title. Returns { [inputTitle]: { revid, parentid, timestamp } | null }.
async function getLatestRevisions(lang, titles, options = {}) {
  const result = {}
  for (let i = 0; i < titles.length; i += TITLE_BATCH_SIZE) {
    const batch = titles.slice(i, i + TITLE_BATCH_SIZE)
    const json = await apiGet(lang, {
      action: 'query',
      prop: 'revisions',
      rvprop: 'ids|timestamp',
      titles: batch.join('|')
    }, options)
    Object.assign(result, mapBatch(batch, json))
  }
  return result
}

function mapBatch(batch, json) {
  const query = json.query || {}
  const normalized = {}
  for (const n of query.normalized || []) normalized[n.from] = n.to
  const byTitle = {}
  for (const page of query.pages || []) byTitle[page.title] = page
  const out = {}
  for (const input of batch) {
    const page = byTitle[normalized[input] || input]
    const rev = page && !page.missing && !page.invalid && page.revisions && page.revisions[0]
    out[input] = rev ? { revid: rev.revid, parentid: rev.parentid, timestamp: rev.timestamp } : null
  }
  return out
}

// Revisions of one title, newest first, back to `since` (Date or ms). `older` is
// the first revision older than since (the parent of the last returned one), or null.
async function listRevisions(lang, title, { since, rvprop = 'ids|timestamp|user|sha1|size' } = {}, options = {}) {
  const sinceMs = since instanceof Date ? since.getTime() : since
  if (!Number.isFinite(sinceMs)) throw new Error('listRevisions requires a since Date or ms number')
  const revisions = []
  let cont = null
  for (;;) {
    const json = await apiGet(lang, {
      action: 'query',
      prop: 'revisions',
      titles: title,
      rvdir: 'older',
      rvlimit: '50',
      rvprop,
      ...cont
    }, options)
    const page = ((json.query || {}).pages || [])[0]
    if (!page || page.missing || page.invalid) return { revisions: [], older: null }
    for (const rev of page.revisions || []) {
      if (Date.parse(rev.timestamp) >= sinceMs) revisions.push(rev)
      else return { revisions, older: rev }
    }
    if (!json.continue) return { revisions, older: null }
    cont = json.continue
  }
}

module.exports = { USER_AGENT, apiGet, getLatestRevisions, listRevisions }
