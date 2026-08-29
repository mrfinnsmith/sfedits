const fs = require('fs')
const path = require('path')

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

function loadWatchlist(watchlistPath) {
  const resolvedPath = path.resolve(watchlistPath)
  const content = fs.readFileSync(resolvedPath, 'utf8')
  return JSON.parse(content)
}

function getConfig(configPath = './config.json', watchlistPath = null, options = {}) {
  const resolvedConfigPath = path.resolve(configPath)
  const configContent = fs.readFileSync(resolvedConfigPath, 'utf8')
  const config = JSON.parse(configContent)

  // Handle externally referenced ranges if present
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

  if (watchlistPath) {
    // Explicit watchlist path provided
    const resolvedWatchlistPath = path.resolve(watchlistPath)
    watchlist = loadWatchlist(resolvedWatchlistPath)
    watchlistSource = watchlistPath
    watchlistLoadedFromFile = true
  } else {
    // Look for watchlist.json next to config file
    const defaultWatchlistPath = path.join(path.dirname(resolvedConfigPath), 'watchlist.json')
    if (fs.existsSync(defaultWatchlistPath)) {
      watchlist = loadWatchlist(defaultWatchlistPath)
      watchlistSource = defaultWatchlistPath
      watchlistLoadedFromFile = true
    } else {
      // Fall back to inline watchlist in config.json
      watchlistSource = 'inline config'
    }
  }

  if (watchlistLoadedFromFile && watchlist) {
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
