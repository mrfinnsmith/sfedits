const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const { USER_AGENT, apiGet, getLatestRevisions, listRevisions } = require('../lib/wikipedia-api')

const HOST = 'https://en.wikipedia.org'
const noSleep = { sleep: async () => {} }

function sleepRecorder() {
  const calls = []
  return { calls, options: { sleep: async ms => { calls.push(ms) } } }
}

describe('lib/wikipedia-api', function() {
  beforeEach(function() { nock.disableNetConnect() })
  afterEach(function() { nock.cleanAll(); nock.enableNetConnect() })

  describe('apiGet', function() {
    it('adds maxlag, format, formatversion and the User-Agent', async function() {
      let seen
      nock(HOST, { reqheaders: { 'user-agent': USER_AGENT } })
        .get('/w/api.php').query(q => { seen = q; return true })
        .reply(200, { ok: 1 })
      const json = await apiGet('en', { action: 'query', titles: 'A|B' }, noSleep)
      assert.deepEqual(json, { ok: 1 })
      assert.equal(seen.maxlag, '5')
      assert.equal(seen.format, 'json')
      assert.equal(seen.formatversion, '2')
      assert.equal(seen.action, 'query')
      assert.equal(seen.titles, 'A|B')
    })

    it('uses the language as the host', async function() {
      nock('https://zh.wikipedia.org').get('/w/api.php').query(true).reply(200, { zh: true })
      assert.deepEqual(await apiGet('zh', { action: 'query' }, noSleep), { zh: true })
    })

    it('runs requests serially: the second starts only after the first settles', async function() {
      const events = []
      nock(HOST).get('/w/api.php').query(q => q.n === '1')
        .delay(50).reply(200, () => { events.push('first replied'); return { n: 1 } })
      nock(HOST).get('/w/api.php').query(q => { if (q.n === '2') events.push('second started'); return q.n === '2' })
        .reply(200, { n: 2 })
      const [a, b] = await Promise.all([
        apiGet('en', { n: '1' }, noSleep),
        apiGet('en', { n: '2' }, noSleep)
      ])
      assert.equal(a.n, 1)
      assert.equal(b.n, 2)
      assert.deepEqual(events, ['first replied', 'second started'])
    })

    it('a failed request does not block the queue', async function() {
      nock(HOST).get('/w/api.php').query(true).reply(500, 'boom')
      nock(HOST).get('/w/api.php').query(true).reply(200, { ok: 1 })
      let failed = false
      await apiGet('en', {}, noSleep).catch(() => { failed = true })
      assert.isTrue(failed)
      assert.deepEqual(await apiGet('en', {}, noSleep), { ok: 1 })
    })

    it('retries a maxlag error (HTTP 200) after Retry-After seconds', async function() {
      nock(HOST).get('/w/api.php').query(true)
        .reply(200, { error: { code: 'maxlag', info: 'lagged' } }, { 'Retry-After': '7' })
      nock(HOST).get('/w/api.php').query(true).reply(200, { ok: 1 })
      const { calls, options } = sleepRecorder()
      assert.deepEqual(await apiGet('en', {}, options), { ok: 1 })
      assert.deepEqual(calls, [7000])
    })

    it('retries HTTP 429 and defaults to 5s without a numeric Retry-After', async function() {
      nock(HOST).get('/w/api.php').query(true).reply(429, 'slow down')
      nock(HOST).get('/w/api.php').query(true).reply(503, 'busy', { 'Retry-After': 'soon' })
      nock(HOST).get('/w/api.php').query(true).reply(200, { ok: 1 })
      const { calls, options } = sleepRecorder()
      assert.deepEqual(await apiGet('en', {}, options), { ok: 1 })
      assert.deepEqual(calls, [5000, 5000])
    })

    it('gives up after 3 retries and throws', async function() {
      const scope = nock(HOST).get('/w/api.php').query(true).times(4)
        .reply(429, 'no', { 'Retry-After': '1' })
      const { calls, options } = sleepRecorder()
      let err
      try { await apiGet('en', {}, options) } catch (e) { err = e }
      assert.isDefined(err)
      assert.match(err.message, /after 3 retries/)
      assert.deepEqual(calls, [1000, 1000, 1000])
      assert.isTrue(scope.isDone())
    })

    it('throws on other API errors with code and info, without retrying', async function() {
      nock(HOST).get('/w/api.php').query(true)
        .reply(200, { error: { code: 'badvalue', info: 'bad thing' } })
      const { calls, options } = sleepRecorder()
      let err
      try { await apiGet('en', {}, options) } catch (e) { err = e }
      assert.match(err.message, /badvalue.*bad thing/)
      assert.lengthOf(calls, 0)
    })

    it('throws on other non-2xx statuses without retrying', async function() {
      nock(HOST).get('/w/api.php').query(true).reply(500, 'err')
      const { calls, options } = sleepRecorder()
      let err
      try { await apiGet('en', {}, options) } catch (e) { err = e }
      assert.match(err.message, /HTTP 500/)
      assert.lengthOf(calls, 0)
    })

    it('throws on a network error without retrying', async function() {
      nock(HOST).get('/w/api.php').query(true).replyWithError('socket hang up')
      const { calls, options } = sleepRecorder()
      let err
      try { await apiGet('en', {}, options) } catch (e) { err = e }
      assert.isDefined(err)
      assert.lengthOf(calls, 0)
    })
  })

  describe('getLatestRevisions', function() {
    it('batches 51 titles into 2 requests', async function() {
      const titles = Array.from({ length: 51 }, (_, i) => `Page ${i}`)
      const sizes = []
      nock(HOST).get('/w/api.php').query(q => { sizes.push(q.titles.split('|').length); return true })
        .times(2).reply(200, { query: { pages: [] } })
      const out = await getLatestRevisions('en', titles, noSleep)
      assert.deepEqual(sizes, [50, 1])
      assert.lengthOf(Object.keys(out), 51)
      assert.isNull(out['Page 0'])
    })

    it('requests ids|timestamp and no redirects param', async function() {
      let seen
      nock(HOST).get('/w/api.php').query(q => { seen = q; return true }).reply(200, { query: { pages: [] } })
      await getLatestRevisions('en', ['A'], noSleep)
      assert.equal(seen.action, 'query')
      assert.equal(seen.prop, 'revisions')
      assert.equal(seen.rvprop, 'ids|timestamp')
      assert.notProperty(seen, 'redirects')
    })

    it('maps normalized titles back to the input and returns null for missing pages', async function() {
      nock(HOST).get('/w/api.php').query(true).reply(200, {
        batchcomplete: true,
        query: {
          normalized: [
            { fromencoded: false, from: 'Nancy_pelosi', to: 'Nancy pelosi' },
            { fromencoded: false, from: 'Nonexistent_Page_xyz', to: 'Nonexistent Page xyz' }
          ],
          pages: [
            { ns: 0, title: 'Nonexistent Page xyz', missing: true },
            { pageid: 1, ns: 0, title: 'Nancy pelosi', revisions: [{ revid: 10, parentid: 9, timestamp: '2025-03-14T00:52:21Z' }] },
            { pageid: 2, ns: 0, title: 'London Breed', revisions: [{ revid: 20, parentid: 19, timestamp: '2026-10-04T08:05:13Z' }] }
          ]
        }
      })
      const out = await getLatestRevisions('en',
        ['Nancy_pelosi', 'London Breed', 'Nonexistent_Page_xyz'], noSleep)
      assert.deepEqual(out, {
        'Nancy_pelosi': { revid: 10, parentid: 9, timestamp: '2025-03-14T00:52:21Z' },
        'London Breed': { revid: 20, parentid: 19, timestamp: '2026-10-04T08:05:13Z' },
        'Nonexistent_Page_xyz': null
      })
    })
  })

  describe('listRevisions', function() {
    const rev = (revid, ts) => ({ revid, parentid: revid - 1, timestamp: ts, user: 'U', size: 1, sha1: 'x' + revid })
    const page = (revisions, cont) => {
      const body = { query: { pages: [{ pageid: 1, ns: 0, title: 'T', revisions }] } }
      if (cont) body.continue = cont
      return body
    }
    const since = Date.parse('2026-10-01T00:00:00Z')

    it('sends the listing params and returns revisions with older null when history ends', async function() {
      let seen
      nock(HOST).get('/w/api.php').query(q => { seen = q; return true })
        .reply(200, page([rev(3, '2026-10-03T00:00:00Z'), rev(2, '2026-10-02T00:00:00Z')]))
      const out = await listRevisions('en', 'T', { since }, noSleep)
      assert.equal(seen.titles, 'T')
      assert.equal(seen.rvdir, 'older')
      assert.equal(seen.rvlimit, '50')
      assert.equal(seen.rvprop, 'ids|timestamp|user|sha1|size')
      assert.deepEqual(out.revisions.map(r => r.revid), [3, 2])
      assert.isNull(out.older)
    })

    it('stops at the first revision older than since and returns it as older', async function() {
      nock(HOST).get('/w/api.php').query(true)
        .reply(200, page([rev(3, '2026-10-03T00:00:00Z'), rev(2, '2026-09-30T23:59:59Z'), rev(1, '2026-09-01T00:00:00Z')],
          { rvcontinue: 'nope', continue: '||' }))
      const out = await listRevisions('en', 'T', { since: new Date(since) }, noSleep)
      assert.deepEqual(out.revisions.map(r => r.revid), [3])
      assert.equal(out.older.revid, 2)
    })

    it('includes a revision exactly at since', async function() {
      nock(HOST).get('/w/api.php').query(true).reply(200, page([rev(2, '2026-10-01T00:00:00Z'), rev(1, '2026-09-01T00:00:00Z')]))
      const out = await listRevisions('en', 'T', { since }, noSleep)
      assert.deepEqual(out.revisions.map(r => r.revid), [2])
      assert.equal(out.older.revid, 1)
    })

    it('follows continue across requests', async function() {
      const seen = []
      nock(HOST).get('/w/api.php').query(q => { if (!q.rvcontinue) seen.push(q); return !q.rvcontinue })
        .reply(200, page([rev(5, '2026-10-05T00:00:00Z')], { rvcontinue: '2026|4', continue: '||' }))
      nock(HOST).get('/w/api.php').query(q => { if (q.rvcontinue === '2026|4') seen.push(q); return q.rvcontinue === '2026|4' })
        .reply(200, page([rev(4, '2026-10-04T00:00:00Z'), rev(3, '2026-08-01T00:00:00Z')], { rvcontinue: 'x|2', continue: '||' }))
      const out = await listRevisions('en', 'T', { since }, noSleep)
      assert.deepEqual(out.revisions.map(r => r.revid), [5, 4])
      assert.equal(out.older.revid, 3)
      assert.equal(seen[1].continue, '||')
    })

    it('passes hidden flags through and honours a custom rvprop', async function() {
      let seen
      nock(HOST).get('/w/api.php').query(q => { seen = q; return true })
        .reply(200, page([{ revid: 2, parentid: 1, timestamp: '2026-10-02T00:00:00Z', sha1hidden: true, userhidden: true }]))
      const out = await listRevisions('en', 'T', { since, rvprop: 'ids|timestamp|sha1|flags' }, noSleep)
      assert.equal(seen.rvprop, 'ids|timestamp|sha1|flags')
      assert.isTrue(out.revisions[0].sha1hidden)
      assert.isTrue(out.revisions[0].userhidden)
    })

    it('returns empty for a missing page', async function() {
      nock(HOST).get('/w/api.php').query(true)
        .reply(200, { query: { pages: [{ ns: 0, title: 'T', missing: true }] } })
      assert.deepEqual(await listRevisions('en', 'T', { since }, noSleep), { revisions: [], older: null })
    })

    it('requires since', async function() {
      let err
      try { await listRevisions('en', 'T', {}, noSleep) } catch (e) { err = e }
      assert.match(err.message, /since/)
    })
  })
})
