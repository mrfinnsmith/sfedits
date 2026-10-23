const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const nock = require('nock')
const fs = require('fs')
const path = require('path')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('edit outcome recording through sendStatus', function() {
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
  let outcomes
  let geminiVerdict
  let pageWatch

  const fakeAccount = {
    bluesky: { identifier: 'testuser.bsky.social', password: 'p', service: 'https://bsky.social' },
    mastodon: { access_token: 't', instance: 'https://mastodon.example.com' },
    template: '{{page}} edited by {{name}} {{&url}}',
    pii_blocking: { enabled: false },
    pii_alerts: { bluesky_recipient: 'owner.bsky.social', mastodon_recipient: 'owner@example.com' }
  }

  const piiAccount = Object.assign({}, fakeAccount, { pii_blocking: { enabled: true } })

  const fakeEdit = {
    page: 'Test Article',
    user: 'TestUser',
    url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'
  }

  function mockDiff(wgPageName, extraHtml = '') {
    nock('https://en.wikipedia.org')
      .get('/w/index.php')
      .query({ diff: '123', oldid: '456' })
      .reply(200, `<script>RLCONF={"wgPageName":"${wgPageName}"};</script>${extraHtml}`)
  }

  function mockBlueskyOk() {
    nock('https://bsky.social')
      .post('/xrpc/com.atproto.server.createSession')
      .reply(200, { accessJwt: 'x', refreshJwt: 'y', did: 'did:plc:x', handle: 'x.bsky.social' })
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .reply(200, { blob: { $type: 'blob', ref: { $link: 'bafkreih5aznjvttude6c3wbvqeebb6rlx5wkbzyppv7garjiubll2ceym4' }, mimeType: 'image/png', size: 1 } })
      .post('/xrpc/com.atproto.repo.createRecord')
      .reply(200, { uri: 'at://did:plc:x/app.bsky.feed.post/1', cid: 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' })
  }

  function mockMastodonOk() {
    nock('https://mastodon.example.com')
      .post('/api/v1/media')
      .reply(200, { id: '1' })
      .post(/\/api\/v1\/statuses.*/)
      .reply(200, { id: '2', url: 'https://mastodon.example.com/@u/2' })
  }

  function mockMastodonFail() {
    nock('https://mastodon.example.com')
      .post('/api/v1/media')
      .reply(500, { error: 'boom' })
  }

  async function run(account, pageName, extraHtml) {
    mockDiff(pageName, extraHtml)
    const statusData = pageWatch.getStatus(fakeEdit, fakeEdit.user, account.template)
    await settle(pageWatch.sendStatus(account, statusData, fakeEdit))
  }

  function useScreenshot() {
    fs.writeFileSync(fakeScreenshotPath, 'fake image data')
    screenshotResult = fakeScreenshotPath
  }

  function load(extraStubs = {}) {
    return proxyquire('../page-watch', Object.assign({
      './lib/screenshot': { takeScreenshot: async () => screenshotResult },
      './lib/geolocation': {
        enrichIPsInText: async (text) => text,
        initializeReader: async () => null
      },
      './lib/edit-outcomes': {
        recordOutcome: (edit, outcome, detail) => { outcomes.push({ url: edit.url, outcome, detail }) }
      },
      './lib/edit-log': { recordEdit: async () => {} },
      './lib/gemini-pii-check': { verifyPIIWithGemini: async () => geminiVerdict() },
      './lib/draft-manager': { saveDraft: () => {} },
      // pii-blocks.log would otherwise be appended in the working directory
      fs: { appendFileSync: () => {} },
      './lib/dm-alert': {
        sendBlueskyDm: async (account, text, facets) => { dmCalls.push({ platform: 'bluesky', text, facets }); return true },
        sendMastodonDm: async (account, text) => { dmCalls.push({ platform: 'mastodon', text }); return true }
      }
    }, extraStubs))
  }

  beforeEach(function() {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
    fakeScreenshotPath = path.join(__dirname, 'fake-failure-screenshot.png')
    screenshotResult = null
    dmCalls = []
    outcomes = []
    geminiVerdict = () => 'confirmed'
    pageWatch = load()
  })

  afterEach(function() {
    clock.restore()
    if (fs.existsSync(fakeScreenshotPath)) fs.unlinkSync(fakeScreenshotPath)
    nock.cleanAll()
  })

  it('records exactly one "posted" after both platforms succeed', async function() {
    useScreenshot()
    mockBlueskyOk()
    mockMastodonOk()
    await run(fakeAccount, 'Test_Article')
    assert.deepEqual(outcomes, [{ url: fakeEdit.url, outcome: 'posted', detail: undefined }])
  })

  it('records wrong_page with the actual page when the diff belongs to another page', async function() {
    await run(fakeAccount, 'Some_Other_Page')
    assert.deepEqual(outcomes, [{ url: fakeEdit.url, outcome: 'wrong_page', detail: 'diff is for "Some Other Page"' }])
  })

  it('records screenshot_failed when the screenshot is null', async function() {
    screenshotResult = null
    await run(fakeAccount, 'Test_Article')
    assert.lengthOf(outcomes, 1)
    assert.equal(outcomes[0].outcome, 'screenshot_failed')
    assert.equal(outcomes[0].detail, 'Failed to capture screenshot')
  })

  it('records post_failed, not posted, when Bluesky succeeds and Mastodon fails', async function() {
    useScreenshot()
    mockBlueskyOk()
    mockMastodonFail()
    await run(fakeAccount, 'Test_Article')
    assert.lengthOf(outcomes, 1)
    assert.equal(outcomes[0].outcome, 'post_failed')
    assert.notInclude(outcomes.map(o => o.outcome), 'posted')
  })

  it('records no_diff_text when the diff has no extractable text', async function() {
    await run(piiAccount, 'Test_Article')
    assert.deepEqual(outcomes, [{ url: fakeEdit.url, outcome: 'no_diff_text', detail: 'Could not extract diff text' }])
  })

  it('records pii_blocked when PII is confirmed, and sends the PII DMs', async function() {
    nock('http://pii-service:5000').post('/analyze').reply(200, {
      has_pii: true,
      entities: [{ type: 'EMAIL_ADDRESS', score: 0.9 }]
    })
    await run(piiAccount, 'Test_Article', '<td class="diff-addedline">mail me at a@b.com</td>')
    assert.deepEqual(outcomes, [{ url: fakeEdit.url, outcome: 'pii_blocked', detail: 'PII detected' }])
    assert.deepEqual(dmCalls.map(c => c.platform), ['bluesky', 'mastodon'])
  })

  it('records pii_blocked when Gemini is unavailable', async function() {
    geminiVerdict = () => 'unavailable'
    nock('http://pii-service:5000').post('/analyze').reply(200, {
      has_pii: true,
      entities: [{ type: 'EMAIL_ADDRESS', score: 0.9 }]
    })
    await run(piiAccount, 'Test_Article', '<td class="diff-addedline">mail me at a@b.com</td>')
    assert.equal(outcomes[0].outcome, 'pii_blocked')
  })

  it('records screening_error with the error message', async function() {
    geminiVerdict = () => { throw new Error('gemini exploded') }
    nock('http://pii-service:5000').post('/analyze').reply(200, {
      has_pii: true,
      entities: [{ type: 'EMAIL_ADDRESS', score: 0.9 }]
    })
    await run(piiAccount, 'Test_Article', '<td class="diff-addedline">mail me at a@b.com</td>')
    assert.deepEqual(outcomes, [{ url: fakeEdit.url, outcome: 'screening_error', detail: 'gemini exploded' }])
  })

  it('screenForPII tags each non-safe result with an outcome', async function() {
    const noText = await pageWatch.screenForPII(piiAccount, fakeEdit, { text: 't' }, '')
    assert.equal(noText.outcome, 'no_diff_text')
    assert.equal(noText.reason, 'Could not extract diff text')
  })

  it('does not DM the owner when posts fail repeatedly (the streak alert is gone)', async function() {
    for (let i = 0; i < 3; i++) {
      screenshotResult = null
      await run(fakeAccount, 'Test_Article')
    }
    assert.lengthOf(outcomes, 3)
    assert.lengthOf(dmCalls, 0)
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
