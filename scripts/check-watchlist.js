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
// It also lists new language versions: Wikipedia articles a tracked topic has
// in any language that topics.json doesn't watch it on yet (sfedits#23). Finn
// watches topics, not languages, so there is no language filter: a version on
// a wiki the bot has never watched is proposed the same way. Versions Finn has
// decided not to watch go in declined.json and are skipped. New versions are
// suggestions, not problems: they never change the exit code.
//
// Usage: node scripts/check-watchlist.js [--topics topics.json]
//          [--watchlist watchlist.json] [--declined declined.json]
//          [--report report.md]
// --report writes a Markdown issue body listing every problem and new version
// with the proposed watchlist change, only when there is something to report
// (the file is removed when the run is clean). The weekly workflow files it.
// Exit codes: 0 no problems (new versions may still be listed), 1 problems,
// 2 the check itself failed (bad input file, API error).

const fs = require('fs')
const path = require('path')
const minimist = require('minimist')
const { loadWatchlist } = require('../lib/config')

const USER_AGENT = 'sfedits-watchlist-check/1.0 (https://github.com/mrfinnsmith/sfedits)'
const HUMAN = 'Q5'
const DISAMBIGUATION_ITEMS = ['Q4167410', 'Q22808320']
const BATCH = 50

// Watchlist keys are the wiki's subdomain on wikipedia.org (the bot matches
// edits by URL host and joins #<key>.wikipedia on IRC). Wikidata site ids
// don't always map to that by swapping underscores for hyphens: be_x_oldwiki
// is be-tarask.wikipedia.org. So the key is taken from each sitelink's URL
// host, which also drops every non-Wikipedia sitelink (commonswiki,
// enwikiquote, enwikisource, specieswiki, ...): only <key>.wikipedia.org
// counts.
const WIKIPEDIA_HOST = /^([a-z0-9-]+)\.wikipedia\.org$/

