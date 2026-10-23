const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { appendJsonl, readJsonl } = require('../lib/jsonl-log')

describe('jsonl-log', function() {
  let dir, file

  beforeEach(function() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-log-test-'))
    file = path.join(dir, 'log.jsonl')
  })

  afterEach(function() {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('appendJsonl', function() {
    it('creates the file and appends one JSON line per call', function() {
      appendJsonl(file, { n: 1 })
      appendJsonl(file, { n: 2 })
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n')
    })

    it('trims to the newer half of lines once the file reaches the limit', function() {
      const lines = []
      for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ i, pad: 'x'.repeat(20) }))
      fs.writeFileSync(file, lines.join('\n') + '\n')
      const size = fs.statSync(file).size

      appendJsonl(file, { i: 10 }, size)

      const kept = readJsonl(file).map(e => e.i)
      assert.deepEqual(kept, [5, 6, 7, 8, 9, 10])
      assert.isTrue(fs.readFileSync(file, 'utf8').endsWith('\n'))
    })

    it('does not trim a file below the limit', function() {
      fs.writeFileSync(file, '{"i":0}\n{"i":1}\n')
      appendJsonl(file, { i: 2 }, 1024)
      assert.deepEqual(readJsonl(file).map(e => e.i), [0, 1, 2])
    })

    it('leaves no temp files behind after a trim', function() {
      fs.writeFileSync(file, '{"i":0}\n{"i":1}\n{"i":2}\n{"i":3}\n')
      appendJsonl(file, { i: 4 }, 10)
      assert.deepEqual(fs.readdirSync(dir), ['log.jsonl'])
    })

    it('throws when the file cannot be written', function() {
      const bad = path.join(dir, 'missing-dir', 'log.jsonl')
      assert.throws(() => appendJsonl(bad, { n: 1 }))
    })
  })

  describe('readJsonl', function() {
    it('returns [] when the file does not exist', function() {
      assert.deepEqual(readJsonl(file), [])
    })

    it('skips blank and malformed lines', function() {
      fs.writeFileSync(file, '{"a":1}\n\n   \n{not json\n{"a":2}\n')
      assert.deepEqual(readJsonl(file), [{ a: 1 }, { a: 2 }])
    })

    it('round-trips objects written by appendJsonl', function() {
      appendJsonl(file, { outcome: 'posted', rev_id: 42 })
      assert.deepEqual(readJsonl(file), [{ outcome: 'posted', rev_id: 42 }])
    })
  })
})
