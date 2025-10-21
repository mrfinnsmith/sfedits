FROM node:20-slim

WORKDIR /opt/sfedits

# Install system dependencies for Puppeteer and Python
RUN apt-get update && apt-get install -y \
    build-essential \
    libicu-dev \
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
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY . .

# Install Node.js dependencies
RUN npm install

# Install Python dependencies for PII screening
# Use venv to avoid pip externally-managed-environment restrictions
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip3 install --no-cache-dir \
    presidio-analyzer==2.2.360 \
    spacy>=3.4.4 \
    && python3 -m spacy download en_core_web_sm

EXPOSE 3000

VOLUME /opt/sfedits/config.json

CMD ["node", "page-watch.js"]