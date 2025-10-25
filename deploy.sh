#!/bin/bash
# Deploy script - reads droplet IP from .env

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

DROPLET_USER="root"
DROPLET_PATH="/root/sfedits"

echo "Deploying to $DROPLET_IP..."

rsync -avz --exclude '.git' --exclude 'node_modules' --exclude '__pycache__' \
  --exclude '.env' --exclude 'config.json' . root@$DROPLET_IP:$DROPLET_PATH/

ssh root@$DROPLET_IP << 'EOF'
  cd /root/sfedits
  docker-compose down
  docker system prune -af
  docker-compose build
  docker-compose up -d
EOF

echo "Deployment complete!"
