const puppeteer = require('puppeteer')
const path = require('path')

/**
 * Take screenshot of Wikipedia diff
 * Returns filename path or null if screenshot fails
 */
async function takeScreenshot(url) {
  const filename = path.resolve(Date.now() + '.png')

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

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(url, { waitUntil: 'networkidle0' })

    const element = await page.$('table.diff.diff-type-table.diff-contentalign-left')
    if (element) {
      const box = await element.boundingBox()
      await page.screenshot({
        path: filename,
        clip: box
      })
      return filename
    }
  } catch (error) {
    console.error('Screenshot error:', error.message)
    // Return null instead of throwing - caller decides what to do
  } finally {
    await browser.close()
  }

  return null
}

module.exports = {
  takeScreenshot
}
