# Post-Mortem: Bot Outage Feb 1 - Mar 8, 2026

## Summary

The sfedits bot stopped posting on approximately Feb 4, 2026. The outage went unnoticed for over a month until manual investigation on Mar 8. The root cause was a crash loop that exhausted Docker's restart backoff, followed by a weekly cleanup cron job that destroyed the stopped container and its image.

## Timeline (all times UTC)

- **2025-11-11** - Bot container last created (commit `cebbcde`, the `fix/screenshot-compression-f9b6bc4` branch)
- **2026-02-01 02:40** - First recorded crash. Bot dies with exit code 1, Docker restarts it
- **2026-02-01 to 02-04** - Bot enters crash loop. Repeated die/restart cycles, each run lasting seconds to minutes:
  - Feb 1: 2 crashes
  - Feb 2: 2 crashes
  - Feb 3: 4 crashes
  - Feb 4: 3 crashes (last post likely around this date)
- **2026-02-06 02:17** - Final crash. Docker's restart backoff stops restarting the container
- **2026-02-08 03:00** - Weekly cron job runs `docker system prune -af --filter "until=168h"`. Destroys the stopped bot container and its image. ~2.7GB reclaimed
- **2026-02-08 onward** - No bot container or image exists. Nothing to restart. Admin container unaffected (still running)
- **2026-03-08** - Outage discovered. Bot rebuilt and restarted manually

## Root Cause

**Immediate cause:** The bot process crashed (exit code 1) repeatedly. The exact error is unknown because container logs were destroyed by the prune job. Likely causes: Bluesky/Mastodon auth failure, screenshot/Puppeteer crash, or PII subprocess error during a post attempt.

**Contributing cause:** The weekly cleanup script (`/usr/local/bin/docker-cleanup.sh`) runs `docker system prune -af --filter "until=168h"`, which removes all stopped containers older than 7 days. Once the bot stopped restarting and sat in a stopped state for >7 days, the prune job destroyed it permanently.

**Cron entry:** `0 3 * * 0 /usr/local/bin/docker-cleanup.sh`

**Why it went unnoticed:** No monitoring, alerting, or healthchecks exist. The bot posts infrequently (only when specific SF-related Wikipedia articles are edited), so silence doesn't immediately signal a problem.

## What Survived

The `sfedits-admin` container (created 2025-11-11) remained running throughout. `docker system prune` only removes stopped containers, so the running admin container and its image were untouched.

## Deployed State at Time of Outage

The droplet was running commit `cebbcde` from the `fix/screenshot-compression-f9b6bc4` branch (not `main`). This is the early architecture: no docker-compose, standalone containers, PII runs as a Python subprocess inside the bot container.

The `main` branch had diverged significantly with a different architecture (docker-compose, PII microservice, deploy.sh), but was never deployed.

## Resolution

- Rebuilt bot image on the droplet (removed unused `en_core_web_lg` spaCy model from Dockerfile to avoid OOM during build)
- Started bot container: `docker run -d --init --restart unless-stopped --name sfedits-bot -v /root/sfedits/config.json:/opt/sfedits/config.json -v /root/sfedits/drafts:/opt/sfedits/drafts sfedits`
- Verified bot loaded config and connected to IRC

## Action Items

1. **Fix the cleanup script** so it cannot destroy containers with restart policies. Either exclude named containers or switch to only pruning images/build cache (not containers)
2. **Add uptime monitoring/alerting** so outages are detected within hours, not months. Options: healthcheck endpoint + external ping service, or a simple cron that checks `docker ps` and sends an alert
3. **Add error handling in the bot** so a single post failure (screenshot, auth, PII) doesn't crash the entire process. The bot should log the error and continue listening for the next edit
4. **Decide on deployment branch.** The droplet runs `cebbcde` (feature branch) while `main` has a completely different architecture. These need to be reconciled
5. **Preserve logs.** Configure Docker log rotation instead of relying on prune to reclaim space, so crash logs are available for debugging
