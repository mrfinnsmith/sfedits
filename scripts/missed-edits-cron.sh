#!/bin/bash
# Find watched Wikipedia edits the bot never posted and DM a summary (sfedits#44).
# Runs the check in a throwaway container of the bot image, so the host needs no Node 22.
#
# Reads only HEALTHCHECKS_PING_URL from .env (a secret: never echoed, and passed to docker
# by name so the value stays out of the process list). Pings it on success; the script
# itself pings /fail for check problems, and this wrapper pings /fail when it cannot run.
#
# Install: add to crontab on the droplet
#   */15 * * * * /root/sfedits/scripts/missed-edits-cron.sh >> /var/log/sfedits-missed-edits.log 2>&1

set -u

APP_DIR="/root/sfedits"
LOCK_FILE="/var/lock/sfedits-missed-edits.lock"

# Skip this run if the previous one is still going.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date)] previous run still going, skipping"
  exit 0
fi

# Only the one line we need; the rest of .env is never sourced.
STRIP_CHARS=$(printf '"\047\r')  # double quote, single quote, carriage return
HEALTHCHECKS_PING_URL=$(grep -m1 '^HEALTHCHECKS_PING_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d "$STRIP_CHARS")
export HEALTHCHECKS_PING_URL

ping_fail() {
  [ -n "$HEALTHCHECKS_PING_URL" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$1" "${HEALTHCHECKS_PING_URL%/}/fail" >/dev/null 2>&1 \
    || echo "[$(date)] could not ping /fail"
}

IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^sfedits[_-]bot:latest$' | head -1)
if [ -z "$IMAGE" ]; then
  MSG="missed-edits: bot image not found"
  echo "[$(date)] $MSG"
  ping_fail "$MSG"
  exit 1
fi

docker run --rm --memory=96m \
  -v "$APP_DIR/data:/opt/sfedits/data" \
  -v "$APP_DIR/config.json:/opt/sfedits/config.json:ro" \
  -v "$APP_DIR/watchlist.json:/opt/sfedits/watchlist.json:ro" \
  -e HEALTHCHECKS_PING_URL \
  "$IMAGE" node scripts/missed-edits.js
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  MSG="missed-edits: docker run exited $STATUS"
  echo "[$(date)] $MSG"
  ping_fail "$MSG"
  exit 1
fi
exit 0
