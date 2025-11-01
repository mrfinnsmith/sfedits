FROM node:20-slim

# Use root as base directory
WORKDIR /opt/sfedits

# Install system dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    libgconf-2-4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libnss3-dev \
    libxss-dev \
    fonts-liberation \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Use root package.json (same as bot)
# This ensures lib/ can access all dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy shared lib first
COPY lib ./lib/

# Copy admin files
COPY admin/server.js ./admin/
COPY admin/public ./admin/public/

# Run admin server from admin directory
WORKDIR /opt/sfedits/admin

EXPOSE 3000

CMD ["node", "server.js"]
