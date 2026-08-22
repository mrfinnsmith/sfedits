const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const sinon = require('sinon')
const { analyzeForPII } = require('../page-watch')

describe('analyzeForPII retry logic', function() {
  let fetchStub

  beforeEach(function() {
    fetchStub = sinon.stub(global, 'fetch')
  })

  afterEach(function() {
    fetchStub.restore()
  })

  it('retries once after a failure and returns the second response', async function() {
    const secondResponse = {
      ok: true,
      json: async () => ({ has_pii: true, entities: [{ type: 'PHONE_NUMBER' }] })
    }

    fetchStub.onFirstCall().rejects(new Error('Timeout'))
    fetchStub.onSecondCall().resolves(secondResponse)

    const result = await analyzeForPII('test text', null, 0)

    assert.equal(fetchStub.callCount, 2, 'fetch should be called exactly twice')
    assert.isTrue(result.has_pii)
    assert.equal(result.entities.length, 1)
    assert.equal(result.entities[0].type, 'PHONE_NUMBER')
  })

  it('fails open after two failures', async function() {
    fetchStub.rejects(new Error('Timeout'))

    const result = await analyzeForPII('test text', null, 0)

    assert.equal(fetchStub.callCount, 2, 'fetch should be called exactly twice')
    assert.isFalse(result.has_pii)
    assert.deepEqual(result.entities, [])
  })

  it('does not retry when the first request succeeds', async function() {
    const successResponse = {
      ok: true,
      json: async () => ({ has_pii: false, entities: [] })
    }

    fetchStub.resolves(successResponse)

    const result = await analyzeForPII('test text', null, 0)

    assert.equal(fetchStub.callCount, 1, 'fetch should be called exactly once')
    assert.isFalse(result.has_pii)
    assert.deepEqual(result.entities, [])
  })

  it('treats a non-2xx response as a failure and retries', async function() {
    const failureResponse = {
      ok: false,
      status: 500
    }
    const successResponse = {
      ok: true,
      json: async () => ({ has_pii: true, entities: [{ type: 'EMAIL_ADDRESS' }] })
    }

    fetchStub.onFirstCall().resolves(failureResponse)
    fetchStub.onSecondCall().resolves(successResponse)

    const result = await analyzeForPII('test text', null, 0)

    assert.equal(fetchStub.callCount, 2, 'fetch should be called exactly twice')
    assert.isTrue(result.has_pii)
    assert.equal(result.entities.length, 1)
    assert.equal(result.entities[0].type, 'EMAIL_ADDRESS')
  })
})
