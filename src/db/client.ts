import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}

export async function checkDatabase(db: Database): Promise<"ok" | "error"> {
  try {
    await db.execute(sql`select 1`);
    return "ok";
  } catch {
    return "error";
  }
}
