// Minimal replacement for the `wikichanges` npm package (issue #9). That
// library resolved wiki names and joined channels from a hardcoded 41-channel
// table, so any watched wiki outside the table was silently unreachable. Here
// the caller supplies the channel list (derived from the watchlist), the wiki
// identity is the language code in the channel name, and there is no table.
//
// The message regex is copied verbatim from wikichanges 0.2.9; it has parsed
// the production feed for years and is not worth rewriting.

const os = require('os')
const irc = require('irc')

// '#simple.wikipedia' -> 'simple'
function langFromChannel(channel) {
  return channel.replace(/^#/, '').replace(/\.wikipedia$/, '')
}

// 'simple' -> '#simple.wikipedia'
function channelForLang(lang) {
  return `#${lang}.wikipedia`
}

const MESSAGE_RE = /\x0314\[\[\x0307(.+?)\x0314\]\]\x034 (.*?)\x0310.*\x0302(.*?)\x03.+\x0303(.+?)\x03.+\x03 (.*) \x0310(.*)\x03.*/

function parseMessage(channel, msg) {
  const m = MESSAGE_RE.exec(msg)
  if (!m) {
    return null
  }

  let delta = null
  if (m[5]) {
    const deltaMatch = /([+-]\d+)/.exec(m[5])
    if (deltaMatch) {
      delta = parseInt(deltaMatch[1], 10)
    }
  }

  const user = m[4]
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(user)
  const ipv6 = /^([0-9a-fA-F]*:){7}[0-9a-fA-F]*$/.test(user)

  const flag = m[2]
  const page = m[1]
  const lang = langFromChannel(channel)
  const wikipediaUrl = `https://${channel.replace('#', '')}.org`

  return {
    channel,
    flag,
    page,
    pageUrl: `${wikipediaUrl}/wiki/${page.replace(/ /g, '_')}`,
    url: m[3],
    delta,
    comment: m[6],
    wikipedia: lang,
    user,
    userUrl: `${wikipediaUrl}/wiki/User:${user}`,
    unpatrolled: flag.includes('!'),
    newPage: flag.includes('N'),
    robot: flag.includes('B'),
    anonymous: ipv4 || ipv6
  }
}

class WikiChanges {
  constructor(opts = {}) {
    if (!Array.isArray(opts.channels) || opts.channels.length === 0) {
      throw new Error('WikiChanges requires a non-empty channels array')
    }
    this.channels = opts.channels
    this.ircNickname = opts.ircNickname || 'wikichanges-' + os.hostname()
  }

  listen(callback) {
    this.client = new irc.Client('irc.wikimedia.org', this.ircNickname, {
      channels: this.channels,
      floodProtection: true
    })

    // A colored diff line can arrive split across two IRC messages. Keep the
    // unparseable remainder per channel and try prepending it to the next
    // message, exactly as the original library did.
    const previousMessage = {}

    this.client.addListener('message', (from, to, msg) => {
      if (previousMessage[to]) {
        msg = previousMessage[to] + msg
      }
      const edit = parseMessage(to, msg)
      if (edit) {
        previousMessage[to] = false
        callback(edit)
      } else {
        previousMessage[to] = msg
      }
    })

    this.client.addListener('error', (msg) => {
      console.log('irc error: ', msg)
    })
  }
}

module.exports = {
  WikiChanges,
  parseMessage,
  langFromChannel,
  channelForLang
}
