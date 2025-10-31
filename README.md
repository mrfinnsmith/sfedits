# SF Edits

A Wikipedia edit monitoring bot that watches for edits to San Francisco-related articles and posts screenshots to Bluesky and Mastodon. Includes automated PII screening, geolocation enrichment for anonymous edits, and a web UI for reviewing blocked posts.

Based on [anon](https://github.com/edsu/anon), originally created for @congressedits.

## Architecture

**Four-service microservice architecture (docker-compose):**

1. **Bot service** (Node.js)
   - Monitors Wikipedia IRC feed for real-time edits
   - Watches configured SF-related articles
   - Screens edits for PII before posting
   - Enriches anonymous IPs with country flags (MaxMind GeoLite2-City)
   - Takes screenshots with Puppeteer
   - Posts to Bluesky and Mastodon

2. **PII service** (Python/Flask)
   - Persistent analyzer with pre-loaded spaCy model
   - Screens edits for personally identifiable information
   - Responds in ~100-200ms via HTTP API
   - Used by bot and admin console

3. **Admin console** (Node.js/Express)
   - Web UI for reviewing PII-blocked drafts
   - Bluesky DM authentication (passwordless login)
   - Posts to Bluesky and Mastodon with retry logic
   - Exposed on port 3000

4. **MaxMind updater** (curl)
   - Downloads latest IP geolocation database weekly
   - Runs continuously in background
   - Updates transparently - no restarts needed

## How it works

1. Bot detects Wikipedia edit
2. Fetches diff HTML and extracts text
3. Sends text to PII service for screening
4. **If PII detected:** Block post, save draft, send DM alerts
5. **If clean:** Enrich IP with country flag, take screenshot, post to both platforms

## Setup

### 1. Create configuration

```bash
cp config.json.template config.json
# Edit with your Bluesky/Mastodon credentials and article watchlist
```

### 2. Run locally

**Docker (recommended):**
```bash
docker-compose up -d
```

**Node.js (requires Python/PII service separate):**
```bash
npm install
node page-watch.js --noop  # Test mode - doesn't post
```

The PII service will take ~20-30 seconds to load spaCy models on first start. The bot waits for the PII service to be healthy before starting.

### 3. Deploy to production

When ready to deploy to a live server:

1. **Get a droplet** (minimum 512MB RAM, Ubuntu 22.04+)

2. **On your local machine**, create `.env`:
```bash
DROPLET_IP=your.droplet.ip
```

3. **First-time setup on droplet:**
```bash
ssh root@YOUR_DROPLET_IP
cd /root/sfedits

# Initialize git repository
git init
git remote add origin YOUR_GIT_URL
git fetch origin
git reset --hard origin/main

# Create droplet .env
cat > .env << 'EOF'
DROPLET_IP=YOUR_DROPLET_IP
EOF

# Create config.json with credentials
cp config.json.template config.json
nano config.json  # Edit with your credentials

# Start all services
docker-compose up -d
```

4. **Deploy updates:**
```bash
git add .
git commit -m "Your changes"
git push origin main
./deploy.sh
```

The deploy script pulls latest code, rebuilds containers, and restarts all services.

## Management

Once deployed, SSH into the droplet:

```bash
ssh root@YOUR_DROPLET_IP
cd /root/sfedits

# Check status
docker-compose ps

# View logs
docker-compose logs -f
docker-compose logs -f bot
docker-compose logs -f pii-service
docker-compose logs -f admin

# Restart services
docker-compose restart

# Stop all
docker-compose down
```

**To update code:** Run `./deploy.sh` on your local machine.

**To change config:** Edit `config.json` on the droplet and run `docker-compose restart bot admin`.

## Maintenance

Services automatically restart if interrupted or if the server reboots.

**Check disk usage:**
```bash
df -h /
docker system df
```

**Clean up old Docker images:**
```bash
docker system prune -af
```

## Configuration

Create `config.json` from the template:

```json
{
  "nick": "sfedits",
  "accounts": [{
    "template": "{{{page}}} Wikipedia article edited by {{{name}}} {{&url}}",
    "watchlist": {
      "English Wikipedia": {
        "San Francisco Board of Supervisors": true,
        "Daniel Lurie": true
      }
    },
    "bluesky": {
      "identifier": "your-username.bsky.social",
      "password": "your-app-password"
    },
    "mastodon": {
      "instance": "https://your-instance.social",
      "access_token": "your-access-token"
    },
    "pii_alerts": {
      "bluesky_recipient": "yourhandle.bsky.social",
      "mastodon_recipient": "yourhandle"
    }
  }]
}
```

**Important:** Never commit `config.json` - it contains credentials and is gitignored. Update it directly on the droplet when you need to change the watchlist or credentials.

### Bluesky Setup

To set up Bluesky posting and PII alert DMs:

1. Go to Bluesky Settings → App Passwords → Add App Password
2. **Critical:** Check "Allow access to your direct messages" (required for PII alerts)
3. Copy the app password to your config.json

**Note:** If PII alerts don't work, regenerate the app password with DM access enabled.

### Mastodon Setup

To set up Mastodon posting and PII alert DMs:

1. Go to your Mastodon instance's settings → Development → New Application
2. **Critical:** When selecting scopes, choose:
   - `write:media` - upload media files
   - `write:statuses` - publish posts
3. Copy the access token to your config.json

**Note:** Without the correct scopes (`write:media` and `write:statuses`), Mastodon posting will fail silently while Bluesky continues to work.

## PII Screening

The bot automatically screens all edits for personally identifiable information (PII) before posting to prevent malicious actors from using the bot to amplify private data.

### How it works

1. Bot fetches Wikipedia diff HTML and extracts text
2. Sends text to PII microservice (Python/Flask with Microsoft Presidio)
3. PII service analyzes for:
   - Email addresses
   - Phone numbers
   - Social Security Numbers
   - Credit card numbers
4. **If PII found:** Block post, save draft, send DM alerts, log to file
5. **If clean:** Post normally to Bluesky/Mastodon

The PII service runs continuously with pre-loaded spaCy models, providing fast analysis (~100-200ms per edit).

### Setup

Add `pii_alerts` to your `config.json` (shown in Configuration section above) with your personal handles:

```json
"pii_alerts": {
  "bluesky_recipient": "yourhandle.bsky.social",
  "mastodon_recipient": "yourhandle@instance.social"
}
```

**Important setup steps:**
1. **Bluesky:** Create a DM conversation between your bot account and your personal Bluesky account (send a DM manually in the app first)
2. **Bluesky:** Ensure the bot's app password has "Allow access to your direct messages" checked
3. **Mastodon:** Use format `username@instance.social` for cross-instance DMs (e.g., if bot is on `sfba.social` but you're on `mastodon.social`, use `you@mastodon.social`)

### When PII is detected

You'll receive DMs on both Bluesky and Mastodon with:
- Article name and editor
- Diff URL
- The text that would have been posted
- What PII was detected (type and confidence score)

The blocked edit is also logged to `pii-blocks.log` for SSH review.

### Admin Console for Draft Review

When PII is detected, posts are blocked and saved as drafts. The admin console is a web UI for reviewing and posting drafts.

**Deployment:**

The admin console is automatically deployed as part of `docker-compose up -d`. No separate deployment needed.

**Requirements:**
- Bot's Bluesky app password has "Allow access to your direct messages" enabled
- DM conversation exists between bot and recipient (start manually in Bluesky app)
- `pii_alerts.bluesky_recipient` is set in config.json
- Port 3000 is accessible

**Access:**
- URL: `http://your-droplet-ip:3000`
- Click "Send Code to Bluesky" → Check DMs → Enter 6-digit code
- Session lasts 24 hours

**Features:**
- Review blocked posts with screenshots
- See detected PII types and confidence scores
- Post to both platforms with one click
- Automatic retry if one platform fails

### Fail-safe design

The system blocks posts if:
- PII is detected with any confidence level
- Diff text cannot be extracted from Wikipedia
- PII service is unreachable or times out (5s timeout)
- Any unexpected error occurs during screening

If the PII service is unavailable, the bot allows posts through with a warning log (avoiding complete service outage). The persistent microservice architecture makes this scenario rare.

### Accuracy

Based on testing with Wikipedia-style content:
- **87.5% accuracy** overall
- **0% false positives** on clean Wikipedia edits
- **100% detection** on emails, phone numbers, and SSNs

## Monitored Articles

Currently configured to monitor SF political figures across **10 language Wikipedias**:
- **English**: SF Board of Supervisors, mayors, city officials, state legislators
- **Arabic, Chinese, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish**: Translations of major political figures

The config includes:
- Current and recent SF mayors (Breed, Newsom, Lee, etc.)
- All current Board of Supervisors members
- Key city officials (DA, Sheriff, Police Commission)
- Major historical figures (Feinstein, Moscone, Willie Brown)
- State/federal legislators (Pelosi, Wiener, Harris)
- Corruption scandals and investigations

Use the translation scripts to expand to additional languages or discover new articles to monitor.

## Development

### Testing

The codebase has comprehensive test coverage to ensure reliability:

```bash
npm test  # Run all tests (~3 seconds)
```

**Test suite:**
- **41 passing tests** covering posting flow, text transformations, and URL helpers
- **Integration test** that mocks Bluesky/Mastodon APIs and validates end-to-end posting
- **Unit tests** for text pipeline, geolocation, facet building, and URL generation

Tests use:
- `mocha` + `chai` for test framework and assertions
- `nock` for HTTP API mocking (Bluesky, Mastodon)
- `proxyquire` for dependency injection
- `sinon` for function stubbing

**When to run tests:**
- Before committing changes
- After modifying posting flow or text transformations
- Before refactoring or extracting code to `lib/`

### Local Development

```bash
npm install                 # Install dependencies
npm test                    # Run tests
node page-watch.js --noop   # Test mode - doesn't post
node page-watch.js --verbose # Show all edit activity
```

**Test mode (`--noop`):**
- Monitors Wikipedia edits in real-time
- Logs what would be posted
- Doesn't actually post to Bluesky/Mastodon
- Useful for testing config changes

## Scripts

### `scripts/find-categories.js`

Analyzes Wikipedia categories for all articles in your config to help identify patterns for finding equivalent articles across different language Wikipedias.

```bash
node scripts/find-categories.js
```

This script:
- Fetches categories for each article in your English Wikipedia watchlist
- Helps identify common category patterns (e.g., "San Francisco Board of Supervisors members")
- Useful for expanding monitoring to other language Wikipedias

### `scripts/find-articles-in-categories.js`

Finds all Wikipedia articles within specified categories. Can be used standalone or piped from the category finder to discover related articles.

```bash
# Use with specific categories
node scripts/find-articles-in-categories.js "Mayors of San Francisco" "California politicians"

# Pipe from category finder to discover articles in all found categories
node scripts/find-categories.js | node scripts/find-articles-in-categories.js
```

This script:
- Takes category names as input and finds all articles in those categories
- Supports piping from find-categories.js output
- Useful for discovering related political figures to add to your watchlist
- Provides summary of unique articles across all categories

### `scripts/find-translations.js`

Finds all Wikipedia language translations for articles in your config. Helps discover equivalent articles across different language Wikipedias.

```bash
node scripts/find-translations.js
```

This script:
- Analyzes all articles in your current config
- Finds translations in other language Wikipedias
- Shows language codes and translated article titles
- Useful for expanding monitoring to multiple language Wikipedias

## License

CC0 - Public Domain