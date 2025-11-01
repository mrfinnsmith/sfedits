/**
 * Mastodon Platform Posting
 *
 * High-level posting abstraction for Mastodon. Handles media upload and status posting
 * with plain text URLs. This module centralizes all Mastodon posting logic to ensure
 * consistency across the bot and admin console.
 *
 * NOTE: Mastodon only accepts plain text, not HTML. URLs are auto-linkified by Mastodon.
 *
 * @see https://docs.joinmastodon.org/methods/statuses/
 */

const fs = require('fs')
const Mastodon = require('mastodon')
const { buildMastodonText } = require('./html-utils')

/**
 * Posts to Mastodon with screenshot and plain text formatting
 *
 * Handles the complete Mastodon posting flow:
 * 1. Connects to Mastodon instance
 * 2. Uploads screenshot as media attachment
 * 3. Formats text with URLs in parentheses (Article (url) format)
 * 4. Creates status with media attachment
 *
 * @param {Object} options - Posting options
 * @param {Object} options.account - Mastodon account config (access_token, instance)
 * @param {string} options.text - Post text (should be enriched with IP flags)
 * @param {string} options.screenshot - Path to screenshot PNG file
 * @param {Object} options.metadata - Post metadata for text formatting
 * @param {string} options.metadata.page - Article name (for alt text and text formatting)
 * @param {string} options.metadata.name - Username/IP (for text formatting)
 * @param {string} options.metadata.pageUrl - Wikipedia article URL (for text formatting)
 * @param {string} options.metadata.userUrl - User contributions URL (for text formatting)
 * @returns {Promise<Object>} Mastodon status response with ID and URL
 * @throws {Error} If media upload or posting fails
 *
 * @example
 * await post({
 *   account: { access_token: 'token', instance: 'https://mastodon.social' },
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
  // Connect to Mastodon instance
  const M = new Mastodon({
    access_token: account.access_token,
    api_url: account.instance + '/api/v1/'
  })

  // Upload screenshot
  const imageData = fs.createReadStream(screenshot)
  const mediaData = await M.post('media', {
    file: imageData,
    description: `Screenshot of edit to ${metadata.page}`
  })

  // Format text with URLs in parentheses for Mastodon
  const mastodonText = buildMastodonText(
    text,
    metadata.page,
    metadata.name,
    metadata.pageUrl,
    metadata.userUrl
  )

  // Post status with media
  return await M.post('statuses', {
    status: mastodonText,
    media_ids: [mediaData.data.id]
  })
}

module.exports = { post }
