const https = require('https')
const fs = require('fs')
const path = require('path')

// Prefer Pro (free with Google One/AI Pro), fall back to Flash (always free)
const MODEL_PRO = 'gemini-2.5-pro'
const MODEL_FLASH = 'gemini-2.0-flash'
const API_BASE = 'generativelanguage.googleapis.com'

const LOG_FILE = path.join(__dirname, '..', 'data', 'gemini-pii-checks.log')

// Cache which model to use so we only probe once per process lifetime
let resolvedModel = null

const PROMPT_TEMPLATE = `You are a PII (personally identifiable information) reviewer for a bot that posts Wikipedia edit summaries to social media.

A PII detection system flagged the following post text as containing PII. Your job is to determine if this is a TRUE positive (real PII that should not be posted) or a FALSE positive (not actually PII).

Context: Wikipedia editors often have usernames that look like real names but are pseudonyms. IP addresses of anonymous editors are expected and acceptable. Article titles may contain names of public figures, which are not PII.

Post text:
"""
{POST_TEXT}
"""

Detected entities:
{ENTITIES}

Respond with ONLY a JSON object (no markdown, no code fences):
{"is_pii": true/false, "reason": "brief explanation"}`

/**
 * Verify Presidio's PII detection using Gemini.
 * Returns:
 *   'false_positive' - Gemini confidently says not real PII, safe to post
 *   'confirmed'      - Gemini confirms real PII, block the post
 *   'unavailable'    - Could not reach Gemini or parse response, fall back to blocking
 */
async function verifyPIIWithGemini(postText, entities) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    logCheck({ status: 'unavailable', reason: 'GEMINI_API_KEY not set', postText, entities })
    return 'unavailable'
  }

  const entityDescriptions = entities.map(e => {
    const snippet = postText.substring(e.start, e.end)
    return `- Type: ${e.type}, Text: "${snippet}", Confidence: ${e.score}`
  }).join('\n')

  const prompt = PROMPT_TEMPLATE
    .replace('{POST_TEXT}', postText)
    .replace('{ENTITIES}', entityDescriptions)

  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 }
    }
  })

  let model, rawResponse
  try {
    model = await pickModel(apiKey)
    const reqPath = `/v1beta/models/${model}:generateContent?key=${apiKey}`
    rawResponse = await makeRequest(reqPath, requestBody)
  } catch (error) {
    logCheck({ status: 'unavailable', reason: error.message, model, postText, entities })
    return 'unavailable'
  }

  try {
    const response = JSON.parse(rawResponse)
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text
    const usage = response.usageMetadata || {}

    const tokenInfo = {
      promptTokenCount: usage.promptTokenCount || 0,
      totalTokenCount: usage.totalTokenCount || 0
    }

    if (!text) {
      logCheck({ status: 'unavailable', reason: 'empty response from Gemini', model, rawResponse, postText, entities, ...tokenInfo })
      return 'unavailable'
    }

    // Strip markdown code fences if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const result = JSON.parse(cleaned)

    if (typeof result.is_pii !== 'boolean') {
      logCheck({ status: 'unavailable', reason: 'is_pii not a boolean', model, geminiResponse: text, postText, entities, ...tokenInfo })
      return 'unavailable'
    }

    const status = result.is_pii ? 'confirmed' : 'false_positive'
    logCheck({ status, model, reason: result.reason, postText, entities, geminiResponse: text, ...tokenInfo })
    return status
  } catch (error) {
    logCheck({ status: 'unavailable', reason: 'failed to parse response: ' + error.message, model, rawResponse, postText, entities })
    return 'unavailable'
  }
}

const MAX_LOG_BYTES = 1024 * 1024 // 1MB

function logCheck(entry) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  }
  const level = entry.status === 'false_positive' ? '✓' : entry.status === 'confirmed' ? '🚫' : '⚠'
  console.log(`${level} Gemini PII check: ${entry.status} - ${entry.reason || 'no reason'}`)

  try {
    trimLogIfNeeded()
    fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n')
  } catch (err) {
    console.error('Failed to write gemini PII log:', err.message)
  }
}

function trimLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size < MAX_LOG_BYTES) return

    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    // Keep the newest half
    const keep = lines.slice(Math.floor(lines.length / 2))
    fs.writeFileSync(LOG_FILE, keep.join('\n') + '\n')
  } catch (err) {
    if (err.code === 'ENOENT') return
    console.error('Failed to trim gemini PII log:', err.message)
  }
}

/**
 * Check if Pro is available (free with paid Google account), otherwise use Flash.
 * Result is cached for the lifetime of the process.
 */
async function pickModel(apiKey) {
  if (resolvedModel) return resolvedModel

  try {
    const probe = `/v1beta/models/${MODEL_PRO}?key=${apiKey}`
    await makeRequest(probe, null, 'GET')
    resolvedModel = MODEL_PRO
    console.log(`✓ Gemini Pro available - using ${MODEL_PRO}`)
  } catch {
    resolvedModel = MODEL_FLASH
    console.log(`✓ Gemini Pro not available - using ${MODEL_FLASH}`)
  }
  return resolvedModel
}

function makeRequest(reqPath, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (body) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
    }

    const req = https.request({
      hostname: API_BASE,
      path: reqPath,
      method: method,
      headers: headers
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Gemini API returned ${res.statusCode}: ${data}`))
          return
        }
        resolve(data)
      })
    })

    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy(new Error('Gemini API request timed out'))
    })
    if (body) req.write(body)
    req.end()
  })
}

module.exports = { verifyPIIWithGemini }