function wikiFromUrl(url) {
  try {
    const match = new URL(url).hostname.match(WIKIPEDIA_HOST)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// { wiki: { title, url } } for every Wikipedia article of a Wikidata item.
function wikipediaLinks(entity) {
  const links = {}
  for (const link of Object.values((entity && entity.sitelinks) || {})) {
    const wiki = link && link.url ? wikiFromUrl(link.url) : null
    if (wiki) {
      links[wiki] = { title: link.title, url: link.url }
    }
  }
  return links
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

// declined.json: language versions Finn decided not to watch, so the weekly
// check doesn't propose them again. A list of
// {"id": "Q123", "wiki": "tlh", "note": "why (optional)"}.
function validateDeclined(declined, topics) {
  if (!Array.isArray(declined)) {
    return ['declined.json must be an array']
  }
  const problems = []
  const topicWikis = new Map(topics.map(t => [t.id, t.wikis]))
  const seen = new Set()
  for (const entry of declined) {
    const name = JSON.stringify(entry)
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' ||
        typeof entry.wiki !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.wiki) ||
        (entry.note !== undefined && typeof entry.note !== 'string')) {
      problems.push(`declined.json: ${name} must be {"id": "Q123", "wiki": "xx", "note": "optional"}`)
      continue
    }
    const key = `${entry.id} ${entry.wiki}`
    if (seen.has(key)) {
      problems.push(`declined.json: ${entry.id} on ${entry.wiki} is listed twice`)
    }
    seen.add(key)
    if (!topicWikis.has(entry.id)) {
      problems.push(`declined.json: ${entry.id} is not a topic in topics.json`)
    } else if (topicWikis.get(entry.id).includes(entry.wiki)) {
      problems.push(`declined.json: ${entry.id} on ${entry.wiki} is declined but topics.json watches it`)
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
      props: 'claims|sitelinks/urls'
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

async function checkWatchlist({ topics, watchlist, declined = [], fetchJson = defaultFetchJson }) {
  const problems = validateTopicsShape(topics)
  if (problems.length > 0) {
    return { problems, expected: null, newVersions: [] }
  }
  problems.push(...validateDeclined(declined, topics))
  const declinedKeys = new Set(
    (Array.isArray(declined) ? declined : []).filter(d => d && d.id && d.wiki).map(d => `${d.id} ${d.wiki}`)
  )
  const newVersions = []

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
    const links = wikipediaLinks(entity)
    for (const wiki of topic.wikis) {
      const link = links[wiki]
      if (!link) {
        problems.push(`${topic.id} (${topic.label}): no ${wiki} article`)
        continue
      }
      expected[wiki] = expected[wiki] || {}
      expected[wiki][link.title] = topic.id
    }
    for (const wiki of Object.keys(links).sort()) {
      if (!topic.wikis.includes(wiki) && !declinedKeys.has(`${topic.id} ${wiki}`)) {
        newVersions.push({
          id: topic.id,
          label: topic.label,
          wiki,
          title: links[wiki].title,
          url: links[wiki].url,
          watchedWiki: Object.prototype.hasOwnProperty.call(watchlist, wiki)
        })
      }
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

  return { problems, expected, newVersions }
}

// GitHub rejects issue bodies over 65536 characters.
const MAX_REPORT = 60000

function versionLine(v) {
  return `- ${v.label} (${v.id}) on \`${v.wiki}\`: [${v.title}](${v.url})`
}

// Markdown issue body: every problem, every new language version, and the
// watchlist.json / topics.json change that would add them.
function buildReport({ problems, newVersions, runUrl = null, date = new Date() }) {
  const out = []
  const day = date.toISOString().slice(0, 10)
  out.push(`The weekly watchlist check (${day}) found something. Nothing has been changed: ` +
    'any watchlist change goes through a normal PR, and the bot only picks it up after a redeploy (`deploy.sh`).')
  if (runUrl) {
    out.push('', `Run: ${runUrl}`)
  }

  if (problems.length > 0) {
    out.push('', `## Problems (${problems.length})`, '',
      'The watchlist no longer matches Wikipedia. Fix `topics.json` and `watchlist.json` together.', '')
    for (const p of problems) {
      out.push(`- ${p}`)
    }
  }

  if (newVersions.length > 0) {
    const watched = newVersions.filter(v => v.watchedWiki)
    const unwatched = newVersions.filter(v => !v.watchedWiki)
    const unwatchedWikis = new Set(unwatched.map(v => v.wiki))
    out.push('', `## New language versions (${newVersions.length})`, '',
      `${watched.length} on wikis the bot already watches, ${unwatched.length} on ` +
      `${unwatchedWikis.size} wiki${unwatchedWikis.size === 1 ? '' : 's'} it doesn't watch yet. ` +
      'To watch one, add its wiki to the topic in `topics.json` and the title to `watchlist.json` ' +
      '(the bot joins every wiki listed there). To stop seeing one, add ' +
      '`{"id": "Q…", "wiki": "…"}` to `declined.json`.')
    if (watched.length > 0) {
      out.push('', '### On wikis the bot already watches', '')
      out.push(...watched.map(versionLine))
    }
    if (unwatched.length > 0) {
      out.push('', '### On wikis the bot doesn\'t watch yet', '')
      out.push(...unwatched.map(versionLine))
    }

    const additions = {}
    const topicWikis = {}
    for (const v of newVersions) {
      additions[v.wiki] = additions[v.wiki] || {}
      additions[v.wiki][v.title] = true
      topicWikis[v.id] = topicWikis[v.id] || { label: v.label, wikis: [] }
      topicWikis[v.id].wikis.push(v.wiki)
    }
    const sortedAdditions = {}
    for (const wiki of Object.keys(additions).sort()) {
      sortedAdditions[wiki] = additions[wiki]
    }
    out.push('', '<details><summary>Proposed watchlist.json additions (all of the above)</summary>', '',
      '```json', JSON.stringify(sortedAdditions, null, 2), '```', '', '</details>')
    out.push('', '<details><summary>Proposed topics.json wikis to add (all of the above)</summary>', '')
    for (const [id, { label, wikis }] of Object.entries(topicWikis)) {
      out.push(`- ${label} (${id}): ${wikis.map(w => `\`${w}\``).join(', ')}`)
    }
    out.push('', '</details>')
  }

  let body = out.join('\n') + '\n'
  if (body.length > MAX_REPORT) {
    body = body.slice(0, MAX_REPORT) +
      '\n\n**Report truncated** (too long for an issue). Run `node scripts/check-watchlist.js` for the full list.\n'
  }
  return body
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['topics', 'watchlist', 'declined', 'report'],
    boolean: ['help', 'h'],
    default: { topics: './topics.json', watchlist: './watchlist.json', declined: './declined.json' }
  })
  if (argv.help || argv.h) {
    console.log('Usage: node scripts/check-watchlist.js [--topics topics.json] [--watchlist watchlist.json] ' +
      '[--declined declined.json] [--report report.md]')
    return 0
  }

  const topics = JSON.parse(fs.readFileSync(path.resolve(argv.topics), 'utf8'))
  const watchlist = loadWatchlist(argv.watchlist)
  const declined = JSON.parse(fs.readFileSync(path.resolve(argv.declined), 'utf8'))
  const { problems, newVersions } = await checkWatchlist({ topics, watchlist, declined })

  if (newVersions.length > 0) {
    const watched = newVersions.filter(v => v.watchedWiki).length
    console.log(`${newVersions.length} new language version(s) not watched yet ` +
      `(${watched} on watched wikis, ${newVersions.length - watched} on ` +
      `${new Set(newVersions.filter(v => !v.watchedWiki).map(v => v.wiki)).size} unwatched wikis). ` +
      'Suggestions only, not failures:')
    for (const v of newVersions) {
      console.log(`- ${v.label} (${v.id}) on ${v.wiki}${v.watchedWiki ? '' : ' (wiki not watched)'}: "${v.title}"`)
    }
  }

  if (argv.report) {
    const reportPath = path.resolve(argv.report)
    if (problems.length > 0 || newVersions.length > 0) {
      const runUrl = process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null
      fs.writeFileSync(reportPath, buildReport({ problems, newVersions, runUrl }))
      console.log(`Report written to ${argv.report}`)
    } else {
      fs.rmSync(reportPath, { force: true })
    }
  }

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

module.exports = { checkWatchlist, validateTopicsShape, validateDeclined, wikipediaLinks, wikiFromUrl, buildReport }
