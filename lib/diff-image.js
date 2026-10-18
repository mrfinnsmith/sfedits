/**
 * Diff image capture orchestration
 *
 * Preferred path: fetch the structured diff from the MediaWiki compare API,
 * render our own compact HTML, and screenshot that. Produces a readable
 * image plus descriptive alt text.
 *
 * Fallback path: screenshot the live Wikipedia diff page (the original
 * behavior), with generic alt text.
 */

const { fetchCompareDiff, renderDiffHtml, buildAltText } = require('./compare-diff')
const { takeScreenshot, takeHtmlScreenshot } = require('./screenshot')

/**
 * Capture a diff image for posting.
 * @param {string} diffUrl - Wikipedia diff URL
 * @param {string} page - Article title
 * @returns {Promise<{screenshot: string, altText: string|null}|null>}
 *   Screenshot path plus alt text, or null if both paths fail.
 *   altText is null when the fallback (raw page screenshot) was used.
 */
async function captureDiffImage(diffUrl, page) {
  try {
    const diff = await fetchCompareDiff(diffUrl)
    if (diff && diff.length > 0) {
      const html = renderDiffHtml(diff, page)
      const screenshot = await takeHtmlScreenshot(html)
      if (screenshot) {
        return { screenshot, altText: buildAltText(diff, page) }
      }
    }
  } catch (error) {
    console.error(`[captureDiffImage] Compare API path failed, falling back to page screenshot: ${error.message}`)
  }

  // Fallback: screenshot the live diff page. Wait for the diff table to
  // fully render first (same delay the bot always used).
  await new Promise(r => setTimeout(r, 2000))
  const screenshot = await takeScreenshot(diffUrl)
  return screenshot ? { screenshot, altText: null } : null
}

module.exports = { captureDiffImage }
