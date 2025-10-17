# SF Edits

A Wikipedia edit monitoring bot that watches for anonymous edits to San Francisco-related articles and posts screenshots to Bluesky and Mastodon.

Based on [anon](https://github.com/edsu/anon), originally created for @congressedits.

## How it works

1. Connects to Wikipedia's IRC feed to monitor real-time edits
2. Watches for edits to configured SF-related articles
3. Takes screenshots of the diff using Puppeteer
4. Posts to Bluesky and Mastodon with the screenshot

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
# Add swap for Docker builds
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

# Install dependencies
apt update && apt install -y docker.io git

# Clone and build
git clone https://github.com/mrfinnsmith/sfedits.git && cd sfedits
docker build -t sfedits .
```

3. **Configure:**
```bash
cp config.json.template config.json
vi config.json  # Add your Bluesky/Mastodon credentials and watchlist
```

4. **Run:**
```bash
docker run -d --restart unless-stopped --name sfedits-bot \
  -v /root/sfedits/config.json:/opt/sfedits/config.json sfedits
```

## Management Commands

```bash
# Check status
docker ps
docker logs sfedits-bot

# Follow logs in real-time
docker logs -f sfedits-bot

# Control bot
docker stop sfedits-bot
docker start sfedits-bot
docker restart sfedits-bot

# Update config and restart
vi config.json
docker restart sfedits-bot

# Deploy code changes (after git push from local)
git pull && docker build -t sfedits . && docker stop sfedits-bot && docker rm sfedits-bot && docker run -d --restart unless-stopped --name sfedits-bot -v /root/sfedits/config.json:/opt/sfedits/config.json sfedits

# Check restart policy (should show "unless-stopped")
docker inspect sfedits-bot | grep -A 3 RestartPolicy
```

**Note:** The container is configured with `--restart unless-stopped` so it will automatically restart if interrupted or if the server reboots.

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
    }
  }]
}
```

**Important:** Never commit `config.json` - it contains credentials and is gitignored. Update it directly on the droplet when you need to change the watchlist or credentials.

### Mastodon Setup

To set up Mastodon posting, you need to create an application on your Mastodon instance:

1. Go to your Mastodon instance's settings → Development → New Application
2. **Critical:** When selecting scopes, choose:
   - `write:media` - upload media files
   - `write:statuses` - publish posts
3. Copy the access token to your config.json

**Note:** Without the correct scopes (`write:media` and `write:statuses`), Mastodon posting will fail silently while Bluesky continues to work.

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