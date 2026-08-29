const { describe, it, beforeEach, afterEach } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { getConfig, countWatchlist, loadWatchlist } = require('../lib/config')
const { extractWatchlist } = require('../scripts/extract-watchlist')
const pageWatch = require('../page-watch')

describe('Watchlist and Configuration Loading', function() {
  let tmpDir

  beforeEach(function() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfedits-test-'))
  })

  afterEach(function() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('countWatchlist', function() {
    it('returns 0 wikis and 0 titles for null or non-object watchlist', function() {
      assert.deepEqual(countWatchlist(null), { wikis: 0, titles: 0 })
      assert.deepEqual(countWatchlist(undefined), { wikis: 0, titles: 0 })
      assert.deepEqual(countWatchlist('invalid'), { wikis: 0, titles: 0 })
    })

    it('returns correct counts for single wiki and multiple titles', function() {
      const watchlist = {
        'English Wikipedia': {
          'San Francisco Board of Supervisors': true,
          'Daniel Lurie': true,
          'London Breed': true
        }
      }
      assert.deepEqual(countWatchlist(watchlist), { wikis: 1, titles: 3 })
    })

    it('returns correct counts across multiple wikis', function() {
      const watchlist = {
        'English Wikipedia': {
          'San Francisco Board of Supervisors': true,
          'Daniel Lurie': true
        },
        'Spanish Wikipedia': {
          'San Francisco': true
        },
        'French Wikipedia': {
          'San Francisco': true,
          'Alcatraz': true
        }
      }
      assert.deepEqual(countWatchlist(watchlist), { wikis: 3, titles: 5 })
    })
  })

  describe('getConfig watchlist resolution', function() {
    it('loads watchlist from watchlist.json when present next to config.json', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [
          {
            template: '{{{page}}} edited',
            bluesky: { identifier: 'test.bsky.social' }
          }
        ]
      }
      const watchlistData = {
        'English Wikipedia': {
          'Golden Gate Bridge': true,
          'Coit Tower': true
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify(watchlistData), 'utf8')

      const config = getConfig(configPath, null, { silent: true })

      assert.isDefined(config.accounts[0].watchlist)
      assert.deepEqual(config.accounts[0].watchlist, watchlistData)
    })

    it('uses inline config.json watchlist when watchlist.json is absent', function() {
      const configPath = path.join(tmpDir, 'config.json')

      const inlineWatchlist = {
        'English Wikipedia': {
          'Twin Peaks': true
        }
      }
      const configData = {
        nick: 'testbot',
        accounts: [
          {
            template: '{{{page}}} edited',
            watchlist: inlineWatchlist,
            bluesky: { identifier: 'test.bsky.social' }
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')

      const config = getConfig(configPath, null, { silent: true })

      assert.isDefined(config.accounts[0].watchlist)
      assert.deepEqual(config.accounts[0].watchlist, inlineWatchlist)
    })

    it('throws when inline and file watchlists differ (migration guard)', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const inlineWatchlist = {
        'English Wikipedia': {
          'Old Inline Article': true
        }
      }
      const fileWatchlist = {
        'English Wikipedia': {
          'New File Article': true
        }
      }

      const configData = {
        nick: 'testbot',
        accounts: [
          {
            template: '{{{page}}} edited',
            watchlist: inlineWatchlist
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify(fileWatchlist), 'utf8')

      assert.throws(() => {
        getConfig(configPath, null, { silent: true })
      }, /Watchlist conflict.*extract-watchlist/)
    })

    it('does not throw when inline and file watchlists are deep-equal (idempotent re-deploy)', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const inlineWatchlist = {
        'English Wikipedia': {
          'New File Article': true
        }
      }
      const fileWatchlist = {
        'English Wikipedia': {
          'New File Article': true
        }
      }

      const configData = {
        nick: 'testbot',
        accounts: [
          {
            template: '{{{page}}} edited',
            watchlist: inlineWatchlist
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify(fileWatchlist), 'utf8')

      const config = getConfig(configPath, null, { silent: true })

      assert.deepEqual(config.accounts[0].watchlist, fileWatchlist)
    })

    it('throws when a top-level config.watchlist differs from the file (migration guard)', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const configData = {
        nick: 'testbot',
        watchlist: {
          'English Wikipedia': {
            'Inline Top Level': true
          }
        },
        accounts: [{ template: 'test' }]
      }
      const fileWatchlist = {
        'English Wikipedia': {
          'File Title': true
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify(fileWatchlist), 'utf8')

      assert.throws(() => {
        getConfig(configPath, null, { silent: true })
      }, /Watchlist conflict/)
    })

    it('does not throw when the inline watchlist is empty and the file has titles', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [
          {
            template: 'test',
            watchlist: {}
          }
        ]
      }
      const fileWatchlist = {
        'English Wikipedia': {
          'File Title': true
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify(fileWatchlist), 'utf8')

      const config = getConfig(configPath, null, { silent: true })

      assert.deepEqual(config.accounts[0].watchlist, fileWatchlist)
    })

    it('supports explicit watchlist path override', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const customWatchlistPath = path.join(tmpDir, 'custom-watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [{ template: 'test' }]
      }
      const customWatchlist = {
        'Spanish Wikipedia': {
          'San Francisco': true
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(customWatchlistPath, JSON.stringify(customWatchlist), 'utf8')

      const config = getConfig(configPath, customWatchlistPath, { silent: true })

      assert.deepEqual(config.accounts[0].watchlist, customWatchlist)
    })

    it('fails loudly when watchlist.json is malformed (invalid JSON)', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [{ template: 'test' }]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, '{ "English Wikipedia": { invalid json }', 'utf8')

      assert.throws(() => {
        getConfig(configPath, null, { silent: true })
      }, SyntaxError)
    })

    it('fails loudly when explicit watchlist path does not exist', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const missingWatchlistPath = path.join(tmpDir, 'nonexistent-watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [{ template: 'test' }]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')

      assert.throws(() => {
        getConfig(configPath, missingWatchlistPath, { silent: true })
      }, Error)
    })

    it('fails loudly when watchlist.json is unreadable due to permissions', function() {
      // Skip if running as root where permissions might be bypassed
      if (process.getuid && process.getuid() === 0) {
        this.skip()
      }

      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [{ template: 'test' }]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify({ 'English Wikipedia': { 'Test': true } }), 'utf8')
      fs.chmodSync(watchlistPath, 0o000)

      try {
        assert.throws(() => {
          getConfig(configPath, null, { silent: true })
        }, /EACCES|permission/i)
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(watchlistPath, 0o644)
      }
    })

    it('populates watchlist for all accounts in config.accounts', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const watchlistPath = path.join(tmpDir, 'watchlist.json')

      const configData = {
        nick: 'testbot',
        accounts: [
          { template: 'account 1' },
          { template: 'account 2' }
        ]
      }
      const watchlistData = {
        'English Wikipedia': {
          'Presidio of San Francisco': true
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(watchlistPath, JSON.stringify(watchlistData), 'utf8')

      const config = getConfig(configPath, null, { silent: true })

      assert.equal(config.accounts.length, 2)
      assert.deepEqual(config.accounts[0].watchlist, watchlistData)
      assert.deepEqual(config.accounts[1].watchlist, watchlistData)
    })

    it('loads externally referenced ranges file when specified as string', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const rangesPath = path.join(tmpDir, 'ranges.json')

      const rangesData = ['192.168.1.0/24']
      const configData = {
        nick: 'testbot',
        accounts: [
          {
            template: 'test',
            ranges: './ranges.json',
            watchlist: { 'English Wikipedia': { 'Test': true } }
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(configData), 'utf8')
      fs.writeFileSync(rangesPath, JSON.stringify(rangesData), 'utf8')

      const config = getConfig(configPath, null, { silent: true })

      assert.deepEqual(config.accounts[0].ranges, rangesData)
    })
  })

  describe('loadWatchlist shape validation', function() {
    function writeWatchlist(content) {
      const watchlistPath = path.join(tmpDir, 'watchlist.json')
      fs.writeFileSync(watchlistPath, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
      return watchlistPath
    }

    it('rejects an empty object watchlist', function() {
      const watchlistPath = writeWatchlist({})
      assert.throws(() => loadWatchlist(watchlistPath), /empty \(no wikis\)/)
    })

    it('rejects a JSON string watchlist', function() {
      const watchlistPath = writeWatchlist('"just a string"')
      assert.throws(() => loadWatchlist(watchlistPath), /Invalid watchlist/)
    })

    it('rejects an array watchlist', function() {
      const watchlistPath = writeWatchlist(['English Wikipedia'])
      assert.throws(() => loadWatchlist(watchlistPath), /Invalid watchlist/)
    })

    it('rejects a wiki mapping to an empty object', function() {
      const watchlistPath = writeWatchlist({ 'English Wikipedia': {} })
      assert.throws(() => loadWatchlist(watchlistPath), /has no titles/)
    })

    it('rejects a non-boolean leaf', function() {
      const watchlistPath = writeWatchlist({ 'English Wikipedia': { 'Test Article': 'yes' } })
      assert.throws(() => loadWatchlist(watchlistPath), /must be a boolean/)
    })

    it('accepts a valid watchlist', function() {
      const watchlistPath = writeWatchlist({ 'English Wikipedia': { 'Test Article': true } })
      assert.deepEqual(loadWatchlist(watchlistPath), { 'English Wikipedia': { 'Test Article': true } })
    })
  })

  describe('page-watch checkConfig', function() {
    it('fails when the resolved watchlist is empty', function(done) {
      const config = {
        nick: 'testbot',
        accounts: [{ template: 'test', watchlist: {} }]
      }
      pageWatch.checkConfig(config, function(err) {
        try {
          assert.isOk(err)
          assert.match(String(err), /watchlist/i)
          done()
        } catch (e) {
          done(e)
        }
      })
    })

    it('passes when the resolved watchlist has a wiki with titles', function(done) {
      const config = {
        nick: 'testbot',
        accounts: [{
          template: 'test',
          watchlist: { 'English Wikipedia': { 'Golden Gate Bridge': true } }
        }]
      }
      pageWatch.checkConfig(config, function(err) {
        try {
          assert.isNotOk(err)
          done()
        } catch (e) {
          done(e)
        }
      })
    })
  })

  describe('scripts/extract-watchlist.js', function() {
    it('extracts watchlist into committed shape and strips all credentials', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const outputPath = path.join(tmpDir, 'extracted-watchlist.json')

      const fixtureConfig = {
        nick: 'sfedits',
        accounts: [
          {
            template: '{{{page}}} Wikipedia article edited by {{{name}}} {{&url}}',
            watchlist: {
              'English Wikipedia': {
                'San Francisco Board of Supervisors': true,
                'Daniel Lurie': true,
                'London Breed': true
              },
              'Spanish Wikipedia': {
                'San Francisco (California)': true
              }
            },
            bluesky: {
              identifier: 'secret-bot.bsky.social',
              password: 'super-secret-password-1234'
            },
            mastodon: {
              instance: 'https://secret.instance',
              access_token: 'secret-access-token-5678'
            },
            pii_alerts: {
              bluesky_recipient: 'admin.bsky.social',
              mastodon_recipient: 'admin@instance.social'
            },
            pii_blocking: {
              enabled: true,
              blocked_entity_types: ['EMAIL_ADDRESS', 'PHONE_NUMBER']
            }
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(fixtureConfig, null, 2), 'utf8')

      const result = extractWatchlist(configPath, outputPath)

      assert.equal(result.wikis, 2)
      assert.equal(result.titles, 4)
      assert.isTrue(fs.existsSync(outputPath))

      const writtenContent = fs.readFileSync(outputPath, 'utf8')
      const parsedWatchlist = JSON.parse(writtenContent)

      // Expected shape: wiki -> title -> true
      assert.deepEqual(parsedWatchlist, {
        'English Wikipedia': {
          'San Francisco Board of Supervisors': true,
          'Daniel Lurie': true,
          'London Breed': true
        },
        'Spanish Wikipedia': {
          'San Francisco (California)': true
        }
      })

      // Must not contain any credential fields or other config keys
      assert.isUndefined(parsedWatchlist.bluesky)
      assert.isUndefined(parsedWatchlist.mastodon)
      assert.isUndefined(parsedWatchlist.pii_alerts)
      assert.isUndefined(parsedWatchlist.pii_blocking)
      assert.isUndefined(parsedWatchlist.nick)
      assert.isUndefined(parsedWatchlist.template)
      assert.isUndefined(parsedWatchlist.password)
      assert.isUndefined(parsedWatchlist.access_token)

      // Raw written content must not contain any secret values
      assert.notInclude(writtenContent, 'secret')
      assert.notInclude(writtenContent, 'super-secret-password-1234')
      assert.notInclude(writtenContent, 'secret-access-token-5678')
      assert.notInclude(writtenContent, 'admin.bsky.social')
    })

    it('merges watchlists across multiple accounts', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const outputPath = path.join(tmpDir, 'extracted-watchlist.json')

      const fixtureConfig = {
        accounts: [
          {
            watchlist: {
              'English Wikipedia': {
                'Article One': true
              }
            },
            bluesky: { password: 'pwd1' }
          },
          {
            watchlist: {
              'English Wikipedia': {
                'Article Two': true
              },
              'French Wikipedia': {
                'Article Un': true
              }
            },
            bluesky: { password: 'pwd2' }
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(fixtureConfig), 'utf8')

      const result = extractWatchlist(configPath, outputPath)
      assert.equal(result.wikis, 2)
      assert.equal(result.titles, 3)

      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      assert.deepEqual(written, {
        'English Wikipedia': {
          'Article One': true,
          'Article Two': true
        },
        'French Wikipedia': {
          'Article Un': true
        }
      })
    })

    it('fails when config file does not exist', function() {
      const missingConfig = path.join(tmpDir, 'missing.json')
      const outputPath = path.join(tmpDir, 'out.json')

      assert.throws(() => {
        extractWatchlist(missingConfig, outputPath)
      }, /Failed to read config file/)
    })

    it('fails when config file has no watchlist', function() {
      const configPath = path.join(tmpDir, 'config.json')
      const outputPath = path.join(tmpDir, 'out.json')

      fs.writeFileSync(configPath, JSON.stringify({ nick: 'bot', accounts: [{ template: 'test' }] }), 'utf8')

      assert.throws(() => {
        extractWatchlist(configPath, outputPath)
      }, /No watchlist found in config file/)
    })

    it('executes via CLI and prints summary line', function(done) {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'extract-watchlist.js')
      const configPath = path.join(tmpDir, 'config.json')
      const outputPath = path.join(tmpDir, 'out-watchlist.json')

      const fixtureConfig = {
        accounts: [
          {
            watchlist: {
              'English Wikipedia': {
                'City Hall': true
              }
            }
          }
        ]
      }

      fs.writeFileSync(configPath, JSON.stringify(fixtureConfig), 'utf8')

      execFile(process.execPath, [scriptPath, '--config', configPath, '--output', outputPath], (err, stdout, stderr) => {
        assert.isNull(err)
        assert.include(stdout, 'Extracted watchlist with 1 title across 1 wiki')
        assert.isTrue(fs.existsSync(outputPath))
        const extracted = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
        assert.deepEqual(extracted, { 'English Wikipedia': { 'City Hall': true } })
        done()
      })
    })

    it('executes via CLI with --help flag', function(done) {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'extract-watchlist.js')

      execFile(process.execPath, [scriptPath, '--help'], (err, stdout, stderr) => {
        assert.isNull(err)
        assert.include(stdout, 'Usage: node scripts/extract-watchlist.js')
        assert.include(stdout, '--config')
        assert.include(stdout, '--output')
        done()
      })
    })
  })
})
