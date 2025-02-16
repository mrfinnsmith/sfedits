const fs = require('fs')
const anon = require('./anon')
const { assert } = require('chai')

describe('anon', function() {

 describe('getStatus', function() {
   it('works', function() {
     const edit = {page: 'Foo', url: 'http://example.com'}
     const name = 'Bar'
     const template = "{{page}} edited by {{name}} {{&url}}"
     const result = anon.getStatus(edit, name, template)
     assert.equal('Foo edited by Bar http://example.com', result)
   })
 })

 describe('takeScreenshot', function() {
   it('works', function(done) {
     this.timeout(20000)
     const url = 'https://en.wikipedia.org/w/index.php?diff=1045445516&oldid=1044483280'
     anon.takeScreenshot(url).then(function(path) {
       fs.stat(path, (err, stat) => {
         assert.isNull(err)
         assert.isTrue(stat.size > 0)
         fs.unlink(path, done)
       })
     })
   })
 })

})