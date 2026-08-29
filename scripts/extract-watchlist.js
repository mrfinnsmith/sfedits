#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const minimist = require('minimist')
const { countWatchlist } = require('../lib/config')

function extractWatchlist(configPath = './config.json', outputPath = './watchlist.json') {
  const resolvedConfigPath = path.resolve(configPath)
  const resolvedOutputPath = path.resolve(outputPath)

  let rawConfig
  try {
    rawConfig = fs.readFileSync(resolvedConfigPath, 'utf8')
  } catch (err) {
    throw new Error(`Failed to read config file at ${configPath}: ${err.message}`)
  }

  let config
  try {
    config = JSON.parse(rawConfig)
  } catch (err) {
    throw new Error(`Failed to parse JSON in config file at ${configPath}: ${err.message}`)
  }

  let extractedWatchlist = {}
  let found = false

  if (config.accounts && Array.isArray(config.accounts)) {
    for (const account of config.accounts) {
      if (account.watchlist && typeof account.watchlist === 'object') {
        found = true
        for (const [wikiName, pages] of Object.entries(account.watchlist)) {
          if (!extractedWatchlist[wikiName]) {
            extractedWatchlist[wikiName] = {}
          }
          if (pages && typeof pages === 'object') {
            for (const [pageName, val] of Object.entries(pages)) {
              extractedWatchlist[wikiName][pageName] = Boolean(val)
            }
          }
        }
      }
    }
  }

  if (!found && config.watchlist && typeof config.watchlist === 'object') {
    found = true
    for (const [wikiName, pages] of Object.entries(config.watchlist)) {
      if (!extractedWatchlist[wikiName]) {
        extractedWatchlist[wikiName] = {}
      }
      if (pages && typeof pages === 'object') {
        for (const [pageName, val] of Object.entries(pages)) {
          extractedWatchlist[wikiName][pageName] = Boolean(val)
        }
      }
    }
  }

  if (!found) {
    throw new Error(`No watchlist found in config file at ${configPath}`)
  }

  const { wikis, titles } = countWatchlist(extractedWatchlist)
  fs.writeFileSync(resolvedOutputPath, JSON.stringify(extractedWatchlist, null, 2) + '\n', 'utf8')

  return {
    watchlist: extractedWatchlist,
    outputPath: resolvedOutputPath,
    wikis,
    titles
  }
}

function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['config', 'output'],
    boolean: ['help', 'h'],
    default: {
      config: './config.json',
      output: './watchlist.json'
    }
  })

  if (argv.help || argv.h) {
    console.log('Usage: node scripts/extract-watchlist.js [options]')
    console.log('')
    console.log('Extracts the watchlist from config.json into a standalone watchlist.json file.')
    console.log('')
    console.log('Options:')
    console.log('  --config <path>   Path to config.json (default: ./config.json)')
    console.log('  --output <path>   Path to output watchlist.json (default: ./watchlist.json)')
    console.log('  --help, -h        Show this help message')
    process.exit(0)
  }

  try {
    const result = extractWatchlist(argv.config, argv.output)
    const wikiWord = result.wikis === 1 ? 'wiki' : 'wikis'
    const titleWord = result.titles === 1 ? 'title' : 'titles'
    console.log(`Extracted watchlist with ${result.titles} ${titleWord} across ${result.wikis} ${wikiWord} to ${argv.output}`)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  extractWatchlist
}
