#!/usr/bin/env node

const fs = require('fs')
const https = require('https')

function getConfig() {
  const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))
  return config
}

function getWikipediaTranslations(pageTitle, lang = 'en') {
  return new Promise((resolve, reject) => {
    const encodedTitle = encodeURIComponent(pageTitle)
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=langlinks&titles=${encodedTitle}&lllimit=max`
    
    const options = {
      headers: {
        'User-Agent': 'SF Edits Translation Finder (https://github.com/mrfinnsmith/sfedits) Node.js'
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
          
          const langlinks = pages[pageId].langlinks || []
          const translations = langlinks.map(link => ({
            lang: link.lang,
            title: link['*']
          }))
          resolve(translations)
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const config = getConfig()
  
  console.log('Finding translations for all articles in config...\n')
  
  for (const account of config.accounts) {
    if (account.watchlist) {
      for (const [wikiName, articles] of Object.entries(account.watchlist)) {
        console.log(`📚 ${wikiName}:\n`)
        
        // Extract language code from wiki name (e.g., "English Wikipedia" -> "en")
        let langCode = 'en'
        if (wikiName.includes('English')) langCode = 'en'
        else if (wikiName.includes('Spanish')) langCode = 'es'
        else if (wikiName.includes('French')) langCode = 'fr'
        else if (wikiName.includes('German')) langCode = 'de'
        else if (wikiName.includes('Chinese')) langCode = 'zh'
        else if (wikiName.includes('Japanese')) langCode = 'ja'
        // Add more language mappings as needed
        
        const articleTitles = Object.keys(articles)
        
        for (const article of articleTitles) {
          console.log(`📄 ${article} (${langCode})`)
          try {
            const translations = await getWikipediaTranslations(article, langCode)
            
            if (translations.length > 0) {
              console.log(`  Found ${translations.length} translations:`)
              translations
                .sort((a, b) => a.lang.localeCompare(b.lang))
                .forEach(translation => {
                  console.log(`    ${translation.lang}: ${translation.title}`)
                })
            } else {
              console.log('  - No translations found')
            }
            console.log() // blank line
            
            // Rate limiting - be nice to Wikipedia's API
            await new Promise(resolve => setTimeout(resolve, 100))
            
          } catch (error) {
            console.log(`  ❌ Error fetching translations: ${error.message}`)
            console.log()
          }
        }
      }
    }
  }
}

if (require.main === module) {
  main().catch(console.error)
}