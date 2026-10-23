const { assert } = require('chai')
const proxyquire = require('proxyquire')

describe('lib/screenshot', function() {
  let closed
  let pageOpts

  function load(opts) {
    closed = 0
    pageOpts = opts
    const page = {
      setViewport: async () => {},
      goto: async () => { if (opts.gotoError) throw new Error(opts.gotoError) },
      $: async () => (opts.noElement ? null : { boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }),
      screenshot: async () => {},
      evaluate: async () => {}
    }
    const browser = { newPage: async () => page, close: async () => { closed++ } }
    return proxyquire('../lib/screenshot', {
      puppeteer: { launch: async () => browser },
      './jsonl-log': { appendJsonl: () => {} }
    })
  }

  beforeEach(function() {
    this.currentTest.errLog = console.error
    console.error = () => {}
  })

  afterEach(function() {
    console.error = this.currentTest.errLog
  })

  it('reports "Diff table element not found" when the diff table is missing', async function() {
    const s = load({ noElement: true })
    assert.deepEqual(await s.takeScreenshotWithReason('https://x'), { file: null, reason: 'Diff table element not found' })
    assert.equal(closed, 1)
    assert.isNull(await s.takeScreenshot('https://x'))
    assert.equal(closed, 2)
  })

  it('reports the error message when navigation fails', async function() {
    const s = load({ gotoError: 'Navigation timeout of 30000 ms exceeded' })
    assert.deepEqual(await s.takeScreenshotWithReason('https://x'), { file: null, reason: 'Navigation timeout of 30000 ms exceeded' })
    assert.equal(closed, 1)
    assert.isNull(await s.takeScreenshot('https://x'))
    assert.equal(closed, 2)
  })

  it('returns the file path and a null reason on success', async function() {
    const s = load({})
    const result = await s.takeScreenshotWithReason('https://x')
    assert.match(result.file, /\d+\.png$/)
    assert.isNull(result.reason)
    assert.equal(closed, 1)
    assert.match(await s.takeScreenshot('https://x'), /\d+\.png$/)
    assert.equal(closed, 2)
  })
})
