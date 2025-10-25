#!/usr/bin/env node

const fs = require('fs')
const { BskyAgent } = require('@atproto/api')

// Load config
const config = require('../config.json')
const account = config.accounts[0]

// Mock geolocation database (in production, this would be loaded from MaxMind .mmdb file)
// For testing, we'll use the same IPs from the previous script with known locations
const geoDatabase = {
  '67.188.85.86': { country: 'United States', code: 'US', isp: 'Comcast Cable Communications, Inc.' },
  '50.90.187.160': { country: 'United States', code: 'US', isp: 'Spectrum' },
  '204.137.178.108': { country: 'Dominican Republic', code: 'DO', isp: 'ORBIT CABLE, S. A' },
  '76.221.143.81': { country: 'United States', code: 'US', isp: 'AT&T Corp' },
  '2601:281:D884:160:AD72:8529:400:FFEA': { country: 'United States', code: 'US', isp: 'Comcast Cable Communications, LLC' },
  '2600:1700:4EAD:A400:B188:D4D8:B0B4:BD46': { country: 'United States', code: 'US', isp: 'AT&T Internet Services' },
  '24.41.236.55': { country: 'Puerto Rico', code: 'PR', isp: 'Liberty Communications of Puerto Rico LLC' },
  '92.151.145.132': { country: 'France', code: 'FR', isp: 'Unknown' },
  '162.10.196.94': { country: 'United States', code: 'US', isp: 'Netskope' },
  '109.229.74.21': { country: 'Russia', code: 'RU', isp: 'OOO Teleset\' plus' }
}

// Local lookup function (no API calls)
function getCountry(ip) {
  return geoDatabase[ip] || null
}

// Country code to flag emoji
function countryToFlag(code) {
  if (!code || code.length !== 2) return ''
  return String.fromCodePoint(...[...code].map(c => c.charCodeAt(0) + 127397))
}

// Detect IP in text
function findIP(text) {
  const ipv4 = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
  const ipv6 = text.match(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/i)
  return ipv4 ? ipv4[0] : ipv6 ? ipv6[0] : null
}

async function main() {
  try {
    // Create agent and login
    const agent = new BskyAgent({ service: 'https://bsky.social' })
    await agent.login({
      identifier: account.bluesky.identifier,
      password: account.bluesky.password
    })

    console.log('Fetching posts from Bluesky...\n')

    // Fetch feed (gets latest posts)
    const feed = await agent.getAuthorFeed({ actor: account.bluesky.identifier, limit: 100 })

    let postsWithIPs = []

    for (const item of feed.data.feed) {
      const post = item.post
      const text = post.record.text
      const ip = findIP(text)

      if (ip) {
        const geo = getCountry(ip)
        postsWithIPs.push({
          uri: post.uri,
          text,
          ip,
          country: geo?.country || 'Unknown',
          countryCode: geo?.code || '',
          isp: geo?.isp || '',
          createdAt: post.record.createdAt
        })
        console.log(`Found IP: ${ip} (${geo?.country || 'Unknown'})`)
      }
    }

    if (postsWithIPs.length === 0) {
      console.log('No posts with IP addresses found.')
      process.exit(0)
    }

    console.log(`\n\nFound ${postsWithIPs.length} posts with IP addresses.\n`)
    console.log('='.repeat(100))

    // Display enriched posts formatted as they would appear
    for (const post of postsWithIPs) {
      const geo = post.country ? ` [${post.countryCode}]` : ''

      // Extract article name and URL from original text
      const urlMatch = post.text.match(/(https?:\/\/[^\s]+)/)
      const url = urlMatch ? urlMatch[1] : ''
      const textParts = post.text.split(url)
      const beforeUrl = textParts[0].trim()

      // Create enriched version with geolocation
      const enrichedText = beforeUrl.replace(
        post.ip,
        `${post.ip}${geo}`
      )

      const flag = countryToFlag(post.countryCode)
      const geoDisplay = flag || post.countryCode

      console.log(`\n📅 ${new Date(post.createdAt).toLocaleString()}`)
      console.log(``)
      console.log(`📍 BLUESKY:`)
      console.log(`   ${beforeUrl.replace(post.ip, `${post.ip} ${geoDisplay}`)} ${url}`)
      console.log(``)
      console.log(`🐘 MASTODON:`)
      console.log(`   ${beforeUrl.replace(post.ip, `${post.ip} ${geoDisplay}`)} (${url})`)
      console.log('-'.repeat(100))
    }

  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

main()
