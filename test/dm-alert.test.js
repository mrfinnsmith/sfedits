/**
 * Tests for lib/dm-alert.js return values (delivered = true/false).
 * All network is mocked with nock; console output is silenced.
 */

const { describe, it, before, beforeEach, afterEach, after } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const sinon = require('sinon')
const { sendBlueskyDm, sendMastodonDm } = require('../lib/dm-alert')

const session = { accessJwt: 'jwt', refreshJwt: 'refresh', did: 'did:plc:x', handle: 'owner.bsky.social' }

const bskyAccount = {
  bluesky: { identifier: 'bot.bsky.social', password: 'p', service: 'https://bsky.social' },
  pii_alerts: { bluesky_recipient: 'owner.bsky.social' }
}

const mastoAccount = {
  mastodon: { access_token: 't', instance: 'https://mastodon.example.com' },
  pii_alerts: { mastodon_recipient: 'owner@example.com' }
}

function mockSession() {
  return nock('https://bsky.social')
    .post('/xrpc/com.atproto.server.createSession')
    .reply(200, session)
}

function mockConvos(body, status = 200) {
  return nock('https://api.bsky.chat')
    .get('/xrpc/chat.bsky.convo.listConvos')
    .query(true)
    .reply(status, body)
}

const convosWithOwner = {
  convos: [{ id: 'convo-1', members: [{ handle: 'owner.bsky.social' }] }]
}

describe('lib/dm-alert', function() {
  before(function() {
    nock.disableNetConnect()
  })

  beforeEach(function() {
    sinon.stub(console, 'log')
    sinon.stub(console, 'error')
  })

  afterEach(function() {
    console.log.restore()
    console.error.restore()
    nock.cleanAll()
  })

  after(function() {
    nock.enableNetConnect()
  })

  describe('sendBlueskyDm()', function() {
    it('returns true when sendMessage returns 2xx', async function() {
      mockSession()
      mockConvos(convosWithOwner)
      nock('https://api.bsky.chat')
        .post('/xrpc/chat.bsky.convo.sendMessage')
        .reply(200, { id: 'msg-1' })

      assert.isTrue(await sendBlueskyDm(bskyAccount, 'hello'))
      assert.isTrue(nock.isDone())
    })

    it('returns false with no network calls when no recipient is configured', async function() {
      const account = { bluesky: bskyAccount.bluesky, pii_alerts: {} }
      assert.isFalse(await sendBlueskyDm(account, 'hello'))
      assert.isFalse(await sendBlueskyDm({}, 'hello'))
      assert.lengthOf(nock.pendingMocks(), 0)
    })

    it('returns false when listConvos returns an error body', async function() {
      mockSession()
      mockConvos({ error: 'InvalidToken', message: 'bad token' }, 401)

      assert.isFalse(await sendBlueskyDm(bskyAccount, 'hello'))
    })

    it('returns false when there is no conversation with the recipient', async function() {
      mockSession()
      mockConvos({ convos: [{ id: 'other', members: [{ handle: 'someone-else.bsky.social' }] }] })

      assert.isFalse(await sendBlueskyDm(bskyAccount, 'hello'))
    })

    it('returns false when sendMessage returns 500', async function() {
      mockSession()
      mockConvos(convosWithOwner)
      nock('https://api.bsky.chat')
        .post('/xrpc/chat.bsky.convo.sendMessage')
        .reply(500, { error: 'InternalServerError' })

      assert.isFalse(await sendBlueskyDm(bskyAccount, 'hello'))
    })

    it('returns false when login fails', async function() {
      nock('https://bsky.social')
        .post('/xrpc/com.atproto.server.createSession')
        .reply(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' })

      assert.isFalse(await sendBlueskyDm(bskyAccount, 'hello'))
    })
  })

  describe('sendMastodonDm()', function() {
    it('returns true when the status is created', async function() {
      nock('https://mastodon.example.com')
        .post('/api/v1/statuses')
        .query(true)
        .reply(200, { id: '123', url: 'https://mastodon.example.com/@bot/123' })

      assert.isTrue(await sendMastodonDm(mastoAccount, 'hello'))
      assert.isTrue(nock.isDone())
    })

    it('returns false when the API returns 401', async function() {
      nock('https://mastodon.example.com')
        .post('/api/v1/statuses')
        .query(true)
        .reply(401, { error: 'The access token is invalid' })

      assert.isFalse(await sendMastodonDm(mastoAccount, 'hello'))
      assert.isTrue(nock.isDone())
    })

    it('returns false when the API returns 500', async function() {
      nock('https://mastodon.example.com')
        .post('/api/v1/statuses')
        .query(true)
        .reply(500, { error: 'Internal server error' })

      assert.isFalse(await sendMastodonDm(mastoAccount, 'hello'))
      assert.isTrue(nock.isDone())
    })

    it('returns false when no recipient is configured', async function() {
      const account = { mastodon: mastoAccount.mastodon, pii_alerts: {} }
      assert.isFalse(await sendMastodonDm(account, 'hello'))
      assert.isFalse(await sendMastodonDm({}, 'hello'))
    })
  })
})
