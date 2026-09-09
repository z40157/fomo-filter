// Production-safe migration runner for the V2 Shadow Postgres — mirrors
// scripts/migrate.ts exactly, but against SHADOW_DATABASE_URL and the
// drizzle-shadow/ migrations folder (V1's schema.ts + V2's schemaV2.ts
// combined, per db/shadowSchema.ts). Never touches DATABASE_URL / drizzle/
// — V1's migration path is completely untouched by this file's existence.
//
// Does not start the scanner, does not seed data — migrations only.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { ExponentialBackoff } from "../chain/backoff.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../../drizzle-shadow");

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
        throw new Error(`shadow database not reachable after ${MAX_WAIT_MS}ms: ${String(lastErr)}`);
      }
      await sleep(Math.min(backoff.next(), remaining));
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env["SHADOW_DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("SHADOW_DATABASE_URL is required to run shadow migrations");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await waitForDatabase(pool);
    const db = drizzle(pool);
    console.log(`Running shadow migrations from ${MIGRATIONS_FOLDER} ...`);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("Shadow migrations complete.");
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Shadow migration failed:", err);
    process.exit(1);
  });
