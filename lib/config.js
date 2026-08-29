const fs = require('fs')
const path = require('path')
const { isDeepStrictEqual } = require('util')

function countWatchlist(watchlist) {
  if (!watchlist || typeof watchlist !== 'object') {
    return { wikis: 0, titles: 0 }
  }
  const wikis = Object.keys(watchlist).length
  let titles = 0
  for (const wiki of Object.values(watchlist)) {
    if (wiki && typeof wiki === 'object') {
      titles += Object.keys(wiki).length
    }
  }
  return { wikis, titles }
}

// Enforce the committed watchlist shape: a non-empty object mapping wiki names
// to objects of article title -> boolean. Anything else is a malformed file and
// must fail loudly rather than silently watching zero titles (e.g. `{}`) or
// treating a JSON string / array as a watchlist.
function validateWatchlistShape(parsed, watchlistPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid watchlist in ${watchlistPath}: expected a JSON object mapping wiki names to article-title maps`)
  }
  const wikiNames = Object.keys(parsed)
  if (wikiNames.length === 0) {
    throw new Error(`Invalid watchlist in ${watchlistPath}: the watchlist is empty (no wikis)`)
  }
  for (const wikiName of wikiNames) {
    const pages = parsed[wikiName]
    if (!pages || typeof pages !== 'object' || Array.isArray(pages)) {
      throw new Error(`Invalid watchlist in ${watchlistPath}: wiki "${wikiName}" must map article titles to booleans`)
    }
    const titles = Object.keys(pages)
    if (titles.length === 0) {
      throw new Error(`Invalid watchlist in ${watchlistPath}: wiki "${wikiName}" has no titles`)
    }
    for (const title of titles) {
      if (typeof pages[title] !== 'boolean') {
        throw new Error(`Invalid watchlist in ${watchlistPath}: "${wikiName}" -> "${title}" must be a boolean`)
      }
    }
  }
}

function loadWatchlist(watchlistPath) {
  const resolvedPath = path.resolve(watchlistPath)
  const content = fs.readFileSync(resolvedPath, 'utf8')
  const parsed = JSON.parse(content)
  validateWatchlistShape(parsed, resolvedPath)
  return parsed
}

function getConfig(configPath = './config.json', watchlistPath = null, options = {}) {
  const resolvedConfigPath = path.resolve(configPath)
  const configContent = fs.readFileSync(resolvedConfigPath, 'utf8')
  const config = JSON.parse(configContent)

  // Handle externally referenced ranges if present. Relative ranges paths are
  // resolved against the config file's directory, not the process cwd (which
  // is how the old require()-based loader in page-watch.js resolved them), so
  // deployments work regardless of where the bot is started from.
  if (config.accounts && Array.isArray(config.accounts)) {
    for (const account of config.accounts) {
      if (typeof account.ranges === 'string') {
        const rangesPath = path.isAbsolute(account.ranges)
          ? account.ranges
          : path.resolve(path.dirname(resolvedConfigPath), account.ranges)
        account.ranges = JSON.parse(fs.readFileSync(rangesPath, 'utf8'))
      }
    }
  }

  let watchlist = null
  let watchlistSource = null
  let watchlistLoadedFromFile = false
  let resolvedWatchlistPath = null

  if (watchlistPath) {
    // Explicit watchlist path provided
    resolvedWatchlistPath = path.resolve(watchlistPath)
    watchlist = loadWatchlist(resolvedWatchlistPath)
    watchlistSource = watchlistPath
    watchlistLoadedFromFile = true
  } else {
    // Look for watchlist.json next to config file
    const defaultWatchlistPath = path.join(path.dirname(resolvedConfigPath), 'watchlist.json')
    if (fs.existsSync(defaultWatchlistPath)) {
      resolvedWatchlistPath = defaultWatchlistPath
      watchlist = loadWatchlist(resolvedWatchlistPath)
      watchlistSource = defaultWatchlistPath
      watchlistLoadedFromFile = true
    } else {
      // Fall back to inline watchlist in config.json
      watchlistSource = 'inline config'
    }
  }

  if (watchlistLoadedFromFile && watchlist) {
    // Migration guard: if any account (or the top-level config.watchlist)
    // still carries a non-empty inline watchlist that differs from the file,
    // refuse to start. Silently preferring the file here would drop the bot
    // from ~379 monitored titles to the committed 3-title placeholder on the
    // first deploy after this change.
    const inlineWatchlists = []
    if (config.accounts && Array.isArray(config.accounts)) {
      for (const account of config.accounts) {
        if (account.watchlist && typeof account.watchlist === 'object'
            && Object.keys(account.watchlist).length > 0) {
          inlineWatchlists.push(account.watchlist)
        }
      }
    }
    if (config.watchlist && typeof config.watchlist === 'object'
        && Object.keys(config.watchlist).length > 0) {
      inlineWatchlists.push(config.watchlist)
    }
    for (const inlineWatchlist of inlineWatchlists) {
      if (!isDeepStrictEqual(inlineWatchlist, watchlist)) {
        throw new Error(
          `Watchlist conflict: the inline watchlist in ${resolvedConfigPath} differs from the watchlist file ${resolvedWatchlistPath}. ` +
          'To migrate, run `node scripts/extract-watchlist.js`, commit the resulting watchlist.json, ' +
          'then delete the `watchlist` key from each account in config.json and redeploy.'
        )
      }
    }

    // The file watchlist applies to every account: all accounts share one
    // watchlist. Per-account inline watchlists were either absent or verified
    // deep-equal to the file above, so nothing per-account is overwritten.
    if (config.accounts && Array.isArray(config.accounts)) {
      for (const account of config.accounts) {
        account.watchlist = watchlist
      }
    } else {
      config.watchlist = watchlist
    }
  }

  if (!options.silent) {
    console.log('loaded config from', configPath)
    const activeWatchlist = config.accounts && config.accounts[0] && config.accounts[0].watchlist
      ? config.accounts[0].watchlist
      : config.watchlist
    const { wikis, titles } = countWatchlist(activeWatchlist)
    const wikiPlural = wikis === 1 ? 'wiki' : 'wikis'
    const titlePlural = titles === 1 ? 'title' : 'titles'

    if (watchlistLoadedFromFile) {
      console.log(`Loaded watchlist from ${watchlistSource}: ${titles} ${titlePlural} across ${wikis} ${wikiPlural}`)
    } else if (activeWatchlist) {
      console.log(`Loaded watchlist from inline config: ${titles} ${titlePlural} across ${wikis} ${wikiPlural}`)
    } else {
      console.log('Loaded watchlist: none (0 titles across 0 wikis)')
    }
  }

  return config
}

module.exports = {
  getConfig,
  loadWatchlist,
  countWatchlist
}
