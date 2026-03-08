#!/bin/bash
# Check that all expected sfedits containers are running.
# Sends DMs via Bluesky and Mastodon if any are down.
#
# Install: add to crontab on the droplet
#   */30 * * * * /root/sfedits/scripts/healthcheck.sh >> /var/log/sfedits-healthcheck.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_CONTAINERS="sfedits-bot"
MISSING=""

for container in $EXPECTED_CONTAINERS; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
    MISSING="$MISSING $container"
  fi
done

if [ -n "$MISSING" ]; then
  echo "[$(date)] ALERT: containers down:$MISSING"
  node "$SCRIPT_DIR/send-alert.js" "sfedits healthcheck: containers down:$MISSING"
  exit 1
else
  echo "[$(date)] OK: all containers running"
  exit 0
fi
