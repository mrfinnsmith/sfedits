// Records a published Wikipedia edit to the sfedits Supabase project, so the
// SF Daily Brief site can show what this bot has found.
// See https://github.com/mrfinnsmith/sfedits/issues/7
//
// Two properties matter more than anything else here:
//
// 1. This is called only after a successful post. The bot catches edits that
//    PII screening then refuses to publish; recording those would republish
//    the diff links the bot declined to post, somewhere more durable and more
//    indexable than a social post. Posted edits only.
//
// 2. It never throws. A database problem must never cost us a post. Every
//    failure path logs and returns.
//
// The credential is this project's secret key, which bypasses RLS. That is
// acceptable only because the project holds exactly one table and nothing
// else: its whole reach is this edit log.

const { getCountryCode } = require('./geolocation')
const { langFromEditUrl } = require('./wiki-url')

const REQUEST_TIMEOUT_MS = 5000

// on_conflict names diff_url as the arbiter. Without it PostgREST falls back to
// the primary key, the retry of an already-recorded edit collides on the unique
// index instead, and the call fails 409 rather than doing nothing. The bot
// posts to social first and records second, so retries are the normal case.
const ENDPOINT = '/rest/v1/wikipedia_edits?on_conflict=diff_url'

let warnedUnconfigured = false

function config() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) return null
  return { url: url.replace(/\/+$/, ''), key }
}

async function recordEdit(edit) {
  const cfg = config()
  if (!cfg) {
    // Once per process, not once per post: an unconfigured bot still works,
    // it just records nothing, and it should say so exactly once.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      console.error('⚠ Supabase not configured - edits will not be recorded')
    }
    return
  }

  try {
    const lang = langFromEditUrl(edit.url)
    if (!lang) {
      console.error('Skipping edit record, cannot derive language from:', edit.url)
      return
    }

    // Anonymous editors are recorded as a country, never as an IP address.
    // getCountryCode returns null when the database is missing or the address
    // does not resolve, and a null country is fine: the edit still counts.
    const anonymous = Boolean(edit.anonymous)
    const editorCountry = anonymous ? await getCountryCode(edit.user) : null
    const editor = anonymous ? null : edit.user

    const response = await fetch(`${cfg.url}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal'
      },
      body: JSON.stringify({
        article_title: edit.page,
        lang,
        diff_url: edit.url,
        // The IRC feed carries no timestamp, so this is when we handled the
        // edit. Live IRC means it trails the real edit by seconds.
        posted_at: new Date().toISOString(),
        editor,
        editor_country: editorCountry
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error(`Failed to record edit: Supabase returned ${response.status}`, detail.slice(0, 200))
      return
    }

    console.log('✓ Edit recorded')
  } catch (error) {
    console.error('Edit logging error:', error.message)
  }
}

module.exports = {
  recordEdit
}
