/**
 * Mastodon post formatting utilities
 * Mastodon's API does not support HTML - it only accepts plain text
 * and auto-detects URLs to make them clickable
 */

/**
 * Build plain-text Mastodon post with URLs for proper link detection
 * Mastodon automatically converts URLs to clickable links
 *
 * @param {string} text - Plain text post
 * @param {string} page - Wikipedia article name
 * @param {string} name - Editor username
 * @param {string} pageUrl - Wikipedia article URL
 * @param {string} userUrl - Editor contributions URL
 * @returns {string} Plain text post with URLs for Mastodon
 */
function buildMastodonText(text, page, name, pageUrl, userUrl) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  let result = text

  // Replace article name with "name (url)" format
  if (pageUrl && page && typeof pageUrl === 'string' && typeof page === 'string') {
    // Match the article name and replace with format that includes the URL in parentheses
    const regex = new RegExp(`\\b${page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    result = result.replace(regex, `${page} (${pageUrl})`)
  }

  // Replace username with "name (url)" format
  if (userUrl && name && typeof userUrl === 'string' && typeof name === 'string') {
    const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    result = result.replace(regex, `${name} (${userUrl})`)
  }

  return result
}

module.exports = {
  buildMastodonText
}
