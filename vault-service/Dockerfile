FROM node:18-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ ./src/

EXPOSE 5000

CMD ["node", "src/app.js"]
