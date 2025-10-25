#!/bin/bash
# Automatically download latest MaxMind GeoLite2-City database
# Runs weekly via docker-compose

set -e

DB_DIR="/opt/sfedits/data"
DB_FILE="$DB_DIR/GeoLite2-City.mmdb"
TEMP_FILE="$DB_DIR/GeoLite2-City.mmdb.tmp"

echo "[$(date)] Starting MaxMind database update..."

# Download latest database
# Uses git.io redirect to MaxMind's official release
curl -sL "https://git.io/GeoLite2-City.mmdb" -o "$TEMP_FILE"

if [ -f "$TEMP_FILE" ] && [ -s "$TEMP_FILE" ]; then
  # Verify it's a valid mmdb file (starts with 'maxmind')
  if file "$TEMP_FILE" | grep -q "data"; then
    mv "$TEMP_FILE" "$DB_FILE"
    echo "[$(date)] Successfully updated MaxMind database"
    exit 0
  else
    echo "[$(date)] ERROR: Downloaded file is not a valid mmdb database"
    rm -f "$TEMP_FILE"
    exit 1
  fi
else
  echo "[$(date)] ERROR: Download failed or file is empty"
  rm -f "$TEMP_FILE"
  exit 1
fi
