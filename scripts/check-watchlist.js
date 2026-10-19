#!/usr/bin/env node

// Check watchlist.json against topics.json and live Wikidata/Wikipedia.
//
// topics.json is the source of truth: each topic is a Wikidata item plus the
// wikis we watch it on. The bot only sees article titles, so when an article is
// moved, deleted or turned into a disambiguation page, the watchlist silently
// stops matching (sfedits#13: en "David Campos" became a disambiguation page and
// the politician's edits went unposted for months). Wikidata sitelinks follow
// page moves, so the title each topic should be watched under can be looked up.
//
// Usage: node scripts/check-watchlist.js [--topics topics.json] [--watchlist watchlist.json]
// Exits 1 and lists the problems if anything is wrong.

const fs = require('fs')
const path = require('path')
const minimist = require('minimist')
const { loadWatchlist } = require('../lib/config')

const USER_AGENT = 'sfedits-watchlist-check/1.0 (https://github.com/mrfinnsmith/sfedits)'
const HUMAN = 'Q5'
const DISAMBIGUATION_ITEMS = ['Q4167410', 'Q22808320']
const BATCH = 50

// Watchlist keys are Wikipedia language codes; Wikidata site ids use
// underscores (zh-yue -> zh_yuewiki).
function siteId(wiki) {
  return wiki.replace(/-/g, '_') + 'wiki'
}

function apiUrl(wiki) {
  return `https://${wiki}.wikipedia.org/w/api.php`
}

async function defaultFetchJson(url, params) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params })
  const res = await fetch(`${url}?${query}`, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new Error(`${url} returned HTTP ${res.status}`)
  }
  return res.json()
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size))
  }
  return out
}

function validateTopicsShape(topics) {
  const problems = []
  if (!Array.isArray(topics) || topics.length === 0) {
    return ['topics.json must be a non-empty array']
  }
  const seen = new Set()
  for (const topic of topics) {
    const name = topic && topic.id ? topic.id : JSON.stringify(topic)
    if (!topic || typeof topic.id !== 'string' || !/^Q\d+$/.test(topic.id)) {
      problems.push(`${name}: id must be a Wikidata item id like Q123`)
      continue
    }
    if (seen.has(topic.id)) {
      problems.push(`${topic.id}: listed twice`)
    }
    seen.add(topic.id)
    if (typeof topic.label !== 'string' || topic.label === '') {
      problems.push(`${topic.id}: label must be a non-empty string`)
    }
    if (typeof topic.person !== 'boolean') {
      problems.push(`${topic.id}: person must be true or false`)
    }
    if (!Array.isArray(topic.wikis) || topic.wikis.length === 0 ||
        !topic.wikis.every(w => typeof w === 'string' && /^[a-z][a-z-]*$/.test(w))) {
      problems.push(`${topic.id}: wikis must be a non-empty list of language codes`)
    } else if (new Set(topic.wikis).size !== topic.wikis.length) {
      problems.push(`${topic.id}: wikis lists a language twice`)
    }
  }
  return problems
}

async function fetchItems(ids, fetchJson) {
  const items = {}
  for (const batch of chunk(ids, BATCH)) {
    const data = await fetchJson('https://www.wikidata.org/w/api.php', {
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'claims|sitelinks'
    })
    for (const [key, entity] of Object.entries(data.entities || {})) {
      // A merged item comes back under its new id with redirects.from set.
      const requested = entity.redirects ? entity.redirects.from : key
      items[requested] = entity
    }
  }
  return items
}

function instanceOf(entity) {
  const claims = (entity.claims && entity.claims.P31) || []
  return claims
    .map(c => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)
    .filter(Boolean)
}

async function fetchPages(wiki, titles, fetchJson) {
  const pages = {}
  for (const batch of chunk(titles, BATCH)) {
    const data = await fetchJson(apiUrl(wiki), {
      action: 'query',
      prop: 'info|pageprops',
      ppprop: 'disambiguation',
      titles: batch.join('|')
    })
    const query = data.query || {}
    const renamed = {}
    for (const n of query.normalized || []) {
      renamed[n.to] = n.from
    }
    for (const page of query.pages || []) {
      pages[renamed[page.title] || page.title] = page
    }
  }
  return pages
}

