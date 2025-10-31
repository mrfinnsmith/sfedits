/**
 * Bluesky Platform Posting
 *
 * High-level posting abstraction for Bluesky. Handles authentication, media upload,
 * facet building, and post creation. This module centralizes all Bluesky posting logic
 * to ensure consistency across the bot and admin console.
 *
 * @see https://docs.bsky.app
 */

const fs = require('fs')
const { createAuthenticatedAgent } = require('./bluesky-client')
const { buildFacets } = require('./bluesky-utils')

/**
 * Posts to Bluesky with screenshot and rich text facets
 *
 * Handles the complete Bluesky posting flow:
 * 1. Authenticates with Bluesky service
 * 2. Uploads screenshot as image blob
 * 3. Builds rich text facets for clickable links
 * 4. Creates post with embedded image
 *
 * @param {Object} options - Posting options
 * @param {Object} options.account - Bluesky account config (identifier, password, service)
 * @param {string} options.text - Post text (should be enriched with IP flags)
 * @param {string} options.screenshot - Path to screenshot PNG file
 * @param {Object} options.metadata - Post metadata for links
 * @param {string} options.metadata.page - Article name (for alt text)
 * @param {string} options.metadata.name - Username/IP
 * @param {string} options.metadata.pageUrl - Wikipedia article URL
 * @param {string} options.metadata.userUrl - User contributions URL
 * @returns {Promise<Object>} Bluesky post response with URI and CID
 * @throws {Error} If authentication, upload, or posting fails
 *
 * @example
 * await post({
 *   account: { identifier: 'bot.bsky.social', password: 'app-pass' },
 *   text: 'Cat edited by 192.0.2.1 [🇺🇸] https://...',
 *   screenshot: '/tmp/screenshot-123.png',
 *   metadata: {
 *     page: 'Cat',
 *     name: '192.0.2.1',
 *     pageUrl: 'https://en.wikipedia.org/wiki/Cat',
 *     userUrl: 'https://en.wikipedia.org/wiki/Special:Contributions/192.0.2.1'
 *   }
 * })
 */
async function post({ account, text, screenshot, metadata }) {
  // Authenticate
  const agent = await createAuthenticatedAgent(account)

  // Upload screenshot
  const imageData = fs.readFileSync(screenshot)
  const uploadResult = await agent.uploadBlob(imageData, {
    encoding: 'image/png'
  })

  // Build facets for clickable links
  const facets = buildFacets(
    text,
    metadata.page,
    metadata.name,
    metadata.pageUrl,
    metadata.userUrl
  )

  // Create post with embedded image
  return await agent.post({
    text: text,
    facets: facets,
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{
        alt: `Screenshot of edit to ${metadata.page}`,
        image: uploadResult.data.blob
      }]
    },
    createdAt: new Date().toISOString()
  })
}

module.exports = { post }
