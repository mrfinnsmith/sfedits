#!/usr/bin/env node

const https = require('https')
const minimist = require('minimist')
const { getConfig } = require('../lib/config')

const argv = minimist(process.argv.slice(2), {
  string: ['config', 'watchlist'],
  default: {
    config: './config.json',
    watchlist: null
  }
})

function getWikipediaCategories(pageTitle) {
  return new Promise((resolve, reject) => {
    const encodedTitle = encodeURIComponent(pageTitle)
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=categories&titles=${encodedTitle}&cllimit=max`
    
    const options = {
      headers: {
        'User-Agent': 'SF Edits Category Finder (https://github.com/mrfinnsmith/sfedits) Node.js'
      }
    }
    
    https.get(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try {
          const response = JSON.parse(data)
          const pages = response.query.pages
          const pageId = Object.keys(pages)[0]
          
          if (pageId === '-1') {
            console.log(`  ❌ Page "${pageTitle}" not found`)
            resolve([])
            return
          }
          
          const categories = pages[pageId].categories || []
          const categoryNames = categories.map(cat => cat.title.replace('Category:', ''))
          resolve(categoryNames)
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const config = getConfig(argv.config, argv.watchlist)
  
  console.log('Finding categories for all English Wikipedia articles in config...\n')
  
  for (const account of config.accounts) {
    if (account.watchlist && account.watchlist['en']) {
      const articles = Object.keys(account.watchlist['en'])
      
      console.log(`Found ${articles.length} English Wikipedia articles to analyze:\n`)
      
      for (const article of articles) {
        console.log(`📄 ${article}`)
        try {
          const categories = await getWikipediaCategories(article)
          if (categories.length > 0) {
            categories.forEach(cat => console.log(`  - ${cat}`))
          } else {
            console.log('  - No categories found')
          }
          console.log() // blank line
          
          // Rate limiting - be nice to Wikipedia's API
          await new Promise(resolve => setTimeout(resolve, 100))
          
        } catch (error) {
          console.log(`  ❌ Error fetching categories: ${error.message}`)
          console.log()
        }
      }
    }
  }
}

if (require.main === module) {
  main().catch(console.error)
}