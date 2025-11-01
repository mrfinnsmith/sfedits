#!/usr/bin/env node

const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { takeScreenshot } = require('../lib/screenshot')
const { createAuthenticatedAgent } = require('../lib/bluesky-client')
const bluesky = require('../lib/bluesky-platform')
const mastodon = require('../lib/mastodon-platform')

const app = express()
const PORT = process.env.PORT || 3000

// Session management with crypto-random tokens
const sessions = new Map() // sessionToken -> { created: Date, expires: Date }
const SESSION_DURATION = 24 * 60 * 60 * 1000 // 24 hours

// One-time login codes
const loginCodes = new Map() // code -> { created: Date, expires: Date }
const CODE_DURATION = 10 * 60 * 1000 // 10 minutes

// Import draft manager from parent directory
const { listDrafts, getDraft, deleteDraft, DRAFTS_DIR, SCREENSHOTS_DIR } = require('../lib/draft-manager')

// Middleware
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// Clean up expired sessions and codes periodically
setInterval(() => {
  const now = Date.now()

  // Clean sessions
  for (const [token, session] of sessions.entries()) {
    if (session.expires < now) {
      sessions.delete(token)
    }
  }

  // Clean login codes
  for (const [code, data] of loginCodes.entries()) {
    if (data.expires < now) {
      loginCodes.delete(code)
    }
  }
}, 60 * 1000) // Check every minute

// Session-based authentication middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.substring(7)
  const session = sessions.get(token)

  if (!session || session.expires < Date.now()) {
    sessions.delete(token)
    return res.status(403).json({ error: 'Session expired or invalid' })
  }

  next()
}

// Load config (same as bot)
function loadConfig() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, '../config.json')
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

// API Routes

/**
 * POST /api/auth/request-code
 * Request a login code via Bluesky DM
 */
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const config = loadConfig()
    const account = config.accounts[0]

    if (!account.bluesky || !account.pii_alerts?.bluesky_recipient) {
      return res.status(500).json({ error: 'Bluesky not configured' })
    }

    // Generate 6-digit code
    const code = crypto.randomInt(100000, 999999).toString()
    const now = Date.now()

    loginCodes.set(code, {
      created: now,
      expires: now + CODE_DURATION
    })

    // Send code via Bluesky DM
    const agent = await createAuthenticatedAgent(account.bluesky)
    const accessJwt = agent.session.accessJwt

    // Get conversation
    const convoResponse = await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=100', {
      headers: {
        'Authorization': `Bearer ${accessJwt}`
      }
    })

    const convosData = await convoResponse.json()

    if (convosData.error) {
      console.error('Failed to list Bluesky conversations:', convosData.error)
      return res.status(500).json({ error: 'Failed to send code' })
    }

    const convo = convosData.convos.find(c =>
      c.members.some(m => m.handle === account.pii_alerts.bluesky_recipient)
    )

    if (!convo) {
      console.error(`No existing Bluesky conversation with ${account.pii_alerts.bluesky_recipient}`)
      return res.status(500).json({ error: 'No DM conversation found' })
    }

    // Send code
    await fetch('https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessJwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        convoId: convo.id,
        message: {
          text: `Admin login code: ${code}\n\nExpires in 10 minutes.`
        }
      })
    })

    console.log(`✓ Login code sent via Bluesky DM`)
    res.json({ success: true, expiresIn: CODE_DURATION })
  } catch (error) {
    console.error('Error sending login code:', error)
    res.status(500).json({ error: 'Failed to send code', details: error.message })
  }
})

/**
 * POST /api/auth/verify-code
 * Verify login code and receive session token
 */
app.post('/api/auth/verify-code', (req, res) => {
  const { code } = req.body

  if (!code) {
    return res.status(400).json({ error: 'Code required' })
  }

  const codeData = loginCodes.get(code)

  if (!codeData) {
    return res.status(401).json({ error: 'Invalid code' })
  }

  if (codeData.expires < Date.now()) {
    loginCodes.delete(code)
    return res.status(401).json({ error: 'Code expired' })
  }

  // Code is valid - delete it and create session
  loginCodes.delete(code)

  const sessionToken = crypto.randomBytes(32).toString('hex')
  const now = Date.now()

  sessions.set(sessionToken, {
    created: now,
    expires: now + SESSION_DURATION
  })

  res.json({
    valid: true,
    token: sessionToken,
    expiresIn: SESSION_DURATION
  })
})

/**
 * GET /api/drafts
 * List all pending drafts
 */
app.get('/api/drafts', requireAuth, (req, res) => {
  try {
    const drafts = listDrafts()
    res.json({ drafts, count: drafts.length })
  } catch (error) {
    console.error('Error listing drafts:', error)
    res.status(500).json({ error: 'Failed to list drafts' })
  }
})