async function checkWatchlist({ topics, watchlist, fetchJson = defaultFetchJson }) {
  const problems = validateTopicsShape(topics)
  if (problems.length > 0) {
    return { problems, expected: null }
  }

  const items = await fetchItems(topics.map(t => t.id), fetchJson)

  // expected[wiki][title] = topic id
  const expected = {}
  for (const topic of topics) {
    const entity = items[topic.id]
    if (!entity || entity.missing !== undefined) {
      problems.push(`${topic.id} (${topic.label}): no such Wikidata item`)
      continue
    }
    if (entity.redirects) {
      problems.push(`${topic.id} (${topic.label}): merged into ${entity.id}, use that id`)
    }
    const types = instanceOf(entity)
    if (types.some(t => DISAMBIGUATION_ITEMS.includes(t))) {
      problems.push(`${topic.id} (${topic.label}): is a disambiguation item, not a topic`)
      continue
    }
    if (topic.person && !types.includes(HUMAN)) {
      problems.push(`${topic.id} (${topic.label}): marked as a person but the item is not a human (P31 Q5)`)
    }
    if (!topic.person && types.includes(HUMAN)) {
      problems.push(`${topic.id} (${topic.label}): the item is a human but is not marked as a person`)
    }
    for (const wiki of topic.wikis) {
      const link = entity.sitelinks && entity.sitelinks[siteId(wiki)]
      if (!link) {
        problems.push(`${topic.id} (${topic.label}): no ${wiki} article`)
        continue
      }
      expected[wiki] = expected[wiki] || {}
      expected[wiki][link.title] = topic.id
    }
  }

  for (const wiki of Object.keys(expected).sort()) {
    const pages = await fetchPages(wiki, Object.keys(expected[wiki]), fetchJson)
    for (const [title, id] of Object.entries(expected[wiki])) {
      const page = pages[title]
      if (!page || page.missing) {
        problems.push(`${wiki}: "${title}" (${id}) does not exist`)
      } else if (page.redirect) {
        problems.push(`${wiki}: "${title}" (${id}) is a redirect`)
      } else if (page.pageprops && page.pageprops.disambiguation !== undefined) {
        problems.push(`${wiki}: "${title}" (${id}) is a disambiguation page`)
      }
    }
  }

  const wikis = new Set([...Object.keys(watchlist), ...Object.keys(expected)])
  for (const wiki of [...wikis].sort()) {
    const want = expected[wiki] || {}
    const have = watchlist[wiki] || {}
    for (const title of Object.keys(have)) {
      if (!(title in want)) {
        problems.push(`${wiki}: "${title}" is watched but is not the current article of any topic`)
      }
    }
    for (const [title, id] of Object.entries(want)) {
      if (!(title in have)) {
        problems.push(`${wiki}: "${title}" (${id}) is not watched`)
      }
    }
  }

  return { problems, expected }
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['topics', 'watchlist'],
    boolean: ['help', 'h'],
    default: { topics: './topics.json', watchlist: './watchlist.json' }
  })
  if (argv.help || argv.h) {
    console.log('Usage: node scripts/check-watchlist.js [--topics topics.json] [--watchlist watchlist.json]')
    return 0
  }

  const topics = JSON.parse(fs.readFileSync(path.resolve(argv.topics), 'utf8'))
  const watchlist = loadWatchlist(argv.watchlist)
  const { problems } = await checkWatchlist({ topics, watchlist })

  if (problems.length === 0) {
    console.log(`OK: ${topics.length} topics match ${argv.watchlist}`)
    return 0
  }
  console.error(`${problems.length} problem(s):`)
  for (const p of problems) {
    console.error(`- ${p}`)
  }
  return 1
}

if (require.main === module) {
  main().then(code => process.exit(code), err => {
    console.error(err.message)
    process.exit(2)
  })
}

module.exports = { checkWatchlist, validateTopicsShape, siteId }
