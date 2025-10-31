#!/bin/bash
# Deploy script - pulls latest code on droplet and rebuilds containers

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
  cd /root/sfedits

  # Pull latest code
  git fetch origin
  git reset --hard origin/main

  # Clean up dangling images (keeps layer cache)
  docker system prune -f

  # Rebuild changed services and start
  docker-compose up -d --build

  # Show status
  echo ""
  echo "Deployment complete! Service status:"
  docker-compose ps
EOF
