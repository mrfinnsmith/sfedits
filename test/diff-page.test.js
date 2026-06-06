const { describe, it } = require('mocha')
const { assert } = require('chai')
const { extractPageName, normalizePage, verifyDiffPage } = require('../lib/diff-page')

// Minimal stand-ins for the mw.config block Wikipedia embeds in diff pages.
function html(wgPageName) {
  return `<!DOCTYPE html><html><head><script>
    document.documentElement.className="client-js";
    RLCONF={"wgPageName":"${wgPageName}","wgNamespaceNumber":0};
  </script></head><body></body></html>`
}

describe('diff-page', function() {
  describe('extractPageName', function() {
    it('reads wgPageName and converts underscores to spaces', function() {
      assert.equal(extractPageName(html('Scott_Wiener')), 'Scott Wiener')
    })

    it('handles prefixed (non-article-namespace) titles', function() {
      assert.equal(
        extractPageName(html('Wikipedia:Articles_for_deletion\\/Roza_Gough')),
        'Wikipedia:Articles for deletion/Roza Gough'
      )
    })

    it('decodes unicode escapes in the title', function() {
      assert.equal(extractPageName(html('Caf\\u00e9')), 'Café')
    })

    it('returns null when wgPageName is absent', function() {
      assert.isNull(extractPageName('<html><body>no config here</body></html>'))
    })

    it('returns null for empty input', function() {
      assert.isNull(extractPageName(''))
    })
  })

  describe('normalizePage', function() {
    it('treats underscores and spaces as equivalent', function() {
      assert.equal(normalizePage('San_Francisco'), normalizePage('San Francisco'))
    })
  })

  describe('verifyDiffPage', function() {
    it('matches when the diff page equals the expected page', function() {
      const result = verifyDiffPage(html('Scott_Wiener'), 'Scott Wiener')
      assert.isTrue(result.match)
      assert.equal(result.actualPage, 'Scott Wiener')
    })

    it('flags the splice bug: expected page differs from the diff page', function() {
      // The real-world failure: title "Scott Wiener" spliced onto the
      // Roza Gough AfD diff by the IRC feed parser.
      const result = verifyDiffPage(
        html('Wikipedia:Articles_for_deletion\\/Roza_Gough'),
        'Scott Wiener'
      )
      assert.isFalse(result.match)
      assert.equal(result.actualPage, 'Wikipedia:Articles for deletion/Roza Gough')
    })

    it('fails open when the page cannot be determined', function() {
      const result = verifyDiffPage('<html>garbage</html>', 'Scott Wiener')
      assert.isTrue(result.match)
      assert.isNull(result.actualPage)
    })
  })
})
