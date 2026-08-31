const { describe, it } = require('mocha')
const { assert } = require('chai')
const { parseMessage, langFromChannel, channelForLang, WikiChanges } = require('../lib/wiki-changes')

// Builds a raw wikimedia IRC message string that satisfies the regex used by
// parseMessage (copied verbatim from the old wikichanges library). Verified
// against the exact regex with a standalone node script before use here.
function buildRawMessage({ page, flag = '', url, user, delta, comment }) {
  return '\x0314[[\x0307' + page + '\x0314]]\x034 ' + flag + '\x0310' + 'X' +
    '\x0302' + url + '\x03' + 'Y' +
    '\x0303' + user + '\x03' + 'Z' +
    '\x03 ' + delta + ' \x0310' + comment + '\x03'
}

describe('lib/wiki-changes', function() {
  describe('parseMessage', function() {
    it('parses a realistic wikimedia IRC message', function() {
      const raw = buildRawMessage({
        page: 'Kamala Harris',
        url: 'https://simple.wikipedia.org/w/index.php?diff=10980485&oldid=10980452',
        user: 'ExampleUser',
        delta: '(+25)',
        comment: 'fixed typo'
      })
      const edit = parseMessage('#simple.wikipedia', raw)

      assert.isNotNull(edit)
      assert.equal(edit.channel, '#simple.wikipedia')
      assert.equal(edit.page, 'Kamala Harris')
      assert.equal(edit.pageUrl, 'https://simple.wikipedia.org/wiki/Kamala_Harris')
      assert.equal(edit.url, 'https://simple.wikipedia.org/w/index.php?diff=10980485&oldid=10980452')
      assert.equal(edit.user, 'ExampleUser')
      assert.equal(edit.wikipedia, 'simple')
      assert.equal(edit.delta, 25)
      assert.equal(edit.comment, 'fixed typo')
      assert.isFalse(edit.anonymous)
    })

    it('marks IPv4 users as anonymous', function() {
      const raw = buildRawMessage({
        page: 'Test Page',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2',
        user: '192.168.1.1',
        delta: '(-3)',
        comment: 'removed spam'
      })
      const edit = parseMessage('#en.wikipedia', raw)

      assert.isNotNull(edit)
      assert.isTrue(edit.anonymous)
      assert.equal(edit.delta, -3)
    })

    it('marks IPv6 users as anonymous', function() {
      const raw = buildRawMessage({
        page: 'Test Page',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2',
        user: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
        delta: '(+1)',
        comment: 'edit'
      })
      const edit = parseMessage('#en.wikipedia', raw)

      assert.isNotNull(edit)
      assert.isTrue(edit.anonymous)
    })

    it('detects robot and newPage flags', function() {
      const raw = buildRawMessage({
        page: 'Test Page',
        flag: 'BN',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2',
        user: 'BotUser',
        delta: '(+1)',
        comment: 'new page created'
      })
      const edit = parseMessage('#en.wikipedia', raw)

      assert.isNotNull(edit)
      assert.equal(edit.flag, 'BN')
      assert.isTrue(edit.robot)
      assert.isTrue(edit.newPage)
    })

    it('detects unpatrolled flag', function() {
      const raw = buildRawMessage({
        page: 'Test Page',
        flag: '!',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2',
        user: 'SomeUser',
        delta: '(+1)',
        comment: 'edit'
      })
      const edit = parseMessage('#en.wikipedia', raw)

      assert.isNotNull(edit)
      assert.isTrue(edit.unpatrolled)
    })

    it('returns null delta when no delta is present in the message', function() {
      const raw = buildRawMessage({
        page: 'Test Page',
        url: 'https://en.wikipedia.org/w/index.php?diff=1&oldid=2',
        user: 'SomeUser',
        delta: 'no delta here',
        comment: 'edit'
      })
      const edit = parseMessage('#en.wikipedia', raw)

      assert.isNotNull(edit)
      assert.isNull(edit.delta)
    })

    it('returns null for garbage input that does not match the regex', function() {
      assert.isNull(parseMessage('#en.wikipedia', 'this is not a wikimedia IRC message at all'))
      assert.isNull(parseMessage('#en.wikipedia', ''))
    })
  })

  describe('langFromChannel / channelForLang', function() {
    it('round-trips simple language codes', function() {
      assert.equal(langFromChannel('#en.wikipedia'), 'en')
      assert.equal(channelForLang('en'), '#en.wikipedia')
    })

    it('round-trips hyphenated language codes like zh-yue', function() {
      assert.equal(langFromChannel('#zh-yue.wikipedia'), 'zh-yue')
      assert.equal(channelForLang('zh-yue'), '#zh-yue.wikipedia')
    })

    it('round-trips the simple English wiki code', function() {
      assert.equal(langFromChannel('#simple.wikipedia'), 'simple')
      assert.equal(channelForLang('simple'), '#simple.wikipedia')
    })
  })

  describe('WikiChanges', function() {
    it('stores the channels passed to the constructor', function() {
      const channels = ['#en.wikipedia', '#simple.wikipedia', '#zh-yue.wikipedia']
      const wc = new WikiChanges({ ircNickname: 'testbot', channels: channels })

      assert.deepEqual(wc.channels, channels)
    })
  })
})
