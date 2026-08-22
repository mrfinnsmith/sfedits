#!/bin/bash
# Check that the sfedits bot is running and healthy.
# Sends DMs via Bluesky and Mastodon if anything is wrong.
#
# Checks:
# 1. Bot container is running
# 2. IRC messages received in last 30 minutes
# 3. Successful post in last 2 days
#
# Install: add to crontab on the droplet
#   */30 * * * * /root/sfedits/scripts/healthcheck.sh >> /var/log/sfedits-healthcheck.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/root/sfedits/data"
NOW=$(date +%s)
ALERT=""

# Read a heartbeat file, retrying once if a concurrent write left it momentarily
# empty. Echoes the millisecond timestamp, or nothing if the content is invalid.
read_heartbeat() {
  TS=$(cat "$1" 2>/dev/null)
  case "$TS" in
    ''|*[!0-9]*)
      sleep 2
      TS=$(cat "$1" 2>/dev/null)
      ;;
  esac
  case "$TS" in
    ''|*[!0-9]*) echo "" ;;
    *) echo "$TS" ;;
  esac
}

# 1. Check bot container is running
BOT_RUNNING=$(docker ps --format '{{.Names}}' | grep -E 'sfedits.bot')
if [ -z "$BOT_RUNNING" ]; then
  ALERT="bot container is not running"
fi

# 2. Check IRC heartbeat (should update every few seconds)
if [ -z "$ALERT" ] && [ -f "$DATA_DIR/heartbeat-irc" ]; then
  IRC_TS=$(read_heartbeat "$DATA_DIR/heartbeat-irc")
  if [ -z "$IRC_TS" ]; then
    ALERT="heartbeat-irc file is empty or invalid"
  else
    # Convert milliseconds to seconds
    IRC_SECS=$((IRC_TS / 1000))
    IRC_AGE=$((NOW - IRC_SECS))
    if [ "$IRC_AGE" -gt 1800 ]; then
      ALERT="no IRC messages for $((IRC_AGE / 60)) minutes"
    fi
  fi
fi

# 3. Check post heartbeat (at least one post every 2 days)
if [ -z "$ALERT" ] && [ -f "$DATA_DIR/heartbeat-post" ]; then
  POST_TS=$(read_heartbeat "$DATA_DIR/heartbeat-post")
  if [ -z "$POST_TS" ]; then
    ALERT="heartbeat-post file is empty or invalid"
  else
    POST_SECS=$((POST_TS / 1000))
    POST_AGE=$((NOW - POST_SECS))
    TWO_DAYS=172800
    if [ "$POST_AGE" -gt "$TWO_DAYS" ]; then
      ALERT="no successful post for $((POST_AGE / 86400)) days"
    fi
  fi
fi

if [ -n "$ALERT" ]; then
  echo "[$(date)] ALERT: $ALERT"
  node "$SCRIPT_DIR/send-alert.js" "sfedits healthcheck: $ALERT"
  exit 1
else
  echo "[$(date)] OK: $BOT_RUNNING"
  exit 0
fi
