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
EXPOSE 3000
# Invoke node directly rather than "npm start": npm run as PID 1 does not
# reliably forward SIGTERM to its child node process (confirmed live —
# `docker stop` produced "npm error signal SIGTERM" with exit code 1 and
# none of index.ts's graceful-shutdown log lines ever appeared). Running
# node itself as PID 1 lets its own SIGTERM/SIGINT handlers receive the
# signal directly. No .env file exists in the image on purpose (Railway
# injects real env vars directly) so --env-file-if-exists isn't needed here.
CMD ["node", "dist/index.js"]
