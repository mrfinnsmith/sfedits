FROM node:20

WORKDIR /opt/sfedits

COPY . /opt/sfedits

RUN apt-get update && apt-get install --yes \
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
   libxss-dev

RUN npm install

EXPOSE 3000

VOLUME /opt/sfedits/config.json

CMD ["node", "page-watch.js"]