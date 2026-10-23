// Pure logic for finding watched-page revisions the bot never posted (sfedits#44).
// No network and no filesystem: scripts/missed-edits.js feeds it data and acts on the result.
const { buildDiffUrl } = require('./wiki-url')

const MIN_AGE_MS = 15 * 60e3 // IRC and the bot get this long to handle an edit before it counts as missed
const MIN_WINDOW_MS = 2 * 3600e3
const MAX_WINDOW_MS = 48 * 3600e3
const ALERTED_RETENTION_MS = 7 * 24 * 3600e3

const MAX_DETAIL_LENGTH = 120

const HANDLED_OUTCOMES = ['posted', 'pii_blocked']

const REASON_TEXT = {
  wrong_page: 'diff belonged to another page',
  no_diff_text: 'diff text could not be extracted',
  screening_error: 'PII screening error',
  screenshot_failed: 'screenshot failed',
  post_failed: 'posting failed',
  never_handled: 'bot never handled it'
}

function outcomeKey(lang, revId) {
  return `${lang}:${revId}`
}

function computeWindowStart(now, state) {
  const st = state || {}
  let start = st.lastSuccessAt
    ? Math.min(now - MIN_WINDOW_MS, st.lastSuccessAt)
    : now - MIN_WINDOW_MS
  start = Math.max(start, now - MAX_WINDOW_MS)
  if (st.baselineAt) start = Math.max(start, st.baselineAt)
  return start
}

function indexOutcomes(outcomes) {
  const index = new Map()
  for (const line of outcomes || []) {
    const key = outcomeKey(line.lang, line.rev_id)
    const prev = index.get(key)
    const handled = HANDLED_OUTCOMES.includes(line.outcome) || (prev ? prev.handled : false)
    index.set(key, { handled, last: line })
  }
  return index
}

// A null revision (protection, move) has the same content as its parent. IRC only shows
// those as log entries, so the bot never sees them as edits.
function isDummyRevision(rev, parent) {
  if (!rev || !parent) return false
  return typeof rev.sha1 === 'string' && rev.sha1 !== '' && rev.sha1 === parent.sha1
}

function toMissedEdit(rev, lang, title, entry) {
  const last = entry ? entry.last : null
  return {
    key: outcomeKey(lang, rev.revid),
    lang,
    page: title,
    rev_id: rev.revid,
    timestamp: rev.timestamp,
    diff_url: (last && last.diff_url) || buildDiffUrl(lang, rev.revid, rev.parentid),
    reason: last ? last.outcome : 'never_handled',
    detail: last && last.detail !== undefined ? last.detail : null
  }
}

function findMissedEdits({ lang, title, revisions, older, outcomeIndex, now, windowStart, known }) {
  const seen = known || {}
  const missed = []
  revisions.forEach((rev, i) => {
    const ts = Date.parse(rev.timestamp)
    if (!(ts >= windowStart && ts <= now - MIN_AGE_MS)) return
    const parent = i + 1 < revisions.length ? revisions[i + 1] : older
    if (isDummyRevision(rev, parent)) return
    const key = outcomeKey(lang, rev.revid)
    const entry = outcomeIndex.get(key)
    if (entry && entry.handled) return
    if (Object.prototype.hasOwnProperty.call(seen, key)) return
    missed.push(toMissedEdit(rev, lang, title, entry))
  })
  return missed
}

function cleanDetail(detail) {
  if (typeof detail !== 'string') return ''
  const text = detail.replace(/\s+/g, ' ').trim()
  return text.length > MAX_DETAIL_LENGTH ? text.slice(0, MAX_DETAIL_LENGTH - 3) + '...' : text
}

function entryText(edit) {
  const detail = cleanDetail(edit.detail)
  const reasonText = REASON_TEXT[edit.reason] || edit.reason
  return `\n\n${edit.page} (${edit.lang}): ${reasonText}${detail ? ': ' + detail : ''}\n${edit.diff_url}`
}

function footerText(k) {
  return `\n\n+${k} more. Full list: data/missed-edits.jsonl on the droplet.`
}

function buildAlertMessage(missed, maxLength) {
  const n = missed.length
  const header = `sfedits: ${n} watched ${n === 1 ? 'edit' : 'edits'} not posted`
  let body = header
  let added = 0
  for (let i = 0; i < n; i++) {
    const remaining = n - i - 1
    const candidate = body + entryText(missed[i])
    const total = candidate.length + (remaining > 0 ? footerText(remaining).length : 0)
    if (total > maxLength) break
    body = candidate
    added++
  }
  return added < n ? body + footerText(n - added) : body
}

function pruneState(state, now) {
  const missed = {}
  for (const [key, entry] of Object.entries(state.missed || {})) {
    const expired = entry.alertedAt && now - entry.alertedAt > ALERTED_RETENTION_MS
    if (!expired) missed[key] = entry
  }
  return { ...state, missed }
}

module.exports = {
  MIN_AGE_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  ALERTED_RETENTION_MS,
  REASON_TEXT,
  outcomeKey,
  computeWindowStart,
  indexOutcomes,
  isDummyRevision,
  findMissedEdits,
  buildAlertMessage,
  pruneState
}
