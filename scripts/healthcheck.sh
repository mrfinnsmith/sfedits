#!/bin/bash
# Check that all expected sfedits containers are running.
# Sends a DM via Mastodon if any are down.
#
# Install: add to crontab on the droplet
#   */30 * * * * /root/sfedits/scripts/healthcheck.sh >> /var/log/sfedits-healthcheck.log 2>&1
#
# Requires MASTODON_INSTANCE and MASTODON_TOKEN environment variables,
# or set them below.

MASTODON_INSTANCE="${MASTODON_INSTANCE:-https://sfba.social}"
MASTODON_TOKEN="${MASTODON_TOKEN:-}"
ALERT_RECIPIENT="${ALERT_RECIPIENT:-@mrfinnsmith@twit.social}"

# Read token from config.json if not set
if [ -z "$MASTODON_TOKEN" ] && [ -f /root/sfedits/config.json ]; then
  MASTODON_TOKEN=$(python3 -c "import json; print(json.load(open('/root/sfedits/config.json'))['mastodon']['access_token'])" 2>/dev/null)
fi

EXPECTED_CONTAINERS="sfedits-bot"
MISSING=""

for container in $EXPECTED_CONTAINERS; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
    MISSING="$MISSING $container"
  fi
done

if [ -n "$MISSING" ]; then
  echo "[$(date)] ALERT: containers down:$MISSING"

  if [ -n "$MASTODON_TOKEN" ]; then
    MESSAGE="$ALERT_RECIPIENT sfedits healthcheck: containers down:$MISSING"
    curl -s -X POST "${MASTODON_INSTANCE}/api/v1/statuses" \
      -H "Authorization: Bearer ${MASTODON_TOKEN}" \
      -d "status=${MESSAGE}" \
      -d "visibility=direct" \
      > /dev/null 2>&1
    echo "[$(date)] Alert sent via Mastodon DM"
  else
    echo "[$(date)] WARNING: No MASTODON_TOKEN set, cannot send alert"
  fi

  exit 1
else
  echo "[$(date)] OK: all containers running"
  exit 0
fi
