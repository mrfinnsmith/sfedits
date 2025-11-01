/**
 * Admin authentication import verification
 *
 * CRITICAL: This test would have caught the bug from commit 9330e41
 * where createAuthenticatedAgent import was removed but still used on line 98
 */

const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')

describe('Admin Server - Import Verification', function() {
  it('loads without ReferenceError (catches missing imports)', function() {
    // This verifies all imports resolve correctly
    // Would have caught: "createAuthenticatedAgent is not defined"

    let app
    try {
      app = require('../admin/server.js')
    } catch (error) {
      if (error.message.includes('is not defined')) {
        assert.fail(`Missing import detected: ${error.message}`)
      }
      throw error
    }

    assert.ok(app, 'Admin server should load successfully')
    assert.equal(typeof app, 'function', 'Should export Express app')
  })

  it('admin/server.js imports createAuthenticatedAgent', function() {
    // Verify the import statement exists in the source file
    const serverPath = path.join(__dirname, '../admin/server.js')
    const content = fs.readFileSync(serverPath, 'utf8')

    const hasImport = content.includes('createAuthenticatedAgent') &&
                      content.includes("require('../lib/bluesky-client')")

    assert.ok(hasImport,
      'admin/server.js must import createAuthenticatedAgent from ../lib/bluesky-client')

    const usesFunction = content.includes('await createAuthenticatedAgent(')

    assert.ok(usesFunction,
      'admin/server.js must use createAuthenticatedAgent (called on line 98)')
  })
})
