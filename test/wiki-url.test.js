const { describe, it } = require('mocha')
const { assert } = require('chai')
const { revisionIdFromDiffUrl, buildDiffUrl } = require('../lib/wiki-url')

describe('revisionIdFromDiffUrl', function() {
  it('reads the revision from a numeric diff parameter', function() {
    assert.strictEqual(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=123&oldid=122'), 123)
  })

  it('reads the revision from oldid when diff=prev', function() {
    assert.strictEqual(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=prev&oldid=456'), 456)
  })

  it('reads the revision from oldid alone (page creation)', function() {
    assert.strictEqual(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?oldid=789'), 789)
  })

  it('returns null when diff and oldid are both absent', function() {
    assert.isNull(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?title=Foo'))
  })

  it('returns null when diff=prev has no oldid', function() {
    assert.isNull(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=prev'))
  })

  it('returns null for diff=next, which names the revision after oldid', function() {
    assert.isNull(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=next&oldid=100'))
  })

  it('returns null for a non-numeric diff or oldid', function() {
    assert.isNull(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?diff=abc&oldid=100'))
    assert.isNull(revisionIdFromDiffUrl('https://en.wikipedia.org/w/index.php?oldid=12x'))
  })

  it('returns null for a malformed URL', function() {
    assert.isNull(revisionIdFromDiffUrl('not a url'))
    assert.isNull(revisionIdFromDiffUrl(undefined))
  })
})

describe('buildDiffUrl', function() {
  it('builds the diff form when a parent revision exists', function() {
    assert.strictEqual(
      buildDiffUrl('en', 123, 122),
      'https://en.wikipedia.org/w/index.php?diff=123&oldid=122'
    )
  })

  it('builds the oldid form for page creation (parentid 0)', function() {
    assert.strictEqual(buildDiffUrl('fr', 55, 0), 'https://fr.wikipedia.org/w/index.php?oldid=55')
  })

  it('builds the oldid form when parentid is null or undefined', function() {
    assert.strictEqual(buildDiffUrl('de', 9, null), 'https://de.wikipedia.org/w/index.php?oldid=9')
    assert.strictEqual(buildDiffUrl('de', 9), 'https://de.wikipedia.org/w/index.php?oldid=9')
  })

  it('round-trips through revisionIdFromDiffUrl', function() {
    assert.strictEqual(revisionIdFromDiffUrl(buildDiffUrl('en', 321, 320)), 321)
    assert.strictEqual(revisionIdFromDiffUrl(buildDiffUrl('en', 321, 0)), 321)
  })
})
