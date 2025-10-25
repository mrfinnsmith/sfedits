# IP Geolocation Preview Implementation

## Overview

Created a standalone Node.js script that fetches all posts from the sfedits Bluesky account, identifies posts containing IP addresses from anonymous Wikipedia edits, enriches them with country flag emojis via local MaxMind GeoLite2 database lookup, and displays formatted previews of how those posts would appear on both Bluesky and Mastodon.

## Files Created

- `scripts/preview-ip-geolocation.js` - Main script

## Functionality

### Data Collection
1. Authenticates to Bluesky API using credentials from `config.json`
2. Fetches the last 100 posts from the sfedits bot account
3. Scans each post text for IPv4 and IPv6 addresses using regex patterns

### Geolocation Lookup
1. For each IP found, performs local database lookup against MaxMind GeoLite2-City
2. Retrieves country code (ISO 3166-1 alpha-2 format)
3. Converts country code to Unicode flag emoji
4. Zero latency, no external API calls, no rate limits

### Output Format

Displays posts with IP addresses in the following format:

```
📅 [Date/Time]

📍 BLUESKY:
   [Article name] Wikipedia article edited by [IP] [Country Flag] [URL]

🐘 MASTODON:
   [Article name] Wikipedia article edited by [IP] [Country Flag] ([URL])
```

Example:
```
📅 10/24/2025, 12:24:39 PM

📍 BLUESKY:
   Gavin Newsom Wikipedia article edited by 67.188.85.86 🇺🇸 https://es.wikipedia.org/w/index.php?diff=170149238&oldid=170148615

🐘 MASTODON:
   Gavin Newsom Wikipedia article edited by 67.188.85.86 🇺🇸 (https://es.wikipedia.org/w/index.php?diff=170149238&oldid=170148615)
```

## Data Found

Script identified 12 posts containing IP addresses from anonymous edits:
- 8 posts from US (🇺🇸)
- 1 post from Puerto Rico (🇵🇷)
- 1 post from Dominican Republic (🇩🇴)
- 1 post from France (🇫🇷)
- 1 post from Russia (🇷🇺)

## Technical Details

### IP Detection
- IPv4 pattern: `\b(?:\d{1,3}\.){3}\d{1,3}\b`
- IPv6 pattern: `(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}`

### MaxMind GeoLite2-City Database
- Format: Binary `.mmdb` file (highly compressed)
- Size: ~50MB
- Contains: ~3-5 million IP network blocks with country-level mapping
- Update: Weekly via free MaxMind GeoLite2 service
- Lookup: Binary search in `.mmdb` file, microsecond latency
- License: Explicitly permits public, non-commercial use

### Country Code to Flag Emoji Conversion
Uses Unicode regional indicator symbols (combining two code points):
- Example: US → 🇺🇸
- All ISO 3166-1 alpha-2 codes supported

## Configuration

No configuration changes required. Script reads from existing `config.json`:
- `accounts[0].bluesky.identifier`
- `accounts[0].bluesky.password`

## Running the Script

```bash
node scripts/preview-ip-geolocation.js
```

Output includes:
1. Progress messages as IPs are discovered
2. Summary count of posts with IPs
3. Formatted preview of each post for both platforms

## Dependencies

Uses existing project dependencies:
- `@atproto/api` - Bluesky API client

Production implementation requires:
- `maxmind` - JavaScript library for `.mmdb` file parsing (npm install maxmind)

## Notes

- Script is read-only; does not modify posts or configuration
- Bluesky credentials from config.json are used for authentication
- Country flags are Unicode regional indicator symbols (ISO 3166-1 alpha-2)
- Output format maintains exact same URL linking as original posts (embedded on Bluesky, in parens on Mastodon)
- Current preview uses in-memory mock database; production uses MaxMind `.mmdb` file
