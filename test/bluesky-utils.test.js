/**
 * Direct unit tests for lib/bluesky-utils.js
 *
 * These tests import and test the module directly (not through page-watch.js)
 * to ensure the extracted code works independently.
 */

const { describe, it } = require('mocha')
const { assert } = require('chai')
const { buildFacets } = require('../lib/bluesky-utils')

describe('lib/bluesky-utils', function() {
  describe('buildFacets()', function() {
    it('creates facet for article name with correct byte offsets', function() {
      const text = 'Cat edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        'Cat',
        'User',
        'https://en.wikipedia.org/wiki/Cat',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have 3 facets: page name, username, diff URL
      assert.equal(facets.length, 3)

      // First facet should be for "Cat"
      const catFacet = facets[0]
      assert.equal(catFacet.index.byteStart, 0)
      assert.equal(catFacet.index.byteEnd, 3)
      assert.equal(catFacet.features[0].$type, 'app.bsky.richtext.facet#link')
      assert.equal(catFacet.features[0].uri, 'https://en.wikipedia.org/wiki/Cat')
    })

    it('creates facet for username with correct byte offsets', function() {
      const text = 'Article edited by TestUser https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        'TestUser',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/TestUser'
      )

      // Second facet should be for "TestUser"
      const userFacet = facets[1]
      const expectedStart = Buffer.byteLength('Article edited by ', 'utf8')
      const expectedEnd = expectedStart + Buffer.byteLength('TestUser', 'utf8')

      assert.equal(userFacet.index.byteStart, expectedStart)
      assert.equal(userFacet.index.byteEnd, expectedEnd)
      assert.equal(userFacet.features[0].uri, 'https://en.wikipedia.org/wiki/Special:Contributions/TestUser')
    })

    it('creates facet for diff URL with correct byte offsets', function() {
      const text = 'Article edited by User https://en.wikipedia.org/w/index.php?diff=123'
      const facets = buildFacets(
        text,
        'Article',
        'User',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Third facet should be for the diff URL
      const urlFacet = facets[2]
      const urlStart = text.indexOf('https://en.wikipedia.org/w/')
      const expectedStart = Buffer.byteLength(text.substring(0, urlStart), 'utf8')
      const expectedEnd = expectedStart + Buffer.byteLength('https://en.wikipedia.org/w/index.php?diff=123', 'utf8')

      assert.equal(urlFacet.index.byteStart, expectedStart)
      assert.equal(urlFacet.index.byteEnd, expectedEnd)
      assert.equal(urlFacet.features[0].uri, 'https://en.wikipedia.org/w/index.php?diff=123')
    })

    it('handles multi-byte UTF-8 characters correctly', function() {
      // Japanese article name: 日本
      const text = '日本 edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        '日本',
        'User',
        'https://ja.wikipedia.org/wiki/日本',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // First facet for 日本
      const pageFacet = facets[0]
      assert.equal(pageFacet.index.byteStart, 0)
      // 日本 is 6 bytes in UTF-8 (3 bytes per character)
      assert.equal(pageFacet.index.byteEnd, 6)
      assert.equal(pageFacet.features[0].uri, 'https://ja.wikipedia.org/wiki/日本')

      // Username facet should start after 日本 + " edited by "
      const userFacet = facets[1]
      const expectedUserStart = Buffer.byteLength('日本 edited by ', 'utf8')
      assert.equal(userFacet.index.byteStart, expectedUserStart)
    })

    it('handles emoji characters correctly in byte offsets', function() {
      // Flag emoji after IP address (geolocation enrichment case)
      const text = 'Article edited by 8.8.8.8 [🇺🇸] https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        '8.8.8.8 [🇺🇸]',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/8.8.8.8'
      )

      // Username facet should handle emoji correctly
      const userFacet = facets[1]
      const expectedStart = Buffer.byteLength('Article edited by ', 'utf8')
      // 🇺🇸 flag emoji is 8 bytes in UTF-8
      const expectedEnd = expectedStart + Buffer.byteLength('8.8.8.8 [🇺🇸]', 'utf8')

      assert.equal(userFacet.index.byteStart, expectedStart)
      assert.equal(userFacet.index.byteEnd, expectedEnd)
    })

    it('returns empty array when page URL is null', function() {
      const text = 'Article edited by User https://example.com/diff'
      const facets = buildFacets(text, 'Article', 'User', null, null)

      // Should only have URL facet (no page or user facets)
      assert.equal(facets.length, 1)
      assert.include(facets[0].features[0].uri, 'https://example.com/diff')
    })

    it('skips page facet if page name not found in text', function() {
      const text = 'Something edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article', // Not in text
        'User',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have user facet and URL facet, but not page facet
      assert.equal(facets.length, 2)
      assert.notEqual(facets[0].features[0].uri, 'https://en.wikipedia.org/wiki/Article')
    })

    it('skips user facet if username not found in text', function() {
      const text = 'Article edited by SomeoneElse https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        'User', // Not in text
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have page facet and URL facet, but not user facet
      assert.equal(facets.length, 2)
      const uris = facets.map(f => f.features[0].uri)
      assert.notInclude(uris, 'https://en.wikipedia.org/wiki/Special:Contributions/User')
    })

    it('handles multiple URLs in text', function() {
      const text = 'Article edited by User https://example.com/diff https://example.com/another'
      const facets = buildFacets(
        text,
        'Article',
        'User',
        'https://en.wikipedia.org/wiki/Article',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      // Should have page, user, and TWO URL facets
      assert.equal(facets.length, 4)
      assert.equal(facets[2].features[0].uri, 'https://example.com/diff')
      assert.equal(facets[3].features[0].uri, 'https://example.com/another')
    })

    it('preserves facet order: page, user, then URLs', function() {
      const text = 'TestPage edited by TestUser https://example.com/1 https://example.com/2'
      const facets = buildFacets(
        text,
        'TestPage',
        'TestUser',
        'https://en.wikipedia.org/wiki/TestPage',
        'https://en.wikipedia.org/wiki/Special:Contributions/TestUser'
      )

      assert.equal(facets.length, 4)
      assert.include(facets[0].features[0].uri, 'TestPage')
      assert.include(facets[1].features[0].uri, 'TestUser')
      assert.include(facets[2].features[0].uri, 'https://example.com/1')
      assert.include(facets[3].features[0].uri, 'https://example.com/2')
    })

    it('handles real Wikipedia diff URL format', function() {
      const text = 'Cat edited by User https://en.wikipedia.org/w/index.php?title=Cat&diff=123&oldid=456'
      const facets = buildFacets(
        text,
        'Cat',
        'User',
        'https://en.wikipedia.org/wiki/Cat',
        'https://en.wikipedia.org/wiki/Special:Contributions/User'
      )

      const urlFacet = facets.find(f => f.features[0].uri.includes('diff=123'))
      assert.exists(urlFacet)
      assert.equal(urlFacet.features[0].uri, 'https://en.wikipedia.org/w/index.php?title=Cat&diff=123&oldid=456')
    })

    it('returns correct facet structure with $type field', function() {
      const text = 'Article edited by User https://example.com/diff'
      const facets = buildFacets(
        text,
        'Article',
        'User',
        'https://en.wikipedia.org/wiki/Article',
        null
      )

      // Verify facet structure matches Bluesky spec
      const pageFacet = facets[0]
      assert.hasAllKeys(pageFacet, ['index', 'features'])
      assert.hasAllKeys(pageFacet.index, ['byteStart', 'byteEnd'])
      assert.isArray(pageFacet.features)
      assert.equal(pageFacet.features[0].$type, 'app.bsky.richtext.facet#link')
      assert.property(pageFacet.features[0], 'uri')
    })
  })
})
