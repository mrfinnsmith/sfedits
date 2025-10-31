FROM node:20-slim

# Match local directory structure: /opt/sfedits/admin/server.js with lib at /opt/sfedits/lib
WORKDIR /opt/sfedits/admin

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

# Copy admin package files
COPY admin/package*.json ./

# Install dependencies
RUN npm install --production

# Copy admin server and public files
COPY admin/server.js ./
COPY admin/public ./public

# Copy shared modules to parent directory to match local structure
# server.js uses require('../lib/...') so lib must be at /opt/sfedits/lib
COPY lib ../lib/

# Expose admin port
EXPOSE 3000

CMD ["node", "server.js"]
