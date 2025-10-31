const fs = require('fs')
const { getStatus } = require('../page-watch')
const { takeScreenshot } = require('../lib/screenshot')
const { assert } = require('chai')

describe('page-watch', function() {

 describe('getStatus', function() {
   it('works', function() {
     const edit = {page: 'Foo', url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'}
     const name = 'Bar'
     const template = "{{page}} edited by {{name}} {{&url}}"
     const result = getStatus(edit, name, template)
     assert.equal('Foo edited by Bar https://en.wikipedia.org/w/index.php?diff=123&oldid=456', result.text)
   })
 })

 describe('takeScreenshot', function() {
   it.skip('works (requires Chrome/Puppeteer)', function(done) {
     // This test requires Chrome to be installed via Puppeteer
     // Skip by default to avoid test failures on machines without Chrome
     // Uncomment and run manually when testing screenshot functionality
     this.timeout(20000)
     const url = 'https://en.wikipedia.org/w/index.php?diff=1045445516&oldid=1044483280'
     takeScreenshot(url).then(function(path) {
       fs.stat(path, (err, stat) => {
         assert.isNull(err)
         assert.isTrue(stat.size > 0)
         fs.unlink(path, done)
       })
     })
   })
 })

})