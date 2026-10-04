# bugtool — satu container: API + pemroses event + dashboard, data di SQLite (/data).

# ---- build: compile API (bundle esbuild) dan web (Vite) ----
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY packages packages
COPY apps apps
RUN pnpm --filter @bugtool/db generate \
 && pnpm --filter @bugtool/api build \
 && pnpm --filter @bugtool/web build

# ---- deps: satu-satunya modul runtime yang tidak di-bundle (native) ----
FROM node:22-slim AS deps
WORKDIR /deps
RUN echo '{"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund better-sqlite3@12.11.1 \
 && npm cache clean --force

# ---- runtime ----
FROM node:22-slim
ENV NODE_ENV=production \
    DATABASE_URL=file:/data/bugtool.db \
    WEB_DIST=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    API_PORT=4000
WORKDIR /app
COPY --from=deps /deps/node_modules ./node_modules
COPY --from=build /src/apps/api/dist/ ./
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/packages/db/prisma/migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
