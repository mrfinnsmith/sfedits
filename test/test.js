const fs = require('fs')
const pageWatch = require('../page-watch')
const { assert } = require('chai')

describe('page-watch', function() {

 describe('getStatus', function() {
   it('works', function() {
     const edit = {page: 'Foo', url: 'http://example.com'}
     const name = 'Bar'
     const template = "{{page}} edited by {{name}} {{&url}}"
     const result = pageWatch.getStatus(edit, name, template)
     assert.equal('Foo edited by Bar http://example.com', result.text)
   })
 })

 describe('takeScreenshot', function() {
   it('works', function(done) {
     this.timeout(20000)
     const url = 'https://en.wikipedia.org/w/index.php?diff=1045445516&oldid=1044483280'
     pageWatch.takeScreenshot(url).then(function(path) {
       fs.stat(path, (err, stat) => {
         assert.isNull(err)
         assert.isTrue(stat.size > 0)
         fs.unlink(path, done)
       })
     })
   })
 })

})