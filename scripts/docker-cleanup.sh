#!/bin/bash
# Clean up Docker resources without destroying running or restartable containers
#
# The previous version used `docker system prune -af` which removes stopped
# containers. This caused a month-long outage in Feb 2026 when the bot
# crash-looped, stopped, and was then pruned (container + image deleted).
#
# This version only prunes images and build cache, never containers.
# Containers with restart policies will remain intact for Docker to restart.

echo "[$(date)] Starting Docker cleanup..."

# Remove dangling and unused images older than 7 days
docker image prune -af --filter "until=168h"

# Remove build cache older than 7 days
docker builder prune -af --filter "until=168h"

echo "[$(date)] Docker cleanup complete"
docker system df
