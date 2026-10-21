const Mastodon = require('mastodon')
const { createAuthenticatedAgent } = require('./bluesky-client')

/**
 * Send a DM via Bluesky
 * Uses api.bsky.chat service directly (not routed through bsky.social PDS)
 * Never throws: failures are logged, the bot keeps running.
 *
 * @param {Object} account - Account config (bluesky credentials, pii_alerts.bluesky_recipient)
 * @param {string} text - Message text
 * @param {Array} [facets] - Optional Bluesky facets (clickable links)
 */
async function sendBlueskyDm(account, text, facets) {
  if (!account.pii_alerts?.bluesky_recipient) return

  try {
    const agent = await createAuthenticatedAgent(account.bluesky)
    const accessJwt = agent.session.accessJwt

    // Get conversation - chat API is at api.bsky.chat
    const convoResponse = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=100', {
      headers: {
        'Authorization': `Bearer ${accessJwt}`
      }
    })

    const convosData = await convoResponse.json()

    if (convosData.error) {
      console.error('Failed to list Bluesky conversations:', convosData.error)
      return
    }

    const convo = convosData.convos.find(c =>
      c.members.some(m => m.handle === account.pii_alerts.bluesky_recipient)
    )

    if (!convo) {
      console.error(`No existing Bluesky conversation with ${account.pii_alerts.bluesky_recipient}`)
      return
    }

    // Send message - chat API is at api.bsky.chat
    await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessJwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        convoId: convo.id,
        message: {
          text,
          facets
        }
      })
    })

    console.log('✓ Bluesky alert sent')
  } catch (error) {
    console.error('Bluesky alert failed:', error.message)
  }
}

/**
 * Send a DM via Mastodon (a direct-visibility post mentioning the recipient)
 * Never throws: failures are logged, the bot keeps running.
 *
 * @param {Object} account - Account config (mastodon credentials, pii_alerts.mastodon_recipient)
 * @param {string} text - Message text
 */
async function sendMastodonDm(account, text) {
  if (!account.pii_alerts?.mastodon_recipient) return

  try {
    const M = new Mastodon({
      access_token: account.mastodon.access_token,
      api_url: account.mastodon.instance + '/api/v1/'
    })

    await M.post('statuses', {
      status: `@${account.pii_alerts.mastodon_recipient} ${text}`,
      visibility: 'direct'
    })

    console.log('✓ Mastodon alert sent')
  } catch (error) {
    console.error('Mastodon alert failed:', error.message)
  }
}

module.exports = { sendBlueskyDm, sendMastodonDm }
