const puppeteer = require('puppeteer')
const path = require('path')
const { appendJsonl } = require('./jsonl-log')

const MAX_SCREENSHOT_HEIGHT = 5000
const DIFF_SELECTOR = 'table.diff.diff-type-table'
const LOG_FILE = path.join(__dirname, '..', 'data', 'screenshot-failures.log')
const MAX_LOG_BYTES = 1024 * 1024 // 1MB

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--font-render-hinting=none'
]

/**
 * Take screenshot of Wikipedia diff
 * Tries full diff first; if capture fails, trims context rows and retries.
 * Resolves { file, reason }: file is the path (reason null), or file is null with the failure reason.
 */
async function takeScreenshotWithReason(url) {
  const filename = path.resolve(Date.now() + '.png')

  const browser = await puppeteer.launch({
    args: CHROME_ARGS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

    const element = await page.$(DIFF_SELECTOR)
    if (!element) {
      return failure(url, 'element_not_found', 'Diff table element not found')
    }

    const box = await element.boundingBox()
    if (!box) {
      return failure(url, 'bounding_box_null', 'Bounding box is null')
    }

    // Trim rows that exceed MAX_SCREENSHOT_HEIGHT
    let clipBox = box
    if (box.height > MAX_SCREENSHOT_HEIGHT) {
      clipBox = await trimToMaxHeight(page, element)
      if (!clipBox) {
        return failure(url, 'trim_height_failed', `Diff too tall (${Math.round(box.height)}px), trim failed`)
      }
    }

    // Try capturing the full diff
    const result = await captureScreenshot(page, filename, clipBox)
    if (result) return { file: filename, reason: null }

    // Full capture failed - trim context rows and retry
    console.log('[takeScreenshot] Full capture failed, trimming context and retrying...')
    const trimmedBox = await trimContextRows(page, element)
    if (!trimmedBox) {
      return failure(url, 'trim_context_failed', 'No content remained after trimming context rows')
    }

    const retryResult = await captureScreenshot(page, filename, trimmedBox)
    if (retryResult) return { file: filename, reason: null }

    return failure(url, 'capture_failed_after_trim', `Screenshot failed on both attempts (original: ${Math.round(clipBox.height)}px, trimmed: ${Math.round(trimmedBox.height)}px)`)
  } catch (error) {
    return failure(url, 'exception', error.message)
  } finally {
    await browser.close()
  }
}

/**
 * Take screenshot of Wikipedia diff.
 * Returns filename path or null if screenshot fails.
 */
async function takeScreenshot(url) {
  return (await takeScreenshotWithReason(url)).file
}

/**
 * Log a failure and build the failed result
 */
function failure(url, reason, details) {
  logFailure(url, reason, details)
  return { file: null, reason: details }
}

/**
 * Attempt a screenshot with dynamic viewport and captureBeyondViewport: false
 * Returns true on success, false on failure
 */
async function captureScreenshot(page, filename, clipBox) {
  try {
    await page.setViewport({
      width: 1200,
      height: Math.ceil(clipBox.y + clipBox.height)
    })
    await page.screenshot({
      path: filename,
      clip: clipBox,
      captureBeyondViewport: false
    })
    return true
  } catch (error) {
    console.error(`[takeScreenshot] Capture failed: ${error.message}`)
    return false
  }
}

/**
 * Remove context-only rows from the diff table, keeping 1 row of context
 * above and below each changed row. Returns new bounding box or null.
 */
async function trimContextRows(page, element) {
  await page.evaluate((selector) => {
    const table = document.querySelector(selector)
    if (!table) return

    const rows = Array.from(table.querySelectorAll('tr'))

    const isChange = rows.map(r =>
      r.querySelector('td.diff-addedline') !== null ||
      r.querySelector('td.diff-deletedline') !== null
    )

    const keep = rows.map((r, i) => {
      if (r.classList.contains('diff-title')) return true
      if (r.querySelector('td.diff-lineno')) return true
      if (isChange[i]) return true
      if (i > 0 && isChange[i - 1]) return true
      if (i < rows.length - 1 && isChange[i + 1]) return true
      return false
    })

    rows.forEach((r, i) => { if (!keep[i]) r.remove() })
  }, DIFF_SELECTOR)

  const box = await element.boundingBox()
  return box && box.height > 0 ? box : null
}

/**
 * Trim rows that push the diff beyond MAX_SCREENSHOT_HEIGHT
 * Returns new bounding box or null.
 */
async function trimToMaxHeight(page, element) {
  await page.evaluate((selector, maxH) => {
    const table = document.querySelector(selector)
    if (!table) return
    const tableTop = table.getBoundingClientRect().top
    const rows = table.querySelectorAll('tr')
    let removing = false
    for (const row of rows) {
      if (removing) {
        row.remove()
        continue
      }
      const rowBottom = row.getBoundingClientRect().bottom - tableTop
      if (rowBottom > maxH) {
        removing = true
        row.remove()
      }
    }
  }, DIFF_SELECTOR, MAX_SCREENSHOT_HEIGHT)

  const box = await element.boundingBox()
  return box && box.height > 0 ? box : null
}

/**
 * Log screenshot failure to data/screenshot-failures.log
 */
function logFailure(url, reason, details) {
  console.error(`[takeScreenshot] Failed: ${reason} - ${details}`)

  const entry = {
    timestamp: new Date().toISOString(),
    url,
    reason,
    details
  }

  try {
    appendJsonl(LOG_FILE, entry, MAX_LOG_BYTES)
  } catch (err) {
    console.error('[takeScreenshot] Failed to write log:', err.message)
  }
}

module.exports = {
  takeScreenshot,
  takeScreenshotWithReason
}
