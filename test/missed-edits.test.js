const { describe, it } = require('mocha')
const { assert } = require('chai')
const m = require('../lib/missed-edits')

const H = 3600e3
const NOW = Date.parse('2026-10-22T20:00:00Z')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()

describe('missed-edits', function() {
  describe('computeWindowStart', function() {
    it('no state -> now - 2h', function() {
      assert.equal(m.computeWindowStart(NOW, {}), NOW - 2 * H)
    })
    it('recent lastSuccess -> now - 2h', function() {
      assert.equal(m.computeWindowStart(NOW, { lastSuccessAt: NOW - 10 * 60e3 }), NOW - 2 * H)
    })
    it('old lastSuccess -> lastSuccess', function() {
      assert.equal(m.computeWindowStart(NOW, { lastSuccessAt: NOW - 5 * H }), NOW - 5 * H)
    })
    it('very old lastSuccess -> capped at now - 48h', function() {
      assert.equal(m.computeWindowStart(NOW, { lastSuccessAt: NOW - 100 * H }), NOW - 48 * H)
    })
    it('baselineAt raises the start', function() {
      const s = m.computeWindowStart(NOW, { lastSuccessAt: NOW - 10 * H, baselineAt: NOW - 3 * H })
      assert.equal(s, NOW - 3 * H)
    })
  })

  describe('indexOutcomes', function() {
    const line = (outcome, extra) => ({ lang: 'en', rev_id: 1, outcome, diff_url: 'u', ...extra })
    it('posted after a failure is handled', function() {
      const idx = m.indexOutcomes([line('post_failed'), line('posted')])
      assert.isTrue(idx.get('en:1').handled)
    })
    it('pii_blocked is handled', function() {
      assert.isTrue(m.indexOutcomes([line('pii_blocked')]).get('en:1').handled)
    })
    it('failure after posted stays handled', function() {
      assert.isTrue(m.indexOutcomes([line('posted'), line('post_failed')]).get('en:1').handled)
    })
    it('only failures -> not handled, last is the latest line', function() {
      const idx = m.indexOutcomes([line('wrong_page', { detail: 'a' }), line('post_failed', { detail: 'b' })])
      const e = idx.get('en:1')
      assert.isFalse(e.handled)
      assert.equal(e.last.detail, 'b')
    })
  })

  describe('isDummyRevision', function() {
    it('equal sha1 -> true', function() {
      assert.isTrue(m.isDummyRevision({ sha1: 'abc' }, { sha1: 'abc' }))
    })
    it('missing or hidden sha1 -> false', function() {
      assert.isFalse(m.isDummyRevision({ sha1hidden: true }, { sha1hidden: true }))
      assert.isFalse(m.isDummyRevision({ sha1: '' }, { sha1: '' }))
      assert.isFalse(m.isDummyRevision({ sha1: 'abc' }, null))
    })
    it('different sha1 -> false', function() {
      assert.isFalse(m.isDummyRevision({ sha1: 'abc' }, { sha1: 'def' }))
    })
  })

  describe('findMissedEdits', function() {
    const rev = (revid, parentid, msAgo, sha1) => ({ revid, parentid, timestamp: iso(msAgo), sha1 })
    const base = () => ({
      lang: 'en', title: 'Page', older: null, outcomeIndex: new Map(),
      now: NOW, windowStart: NOW - 2 * H, known: {}
    })
    const run = (over) => m.findMissedEdits({ ...base(), ...over })

    it('excludes revisions newer than 15 minutes', function() {
      assert.lengthOf(run({ revisions: [rev(2, 1, 5 * 60e3, 'a')] }), 0)
    })
    it('excludes revisions before the window', function() {
      assert.lengthOf(run({ revisions: [rev(2, 1, 3 * H, 'a')] }), 0)
    })
    it('excludes handled revisions', function() {
      const outcomeIndex = m.indexOutcomes([{ lang: 'en', rev_id: 2, outcome: 'posted' }])
      assert.lengthOf(run({ revisions: [rev(2, 1, H, 'a')], outcomeIndex }), 0)
    })
    it('excludes keys already known', function() {
      assert.lengthOf(run({ revisions: [rev(2, 1, H, 'a')], known: { 'en:2': {} } }), 0)
    })
    it('excludes dummy revisions, including parent from older', function() {
      const revisions = [rev(3, 2, H, 'same'), rev(2, 1, 90 * 60e3, 'x')]
      assert.deepEqual(run({ revisions }).map(e => e.rev_id), [3, 2]) // different sha1: both real edits
      const r2 = run({ revisions: [rev(3, 2, H, 'same'), rev(2, 1, 90 * 60e3, 'same')] })
      assert.deepEqual(r2.map(e => e.rev_id), [2]) // 2 has no known parent, so kept
      const r3 = run({ revisions: [rev(3, 2, H, 'same')], older: rev(2, 1, 3 * H, 'same') })
      assert.lengthOf(r3, 0)
    })
    it('takes reason, detail and diff_url from the last outcome', function() {
      const outcomeIndex = m.indexOutcomes([
        { lang: 'en', rev_id: 2, outcome: 'wrong_page', diff_url: 'old', detail: 'x' },
        { lang: 'en', rev_id: 2, outcome: 'post_failed', diff_url: 'https://en.wikipedia.org/w/index.php?diff=2&oldid=1', detail: 'boom' }
      ])
      const [e] = run({ revisions: [rev(2, 1, H, 'a')], outcomeIndex })
      assert.equal(e.reason, 'post_failed')
      assert.equal(e.detail, 'boom')
      assert.equal(e.diff_url, 'https://en.wikipedia.org/w/index.php?diff=2&oldid=1')
      assert.equal(e.key, 'en:2')
      assert.equal(e.page, 'Page')
    })
    it('never_handled with built diff URL, new-page form for parentid 0', function() {
      const out = run({ revisions: [rev(5, 4, H, 'a'), rev(4, 0, 90 * 60e3, 'b')] })
      assert.equal(out[0].reason, 'never_handled')
      assert.isNull(out[0].detail)
      assert.equal(out[0].diff_url, 'https://en.wikipedia.org/w/index.php?diff=5&oldid=4')
      assert.equal(out[1].diff_url, 'https://en.wikipedia.org/w/index.php?oldid=4')
    })
  })

  describe('buildAlertMessage', function() {
    const edit = (n) => ({ page: `Page ${n}`, lang: 'en', reason: 'never_handled', diff_url: `https://en.wikipedia.org/w/index.php?diff=${n}&oldid=1` })
    it('singular header', function() {
      const msg = m.buildAlertMessage([edit(1)], 1000)
      assert.match(msg, /^sfedits: 1 watched edit not posted/)
      assert.include(msg, 'Page 1 (en): bot never handled it\nhttps://')
    })
    it('plural header and all fit with no footer', function() {
      const msg = m.buildAlertMessage([edit(1), edit(2)], 1000)
      assert.match(msg, /^sfedits: 2 watched edits not posted/)
      assert.notInclude(msg, 'more.')
    })
    it('truncates with a +K more footer within maxLength', function() {
      const list = [1, 2, 3, 4, 5].map(edit)
      const msg = m.buildAlertMessage(list, 200)
      assert.isAtMost(msg.length, 200)
      assert.match(msg, /\n\n\+\d+ more\. Full list: data\/missed-edits\.jsonl on the droplet\.$/)
      const shown = (msg.match(/Page \d/g) || []).length
      assert.include(msg, `+${5 - shown} more.`)
    })
    it('tiny maxLength still returns header and footer', function() {
      const msg = m.buildAlertMessage([edit(1), edit(2)], 10)
      assert.match(msg, /^sfedits: 2 watched edits not posted/)
      assert.include(msg, '+2 more.')
    })
  })

  describe('pruneState', function() {
    const state = {
      baselineAt: 1, lastSuccessAt: 2,
      missed: {
        old: { alertedAt: NOW - 8 * 24 * H },
        recent: { alertedAt: NOW - 1 * H },
        pending: { alertedAt: null, detectedAt: NOW - 30 * 24 * H }
      }
    }
    it('drops old alerted, keeps recent alerted and unalerted', function() {
      const out = m.pruneState(state, NOW)
      assert.deepEqual(Object.keys(out.missed).sort(), ['pending', 'recent'])
      assert.equal(out.baselineAt, 1)
    })
    it('does not mutate input', function() {
      const copy = JSON.parse(JSON.stringify(state))
      m.pruneState(state, NOW)
      assert.deepEqual(state, copy)
    })
  })
})