/**
 * GET /api/drafts/:id
 * Get a specific draft
 */
app.get('/api/drafts/:id', requireAuth, (req, res) => {
  try {
    const draft = getDraft(req.params.id)
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' })
    }
    res.json(draft)
  } catch (error) {
    console.error('Error getting draft:', error)
    res.status(500).json({ error: 'Failed to get draft' })
  }
})

/**
 * POST /api/drafts/:id/post
 * Post a draft to its platform
 */
app.post('/api/drafts/:id/post', requireAuth, async (req, res) => {
  try {
    const draft = getDraft(req.params.id)
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' })
    }

    const config = loadConfig()
    const account = config.accounts[0]

    const results = []
    const postedTo = draft.posted_to || []

    // Take screenshot for posting (admin console doesn't save it in draft)
    const screenshot = await takeScreenshot(draft.diff_url)
    if (!screenshot) {
      throw new Error('Failed to capture screenshot')
    }

    try {
      // Prepare metadata for posting
      const metadata = {
        page: draft.article,
        name: draft.status_data.name,
        pageUrl: draft.status_data.pageUrl,
        userUrl: draft.status_data.userUrl
      }

      // Post to Bluesky if configured and not already posted
      if (account.bluesky && !postedTo.includes('bluesky')) {
        try {
          await bluesky.post({
            account: account.bluesky,
            text: draft.text,
            screenshot,
            metadata
          })

          console.log(`✓ Posted to Bluesky`)
          postedTo.push('bluesky')
          results.push({ platform: 'bluesky', success: true })
        } catch (error) {
          console.error(`✗ Bluesky failed:`, error.message)
          results.push({ platform: 'bluesky', success: false, error: error.message })
        }
      } else if (postedTo.includes('bluesky')) {
        results.push({ platform: 'bluesky', success: true, skipped: true })
      }

      // Post to Mastodon if configured and not already posted
      if (account.mastodon && !postedTo.includes('mastodon')) {
        try {
          await mastodon.post({
            account: account.mastodon,
            text: draft.text,
            screenshot,
            metadata
          })

          console.log(`✓ Posted to Mastodon`)
          postedTo.push('mastodon')
          results.push({ platform: 'mastodon', success: true })
        } catch (error) {
          console.error(`✗ Mastodon failed:`, error.message)
          results.push({ platform: 'mastodon', success: false, error: error.message })
        }
      } else if (postedTo.includes('mastodon')) {
        results.push({ platform: 'mastodon', success: true, skipped: true })
      }
    } finally {
      // Always clean up screenshot, even if posting fails
      if (screenshot && fs.existsSync(screenshot)) {
        fs.unlinkSync(screenshot)
      }
    }

    // Update draft with posted platforms
    draft.posted_to = postedTo
    const draftPath = path.join(DRAFTS_DIR, `${draft.id}.json`)
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2))

    // Only delete draft if ALL configured platforms succeeded
    const allPosted = (!account.bluesky || postedTo.includes('bluesky')) &&
                      (!account.mastodon || postedTo.includes('mastodon'))

    if (allPosted) {
      deleteDraft(draft.id)
      res.json({ success: true, complete: true, results })
    } else {
      // Build detailed error message
      const failures = results.filter(r => !r.success && !r.skipped)
      const failureDetails = failures.map(f => `${f.platform}: ${f.error}`).join('; ')
      res.json({
        success: true,
        complete: false,
        results,
        message: `Posted to some platforms. Failed: ${failureDetails}. Click Post to retry.`
      })
    }
  } catch (error) {
    console.error('Error posting draft:', error)
    res.status(500).json({ error: 'Failed to post', details: error.message })
  }
})

/**
 * DELETE /api/drafts/:id
 * Delete a draft without posting
 */
app.delete('/api/drafts/:id', requireAuth, (req, res) => {
  try {
    const draft = getDraft(req.params.id)
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' })
    }

    deleteDraft(req.params.id)
    res.json({ success: true, message: 'Draft deleted' })
  } catch (error) {
    console.error('Error deleting draft:', error)
    res.status(500).json({ error: 'Failed to delete draft' })
  }
})

/**
 * GET /screenshots/:filename
 * Serve screenshots (requires auth)
 */
app.get('/screenshots/:filename', requireAuth, (req, res) => {
  const screenshotPath = path.join(SCREENSHOTS_DIR, req.params.filename)
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath)
  } else {
    res.status(404).json({ error: 'Screenshot not found' })
  }
})


// Start server only if run directly (not when imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Admin server running on port ${PORT}`)
    console.log(`Passwordless authentication via Bluesky DM enabled`)
  })
}

module.exports = app
