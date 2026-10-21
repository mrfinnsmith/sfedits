#!/usr/bin/env node

/**
 * Smoke test for the screenshot path: takes a real screenshot of a known
 * Wikipedia diff through lib/screenshot.js and checks the result is a PNG.
 *
 * Runs inside the bot and admin Docker images (the chrome-test workflow
 * bind-mounts it into /opt/sfedits), so lib/ is resolved from the working
 * directory first, with the repo layout as a fallback.
 *
 * Usage: node scripts/screenshot-check.js [diff-url]
 * Exit 0 only if a non-empty PNG was produced.
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_URL = 'https://en.wikipedia.org/w/index.php?diff=1381077658&oldid=1380002958'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function loadTakeScreenshot() {
  const candidates = [
    path.join(process.cwd(), 'lib', 'screenshot.js'),
    path.join(__dirname, '..', 'lib', 'screenshot.js')
  ]
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) throw new Error('lib/screenshot.js not found in: ' + candidates.join(', '))
  return require(found).takeScreenshot
}

function checkPng(file) {
  if (!fs.existsSync(file)) return 'returned path does not exist: ' + file
  const buf = fs.readFileSync(file)
  if (buf.length === 0) return 'file is empty'
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'file is not a PNG (bad magic bytes)'
  }
  return null
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  const takeScreenshot = loadTakeScreenshot()
  console.log('Screenshotting ' + url)

  const file = await takeScreenshot(url)
  if (!file) throw new Error('takeScreenshot returned no file')

  try {
    const problem = checkPng(file)
    if (problem) throw new Error(problem)
    console.log('OK: ' + fs.statSync(file).size + ' byte PNG')
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }
}

main().catch(err => {
  console.error('FAIL: ' + (err && err.message ? err.message : err))
  process.exit(1)
})
