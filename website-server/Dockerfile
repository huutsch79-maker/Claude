FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

VOLUME /data/site

EXPOSE 8080 8081
CMD ["node", "server.js"]
