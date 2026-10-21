const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('consecutive post failure alert', function() {
  // sendStatus waits 2s for the diff table to render. setTimeout is faked and
  // advanced by settle() so the tests do not sit through the real wait.
  let clock

  async function settle(promise) {
    let done = false
    const tracked = promise.then(() => { done = true }, () => { done = true })
    while (!done) {
      await clock.tickAsync(2000)
    }
    await tracked
    return promise
  }

  let fakeScreenshotPath
  let screenshotResult
  let dmCalls
  let pageWatch

  const fakeAccount = {
    bluesky: { identifier: 'testuser.bsky.social', password: 'p', service: 'https://bsky.social' },
    mastodon: { access_token: 't', instance: 'https://mastodon.example.com' },
    template: '{{page}} edited by {{name}} {{&url}}',
    pii_blocking: { enabled: false },
    pii_alerts: { bluesky_recipient: 'owner.bsky.social', mastodon_recipient: 'owner@example.com' }
  }

  const fakeEdit = {
    page: 'Test Article',
    user: 'TestUser',
    url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
  }

  function mockDiff(wgPageName) {
    nock('https://en.wikipedia.org')
      .get('/w/index.php')
      .query({ diff: '123', oldid: '456' })
      .reply(200, `<script>RLCONF={"wgPageName":"${wgPageName}"};</script>`)
  }

  function mockSuccessfulPosting() {
    nock('https://bsky.social')
      .post('/xrpc/com.atproto.server.createSession')
      .reply(200, { accessJwt: 'x', refreshJwt: 'y', did: 'did:plc:x', handle: 'x.bsky.social' })
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .reply(200, { blob: { $type: 'blob', ref: { $link: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4' }, mimeType: 'image/png', size: 1 } })
      .post('/xrpc/com.atproto.repo.createRecord')
      .reply(200, { uri: 'at://did:plc:x/app.bsky.feed.post/1', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' })
    nock('https://mastodon.example.com')
      .post('/api/v1/media')
      .reply(200, { id: '1' })
      .post(/\/api\/v1\/statuses.*/)
      .reply(200, { id: '2', url: 'https://mastodon.example.com/@u/2' })
  }

  // Runs one sendStatus against the diff page for `pageName`. Screenshot
  // behaviour comes from `screenshotResult` (null = capture failed).
  async function runSendStatus(pageName) {
    mockDiff(pageName)
    const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
    await settle(pageWatch.sendStatus(fakeAccount, statusData, fakeEdit))
  }

  async function fail() {
    screenshotResult = null
    await runSendStatus('Test_Article')
  }

  async function succeed() {
    fs.writeFileSync(fakeScreenshotPath, 'fake image data')
    screenshotResult = fakeScreenshotPath
    mockSuccessfulPosting()
    await runSendStatus('Test_Article')
  }

  beforeEach(function() {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
    fakeScreenshotPath = path.join(__dirname, 'fake-failure-screenshot.png')
    dmCalls = []
    // Fresh module per test, so the failure counter starts at 0
    pageWatch = proxyquire('../page-watch', {
      './lib/screenshot': { takeScreenshot: async () => screenshotResult },
      './lib/geolocation': {
        enrichIPsInText: async (text) => text,
        initializeReader: async () => null
      },
      './lib/dm-alert': {
        sendBlueskyDm: async (account, text, facets) => { dmCalls.push({ platform: 'bluesky', text, facets }) },
        sendMastodonDm: async (account, text) => { dmCalls.push({ platform: 'mastodon', text }) }
      }
    })
  })

  afterEach(function() {
    clock.restore()
    if (fs.existsSync(fakeScreenshotPath)) fs.unlinkSync(fakeScreenshotPath)
    nock.cleanAll()
  })

  it('does not alert on the 1st failure', async function() {
    await fail()
    assert.lengthOf(dmCalls, 0)
  })

  it('alerts on both channels on the 2nd consecutive failure', async function() {
    await fail()
    await fail()
    assert.deepEqual(dmCalls.map(c => c.platform), ['bluesky', 'mastodon'])
    const expected = 'sfedits: 2 posts in a row failed. Last error: Failed to capture screenshot'
    assert.equal(dmCalls[0].text, expected)
    assert.equal(dmCalls[1].text, expected)
  })

  it('does not include the edit text in the alert', async function() {
    await fail()
    await fail()
    dmCalls.forEach(c => {
      assert.notInclude(c.text, 'Test Article')
      assert.notInclude(c.text, 'TestUser')
    })
  })

  it('does not alert again on the 3rd or 4th failure', async function() {
    await fail()
    await fail()
    dmCalls.length = 0
    await fail()
    await fail()
    assert.lengthOf(dmCalls, 0)
  })

  it('resets the streak on a successful post, so a new streak alerts again', async function() {
    await fail()
    await succeed()
    await fail()
    assert.lengthOf(dmCalls, 0, 'failure, success, failure is not 2 in a row')
    await fail()
    assert.lengthOf(dmCalls, 2, 'the new streak reaches 2')
  })

  it('does not count a blocked post as a failure', async function() {
    await fail()
    await runSendStatus('Some_Other_Page') // diff belongs to a different page: blocked
    assert.lengthOf(dmCalls, 0)
    await fail()
    assert.lengthOf(dmCalls, 2, 'blocked post between failures neither adds nor resets')
  })

  it('does not let a failing DM send throw out of sendStatus', async function() {
    const throwing = proxyquire('../page-watch', {
      './lib/screenshot': { takeScreenshot: async () => null },
      './lib/geolocation': { enrichIPsInText: async (text) => text, initializeReader: async () => null },
      './lib/dm-alert': {
        sendBlueskyDm: async () => { throw new Error('dm down') },
        sendMastodonDm: async () => { throw new Error('dm down') }
      }
    })
    const statusData = throwing.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
    mockDiff('Test_Article')
    await settle(throwing.sendStatus(fakeAccount, statusData, fakeEdit))
    mockDiff('Test_Article')
    await settle(throwing.sendStatus(fakeAccount, statusData, fakeEdit))
  })

  describe('PII alert after the dm-alert refactor', function() {
    it('sends "PII: <text>" with facets on Bluesky', async function() {
      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      await pageWatch.sendBlueskyAlert(fakeAccount, fakeEdit, statusData, {})
      assert.lengthOf(dmCalls, 1)
      assert.equal(dmCalls[0].text, `PII: ${statusData.text}`)
      assert.isArray(dmCalls[0].facets)
    })

    it('sends "PII: <text>" on Mastodon', async function() {
      const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, fakeAccount.template)
      await pageWatch.sendMastodonAlert(fakeAccount, fakeEdit, statusData, {})
      assert.deepEqual(dmCalls, [{ platform: 'mastodon', text: `PII: ${statusData.text}` }])
    })
  })
})
