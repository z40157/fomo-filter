import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as shadowSchema from "./shadowSchema.js";

// Mirrors db/client.ts exactly, but bound to shadowSchema (V1 tables +
// V2 tables) and meant to be constructed from SHADOW_DATABASE_URL only —
// never DATABASE_URL. Kept as a separate module (not a parameterized
// version of createDb) so nothing V2 does can accidentally end up pointed
// at the V1 production connection string by a copy-paste mistake.
export type ShadowDatabase = ReturnType<typeof drizzle<typeof shadowSchema>>;

export function createShadowDb(connectionString: string): ShadowDatabase {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema: shadowSchema });
}

export async function checkShadowDatabase(db: ShadowDatabase): Promise<"ok" | "error"> {
  try {
    await db.execute(sql`select 1`);
    return "ok";
  } catch {
    return "error";
  }
}
