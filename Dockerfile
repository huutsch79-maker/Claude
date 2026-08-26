# Two stages: the dashboard frontend (its own toolchain — Vite/Preact, see
# dashboard/package.json) builds first and independently, then its output
# is copied into the orchestrator image at the same public/ path
# express.static() has always served from. Nothing about how the
# orchestrator serves the dashboard changed — only how that directory's
# contents get produced.
FROM node:22-slim AS dashboard-build
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install
COPY dashboard/ ./
RUN npm run build
# vite.config.ts's outDir ("../public", relative to /dashboard) lands the
# build output at /public in this stage.

FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY --from=dashboard-build /public ./public

RUN npm run build

CMD ["node", "dist/src/orchestrator/index.js"]
