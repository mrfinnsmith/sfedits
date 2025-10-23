# SF Edits

A Wikipedia edit monitoring bot that watches for edits to San Francisco-related articles and posts screenshots to Bluesky and Mastodon with automated PII screening.

Based on [anon](https://github.com/edsu/anon), originally created for @congressedits.

## Architecture

**Two-service microservice architecture:**

1. **Bot service** (Node.js)
   - Monitors Wikipedia IRC feed for real-time edits
   - Watches configured SF-related articles
   - Takes screenshots with Puppeteer
   - Posts to Bluesky and Mastodon

2. **PII service** (Python/Flask)
   - Persistent analyzer with pre-loaded spaCy models
   - Screens edits for personally identifiable information
   - Responds in ~100-200ms via HTTP API

## How it works

1. Bot detects edit → Fetches diff from Wikipedia
2. Sends diff text to PII service for analysis
3. **If PII detected:** Block post, save draft, send DM alerts
4. **If clean:** Take screenshot and post to both platforms

## Quick Start

### Local Development

```bash
git clone https://github.com/mrfinnsmith/sfedits.git
cd sfedits
npm install
cp config.json.template config.json
# Edit config.json with your Bluesky/Mastodon credentials and watchlist
node page-watch.js --noop  # Test mode - doesn't post
```

### Production Deployment (Digital Ocean)

1. **Create droplet** (minimum 512MB RAM) with Ubuntu 22.04+

2. **Setup server:**
```bash
# Add swap for Puppeteer/Chrome (REQUIRED for 512MB droplet)
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Install dependencies
apt update && apt install -y docker.io docker-compose git

# Clone repo
git clone https://github.com/mrfinnsmith/sfedits.git
cd sfedits
```

3. **Configure:**
```bash
cp config.json.template config.json
vi config.json  # Add your Bluesky/Mastodon credentials and watchlist
```

4. **Deploy:**
```bash
docker-compose up -d
```

The PII service will take ~20-30 seconds to load spaCy models on first start. The bot waits for the PII service to be healthy before starting.

## Management Commands

```bash
# Check status
docker-compose ps

# View logs
docker-compose logs -f          # Both services
docker-compose logs -f bot      # Bot only
docker-compose logs -f pii-service  # PII service only

# Control services
docker-compose restart          # Restart both
docker-compose restart bot      # Restart bot only
docker-compose stop             # Stop all
docker-compose down             # Stop and remove containers

# Update config and restart
vi config.json
docker-compose restart bot

# Deploy code changes
git pull && docker-compose down && docker system prune -af && docker-compose build && docker-compose up -d
```

**Note:** Services are configured with `restart: unless-stopped` so they automatically restart if interrupted or if the server reboots.

## Maintenance

**Automated systems in place:**
- Weekly Docker cleanup (Sundays 3am) - removes unused images/containers older than 7 days
- Docker logs capped at 50MB per container
- System logs capped at 500MB
- Email alerts at 75% disk usage via Digital Ocean monitoring

**Manual disk check:**
```bash
df -h /                # Overall disk usage
docker system df       # Docker-specific usage
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

**Deploy admin console (separate container):**

```bash
docker build -t sfedits-admin -f admin/Dockerfile . && \
docker run -d \
  --name sfedits-admin \
  -p 3000:3000 \
  -e CONFIG_PATH=/opt/sfedits-admin/config.json \
  -v $(pwd)/config.json:/opt/sfedits-admin/config.json:ro \
  -v $(pwd)/drafts:/opt/sfedits-admin/drafts \
  --restart unless-stopped \
  sfedits-admin
```

**Requirements:**
- Bot's Bluesky app password must have "Allow access to your direct messages" enabled
- Create a DM conversation between bot account and `pii_alerts.bluesky_recipient` (send one DM manually in Bluesky app)
- `pii_alerts.bluesky_recipient` must be set in config.json
- Port 3000 must be accessible

**Access:**
- URL: `http://your-droplet-ip:3000`
- Click "Send Code to Bluesky" → Check DMs → Enter 6-digit code
- Session lasts 24 hours

**Update admin code:**
```bash
git pull && \
docker stop sfedits-admin && docker rm sfedits-admin && \
docker build -t sfedits-admin -f admin/Dockerfile . && \
docker run -d \
  --name sfedits-admin \
  -p 3000:3000 \
  -e CONFIG_PATH=/opt/sfedits-admin/config.json \
  -v $(pwd)/config.json:/opt/sfedits-admin/config.json:ro \
  -v $(pwd)/drafts:/opt/sfedits-admin/drafts \
  --restart unless-stopped \
  sfedits-admin
```

**Features:**
- Review blocked posts with screenshots
- See detected PII types and confidence scores
- Post to both platforms with one click
- Automatic retry (if one platform fails, retry posts only to that platform)

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

```bash
npm test                    # Run tests
node page-watch.js --noop   # Test without posting
node page-watch.js --verbose # Show all edit activity
```

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