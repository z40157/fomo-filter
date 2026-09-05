import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { narrativeFlags } from "./schema.js";

export interface NewNarrativeFlag {
  tokenId: number;
  /** 0-1. */
  boost: number;
  notes?: string | null;
}

export interface NarrativeFlagsRepo {
  create(flag: NewNarrativeFlag): Promise<void>;
  /** The most recently set boost for a token, or null if none exists — scoring.ts never infers one itself. */
  getLatestBoost(tokenId: number): Promise<number | null>;
}

export function createNarrativeFlagsRepo(db: Database): NarrativeFlagsRepo {
  return {
    async create(flag) {
      await db.insert(narrativeFlags).values({
        tokenId: flag.tokenId,
        boost: flag.boost.toString(),
        notes: flag.notes ?? null,
      });
    },

    async getLatestBoost(tokenId) {
      const rows = await db
        .select({ boost: narrativeFlags.boost })
        .from(narrativeFlags)
        .where(eq(narrativeFlags.tokenId, tokenId))
        .orderBy(desc(narrativeFlags.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? Number(row.boost) : null;
    },
  };
}
