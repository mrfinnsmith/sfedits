const { describe, it } = require('mocha')
const { assert } = require('chai')
const {
  isAnonymousName,
  revidFromDiffUrl,
  apiUrlForDiffUrl,
  parseRevisionsResponse,
  fetchRevisionUsers,
  deriveUpdate,
  fetchAllRows,
  planBackfill,
  summarize,
  sqlLiteral,
  buildSql
} = require('../scripts/backfill-editors')

// The script never touches the network in these tests: every fetch is a stub
// that records the URL and answers like the real Wikipedia API or PostgREST.

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

// A formatversion=2 prop=revisions response.
function revisionsBody(revs, badrevids = []) {
  const body = { batchcomplete: true, query: { pages: revs.map((r, i) => ({ pageid: i + 1, ns: 0, title: `Page ${i}`, revisions: [r] })) } }
  if (badrevids.length) {
    body.query.badrevids = {}
    for (const id of badrevids) body.query.badrevids[id] = { revid: id, missing: true }
  }
  return body
}

const noCountry = async () => null

describe('scripts/backfill-editors', function() {
  describe('revidFromDiffUrl', function() {
    it('reads diff= from the URL the bot writes', function() {
      assert.equal(revidFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=1372098397&oldid=1372098328'), 1372098397)
    })
    it('reads diff= when a title comes first', function() {
      assert.equal(revidFromDiffUrl('https://en.wikipedia.org/w/index.php?title=Cat&diff=123&oldid=456'), 123)
    })
    it('uses oldid for diff=prev and for new-page URLs with no diff', function() {
      assert.equal(revidFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=prev&oldid=789'), 789)
      assert.equal(revidFromDiffUrl('https://en.wikipedia.org/w/index.php?oldid=789&rcid=1000'), 789)
    })
    it('reads path forms', function() {
      assert.equal(revidFromDiffUrl('https://en.wikipedia.org/wiki/Special:Diff/123'), 123)
      assert.equal(revidFromDiffUrl('https://en.wikipedia.org/diff/123'), 123)
    })
    it('returns null when there is no revision id', function() {
      assert.isNull(revidFromDiffUrl('https://en.wikipedia.org/wiki/Cat'))
      assert.isNull(revidFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=next&oldid=abc'))
      assert.isNull(revidFromDiffUrl('not a url'))
    })
  })

  describe('apiUrlForDiffUrl', function() {
    it('uses the diff URL host', function() {
      assert.equal(apiUrlForDiffUrl('https://simple.wikipedia.org/w/index.php?diff=1&oldid=2'), 'https://simple.wikipedia.org/w/api.php')
    })
  })

  describe('isAnonymousName', function() {
    it('is true for IPv4, IPv6 and temporary accounts', function() {
      assert.isTrue(isAnonymousName('23.163.104.37'))
      assert.isTrue(isAnonymousName('2600:1700:5A40:2010:B0D7:1C4E:7A0B:1F2C'))
      assert.isTrue(isAnonymousName('~2026-42504-55'))
    })
    it('is false for registered names, including ones that look a bit like the patterns', function() {
      assert.isFalse(isAnonymousName('AUC2012'))
      assert.isFalse(isAnonymousName('Theodore Christopher'))
      assert.isFalse(isAnonymousName('~Tilde'))
      assert.isFalse(isAnonymousName('1.2.3'))
    })
  })

  describe('parseRevisionsResponse', function() {
    it('maps users, hidden users and missing revisions', function() {
      const result = parseRevisionsResponse(revisionsBody([
        { revid: 1, parentid: 0, user: 'Alice' },
        { revid: 2, parentid: 1, userhidden: true },
        { revid: 3, parentid: 2, user: '23.163.104.37', anon: true }
      ], [4]))
      assert.deepEqual(result.get(1), { user: 'Alice' })
      assert.deepEqual(result.get(2), { hidden: true })
      assert.deepEqual(result.get(3), { user: '23.163.104.37' })
      assert.deepEqual(result.get(4), { missing: true })
    })
  })

  describe('fetchRevisionUsers', function() {
    it('asks 50 revids per request with the right parameters and a User-Agent', async function() {
      const urls = []
      const headers = []
      const fetchImpl = async (url, opts) => {
        urls.push(new URL(url))
        headers.push(opts.headers)
        const ids = new URL(url).searchParams.get('revids').split('|').map(Number)
        return jsonResponse(revisionsBody(ids.map(id => ({ revid: id, user: `U${id}` }))))
      }
      const revids = Array.from({ length: 120 }, (_, i) => i + 1)
      const result = await fetchRevisionUsers('https://en.wikipedia.org/w/api.php', revids, { fetchImpl, delayMs: 0 })

      assert.equal(urls.length, 3)
      assert.deepEqual(urls.map(u => u.searchParams.get('revids').split('|').length), [50, 50, 20])
      assert.equal(urls[0].searchParams.get('prop'), 'revisions')
      assert.equal(urls[0].searchParams.get('rvprop'), 'user|ids')
      assert.equal(urls[0].searchParams.get('formatversion'), '2')
      assert.match(headers[0]['User-Agent'], /sfedits/)
      assert.equal(result.size, 120)
      assert.deepEqual(result.get(120), { user: 'U120' })
    })

    it('marks revids the API did not mention as missing', async function() {
      const fetchImpl = async () => jsonResponse(revisionsBody([{ revid: 1, user: 'A' }]))
      const result = await fetchRevisionUsers('https://en.wikipedia.org/w/api.php', [1, 2], { fetchImpl, delayMs: 0 })
      assert.deepEqual(result.get(2), { missing: true })
    })

    it('retries a 503 and throws on an API error', async function() {
      let n = 0
      const flaky = async () => (++n === 1 ? jsonResponse({}, 503) : jsonResponse(revisionsBody([{ revid: 1, user: 'A' }])))
      const result = await fetchRevisionUsers('https://en.wikipedia.org/w/api.php', [1], { fetchImpl: flaky, delayMs: 0 })
      assert.deepEqual(result.get(1), { user: 'A' })

      const broken = async () => jsonResponse({ error: { code: 'badvalue', info: 'nope' } })
      let error = null
      try {
        await fetchRevisionUsers('https://en.wikipedia.org/w/api.php', [1], { fetchImpl: broken, delayMs: 0 })
      } catch (e) {
        error = e
      }
      assert.match(error.message, /badvalue/)
    })
  })

  describe('deriveUpdate', function() {
    const base = { id: 1, diff_url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=0' }

    it('restores an erased temporary-account name and marks it anonymous with no IP', async function() {
      const row = { ...base, editor: null, ip: null, anonymous: true, editor_country: null }
      const r = await deriveUpdate(row, { user: '~2026-42504-55' }, noCountry)
      assert.equal(r.status, 'change')
      assert.deepEqual(r.patch, { editor: '~2026-42504-55' })
      assert.deepEqual(r.kinds, ['editor filled'])
    })

    it('fills editor and ip for an old IP edit and keeps its stored country', async function() {
      const row = { ...base, editor: null, ip: null, anonymous: true, editor_country: 'RU' }
      const lookups = []
      const r = await deriveUpdate(row, { user: '23.163.104.37' }, async ip => { lookups.push(ip); return 'US' })
      assert.deepEqual(r.patch, { editor: '23.163.104.37', ip: '23.163.104.37' })
      assert.deepEqual(lookups, [], 'no lookup when a country is already stored')
    })

    it('looks up a missing country from the IP, and keeps null when the lookup fails', async function() {
      const row = { ...base, editor: null, ip: null, anonymous: null, editor_country: null }
      const found = await deriveUpdate(row, { user: '8.8.8.8' }, async () => 'US')
      assert.deepEqual(found.patch, { editor: '8.8.8.8', ip: '8.8.8.8', anonymous: true, editor_country: 'US' })

      const notFound = await deriveUpdate(row, { user: '8.8.8.8' }, noCountry)
      assert.notProperty(notFound.patch, 'editor_country')
    })

    it('sets anonymous false for a registered editor', async function() {
      const row = { ...base, editor: 'AUC2012', ip: null, anonymous: null, editor_country: null }
      const r = await deriveUpdate(row, { user: 'AUC2012' }, noCountry)
      assert.deepEqual(r.patch, { anonymous: false })
    })

    it('is unchanged when the row already matches Wikipedia', async function() {
      const row = { ...base, editor: '1.2.3.4', ip: '1.2.3.4', anonymous: true, editor_country: 'US' }
      const r = await deriveUpdate(row, { user: '1.2.3.4' }, noCountry)
      assert.equal(r.status, 'unchanged')
      assert.isNull(r.patch)
    })

    it('leaves hidden, missing and unparseable rows alone', async function() {
      const row = { ...base, editor: null, ip: null, anonymous: true, editor_country: null }
      assert.equal((await deriveUpdate(row, { hidden: true }, noCountry)).status, 'hidden')
      assert.equal((await deriveUpdate(row, { missing: true }, noCountry)).status, 'missing')
      assert.equal((await deriveUpdate(row, undefined, noCountry)).status, 'unparseable')
    })
  })

  describe('fetchAllRows', function() {
    it('pages through the table by id until an empty page', async function() {
      const urls = []
      const pages = [[{ id: 1 }, { id: 2 }], [{ id: 5 }], []]
      const fetchImpl = async (url, opts) => {
        urls.push(new URL(url))
        assert.equal(opts.headers.apikey, 'k')
        return jsonResponse(pages.shift())
      }
      const rows = await fetchAllRows('https://x.supabase.co', 'k', { fetchImpl, pageSize: 2 })
      assert.deepEqual(rows.map(r => r.id), [1, 2, 5])
      assert.isNull(urls[0].searchParams.get('id'))
      assert.equal(urls[1].searchParams.get('id'), 'gt.2')
      assert.equal(urls[2].searchParams.get('id'), 'gt.5')
      assert.include(urls[0].searchParams.get('select'), 'ip')
    })
  })

  describe('planBackfill', function() {
    it('groups revids per wiki and derives each row', async function() {
      const calls = []
      const fetchImpl = async url => {
        const u = new URL(url)
        calls.push(u.host)
        if (u.host === 'en.wikipedia.org') {
          return jsonResponse(revisionsBody([{ revid: 10, user: '~2026-1-1' }, { revid: 11, userhidden: true }]))
        }
        return jsonResponse(revisionsBody([{ revid: 20, user: '23.163.104.37' }]))
      }
      const rows = [
        { id: 1, diff_url: 'https://en.wikipedia.org/w/index.php?diff=10&oldid=9', editor: null, ip: null, anonymous: true, editor_country: null },
        { id: 2, diff_url: 'https://en.wikipedia.org/w/index.php?diff=11&oldid=9', editor: null, ip: null, anonymous: true, editor_country: null },
        { id: 3, diff_url: 'https://ru.wikipedia.org/w/index.php?diff=20&oldid=19', editor: null, ip: null, anonymous: true, editor_country: 'US' },
        { id: 4, diff_url: 'https://en.wikipedia.org/wiki/Cat', editor: 'X', ip: null, anonymous: false, editor_country: null }
      ]
      const { results } = await planBackfill(rows, { fetchImpl, lookupCountry: noCountry, delayMs: 0 })

      assert.deepEqual(calls.sort(), ['en.wikipedia.org', 'ru.wikipedia.org'])
      assert.deepEqual(results.map(r => r.status), ['change', 'hidden', 'change', 'unparseable'])
      const { counts, kinds } = summarize(results)
      assert.equal(counts.change, 2)
      assert.equal(counts.hidden, 1)
      assert.equal(kinds['editor filled'], 2)
      assert.equal(kinds['ip filled'], 1)
    })
  })

  describe('SQL output', function() {
    it('quotes literals safely', function() {
      assert.equal(sqlLiteral(null), 'null')
      assert.equal(sqlLiteral(true), 'true')
      assert.equal(sqlLiteral(false), 'false')
      assert.equal(sqlLiteral("O'Brien"), "'O''Brien'")
      assert.equal(sqlLiteral('a\\b'), "'a\\b'")
      assert.equal(sqlLiteral("x'; drop table t; --"), "'x''; drop table t; --'")
    })

    it('writes one update by id per changed row, with no transaction wrapper', function() {
      const sql = buildSql([
        { row: { id: 7 }, patch: { editor: "O'Brien", anonymous: false } },
        { row: { id: 8 }, patch: { editor: '8.8.8.8', ip: '8.8.8.8', editor_country: 'US' } }
      ], { generatedAt: 'T' })
      assert.include(sql, "update public.wikipedia_edits set editor = 'O''Brien', anonymous = false where id = 7;")
      assert.include(sql, "update public.wikipedia_edits set editor = '8.8.8.8', ip = '8.8.8.8', editor_country = 'US' where id = 8;")
      assert.notMatch(sql, /^\s*(begin|commit)/im)
    })

    it('refuses a non-integer id', function() {
      assert.throws(() => buildSql([{ row: { id: '1; drop' }, patch: { editor: 'a' } }]), /integer/)
    })
  })
})
