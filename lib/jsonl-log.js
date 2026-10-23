const fs = require('fs')

// Append-only JSON Lines files with a size cap. When a file reaches maxBytes,
// the older half of its lines is dropped before the new entry is appended.

function appendJsonl(file, obj, maxBytes = 1024 * 1024) {
  trimIfNeeded(file, maxBytes)
  fs.appendFileSync(file, JSON.stringify(obj) + '\n')
}

function trimIfNeeded(file, maxBytes) {
  let size
  try {
    size = fs.statSync(file).size
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (size < maxBytes) return

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const keep = lines.slice(Math.floor(lines.length / 2))
  replaceFile(file, keep.map(line => line + '\n').join(''))
}

// Write to a temp file beside the target, then rename over it. rename is atomic
// on one filesystem, so a concurrent reader sees either the old or the new file.
function replaceFile(file, contents) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, contents)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

// Parsed objects in file order. Blank and malformed lines are skipped.
function readJsonl(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A partial or corrupt line should not hide the rest of the log.
    }
  }
  return entries
}

module.exports = {
  appendJsonl,
  readJsonl
}
