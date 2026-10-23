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
 * @returns {Promise<boolean>} true only when sendMessage returned a 2xx response;
 *   false when the recipient is not configured, listConvos fails, no conversation
 *   exists, sendMessage is non-2xx, or anything throws
 */
async function sendBlueskyDm(account, text, facets) {
  if (!account.pii_alerts?.bluesky_recipient) return false

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

    if (!convoResponse.ok || convosData.error) {
      console.error('Failed to list Bluesky conversations:', convosData.error || convoResponse.status)
      return false
    }

    const convo = convosData.convos.find(c =>
      c.members.some(m => m.handle === account.pii_alerts.bluesky_recipient)
    )

    if (!convo) {
      console.error(`No existing Bluesky conversation with ${account.pii_alerts.bluesky_recipient}`)
      return false
    }

    // Send message - chat API is at api.bsky.chat
    const sendResponse = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage', {
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

    if (!sendResponse.ok) {
      console.error('Bluesky alert send failed with HTTP', sendResponse.status)
      return false
    }

    console.log('✓ Bluesky alert sent')
    return true
  } catch (error) {
    console.error('Bluesky alert failed:', error.message)
    return false
  }
}

/**
 * Send a DM via Mastodon (a direct-visibility post mentioning the recipient)
 * Never throws: failures are logged, the bot keeps running.
 *
 * @param {Object} account - Account config (mastodon credentials, pii_alerts.mastodon_recipient)
 * @param {string} text - Message text
 * @returns {Promise<boolean>} true only when the status was created (the response data has an id)
 */
async function sendMastodonDm(account, text) {
  if (!account.pii_alerts?.mastodon_recipient) return false

  try {
    const M = new Mastodon({
      access_token: account.mastodon.access_token,
      api_url: account.mastodon.instance + '/api/v1/'
    })

    // Verified in node_modules/mastodon/lib/mastodon.js (v1.2.2): M.post rejects on
    // transport errors and on JSON bodies with `error`/`errors` (HTTP 4xx with a Mastodon
    // error body), but RESOLVES with { data, resp } for any other response, including a
    // bare 500 with an empty body. So "created" is checked by the presence of a status id.
    const result = await M.post('statuses', {
      status: `@${account.pii_alerts.mastodon_recipient} ${text}`,
      visibility: 'direct'
    })

    if (!result?.data?.id) {
      console.error('Mastodon alert failed: response had no status id')
      return false
    }

    console.log('✓ Mastodon alert sent')
    return true
  } catch (error) {
    console.error('Mastodon alert failed:', error.message)
    return false
  }
}

module.exports = { sendBlueskyDm, sendMastodonDm }
