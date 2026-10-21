FROM node:22-bookworm-slim

# Use root as base directory
WORKDIR /opt/sfedits

# Install system dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    libgconf-2-4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libnss3-dev \
    libxss-dev \
    fonts-liberation \
    fonts-noto-core \
    xvfb \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Use root package.json (same as bot)
# This ensures lib/ can access all dependencies
COPY package*.json ./
# The bot launches full Chrome, never chrome-headless-shell, so skip that download
ENV PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true
RUN npm ci --only=production

# Download the Chrome for Testing build pinned by the installed Puppeteer
# (so package-lock.json decides the Chrome version) and install the system
# libraries it needs. This is Puppeteer's documented Docker approach. The
# explicit step fails the build if the download fails, unlike the postinstall.
# --install-deps runs `apt-get satisfy`, which needs fresh package lists.
RUN apt-get update \
    && npx puppeteer browsers install chrome --install-deps \
    && rm -rf /var/lib/apt/lists/*

# Copy shared lib first
COPY lib ./lib/

# Copy admin files
COPY admin/server.js ./admin/
COPY admin/public ./admin/public/

EXPOSE 3000

CMD ["node", "admin/server.js"]
