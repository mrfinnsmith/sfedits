FROM node:20-slim

WORKDIR /opt/sfedits

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
    xvfb

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY . .

RUN npm install

EXPOSE 3000

VOLUME /opt/sfedits/config.json

CMD ["node", "page-watch.js"]