const { describe, it } = require('mocha')
const { assert } = require('chai')
const pageWatch = require('../page-watch')
const realWatchlist = require('../watchlist.json')

const { matchesWatchlist, channelsForConfig, checkConfig } = pageWatch

describe('watchlist matching by language subdomain code', function() {
  describe('issue #9 reproduction: matching must not depend on the display name', function() {
    it('matches an edit using the real watchlist.json even when edit.wikipedia is the old display name', function() {
      const edit = {
        wikipedia: 'Simple Wikipedia',
        channel: '#simple.wikipedia',
        page: 'Kamala Harris',
        user: 'ExampleUser',
        url: 'https://simple.wikipedia.org/w/index.php?diff=10980485&oldid=10980452'
      }

      assert.isTrue(matchesWatchlist(realWatchlist, edit))
    })
  })

  describe('failure-mode-1 wikis (wrong display name in old library)', function() {
    ;['fa', 'ms', 'sl'].forEach(function(lang) {
      it('matches a real watched title in "' + lang + '"', function() {
        const title = Object.keys(realWatchlist[lang])[0]
        const edit = {
          wikipedia: 'Some Wrong Display Name',
          channel: '#' + lang + '.wikipedia',
          page: title,
          user: 'ExampleUser',
          url: 'https://' + lang + '.wikipedia.org/w/index.php?diff=1&oldid=2'
        }

        assert.isTrue(matchesWatchlist(realWatchlist, edit))
      })
    })
  })

  describe('failure-mode-2 wikis (never joined by the hardcoded 41-channel table)', function() {
    ;['arz', 'hy', 'sr'].forEach(function(lang) {
      it('matches a real watched title in "' + lang + '"', function() {
        const title = Object.keys(realWatchlist[lang])[0]
        const edit = {
          wikipedia: 'Some Wrong Display Name',
          channel: '#' + lang + '.wikipedia',
          page: title,
          user: 'ExampleUser',
          url: 'https://' + lang + '.wikipedia.org/w/index.php?diff=1&oldid=2'
        }

        assert.isTrue(matchesWatchlist(realWatchlist, edit))
      })
    })

    it('matches a real watched title in "zh-yue" (hyphenated language code)', function() {
      const title = Object.keys(realWatchlist['zh-yue'])[0]
      const edit = {
        wikipedia: 'Some Wrong Display Name',
        channel: '#zh-yue.wikipedia',
        page: title,
        user: 'ExampleUser',
        url: 'https://zh-yue.wikipedia.org/w/index.php?diff=1&oldid=2'
      }

      assert.isTrue(matchesWatchlist(realWatchlist, edit))
    })
  })

  describe('negative cases', function() {
    it('returns false for an unwatched page on a watched wiki', function() {
      const edit = {
        wikipedia: 'Simple Wikipedia',
        channel: '#simple.wikipedia',
        page: 'This Page Is Definitely Not Watched XYZ123',
        user: 'ExampleUser',
        url: 'https://simple.wikipedia.org/w/index.php?diff=1&oldid=2'
      }

      assert.isFalse(matchesWatchlist(realWatchlist, edit))
    })

    it('returns false for a watched page title on an unwatched language', function() {
      const title = Object.keys(realWatchlist['simple'])[0]
      const edit = {
        wikipedia: 'Not A Real Wikipedia',
        channel: '#zz.wikipedia',
        page: title,
        user: 'ExampleUser',
        url: 'https://zz.wikipedia.org/w/index.php?diff=1&oldid=2'
      }

      assert.isFalse(matchesWatchlist(realWatchlist, edit))
    })

    it('does not match Object.prototype member names as page titles', function() {
      ;['constructor', 'hasOwnProperty', 'toString', '__proto__', 'valueOf'].forEach(function(page) {
        const edit = {
          page: page,
          user: 'ExampleUser',
          url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2'
        }
        assert.isFalse(matchesWatchlist(realWatchlist, edit), page)
      })
    })

    it('does not match Object.prototype member names as language codes', function() {
      const edit = {
        page: 'name',
        user: 'ExampleUser',
        url: 'https://constructor.wikipedia.org/w/index.php?diff=1&oldid=2'
      }
      assert.isFalse(matchesWatchlist(realWatchlist, edit))
    })

    it('returns false without throwing when url is undefined', function() {
      const edit = {
        wikipedia: 'Simple Wikipedia',
        channel: '#simple.wikipedia',
        page: Object.keys(realWatchlist['simple'])[0],
        user: 'ExampleUser',
        url: undefined
      }

      assert.doesNotThrow(function() {
        assert.isFalse(matchesWatchlist(realWatchlist, edit))
      })
    })

    it('returns false without throwing when url is not a url', function() {
      const edit = {
        wikipedia: 'Simple Wikipedia',
        channel: '#simple.wikipedia',
        page: Object.keys(realWatchlist['simple'])[0],
        user: 'ExampleUser',
        url: 'not a url'
      }

      assert.doesNotThrow(function() {
        assert.isFalse(matchesWatchlist(realWatchlist, edit))
      })
    })
  })

  describe('channelsForConfig', function() {
    it('returns one channel per language in the real watchlist and includes expected wikis', function() {
      const config = { accounts: [{ watchlist: realWatchlist }] }
      const channels = channelsForConfig(config)

      assert.equal(channels.length, 49)
      assert.include(channels, '#simple.wikipedia')
      assert.include(channels, '#arz.wikipedia')
      assert.include(channels, '#hy.wikipedia')
      assert.include(channels, '#zh-yue.wikipedia')
    })
  })

  describe('checkConfig validates watchlist keys are reachable language codes', function() {
    it('errors and names the offending key for a display-name watchlist key', function(done) {
      const config = {
        nick: 'testbot',
        accounts: [{
          template: 'test',
          watchlist: { 'English Wikipedia': { 'X': true } }
        }]
      }

      pageWatch.checkConfig(config, function(err) {
        try {
          assert.isOk(err)
          assert.include(String(err), 'English Wikipedia')
          done()
        } catch (e) {
          done(e)
        }
      })
    })

    it('passes for a watchlist keyed by valid language subdomain codes', function(done) {
      const config = {
        nick: 'testbot',
        accounts: [{
          template: 'test',
          watchlist: {
            en: { 'X': true },
            'zh-yue': { 'Y': true }
          }
        }]
      }

      pageWatch.checkConfig(config, function(err) {
        try {
          assert.isNotOk(err)
          done()
        } catch (e) {
          done(e)
        }
      })
    })

    it('still errors when the resolved watchlist is empty', function(done) {
      const config = {
        nick: 'testbot',
        accounts: [{ template: 'test', watchlist: {} }]
      }

      pageWatch.checkConfig(config, function(err) {
        try {
          assert.isOk(err)
          assert.match(String(err), /watchlist/i)
          done()
        } catch (e) {
          done(e)
        }
      })
    })
  })
})
