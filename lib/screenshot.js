const puppeteer = require('puppeteer')
const path = require('path')

const MAX_SCREENSHOT_HEIGHT = 5000

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
        let clipBox = box
        if (box.height > MAX_SCREENSHOT_HEIGHT) {
          console.log(`[takeScreenshot] Diff too tall (${Math.round(box.height)}px), trimming DOM to fit within ${MAX_SCREENSHOT_HEIGHT}px`)
          await page.evaluate((maxH) => {
            const table = document.querySelector('table.diff.diff-type-table.diff-contentalign-left')
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
          }, MAX_SCREENSHOT_HEIGHT)
          const trimmedBox = await element.boundingBox()
          console.log(`[takeScreenshot] Trimmed bounding box: ${trimmedBox ? JSON.stringify(trimmedBox) : 'null'}`)
          if (trimmedBox) {
            clipBox = trimmedBox
          }
        }
        console.log(`[takeScreenshot] Taking screenshot...`)
        await page.screenshot({
          path: filename,
          clip: clipBox
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
