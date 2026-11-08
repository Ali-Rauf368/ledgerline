# syntax=docker/dockerfile:1
# Ledgerline: production image. Node 24 provides the built-in node:sqlite driver, so there is no DB server.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3700 \
    HOSTNAME=0.0.0.0 \
    LEDGER_DB=/app/data/ledger.db
RUN addgroup -S ledger && adduser -S ledger -G ledger
# Next.js standalone server + static assets
COPY --from=build --chown=ledger:ledger /app/.next/standalone ./
COPY --from=build --chown=ledger:ledger /app/.next/static ./.next/static
# Engine + seed script (run with Node's built-in TypeScript type stripping on first start)
COPY --from=build --chown=ledger:ledger /app/lib ./lib
COPY --from=build --chown=ledger:ledger /app/scripts ./scripts
COPY --chown=ledger:ledger docker/esm.package.json ./lib/package.json
COPY --chown=ledger:ledger docker/esm.package.json ./scripts/package.json
COPY --chown=ledger:ledger docker/entrypoint.sh ./entrypoint.sh
RUN mkdir -p /app/data && chown ledger:ledger /app/data && chmod +x ./entrypoint.sh
USER ledger
VOLUME ["/app/data"]
EXPOSE 3700
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:3700/api/health || exit 1
ENTRYPOINT ["./entrypoint.sh"]
