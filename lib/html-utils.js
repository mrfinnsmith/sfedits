/**
 * HTML utilities for building Mastodon posts with embedded links
 */

/**
 * Escape HTML special characters to prevent injection
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for HTML
 */
function escapeHtml(text) {
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }
  return text.replace(/[&<>"']/g, char => escapeMap[char])
}

/**
 * Build HTML-formatted Mastodon post with clickable links
 * Replaces article name, username, and diff URLs with HTML links
 *
 * @param {string} text - Plain text post
 * @param {string} page - Wikipedia article name
 * @param {string} name - Editor username
 * @param {string} pageUrl - Wikipedia article URL
 * @param {string} userUrl - Editor contributions URL
 * @returns {string} HTML-formatted post safe for Mastodon
 */
function buildMastodonHtml(text, page, name, pageUrl, userUrl) {
  if (!text || typeof text !== 'string') {
    return '<p></p>'
  }

  let html = escapeHtml(text)

  // Replace URLs first (before text replacements) to avoid double-escaping
  html = html.replace(
    /https?:\/\/[^\s<>"]+/g,
    (url) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
  )

  // Replace article name with link
  if (pageUrl && page && typeof pageUrl === 'string' && typeof page === 'string') {
    const escapedPage = escapeHtml(page)
    const escapedUrl = escapeHtml(pageUrl)
    // Use word boundary to avoid partial matches
    const regex = new RegExp(`\\b${escapedPage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    html = html.replace(regex, `<a href="${escapedUrl}">${escapedPage}</a>`)
  }

  // Replace username with link
  if (userUrl && name && typeof userUrl === 'string' && typeof name === 'string') {
    const escapedName = escapeHtml(name)
    const escapedUrl = escapeHtml(userUrl)
    const regex = new RegExp(`\\b${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    html = html.replace(regex, `<a href="${escapedUrl}">${escapedName}</a>`)
  }

  return `<p>${html}</p>`
}

module.exports = {
  escapeHtml,
  buildMastodonHtml
}
