FROM node:20-slim

WORKDIR /opt/sfedits-admin

# Copy admin package files
COPY admin/package*.json ./

# Install dependencies
RUN npm install --production

# Copy admin server and public files
COPY admin/server.js ./
COPY admin/public ./public

# Copy shared modules from parent directory
COPY lib ./lib

# Expose admin port
EXPOSE 3000

CMD ["node", "server.js"]
