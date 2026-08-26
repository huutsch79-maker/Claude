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

# Not `npm run build` — that also runs build:dashboard, which needs
# dashboard/'s source (never copied into this stage on purpose; its
# output already landed above via COPY --from). Only the orchestrator's
# own TypeScript needs compiling here.
RUN npm run build:orchestrator

CMD ["node", "dist/src/orchestrator/index.js"]
