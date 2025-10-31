/**
 * Bluesky Client
 *
 * Shared authentication and agent creation for Bluesky ATP (Authenticated Transfer Protocol).
 * Centralizes login logic to ensure consistent authentication across the codebase.
 *
 * @see https://docs.bsky.app
 */

const { BskyAgent } = require('@atproto/api')

/**
 * Creates an authenticated Bluesky agent
 *
 * Handles authentication and returns a fully initialized agent ready for API calls.
 * Uses app passwords for authentication - ensure the app password has required scopes
 * (posting, DM access if needed).
 *
 * @param {Object} config - Bluesky account configuration
 * @param {string} config.identifier - Username (e.g., 'user.bsky.social') or DID
 * @param {string} config.password - App password (not account password)
 * @param {string} [config.service='https://bsky.social'] - Bluesky PDS service URL
 * @returns {Promise<BskyAgent>} Authenticated agent with session
 * @throws {Error} If authentication fails
 *
 * @example
 * const agent = await createAuthenticatedAgent({
 *   identifier: 'bot.bsky.social',
 *   password: 'app-password-here',
 *   service: 'https://bsky.social'
 * })
 * await agent.post({ text: 'Hello from my bot!' })
 */
async function createAuthenticatedAgent(config) {
  const agent = new BskyAgent({
    service: config.service || 'https://bsky.social'
  })

  await agent.login({
    identifier: config.identifier,
    password: config.password
  })

  return agent
}

module.exports = { createAuthenticatedAgent }
