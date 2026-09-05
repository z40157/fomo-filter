import { and, count, eq, isNull } from "drizzle-orm";
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
  /** Doppler-only: the pool-initializer/hook contract address. Omit for other sources. */
  initializer?: string | null;
}

export interface TrackedToken {
  id: number;
  address: string;
  symbol: string | null;
  launchSource: LaunchSource;
  deployer: string;
  pairToken: string;
  pool: string;
  launchBlock: bigint;
  launchTime: Date;
  initializer: string | null;
  poolId: string | null;
}

export interface TokensRepo {
  /** Inserts the token, ignoring the write if `address` already exists. Returns true if a new row was inserted. */
  insertIfNew(token: NewToken): Promise<boolean>;
  countTokens(): Promise<number>;
  /** All tracked tokens, for trade-detection to build its watch lists from. */
  listAll(): Promise<TrackedToken[]>;
  /** Persists a lazily-resolved Doppler PoolId once observed on-chain. */
  setPoolId(tokenId: number, poolId: string): Promise<void>;
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

    async listAll() {
      return db
        .select({
          id: tokens.id,
          address: tokens.address,
          symbol: tokens.symbol,
          launchSource: tokens.launchSource,
          deployer: tokens.deployer,
          pairToken: tokens.pairToken,
          pool: tokens.pool,
          launchBlock: tokens.launchBlock,
          launchTime: tokens.launchTime,
          initializer: tokens.initializer,
          poolId: tokens.poolId,
        })
        .from(tokens);
    },

    async setPoolId(tokenId, poolId) {
      await db
        .update(tokens)
        .set({ poolId })
        .where(and(eq(tokens.id, tokenId), isNull(tokens.poolId)));
    },
  };
}
