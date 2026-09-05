import { count, desc, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { signalWallets, signals } from "./schema.js";
import type { WalletTier } from "./walletWatchlist.js";

export type TriggerCondition = "A" | "B" | "C";

export interface NewSignal {
  tokenId: number;
  triggeredAt: Date;
  triggerConditions: TriggerCondition[];
  distinctOwnerGroups: number;
  tierACount: number;
  hasRepeatAccumulation: boolean;
  windowMinutes: number;
  escalation: boolean;
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
}

export interface NewSignalWallet {
  signalId: number;
  walletAddress: string;
  walletName: string;
  tier: WalletTier;
  ownerGroup: string;
  buyCount: number;
  /** Raw on-chain integer amount, as a decimal string (see schema.ts comment). */
  buyAmount: string;
}

export interface SignalsRepo {
  /** Returns the new signal's id. */
  create(signal: NewSignal): Promise<number>;
  addWallets(wallets: NewSignalWallet[]): Promise<void>;
  countSince(since: Date): Promise<number>;
  lastTriggeredAt(): Promise<Date | null>;
}

export function createSignalsRepo(db: Database): SignalsRepo {
  return {
    async create(signal) {
      const rows = await db
        .insert(signals)
        .values({
          ...signal,
          marketCap: signal.marketCap === null ? null : signal.marketCap.toString(),
          liquidity: signal.liquidity === null ? null : signal.liquidity.toString(),
          volume5m: signal.volume5m === null ? null : signal.volume5m.toString(),
        })
        .returning({ id: signals.id });
      return rows[0]!.id;
    },

    async addWallets(wallets) {
      if (wallets.length === 0) return;
      await db.insert(signalWallets).values(wallets);
    },

    async countSince(since) {
      const rows = await db
        .select({ value: count() })
        .from(signals)
        .where(gte(signals.triggeredAt, since));
      return rows[0]?.value ?? 0;
    },

    async lastTriggeredAt() {
      const rows = await db
        .select({ triggeredAt: signals.triggeredAt })
        .from(signals)
        .orderBy(desc(signals.triggeredAt))
        .limit(1);
      return rows[0]?.triggeredAt ?? null;
    },
  };
}
