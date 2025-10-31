/**
 * Direct unit tests for lib/bluesky-client.js
 *
 * These tests import and test the module directly to verify
 * authentication logic works independently.
 */

const { describe, it } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const { createAuthenticatedAgent } = require('../lib/bluesky-client')

describe('lib/bluesky-client', function() {
  afterEach(function() {
    nock.cleanAll()
  })

  describe('createAuthenticatedAgent()', function() {
    it('creates agent with default service URL', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'fake-access-token',
          refreshJwt: 'fake-refresh-token',
          did: 'did:plc:test123',
          handle: 'test.bsky.social'
        })

      const agent = await createAuthenticatedAgent({
        identifier: 'test.bsky.social',
        password: 'test-password'
      })

      assert.exists(agent)
      assert.exists(agent.session)
      assert.equal(agent.session.accessJwt, 'fake-access-token')
      assert.equal(agent.session.did, 'did:plc:test123')
      assert.equal(agent.session.handle, 'test.bsky.social')
    })

    it('creates agent with custom service URL', async function() {
      nock('https://custom.pds.example.com')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'custom-token',
          refreshJwt: 'custom-refresh',
          did: 'did:plc:custom456',
          handle: 'user.custom.com'
        })

      const agent = await createAuthenticatedAgent({
        identifier: 'user.custom.com',
        password: 'custom-password',
        service: 'https://custom.pds.example.com'
      })

      assert.exists(agent)
      assert.equal(agent.session.accessJwt, 'custom-token')
      assert.equal(agent.session.handle, 'user.custom.com')
    })

    it('authenticates with identifier and password', async function() {
      let capturedBody = null

      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession', body => {
          capturedBody = body
          return true
        })
        .reply(200, {
          accessJwt: 'token',
          refreshJwt: 'refresh',
          did: 'did:plc:test',
          handle: 'test.bsky.social'
        })

      await createAuthenticatedAgent({
        identifier: 'mybot.bsky.social',
        password: 'my-app-password'
      })

      // Verify login was called with correct credentials
      assert.exists(capturedBody)
      assert.equal(capturedBody.identifier, 'mybot.bsky.social')
      assert.equal(capturedBody.password, 'my-app-password')
    })

    it('throws error when authentication fails', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(401, {
          error: 'AuthenticationRequired',
          message: 'Invalid identifier or password'
        })

      try {
        await createAuthenticatedAgent({
          identifier: 'wrong.bsky.social',
          password: 'wrong-password'
        })
        assert.fail('Should have thrown authentication error')
      } catch (error) {
        assert.exists(error)
        // Error message contains "invalid identifier or password"
        assert.match(error.message.toLowerCase(), /(invalid|authentication|unauthorized)/)
      }
    })

    it('throws error when service is unreachable', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .replyWithError('ECONNREFUSED')

      try {
        await createAuthenticatedAgent({
          identifier: 'test.bsky.social',
          password: 'test-password'
        })
        assert.fail('Should have thrown connection error')
      } catch (error) {
        assert.exists(error)
        assert.include(error.message, 'ECONNREFUSED')
      }
    })

    it('returns agent with session data', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'access-token-abc123',
          refreshJwt: 'refresh-token-xyz789',
          did: 'did:plc:testuser',
          handle: 'testuser.bsky.social'
        })

      const agent = await createAuthenticatedAgent({
        identifier: 'testuser.bsky.social',
        password: 'app-password'
      })

      // Verify session contains all expected fields
      assert.equal(agent.session.accessJwt, 'access-token-abc123')
      assert.equal(agent.session.refreshJwt, 'refresh-token-xyz789')
      assert.equal(agent.session.did, 'did:plc:testuser')
      assert.equal(agent.session.handle, 'testuser.bsky.social')
    })

    it('returns agent that can make API calls', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'token',
          refreshJwt: 'refresh',
          did: 'did:plc:test',
          handle: 'test.bsky.social'
        })
        .post('/xrpc/com.atproto.repo.createRecord')
        .reply(200, {
          uri: 'at://did:plc:test/app.bsky.feed.post/abc123',
          cid: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4'
        })

      const agent = await createAuthenticatedAgent({
        identifier: 'test.bsky.social',
        password: 'test-password'
      })

      // Verify agent can make API calls
      const result = await agent.post({ text: 'Test post' })
      assert.exists(result)
      assert.exists(result.uri)
      assert.include(result.uri, 'at://')
    })

    it('handles authentication with DID instead of handle', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'token',
          refreshJwt: 'refresh',
          did: 'did:plc:abc123xyz',
          handle: 'resolved.bsky.social'
        })

      const agent = await createAuthenticatedAgent({
        identifier: 'did:plc:abc123xyz',
        password: 'app-password'
      })

      assert.exists(agent.session)
      assert.equal(agent.session.did, 'did:plc:abc123xyz')
    })

    it('preserves service URL in agent configuration', async function() {
      const customService = 'https://my-custom-pds.example.com'

      nock(customService)
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'token',
          refreshJwt: 'refresh',
          did: 'did:plc:test',
          handle: 'test.custom.com'
        })

      const agent = await createAuthenticatedAgent({
        identifier: 'test.custom.com',
        password: 'password',
        service: customService
      })

      // Verify agent is configured with custom service
      // Note: BskyAgent may add trailing slash to service URL
      assert.exists(agent)
      assert.match(agent.service.toString(), /^https:\/\/my-custom-pds\.example\.com\/?$/)
    })

    it('works with minimal config (identifier and password only)', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(200, {
          accessJwt: 'token',
          refreshJwt: 'refresh',
          did: 'did:plc:test',
          handle: 'test.bsky.social'
        })

      // Only provide required fields, service should default to bsky.social
      const agent = await createAuthenticatedAgent({
        identifier: 'test.bsky.social',
        password: 'password'
      })

      assert.exists(agent)
      assert.exists(agent.session)
      // Note: BskyAgent may add trailing slash to service URL
      assert.match(agent.service.toString(), /^https:\/\/bsky\.social\/?$/)
    })
  })
})
