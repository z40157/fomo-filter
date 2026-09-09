FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# V2 shadow (spec B3) migrations — additive, never read by V1's index.js /
# scripts/migrate.js. See src/scripts/migrateShadow.ts.
COPY --from=build /app/drizzle-shadow ./drizzle-shadow
# config/ currently holds only stockTokens.json + its .example — a
# hand-maintained, git-tracked, non-secret list (empty by default; see
# scoring.ts's Narrative dimension). Without this, index.ts's read of
# config/stockTokens.json throws ENOENT in production (caught, degrades to
# an empty set), silently diverging from dev-environment behavior.
COPY --from=build /app/config ./config
EXPOSE 3000
# Invoke node directly rather than "npm start": npm run as PID 1 does not
# reliably forward SIGTERM to its child node process (confirmed live —
# `docker stop` produced "npm error signal SIGTERM" with exit code 1 and
# none of index.ts's graceful-shutdown log lines ever appeared). Running
# node itself as PID 1 lets its own SIGTERM/SIGINT handlers receive the
# signal directly. No .env file exists in the image on purpose (Railway
# injects real env vars directly) so --env-file-if-exists isn't needed here.
CMD ["node", "dist/index.js"]
