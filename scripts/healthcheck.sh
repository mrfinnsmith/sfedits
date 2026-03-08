#!/bin/bash
# Check that the sfedits bot container is running.
# Sends DMs via Bluesky and Mastodon if it's down.
#
# Install: add to crontab on the droplet
#   */30 * * * * /root/sfedits/scripts/healthcheck.sh >> /var/log/sfedits-healthcheck.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check for bot container under any naming convention
# docker-compose uses sfedits_bot_1, standalone uses sfedits-bot
BOT_RUNNING=$(docker ps --format '{{.Names}}' | grep -E 'sfedits.bot')

if [ -z "$BOT_RUNNING" ]; then
  echo "[$(date)] ALERT: bot container is not running"
  node "$SCRIPT_DIR/send-alert.js" "sfedits healthcheck: bot container is not running"
  exit 1
else
  echo "[$(date)] OK: $BOT_RUNNING"
  exit 0
fi
