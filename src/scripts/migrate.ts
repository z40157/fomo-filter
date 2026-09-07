// Production-safe migration runner for Railway's Pre-Deploy Command.
// Deliberately independent of drizzle-kit (a devDependency, not present in
// the `npm install --omit=dev` runtime image) — uses only drizzle-orm/pg,
// both real production dependencies. Compiles to dist/scripts/migrate.js,
// run via `npm run db:migrate:prod`.
//
// Does not start the scanner, does not seed data — migrations only.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { ExponentialBackoff } from "../chain/backoff.js";

// __dirname is unavailable under ESM — reconstructed from import.meta.url so
// this resolves correctly regardless of the process's cwd when Railway (or
// anything else) invokes `node dist/scripts/migrate.js`. From
// dist/scripts/migrate.js, drizzle/ lives two levels up (dist/scripts ->
// dist -> /app), at /app/drizzle — matching the Dockerfile's
// `COPY --from=build /app/drizzle ./drizzle`.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle");

// Railway's private-network DNS may not be resolvable in the first instant a
// container starts. Retry with backoff rather than failing on the first
// attempt — same reasoning as src/index.ts's startup DB wait.
const MAX_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(pool: pg.Pool): Promise<void> {
  const backoff = new ExponentialBackoff({ initialMs: 1_000, maxMs: 5_000, factor: 2 });
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastErr: unknown;
  for (;;) {
    try {
      await pool.query("select 1");
      return;
    } catch (err) {
      lastErr = err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`database not reachable after ${MAX_WAIT_MS}ms: ${String(lastErr)}`);
      }
      await sleep(Math.min(backoff.next(), remaining));
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  // A single connection is all a one-shot migration run needs — no pool
  // sizing to tune here.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await waitForDatabase(pool);
    const db = drizzle(pool);
    console.log(`Running migrations from ${MIGRATIONS_FOLDER} ...`);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("Migrations complete.");
  } finally {
    // Must always run: an open pool keeps the process alive, which would
    // hang Railway's Pre-Deploy Command until it times out.
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
