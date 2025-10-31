#!/bin/bash
# Deploy script - pulls latest code on droplet and rebuilds containers
# with aggressive memory management to prevent OOM

set -e

# Load .env file
if [ ! -f .env ]; then
  echo "Error: .env file not found"
  echo "Please create .env with DROPLET_IP set"
  exit 1
fi

source .env

if [ -z "$DROPLET_IP" ]; then
  echo "Error: DROPLET_IP not set in .env"
  exit 1
fi

echo "Deploying to $DROPLET_IP..."

ssh root@$DROPLET_IP << 'EOF'
  set -e
  cd /root/sfedits

  echo "=== Pre-deployment checks ==="

  # Check disk space
  DISK_USAGE=$(df / | tail -1 | awk '{print $5}' | sed 's/%//')
  if [ "$DISK_USAGE" -gt 90 ]; then
    echo "WARNING: Disk usage at ${DISK_USAGE}% - running aggressive cleanup"
    docker system prune -af --volumes
  fi

  # Check memory
  FREE_MEM=$(free -m | awk 'NR==2{print $7}')
  echo "Available memory: ${FREE_MEM}MB"
  if [ "$FREE_MEM" -lt 100 ]; then
    echo "WARNING: Low memory (${FREE_MEM}MB) - restarting services to free memory"
    docker-compose restart
    sleep 5
  fi

  echo ""
  echo "=== Pulling latest code ==="
  git fetch origin
  git reset --hard origin/main

  echo ""
  echo "=== Aggressive Docker cleanup ==="
  # Remove ALL unused images, containers, networks, and build cache
  docker system prune -af

  # Show reclaimed space
  echo ""
  docker system df

  echo ""
  echo "=== Building services sequentially to avoid OOM ==="

  # Build services one at a time with memory limits
  # PII service uses cached layers (Python base image)
  echo "Building pii-service..."
  docker-compose build pii-service

  echo "Building bot..."
  docker-compose build bot

  echo "Building admin..."
  docker-compose build admin

  echo ""
  echo "=== Starting services ==="
  # Start services (already built, so no memory spike)
  docker-compose up -d

  # Wait for health checks
  echo "Waiting for services to be healthy..."
  sleep 10

  echo ""
  echo "=== Deployment complete! ==="
  docker-compose ps

  echo ""
  echo "=== System resources after deployment ==="
  free -h
  df -h / | grep -v Filesystem
  docker system df
EOF
