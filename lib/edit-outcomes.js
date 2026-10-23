const path = require('path')
const { appendJsonl, readJsonl } = require('./jsonl-log')
const { langFromEditUrl, revisionIdFromDiffUrl } = require('./wiki-url')

// What happened to a watched edit in the bot's pipeline. Every edit that
// reaches a decision point gets one line in data/edit-outcomes.jsonl, so the
// missed-edit check can tell "handled" from "silently dropped".
const OUTCOMES = [
  'posted',
  'pii_blocked',
  'wrong_page',
  'no_diff_text',
  'screening_error',
  'screenshot_failed',
  'post_failed'
]

const DEFAULT_OUTCOMES_PATH = path.join(__dirname, '..', 'data', 'edit-outcomes.jsonl')

// Never throws: an outcome that cannot be recorded must not break the posting
// flow. An unknown outcome name is a bug in the caller, so it is logged and
// not written.
function recordOutcome(edit, outcome, detail = null, file = DEFAULT_OUTCOMES_PATH) {
  if (!OUTCOMES.includes(outcome)) {
    console.error(`[edit-outcomes] Unknown outcome "${outcome}" for ${edit && edit.url}, not recorded`)
    return
  }
  try {
    appendJsonl(file, {
      time: new Date().toISOString(),
      lang: langFromEditUrl(edit.url),
      page: edit.page,
      diff_url: edit.url,
      rev_id: revisionIdFromDiffUrl(edit.url),
      outcome,
      detail
    })
  } catch (err) {
    console.error(`[edit-outcomes] Failed to record ${outcome} for ${edit && edit.url}: ${err.message}`)
  }
}

function readOutcomes(file = DEFAULT_OUTCOMES_PATH) {
  return readJsonl(file)
}

module.exports = {
  OUTCOMES,
  DEFAULT_OUTCOMES_PATH,
  recordOutcome,
  readOutcomes
}
