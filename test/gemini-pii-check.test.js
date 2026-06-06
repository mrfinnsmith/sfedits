const assert = require('assert')
const nock = require('nock')

const API_BASE = 'https://generativelanguage.googleapis.com'
const PRO = 'gemini-2.5-pro'
const FLASH = 'gemini-2.5-flash'

// Load the module fresh so its cached model choice resets for each test.
function loadModule() {
  delete require.cache[require.resolve('../lib/gemini-pii-check')]
  return require('../lib/gemini-pii-check')
}

function geminiReply(isPii) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ is_pii: isPii, reason: 'test' }) }] } }],
    usageMetadata: { promptTokenCount: 10, totalTokenCount: 20 }
  }
}

// nock cannot trigger Node's socket timeout, so we inject the exact error our
// timeout handler produces (an Error with isTimeout=true) to drive the branch.
function timeoutError() {
  const err = new Error('Gemini API request timed out')
  err.isTimeout = true
  return err
}

const ENTITIES = [{ type: 'US_DRIVER_LICENSE', score: 0.3, start: 0, end: 9 }]
const POST_TEXT = '123456789 edited a page'

function probePro() {
  nock(API_BASE).get(`/v1beta/models/${PRO}`).query(true).reply(200, {})
}

describe('lib/gemini-pii-check - Pro timeout fallback to Flash', () => {
  let originalKey

  beforeEach(() => {
    originalKey = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'test-key'
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  })

  it('falls back to Flash when Pro times out, returning Flash verdict', async () => {
    probePro()
    nock(API_BASE).post(new RegExp(`/v1beta/models/${PRO}:generateContent`)).replyWithError(timeoutError())
    const flashScope = nock(API_BASE).post(new RegExp(`/v1beta/models/${FLASH}:generateContent`))
      .reply(200, geminiReply(false))

    const { verifyPIIWithGemini } = loadModule()
    const verdict = await verifyPIIWithGemini(POST_TEXT, ENTITIES, 'Test Article')

    assert.strictEqual(verdict, 'false_positive')
    assert.ok(flashScope.isDone(), 'expected Flash to be called as fallback')
  })

  it('returns unavailable (blocks) when both Pro and Flash time out', async () => {
    probePro()
    nock(API_BASE).post(new RegExp(`/v1beta/models/${PRO}:generateContent`)).replyWithError(timeoutError())
    nock(API_BASE).post(new RegExp(`/v1beta/models/${FLASH}:generateContent`)).replyWithError(timeoutError())

    const { verifyPIIWithGemini } = loadModule()
    const verdict = await verifyPIIWithGemini(POST_TEXT, ENTITIES, 'Test Article')

    assert.strictEqual(verdict, 'unavailable')
  })

  it('does not fall back to Flash on a non-timeout error (e.g. HTTP 400)', async () => {
    probePro()
    nock(API_BASE).post(new RegExp(`/v1beta/models/${PRO}:generateContent`)).reply(400, { error: 'bad' })
    const flashScope = nock(API_BASE).post(new RegExp(`/v1beta/models/${FLASH}:generateContent`))
      .reply(200, geminiReply(false))

    const { verifyPIIWithGemini } = loadModule()
    const verdict = await verifyPIIWithGemini(POST_TEXT, ENTITIES, 'Test Article')

    assert.strictEqual(verdict, 'unavailable')
    assert.ok(!flashScope.isDone(), 'Flash should not be called on a non-timeout error')
  })

  it('sends thinkingBudget 0 to Flash but not to Pro', async () => {
    let proBody, flashBody
    probePro()
    nock(API_BASE).post(new RegExp(`/v1beta/models/${PRO}:generateContent`), body => { proBody = body; return true })
      .replyWithError(timeoutError())
    nock(API_BASE).post(new RegExp(`/v1beta/models/${FLASH}:generateContent`), body => { flashBody = body; return true })
      .reply(200, geminiReply(false))

    const { verifyPIIWithGemini } = loadModule()
    await verifyPIIWithGemini(POST_TEXT, ENTITIES, 'Test Article')

    assert.strictEqual(proBody.generationConfig.thinkingConfig, undefined, 'Pro must not get thinkingConfig (it 400s on budget 0)')
    assert.strictEqual(flashBody.generationConfig.thinkingConfig.thinkingBudget, 0, 'Flash should disable thinking')
  })

  it('does not call Flash when Pro responds in time', async () => {
    probePro()
    nock(API_BASE).post(new RegExp(`/v1beta/models/${PRO}:generateContent`)).reply(200, geminiReply(true))
    const flashScope = nock(API_BASE).post(new RegExp(`/v1beta/models/${FLASH}:generateContent`))
      .reply(200, geminiReply(false))

    const { verifyPIIWithGemini } = loadModule()
    const verdict = await verifyPIIWithGemini(POST_TEXT, ENTITIES, 'Test Article')

    assert.strictEqual(verdict, 'confirmed')
    assert.ok(!flashScope.isDone(), 'Flash should not be called when Pro succeeds')
  })
})
