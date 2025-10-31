/**
 * Bluesky Utilities
 *
 * Shared utilities for working with Bluesky's rich text format and link facets.
 * Facets use byte offsets (not character positions) to handle UTF-8 correctly.
 *
 * @see https://docs.bsky.app/docs/advanced-guides/post-richtext
 */

/**
 * Creates Bluesky facets for article name, username, and URLs in post text
 *
 * Bluesky uses "facets" to mark up ranges of text as links. Each facet
 * specifies a byte range (not character range) and a link URI. This function
 * correctly handles multi-byte UTF-8 characters and emojis.
 *
 * CRITICAL: Facets must be built AFTER all text transformations are complete.
 * Any text changes after facet creation will break byte offsets.
 *
 * Text transformation pipeline order:
 * 1. Template rendering (produces base text)
 * 2. Content enrichment (IP geolocation flags)
 * 3. Facet building (THIS FUNCTION - must be last)
 *
 * @param {string} text - The complete post text (after all enrichment)
 * @param {string} page - Article name to link
 * @param {string} name - Username/IP to link
 * @param {string} pageUrl - Wikipedia article URL
 * @param {string} userUrl - User contributions URL
 * @returns {Array<Object>} Array of Bluesky facet objects
 *
 * @example
 * const text = "Cat edited by User https://en.wikipedia.org/diff/123"
 * const facets = buildFacets(text, "Cat", "User",
 *   "https://en.wikipedia.org/wiki/Cat",
 *   "https://en.wikipedia.org/wiki/Special:Contributions/User")
 * // Returns 3 facets: one for "Cat", one for "User", one for diff URL
 */
function buildFacets(text, page, name, pageUrl, userUrl) {
  const facets = []
  let searchOffset = 0

  // Article name facet (appears first in template)
  if (pageUrl) {
    const pageIndex = text.indexOf(page, searchOffset)
    if (pageIndex !== -1) {
      const byteStart = Buffer.byteLength(text.substring(0, pageIndex), 'utf8')
      const byteEnd = byteStart + Buffer.byteLength(page, 'utf8')
      facets.push({
        index: { byteStart, byteEnd },
        features: [{
          $type: 'app.bsky.richtext.facet#link',
          uri: pageUrl
        }]
      })
      searchOffset = pageIndex + page.length
    }
  }

  // Username facet (appears after page name in template)
  if (userUrl) {
    const nameIndex = text.indexOf(name, searchOffset)
    if (nameIndex !== -1) {
      const byteStart = Buffer.byteLength(text.substring(0, nameIndex), 'utf8')
      const byteEnd = byteStart + Buffer.byteLength(name, 'utf8')
      facets.push({
        index: { byteStart, byteEnd },
        features: [{
          $type: 'app.bsky.richtext.facet#link',
          uri: userUrl
        }]
      })
    }
  }

  // Diff URL facet (raw URL in text)
  const urlPattern = /https?:\/\/[^\s]+/g
  let match
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0]
    const byteStart = Buffer.byteLength(text.substring(0, match.index), 'utf8')
    const byteEnd = byteStart + Buffer.byteLength(url, 'utf8')
    facets.push({
      index: { byteStart, byteEnd },
      features: [{
        $type: 'app.bsky.richtext.facet#link',
        uri: url
      }]
    })
  }

  return facets
}

module.exports = { buildFacets }
