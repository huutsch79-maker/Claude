FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY db ./db

RUN npm run build

CMD ["node", "dist/src/orchestrator/index.js"]
