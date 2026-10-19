const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const { checkWatchlist, validateTopicsShape, siteId } = require('../scripts/check-watchlist')

function item(id, { types = ['Q5'], sitelinks = {} } = {}) {
  return {
    id,
    claims: {
      P31: types.map(t => ({ mainsnak: { datavalue: { value: { id: t } } } }))
    },
    sitelinks: Object.fromEntries(
      Object.entries(sitelinks).map(([wiki, title]) => [siteId(wiki), { site: siteId(wiki), title }])
    )
  }
}

// Stub for the Wikidata and Wikipedia APIs. pages[wiki][title] holds extra
// page fields such as { missing: true } or { pageprops: { disambiguation: '' } }.
function stubFetch(entities, pages = {}) {
  const calls = []
  const fetchJson = async (url, params) => {
    calls.push({ url, params })
    if (url.includes('wikidata.org')) {
      const out = {}
      for (const id of params.ids.split('|')) {
        out[id] = entities[id] || { id, missing: '' }
      }
      return { entities: out }
    }
    const wiki = url.match(/https:\/\/([^.]+)\.wikipedia/)[1]
    return {
      query: {
        pages: params.titles.split('|').map(title => ({ title, ...((pages[wiki] || {})[title] || {}) }))
      }
    }
  }
  return { fetchJson, calls }
}

const campos = { id: 'Q12054131', label: 'David Campos', person: true, wikis: ['en'] }

