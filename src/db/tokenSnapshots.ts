import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { tokenSnapshots } from "./schema.js";

export interface NewTokenSnapshot {
  tokenId: number;
  price: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
  volume1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  snapshotAt: Date;
}

export interface TokenSnapshotsRepo {
  insert(snapshot: NewTokenSnapshot): Promise<void>;
  /**
   * The nearest snapshot with a known price at-or-before `at`, no older
   * than `maxAgeMs` — used to backfill a trade's historical usdValue.
   * Never returns a snapshot from AFTER `at`: using a later (or current)
   * price to value a past trade would be fabricating history, not
   * recovering it.
   */
  findNearestPriceBefore(tokenId: number, at: Date, maxAgeMs: number): Promise<{ price: number } | null>;
}

export function createTokenSnapshotsRepo(db: Database): TokenSnapshotsRepo {
  return {
    async insert(snapshot) {
      await db.insert(tokenSnapshots).values({
        tokenId: snapshot.tokenId,
        price: snapshot.price === null ? null : snapshot.price.toString(),
        marketCap: snapshot.marketCap === null ? null : snapshot.marketCap.toString(),
        liquidity: snapshot.liquidity === null ? null : snapshot.liquidity.toString(),
        volume5m: snapshot.volume5m === null ? null : snapshot.volume5m.toString(),
        volume1h: snapshot.volume1h === null ? null : snapshot.volume1h.toString(),
        buys5m: snapshot.buys5m,
        sells5m: snapshot.sells5m,
        snapshotAt: snapshot.snapshotAt,
      });
    },

    async findNearestPriceBefore(tokenId, at, maxAgeMs) {
      const earliestAllowed = new Date(at.getTime() - maxAgeMs);
      const rows = await db
        .select({ price: tokenSnapshots.price })
        .from(tokenSnapshots)
        .where(
          and(
            eq(tokenSnapshots.tokenId, tokenId),
            lte(tokenSnapshots.snapshotAt, at),
            gte(tokenSnapshots.snapshotAt, earliestAllowed),
            isNotNull(tokenSnapshots.price),
          ),
        )
        .orderBy(desc(tokenSnapshots.snapshotAt))
        .limit(1);

      const row = rows[0];
      if (!row || row.price === null) return null;
      return { price: Number(row.price) };
    },
  };
}
