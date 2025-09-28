#!/usr/bin/env node

const fs = require('fs')
const https = require('https')

function getCategoryMembers(categoryName, limit = 500) {
  return new Promise((resolve, reject) => {
    const encodedCategory = encodeURIComponent(`Category:${categoryName}`)
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&list=categorymembers&cmtitle=${encodedCategory}&cmlimit=${limit}&cmnamespace=0`
    
    const options = {
      headers: {
        'User-Agent': 'SF Edits Article Finder (https://github.com/mrfinnsmith/sfedits) Node.js'
      }
    }
    
    https.get(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try {
          const response = JSON.parse(data)
          
          if (response.error) {
            console.log(`  ❌ Error: ${response.error.info}`)
            resolve([])
            return
          }
          
          const members = response.query.categorymembers || []
          const articleTitles = members.map(member => member.title)
          resolve(articleTitles)
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  let categories = []
  
  // Check if categories are provided as arguments
  if (process.argv.length > 2) {
    categories = process.argv.slice(2)
  } else {
    // Read from stdin for piping
    const stdin = process.stdin
    stdin.setEncoding('utf8')
    
    let input = ''
    for await (const chunk of stdin) {
      input += chunk
    }
    
    // Parse categories from input (assuming each line contains a category name)
    categories = input.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('📄') && !line.startsWith('  ❌') && !line.startsWith('Found'))
      .map(line => line.replace(/^- /, '')) // Remove leading "- " if present
      .filter(Boolean)
  }
  
  if (categories.length === 0) {
    console.log('Usage: node find-articles-in-categories.js [category1] [category2] ...')
    console.log('Or pipe category names from find-categories.js')
    process.exit(1)
  }
  
  console.log(`Finding articles in ${categories.length} categories...\n`)
  
  const allArticles = new Set()
  
  for (const category of categories) {
    console.log(`📁 Category: ${category}`)
    try {
      const articles = await getCategoryMembers(category)
      
      if (articles.length > 0) {
        console.log(`  Found ${articles.length} articles:`)
        articles.forEach(article => {
          console.log(`    - ${article}`)
          allArticles.add(article)
        })
      } else {
        console.log('  No articles found in this category')
      }
      console.log()
      
      // Rate limiting - be nice to Wikipedia's API
      await new Promise(resolve => setTimeout(resolve, 100))
      
    } catch (error) {
      console.log(`  ❌ Error fetching articles: ${error.message}`)
      console.log()
    }
  }
  
  console.log(`\n📊 Summary: Found ${allArticles.size} unique articles across all categories`)
  
  if (allArticles.size > 0) {
    console.log('\nAll unique articles:')
    Array.from(allArticles).sort().forEach(article => {
      console.log(`  - ${article}`)
    })
  }
}

if (require.main === module) {
  main().catch(console.error)
}