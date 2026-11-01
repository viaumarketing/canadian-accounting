# syntax=docker/dockerfile:1.7
# One multi-target Dockerfile: server (api + worker + migrations), web, backup. Build from the repo root:
#   docker build --platform linux/amd64 -f infrastructure/docker/Dockerfile --target server -t ca-server .
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Pre-fetch the pinned pnpm now so nothing tries to download it when containers run on an offline network.
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/canadian-tax/package.json packages/canadian-tax/
COPY packages/accounting-engine/package.json packages/accounting-engine/
COPY packages/shopify-integration/package.json packages/shopify-integration/
COPY packages/banking/package.json packages/banking/
COPY packages/reporting/package.json packages/reporting/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
# next.config rewrites are fixed at build time; compose always names the API service `api`.
ENV API_INTERNAL_URL=http://api:4000
COPY . .
RUN pnpm build:packages && pnpm --filter @ca/api build && pnpm --filter @ca/worker build \
 && NEXT_TELEMETRY_DISABLED=1 pnpm --filter @ca/web build

# ---- server: compiled NestJS, production dependencies only. One image runs the api, the worker and the migrations. ----
FROM build AS deploy
# `pnpm deploy --prod` copies @ca/worker with its production dependency tree (which includes @ca/api and the shared packages)
# and nothing from devDependencies. The Prisma client is then generated inside that tree, and the Prisma CLI gets a stable path
# (node_modules/prisma): pnpm's .bin shims hard-code the /out build path, which does not exist at run time.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @ca/worker deploy --prod --legacy /out \
 && cd /out/node_modules/@ca/database && ./node_modules/.bin/prisma generate >/dev/null \
 && cd /out/node_modules && ln -s "$(ls -d .pnpm/prisma@*/node_modules/prisma | head -n 1)" prisma && test -f prisma/build/index.js

FROM node:${NODE_VERSION}-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deploy /out /app
ARG APP_VERSION=dev
ARG GIT_SHA=
ARG BUILD_TIME=
ENV NODE_ENV=production APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME
USER node
EXPOSE 4000
# api by default; compose runs the worker with `node dist/main.js` and migrations with the bundled Prisma CLI.
CMD ["node", "node_modules/@ca/api/dist/main.js"]

# ---- web: Next.js standalone output ----
FROM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---- backup: postgres client tools + openssl, scripts baked in (nothing is installed at run time; the network is offline) ----
FROM postgres:17-alpine AS backup
RUN apk add --no-cache openssl
COPY infrastructure/backup/ /scripts/
RUN chmod +x /scripts/*.sh
ENV BACKUP_DIR=/backups
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m --retries=1 CMD ["/bin/sh", "/scripts/healthcheck.sh"]
ENTRYPOINT ["/bin/sh", "/scripts/backup-loop.sh"]