describe('check-watchlist', function() {
  describe('siteId', function() {
    it('maps language codes to Wikidata site ids', function() {
      assert.equal(siteId('en'), 'enwiki')
      assert.equal(siteId('zh-yue'), 'zh_yuewiki')
      assert.equal(siteId('simple'), 'simplewiki')
    })
  })

  describe('validateTopicsShape', function() {
    it('accepts a well-formed topic list', function() {
      assert.deepEqual(validateTopicsShape([campos]), [])
    })

    it('rejects an empty or non-array list', function() {
      assert.lengthOf(validateTopicsShape([]), 1)
      assert.lengthOf(validateTopicsShape({}), 1)
    })

    it('rejects bad ids, duplicates, missing person flags and empty wikis', function() {
      const problems = validateTopicsShape([
        { id: 'David Campos', label: 'x', person: true, wikis: ['en'] },
        campos,
        campos,
        { id: 'Q1', label: 'x', wikis: ['en'] },
        { id: 'Q2', label: 'x', person: false, wikis: [] }
      ])
      assert.lengthOf(problems, 4)
    })
  })

  describe('checkWatchlist', function() {
    it('passes when every topic article is watched and nothing else is', async function() {
      const { fetchJson } = stubFetch({
        Q12054131: item('Q12054131', { sitelinks: { en: 'David Campos (politician)' } })
      })
      const { problems } = await checkWatchlist({
        topics: [campos],
        watchlist: { en: { 'David Campos (politician)': true } },
        fetchJson
      })
      assert.deepEqual(problems, [])
    })

    it('catches a moved article: the old title is stale and the new one unwatched', async function() {
      const { fetchJson } = stubFetch({
        Q12054131: item('Q12054131', { sitelinks: { en: 'David Campos (politician)' } })
      })
      const { problems } = await checkWatchlist({
        topics: [campos],
        watchlist: { en: { 'David Campos': true } },
        fetchJson
      })
      assert.deepEqual(problems, [
        'en: "David Campos" is watched but is not the current article of any topic',
        'en: "David Campos (politician)" (Q12054131) is not watched'
      ])
    })

    it('rejects a disambiguation item as a topic', async function() {
      const { fetchJson } = stubFetch({
        Q134282177: item('Q134282177', { types: ['Q4167410'], sitelinks: { en: 'David Campos' } })
      })
      const { problems } = await checkWatchlist({
        topics: [{ id: 'Q134282177', label: 'David Campos', person: true, wikis: ['en'] }],
        watchlist: { en: { 'David Campos': true } },
        fetchJson
      })
      assert.include(problems, 'Q134282177 (David Campos): is a disambiguation item, not a topic')
    })

    it('checks the person flag against P31 human', async function() {
      const { fetchJson } = stubFetch({
        Q1: item('Q1', { types: ['Q13406463'], sitelinks: { en: 'List page' } }),
        Q2: item('Q2', { types: ['Q5'], sitelinks: { en: 'Someone' } })
      })
      const { problems } = await checkWatchlist({
        topics: [
          { id: 'Q1', label: 'List page', person: true, wikis: ['en'] },
          { id: 'Q2', label: 'Someone', person: false, wikis: ['en'] }
        ],
        watchlist: { en: { 'List page': true, Someone: true } },
        fetchJson
      })
      assert.deepEqual(problems, [
        'Q1 (List page): marked as a person but the item is not a human (P31 Q5)',
        'Q2 (Someone): the item is a human but is not marked as a person'
      ])
    })

    it('reports a missing item and a wiki the item has no article on', async function() {
      const { fetchJson } = stubFetch({
        Q12054131: item('Q12054131', { sitelinks: { en: 'David Campos (politician)' } })
      })
      const { problems } = await checkWatchlist({
        topics: [
          { ...campos, wikis: ['en', 'de'] },
          { id: 'Q999', label: 'Gone', person: false, wikis: ['en'] }
        ],
        watchlist: { en: { 'David Campos (politician)': true } },
        fetchJson
      })
      assert.include(problems, 'Q12054131 (David Campos): no de article')
      assert.include(problems, 'Q999 (Gone): no such Wikidata item')
    })

    it('flags articles that are missing, redirects or disambiguation pages on Wikipedia', async function() {
      const { fetchJson } = stubFetch(
        {
          Q1: item('Q1', { sitelinks: { en: 'A' } }),
          Q2: item('Q2', { sitelinks: { en: 'B' } }),
          Q3: item('Q3', { sitelinks: { en: 'C' } })
        },
        { en: { A: { missing: true }, B: { redirect: true }, C: { pageprops: { disambiguation: '' } } } }
      )
      const { problems } = await checkWatchlist({
        topics: ['Q1', 'Q2', 'Q3'].map(id => ({ id, label: id, person: true, wikis: ['en'] })),
        watchlist: { en: { A: true, B: true, C: true } },
        fetchJson
      })
      assert.deepEqual(problems, [
        'en: "A" (Q1) does not exist',
        'en: "B" (Q2) is a redirect',
        'en: "C" (Q3) is a disambiguation page'
      ])
    })

    it('reports a merged item under the id it was asked for', async function() {
      const { fetchJson } = stubFetch({})
      const merged = async (url, params) => url.includes('wikidata.org')
        ? { entities: { Q20: { ...item('Q20', { sitelinks: { en: 'X' } }), redirects: { from: 'Q10', to: 'Q20' } } } }
        : fetchJson(url, params)
      const { problems } = await checkWatchlist({
        topics: [{ id: 'Q10', label: 'X', person: true, wikis: ['en'] }],
        watchlist: { en: { X: true } },
        fetchJson: merged
      })
      assert.deepEqual(problems, ['Q10 (X): merged into Q20, use that id'])
    })

    it('batches Wikidata lookups at 50 ids', async function() {
      const topics = []
      const entities = {}
      const watchlist = { en: {} }
      for (let i = 1; i <= 120; i++) {
        topics.push({ id: `Q${i}`, label: `T${i}`, person: true, wikis: ['en'] })
        entities[`Q${i}`] = item(`Q${i}`, { sitelinks: { en: `T${i}` } })
        watchlist.en[`T${i}`] = true
      }
      const { fetchJson, calls } = stubFetch(entities)
      const { problems } = await checkWatchlist({ topics, watchlist, fetchJson })
      assert.deepEqual(problems, [])
      assert.lengthOf(calls.filter(c => c.url.includes('wikidata.org')), 3)
      assert.lengthOf(calls.filter(c => c.url.includes('wikipedia.org')), 3)
    })
  })

  describe('committed topics.json', function() {
    const topics = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'topics.json'), 'utf8'))
    const watchlist = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'watchlist.json'), 'utf8'))

    it('is well formed', function() {
      assert.deepEqual(validateTopicsShape(topics), [])
    })

    it('covers every watched wiki and no others', function() {
      const topicWikis = new Set(topics.flatMap(t => t.wikis))
      assert.sameMembers([...topicWikis], Object.keys(watchlist))
    })

    it('has one watched title per topic wiki', function() {
      const pairs = topics.reduce((n, t) => n + t.wikis.length, 0)
      const titles = Object.values(watchlist).reduce((n, w) => n + Object.keys(w).length, 0)
      assert.equal(pairs, titles)
    })
  })
})
