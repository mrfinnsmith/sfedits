# SF Edits

A Wikipedia edit monitoring bot that watches for anonymous edits to San Francisco-related articles and posts screenshots to Bluesky.

Based on [anon](https://github.com/edsu/anon), originally created for @congressedits.

## How it works

1. Connects to Wikipedia's IRC feed to monitor real-time edits
2. Watches for edits to configured SF-related articles
3. Takes screenshots of the diff using Puppeteer
4. Posts to Bluesky with the screenshot

## Quick Start

### Local Development

```bash
git clone https://github.com/mrfinnsmith/sfedits.git
cd sfedits
npm install
cp config.json.template config.json
# Edit config.json with your Bluesky credentials and watchlist
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
vi config.json  # Add your Bluesky credentials and watchlist
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

# Check restart policy (should show "unless-stopped")
docker inspect sfedits-bot | grep -A 3 RestartPolicy
```

**Note:** The container is configured with `--restart unless-stopped` so it will automatically restart if interrupted or if the server reboots.

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
    }
  }]
}
```

**Important:** Never commit `config.json` - it contains credentials and is gitignored. Update it directly on the droplet when you need to change the watchlist or credentials.

## Monitored Articles

Currently watching edits to SF politicians and government:
- SF Board of Supervisors members
- SF Mayor and officials  
- SF Police/Sheriff departments
- CA legislators representing SF

Add/remove articles in the `watchlist` section of your config.

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

## License

CC0 - Public Domain