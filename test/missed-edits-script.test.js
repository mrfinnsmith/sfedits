const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const { execFileSync } = require('child_process')
const os = require('os')
const path = require('path')

const script = require('../scripts/missed-edits')

const NOW = Date.parse('2026-10-22T20:00:00Z')
const MIN = 60e3
const iso = msAgo => new Date(NOW - msAgo).toISOString()

describe('scripts/missed-edits', function() {
  let dir, statePath, logPath, outcomesPath, saved

  const config = (watchlist = { en: { 'Foo': true } }) => ({
    accounts: [{ watchlist, pii_alerts: { bluesky_recipient: 'a.bsky.social', mastodon_recipient: 'me@mastodon.social' } }]
  })

  // One revision 20 minutes old on Foo, unless overridden.
  function fakeApi(overrides = {}) {
    const calls = { latest: [], list: [] }
    const rev = { revid: 500, parentid: 499, timestamp: iso(20 * MIN), sha1: 'b' }
    const api = {
      calls,
      getLatestRevisions: async (lang, titles) => {
        calls.latest.push(lang)
        if (overrides.throwFor === lang) throw new Error('boom')
        const out = {}
        for (const t of titles) out[t] = overrides.latest ? overrides.latest[t] : { revid: 500, parentid: 499, timestamp: rev.timestamp }
        return out
      },
      listRevisions: async (lang, title) => {
        calls.list.push(`${lang}:${title}`)
        return { revisions: [rev], older: { revid: 499, timestamp: iso(5 * 3600e3), sha1: 'a' } }
      }
    }
    return api
  }

  function fakeDeps(api, { bsky = true, mastodon = true } = {}) {
    const dm = { bsky: [], mastodon: [], pings: [] }
    return {
      dm,
      deps: {
        ...api,
        sendBlueskyDm: async (account, text, facets) => { dm.bsky.push({ text, facets }); return bsky },
        sendMastodonDm: async (account, text) => { dm.mastodon.push(text); return mastodon },
        fetch: async (url, opts) => { dm.pings.push({ url, opts }); return { ok: true, status: 200 } }
      }
    }
  }

  const logLines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [])
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const writeState = state => fs.writeFileSync(statePath, JSON.stringify(state))
  const seedState = () => writeState({ baselineAt: NOW - 3 * 3600e3, lastSuccessAt: NOW - 20 * MIN, missed: {} })

  beforeEach(function() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missed-edits-test-'))
    statePath = path.join(dir, 'state.json')
    logPath = path.join(dir, 'missed.jsonl')
    outcomesPath = path.join(dir, 'outcomes.jsonl')
    saved = {}
    for (const [k, v] of Object.entries({
      MISSED_EDITS_STATE_PATH: statePath,
      MISSED_EDITS_LOG_PATH: logPath,
      EDIT_OUTCOMES_PATH: outcomesPath
    })) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
  })

  afterEach(function() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not load puppeteer', function() {
    // A fresh process: in the full suite other tests have already filled require.cache.
    const code = "require('./scripts/missed-edits');" +
      "console.log(Object.keys(require.cache).filter(f => /node_modules[\\\\/]puppeteer/.test(f)).length)"
    const out = execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..') })
    assert.equal(out.toString().trim(), '0')
  })

  it('first run creates a baseline and reports nothing', async function() {
    const { deps, dm } = fakeDeps(fakeApi())
    const summary = await script.runCheck({ now: NOW, config: config(), deps, pingUrl: 'https://hc.test/abc' })
    assert.equal(summary.newMissed, 0)
    assert.equal(dm.bsky.length, 0)
    assert.equal(logLines().length, 0)
    const state = readState()
    assert.equal(state.baselineAt, NOW)
    assert.equal(state.lastSuccessAt, NOW)
  })

  it('logs, DMs and marks a missed edit once, and does not repeat it', async function() {
    seedState()
    const { deps, dm } = fakeDeps(fakeApi())
    const first = await script.runCheck({ now: NOW, config: config(), deps, pingUrl: 'https://hc.test/abc' })
    assert.equal(first.newMissed, 1)
    assert.isTrue(first.delivered)
    assert.equal(logLines().length, 1)
    assert.equal(JSON.parse(logLines()[0]).key, 'en:500')
    assert.include(dm.bsky[0].text, 'Foo (en): bot never handled it')
    assert.isAbove(dm.bsky[0].facets.length, 0)
    assert.equal(dm.mastodon.length, 1)
    assert.equal(readState().missed['en:500'].alertedAt, NOW)

    const second = await script.runCheck({ now: NOW + 5 * MIN, config: config(), deps, pingUrl: 'https://hc.test/abc' })
    assert.equal(second.newMissed, 0)
    assert.equal(second.pending, 0)
    assert.equal(logLines().length, 1)
    assert.equal(dm.bsky.length, 1)
  })

  it('does not report an edit the bot posted', async function() {
    seedState()
    fs.writeFileSync(outcomesPath, JSON.stringify({
      time: iso(10 * MIN), lang: 'en', page: 'Foo', diff_url: 'https://en.wikipedia.org/w/index.php?diff=500&oldid=499', rev_id: 500, outcome: 'posted', detail: null
    }) + '\n')
    const { deps, dm } = fakeDeps(fakeApi())
    const summary = await script.runCheck({ now: NOW, config: config(), deps })
    assert.equal(summary.newMissed, 0)
    assert.equal(dm.bsky.length, 0)
  })

  it('keeps the edit pending when both DMs fail, pings /fail, then delivers next run', async function() {
    seedState()
    const failing = fakeDeps(fakeApi(), { bsky: false, mastodon: false })
    const first = await script.runCheck({ now: NOW, config: config(), deps: failing.deps, pingUrl: 'https://hc.test/abc' })
    assert.isTrue(first.dmFailed)
    assert.isNull(readState().missed['en:500'].alertedAt)
    assert.equal(failing.dm.pings[0].url, 'https://hc.test/abc/fail')
    assert.include(failing.dm.pings[0].opts.body, 'DM delivery failed')

    const working = fakeDeps(fakeApi())
    const second = await script.runCheck({ now: NOW + 5 * MIN, config: config(), deps: working.deps, pingUrl: 'https://hc.test/abc' })
    assert.equal(second.newMissed, 0)
    assert.equal(second.pending, 1)
    assert.isTrue(second.delivered)
    assert.equal(working.dm.bsky.length, 1)
    assert.equal(readState().missed['en:500'].alertedAt, NOW + 5 * MIN)
    assert.equal(working.dm.pings[0].url, 'https://hc.test/abc')
    assert.equal(logLines().length, 1)
  })

  it('one failing wiki is reported and the others are still checked', async function() {
    seedState()
    const api = fakeApi({ throwFor: 'de' })
    const { deps, dm } = fakeDeps(api)
    const wl = { de: { 'Bar': true }, en: { 'Foo': true } }
    const summary = await script.runCheck({ now: NOW, config: config(wl), deps, pingUrl: 'https://hc.test/abc' })
    assert.deepEqual(summary.failedWikis, ['de'])
    assert.deepEqual(api.calls.latest, ['de', 'en'])
    assert.equal(summary.newMissed, 1)
    assert.equal(readState().lastSuccessAt, NOW - 20 * MIN)
    assert.equal(dm.pings[0].url, 'https://hc.test/abc/fail')
    assert.include(dm.pings[0].opts.body, 'de')
  })

  it('all OK pings success and advances lastSuccessAt', async function() {
    seedState()
    const { deps, dm } = fakeDeps(fakeApi())
    await script.runCheck({ now: NOW, config: config(), deps, pingUrl: 'https://hc.test/abc' })
    assert.equal(dm.pings.length, 1)
    assert.notInclude(dm.pings[0].url, '/fail')
    assert.equal(dm.pings[0].opts.method, 'POST')
    assert.equal(readState().lastSuccessAt, NOW)
  })

  it('makes no ping call when the URL is unset', async function() {
    seedState()
    const { deps, dm } = fakeDeps(fakeApi())
    const summary = await script.runCheck({ now: NOW, config: config(), deps, pingUrl: undefined })
    assert.equal(dm.pings.length, 0)
    assert.isFalse(summary.pinged)
  })

  it('throws on a corrupt state file', async function() {
    fs.writeFileSync(statePath, '{not json')
    const { deps } = fakeDeps(fakeApi())
    let error = null
    try {
      await script.runCheck({ now: NOW, config: config(), deps })
    } catch (err) {
      error = err
    }
    assert.isNotNull(error)
    assert.include(error.message, 'not valid JSON')
  })

  it('does not list revisions for titles last edited before the window', async function() {
    seedState()
    const api = fakeApi({ latest: { Foo: { revid: 1, parentid: 0, timestamp: iso(30 * 3600e3) } } })
    const { deps } = fakeDeps(api)
    const summary = await script.runCheck({ now: NOW, config: config(), deps })
    assert.equal(summary.newMissed, 0)
    assert.deepEqual(api.calls.list, [])
  })

  it('skips watchlist titles whose value is false', async function() {
    seedState()
    const api = fakeApi()
    const { deps } = fakeDeps(api)
    const seen = []
    const original = api.getLatestRevisions
    deps.getLatestRevisions = async (lang, titles) => { seen.push(...titles); return original(lang, titles) }
    await script.runCheck({ now: NOW, config: config({ en: { Foo: true, Baz: false } }), deps })
    assert.deepEqual(seen, ['Foo'])
  })

  describe('ping', function() {
    it('returns false without calling fetch when the URL is empty', async function() {
      let called = false
      assert.isFalse(await script.ping('', true, '', async () => { called = true }))
      assert.isFalse(called)
    })
    it('swallows fetch errors', async function() {
      assert.isFalse(await script.ping('https://hc.test/x', true, '', async () => { throw new Error('down') }))
    })
  })
})
