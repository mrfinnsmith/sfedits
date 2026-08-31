const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const { recordEdit } = require('../lib/edit-log')

// recordEdit talks to Supabase over global fetch and reads its credentials from
// the environment, so both are swapped out here. The contract under test is not
// really "does it send the right JSON" but "can it ever break a post", which is
// why most of these assert that a failure stays swallowed.

const EDIT = {
  page: 'Gavin Newsom',
  url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=122',
  user: 'SomeEditor',
  anonymous: false
}

describe('edit-log', function() {
  let calls, originalFetch, originalEnv, logged

  beforeEach(function() {
    calls = []
    logged = []
    originalFetch = global.fetch
    originalEnv = {
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_SECRET_KEY
    }
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'
    global.fetch = async function(url, options) {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return { ok: true, status: 201, text: async () => '' }
    }
  })

  afterEach(function() {
    global.fetch = originalFetch
    if (originalEnv.url === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = originalEnv.url
    if (originalEnv.key === undefined) delete process.env.SUPABASE_SECRET_KEY
    else process.env.SUPABASE_SECRET_KEY = originalEnv.key
  })

  it('names diff_url as the conflict target so a retry is not a 409', async function() {
    await recordEdit(EDIT)
    assert.include(calls[0].url, '/rest/v1/wikipedia_edits?on_conflict=diff_url')
    assert.include(calls[0].options.headers.Prefer, 'resolution=ignore-duplicates')
  })

  it('sends the article, language and diff url', async function() {
    await recordEdit(EDIT)
    assert.equal(calls[0].body.article_title, 'Gavin Newsom')
    assert.equal(calls[0].body.lang, 'en')
    assert.equal(calls[0].body.diff_url, EDIT.url)
    assert.isString(calls[0].body.posted_at)
  })

  it('records a registered editor by name and no country', async function() {
    await recordEdit(EDIT)
    assert.equal(calls[0].body.editor, 'SomeEditor')
    assert.isNull(calls[0].body.editor_country)
  })

  it('never sends the IP address of an anonymous editor', async function() {
    await recordEdit({ ...EDIT, user: '8.8.8.8', anonymous: true })
    assert.isNull(calls[0].body.editor)
    assert.notInclude(JSON.stringify(calls[0].body), '8.8.8.8')
  })

  it('sends nothing when the diff url is malformed', async function() {
    await recordEdit({ ...EDIT, url: 'not-a-url' })
    assert.lengthOf(calls, 0)
  })

  it('sends nothing, and does not throw, when unconfigured', async function() {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
    await recordEdit(EDIT)
    assert.lengthOf(calls, 0)
  })

  it('swallows a non-2xx response', async function() {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
    await recordEdit(EDIT)
  })

  it('swallows a network failure', async function() {
    global.fetch = async () => { throw new Error('ECONNRESET') }
    await recordEdit(EDIT)
  })
})
