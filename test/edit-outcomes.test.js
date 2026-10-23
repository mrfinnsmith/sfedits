const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sinon = require('sinon')
const { OUTCOMES, DEFAULT_OUTCOMES_PATH, recordOutcome, readOutcomes } = require('../lib/edit-outcomes')

const EDIT = {
  page: 'Gavin Newsom',
  url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=122'
}

describe('edit-outcomes', function() {
  let dir, file, errorStub

  beforeEach(function() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-outcomes-test-'))
    file = path.join(dir, 'edit-outcomes.jsonl')
    errorStub = sinon.stub(console, 'error')
  })

  afterEach(function() {
    errorStub.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('exports the seven known outcomes and a default path under data/', function() {
    assert.deepEqual(OUTCOMES, [
      'posted', 'pii_blocked', 'wrong_page', 'no_diff_text',
      'screening_error', 'screenshot_failed', 'post_failed'
    ])
    assert.match(DEFAULT_OUTCOMES_PATH, /data[\\/]edit-outcomes\.jsonl$/)
  })

  it('writes the expected shape with rev_id as an integer and lang from the URL', function() {
    recordOutcome(EDIT, 'posted', null, file)
    const [row] = readOutcomes(file)
    assert.deepEqual(Object.keys(row).sort(), ['detail', 'diff_url', 'lang', 'outcome', 'page', 'rev_id', 'time'])
    assert.strictEqual(row.lang, 'en')
    assert.strictEqual(row.page, 'Gavin Newsom')
    assert.strictEqual(row.diff_url, EDIT.url)
    assert.strictEqual(row.rev_id, 123)
    assert.isNull(row.detail)
    assert.strictEqual(row.outcome, 'posted')
    assert.strictEqual(new Date(row.time).toISOString(), row.time)
  })

  it('stores the detail text when given', function() {
    recordOutcome(EDIT, 'screening_error', 'timeout after 10s', file)
    assert.strictEqual(readOutcomes(file)[0].detail, 'timeout after 10s')
  })

  it('records the revision for a page-creation URL', function() {
    recordOutcome({ page: 'X', url: 'https://fr.wikipedia.org/w/index.php?oldid=77' }, 'wrong_page', null, file)
    const [row] = readOutcomes(file)
    assert.strictEqual(row.lang, 'fr')
    assert.strictEqual(row.rev_id, 77)
  })

  it('stores rev_id as null when the URL has no revision', function() {
    recordOutcome({ page: 'X', url: 'https://en.wikipedia.org/w/index.php?title=X' }, 'no_diff_text', null, file)
    assert.isNull(readOutcomes(file)[0].rev_id)
  })

  it('rejects an unknown outcome: logs an error and writes nothing', function() {
    recordOutcome(EDIT, 'exploded', null, file)
    assert.isFalse(fs.existsSync(file))
    assert.isTrue(errorStub.calledOnce)
    assert.include(errorStub.firstCall.args[0], 'exploded')
  })

  it('never throws when the path cannot be written', function() {
    const bad = path.join(dir, 'no-such-dir', 'edit-outcomes.jsonl')
    assert.doesNotThrow(() => recordOutcome(EDIT, 'posted', null, bad))
    assert.isTrue(errorStub.calledOnce)
  })

  it('readOutcomes returns [] for a missing file', function() {
    assert.deepEqual(readOutcomes(file), [])
  })

  it('appends in call order', function() {
    recordOutcome(EDIT, 'posted', null, file)
    recordOutcome(EDIT, 'pii_blocked', null, file)
    assert.deepEqual(readOutcomes(file).map(r => r.outcome), ['posted', 'pii_blocked'])
  })
})
