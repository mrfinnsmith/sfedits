const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const {
  checkWatchlist, validateTopicsShape, validateDeclined, wikipediaLinks, wikiFromUrl, buildReport
} = require('../scripts/check-watchlist')

// sitelinks are keyed by Wikipedia subdomain ('en', 'zh-yue'); `extra` holds
// raw Wikidata sitelinks such as commonswiki or be_x_oldwiki.
function item(id, { types = ['Q5'], sitelinks = {}, extra = {} } = {}) {
  const links = {}
  for (const [wiki, title] of Object.entries(sitelinks)) {
    const site = wiki.replace(/-/g, '_') + 'wiki'
    links[site] = { site, title, url: `https://${wiki}.wikipedia.org/wiki/${encodeURIComponent(title)}` }
  }
  for (const [site, link] of Object.entries(extra)) {
    links[site] = { site, ...link }
  }
  return {
    id,
    claims: {
      P31: types.map(t => ({ mainsnak: { datavalue: { value: { id: t } } } }))
    },
    sitelinks: links
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
  describe('wikipediaLinks', function() {
    it('keys Wikipedia sitelinks by URL subdomain, not by site id', function() {
      const entity = item('Q1', {
        sitelinks: { en: 'A', 'zh-yue': 'B', simple: 'A' },
        extra: {
          be_x_oldwiki: { title: 'C', url: 'https://be-tarask.wikipedia.org/wiki/C' },
          zh_min_nanwiki: { title: 'D', url: 'https://zh-min-nan.wikipedia.org/wiki/D' }
        }
      })
      assert.deepEqual(Object.keys(wikipediaLinks(entity)).sort(),
        ['be-tarask', 'en', 'simple', 'zh-min-nan', 'zh-yue'])
      assert.equal(wikipediaLinks(entity)['be-tarask'].title, 'C')
    })

    it('ignores non-Wikipedia sitelinks', function() {
      const entity = item('Q1', {
        sitelinks: { en: 'A' },
        extra: {
          commonswiki: { title: 'Category:A', url: 'https://commons.wikimedia.org/wiki/Category:A' },
          enwikiquote: { title: 'A', url: 'https://en.wikiquote.org/wiki/A' },
          enwikisource: { title: 'Author:A', url: 'https://en.wikisource.org/wiki/Author:A' },
          specieswiki: { title: 'A', url: 'https://species.wikimedia.org/wiki/A' },
          dewikivoyage: { title: 'A', url: 'https://de.wikivoyage.org/wiki/A' },
          metawiki: { title: 'A', url: 'https://meta.wikimedia.org/wiki/A' },
          nourl: { title: 'A' }
        }
      })
      assert.deepEqual(Object.keys(wikipediaLinks(entity)), ['en'])
    })

    it('returns null for hosts that are not <key>.wikipedia.org', function() {
      assert.equal(wikiFromUrl('https://en.wikipedia.org/wiki/X'), 'en')
      assert.isNull(wikiFromUrl('https://en.m.wikipedia.org/wiki/X'))
      assert.isNull(wikiFromUrl('not a url'))
    })
  })

  describe('validateDeclined', function() {
    it('accepts an empty list and well-formed entries', function() {
      assert.deepEqual(validateDeclined([], [campos]), [])
      assert.deepEqual(validateDeclined([{ id: 'Q12054131', wiki: 'tlh', note: 'Klingon' }], [campos]), [])
    })

    it('rejects bad shapes, duplicates, unknown topics and declined-but-watched', function() {
      assert.deepEqual(validateDeclined({}, [campos]), ['declined.json must be an array'])
      const problems = validateDeclined([
        { id: 'Q12054131', wiki: 'de' },
        { id: 'Q12054131', wiki: 'de' },
        { id: 'Q12054131', wiki: 'en' },
        { id: 'Q9', wiki: 'de' },
        { id: 'Q12054131' }
      ], [campos])
      assert.deepEqual(problems, [
        'declined.json: Q12054131 on de is listed twice',
        'declined.json: Q12054131 on en is declined but topics.json watches it',
        'declined.json: Q9 is not a topic in topics.json',
        'declined.json: {"id":"Q12054131"} must be {"id": "Q123", "wiki": "xx", "note": "optional"}'
      ])
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

    it('lists new language versions on watched and unwatched wikis without failing', async function() {
      const { fetchJson, calls } = stubFetch({
        Q12054131: item('Q12054131', {
          sitelinks: { en: 'David Campos (politician)', es: 'David Campos', tlh: 'David Campos' },
          extra: {
            enwikiquote: { title: 'David Campos', url: 'https://en.wikiquote.org/wiki/David_Campos' },
            commonswiki: { title: 'Category:David Campos', url: 'https://commons.wikimedia.org/wiki/Category:David_Campos' }
          }
        })
      })
      const { problems, newVersions } = await checkWatchlist({
        topics: [campos],
        watchlist: { en: { 'David Campos (politician)': true }, es: { Other: true } },
        fetchJson
      })
      // es "Other" is stale only because this stub watchlist has no topic for it.
      assert.deepEqual(problems, ['es: "Other" is watched but is not the current article of any topic'])
      assert.deepEqual(newVersions.map(v => [v.wiki, v.title, v.watchedWiki]), [
        ['es', 'David Campos', true],
        ['tlh', 'David Campos', false]
      ])
      // New versions are not looked up on Wikipedia: only watched wikis are.
      assert.deepEqual(calls.filter(c => c.url.includes('wikipedia.org')).map(c => c.url),
        ['https://en.wikipedia.org/w/api.php'])
    })

    it('skips declined language versions', async function() {
      const { fetchJson } = stubFetch({
        Q12054131: item('Q12054131', { sitelinks: { en: 'David Campos (politician)', es: 'David Campos', tlh: 'X' } })
      })
      const { problems, newVersions } = await checkWatchlist({
        topics: [campos],
        watchlist: { en: { 'David Campos (politician)': true } },
        declined: [{ id: 'Q12054131', wiki: 'tlh', note: 'not useful' }],
        fetchJson
      })
      assert.deepEqual(problems, [])
      assert.deepEqual(newVersions.map(v => v.wiki), ['es'])
    })

    it('finds a watched article on a wiki whose site id differs from its host', async function() {
      const { fetchJson } = stubFetch({
        Q1: item('Q1', {
          sitelinks: {},
          extra: { be_x_oldwiki: { title: 'Т', url: 'https://be-tarask.wikipedia.org/wiki/%D0%A2' } }
        })
      })
      const { problems, newVersions } = await checkWatchlist({
        topics: [{ id: 'Q1', label: 'T', person: true, wikis: ['be-tarask'] }],
        watchlist: { 'be-tarask': { Т: true } },
        fetchJson
      })
      assert.deepEqual(problems, [])
      assert.deepEqual(newVersions, [])
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

  describe('buildReport', function() {
    const versions = [
      { id: 'Q1', label: 'A', wiki: 'zh', title: '甲', url: 'https://zh.wikipedia.org/wiki/%E7%94%B2', watchedWiki: true },
      { id: 'Q1', label: 'A', wiki: 'tlh', title: 'A', url: 'https://tlh.wikipedia.org/wiki/A', watchedWiki: false }
    ]

    it('lists problems, new versions and the proposed watchlist change', function() {
      const body = buildReport({ problems: ['en: "X" is a redirect'], newVersions: versions, date: new Date('2026-10-19') })
      assert.include(body, '(2026-10-19)')
      assert.include(body, '## Problems (1)')
      assert.include(body, '- en: "X" is a redirect')
      assert.include(body, '## New language versions (2)')
      assert.include(body, '1 on wikis the bot already watches, 1 on 1 wiki it doesn\'t watch yet')
      assert.include(body, '- A (Q1) on `zh`: [甲](https://zh.wikipedia.org/wiki/%E7%94%B2)')
      assert.include(body, '"tlh": {\n    "A": true\n  }')
      assert.include(body, '- A (Q1): `zh`, `tlh`')
    })

    it('leaves out empty sections and stays under the issue size limit', function() {
      const body = buildReport({ problems: ['p'], newVersions: [] })
      assert.notInclude(body, 'New language versions')
      const many = Array.from({ length: 2000 }, (_, i) => ({ ...versions[1], wiki: `w${i}` }))
      assert.isBelow(buildReport({ problems: [], newVersions: many }).length, 65536)
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

    it('has a valid declined.json', function() {
      const declined = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'declined.json'), 'utf8'))
      assert.deepEqual(validateDeclined(declined, topics), [])
    })

    it('has one watched title per topic wiki', function() {
      const pairs = topics.reduce((n, t) => n + t.wikis.length, 0)
      const titles = Object.values(watchlist).reduce((n, w) => n + Object.keys(w).length, 0)
      assert.equal(pairs, titles)
    })
  })
})
