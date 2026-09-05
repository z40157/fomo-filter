import { count } from "drizzle-orm";
import type { Database } from "./client.js";
import { tokens } from "./schema.js";

export type LaunchSource = "doppler" | "pons_v1";

export interface NewToken {
  address: string;
  symbol: string | null;
  name: string | null;
  launchSource: LaunchSource;
  deployer: string;
  pairToken: string;
  pool: string;
  launchBlock: bigint;
  launchTime: Date;
  launchTx: string;
}

export interface TokensRepo {
  /** Inserts the token, ignoring the write if `address` already exists. Returns true if a new row was inserted. */
  insertIfNew(token: NewToken): Promise<boolean>;
  countTokens(): Promise<number>;
}

export function createTokensRepo(db: Database): TokensRepo {
  return {
    async insertIfNew(token) {
      const inserted = await db
        .insert(tokens)
        .values(token)
        .onConflictDoNothing({ target: tokens.address })
        .returning({ id: tokens.id });
      return inserted.length > 0;
    },

    async countTokens() {
      const rows = await db.select({ value: count() }).from(tokens);
      return rows[0]?.value ?? 0;
    },
  };
}
