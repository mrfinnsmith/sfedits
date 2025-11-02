const puppeteer = require('puppeteer')
const path = require('path')

/**
 * Take screenshot of Wikipedia diff
 * Returns filename path or null if screenshot fails
 */
async function takeScreenshot(url) {
  const filename = path.resolve(Date.now() + '.png')
  console.log(`[takeScreenshot] Starting for URL: ${url}`)

  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--font-render-hinting=none'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  })
  console.log(`[takeScreenshot] Browser launched`)

  try {
    const page = await browser.newPage()
    console.log(`[takeScreenshot] Page created`)
    await page.setViewport({ width: 1200, height: 800 })
    console.log(`[takeScreenshot] Viewport set, navigating to URL...`)
    await page.goto(url, { waitUntil: 'networkidle0' })
    console.log(`[takeScreenshot] Page navigation complete`)

    console.log(`[takeScreenshot] Looking for diff table element...`)
    const element = await page.$('table.diff.diff-type-table.diff-contentalign-left')
    console.log(`[takeScreenshot] Element found: ${!!element}`)
    if (element) {
      console.log(`[takeScreenshot] Getting bounding box...`)
      const box = await element.boundingBox()
      console.log(`[takeScreenshot] Bounding box: ${box ? JSON.stringify(box) : 'null'}`)
      if (box) {
        console.log(`[takeScreenshot] Taking screenshot...`)
        await page.screenshot({
          path: filename,
          clip: box
        })
        console.log(`[takeScreenshot] Screenshot saved to: ${filename}`)
        return filename
      } else {
        console.error(`[takeScreenshot] Bounding box is null`)
      }
    } else {
      console.error(`[takeScreenshot] Diff table element not found`)
    }
  } catch (error) {
    console.error(`[takeScreenshot] Error at step: ${error.stack || error.message}`)
    // Return null instead of throwing - caller decides what to do
  } finally {
    console.log(`[takeScreenshot] Closing browser...`)
    await browser.close()
    console.log(`[takeScreenshot] Browser closed`)
  }

  console.log(`[takeScreenshot] Returning null`)
  return null
}

module.exports = {
  takeScreenshot
}
