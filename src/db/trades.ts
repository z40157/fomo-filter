import { count } from "drizzle-orm";
import type { Database } from "./client.js";
import { trades } from "./schema.js";

export type TradeSide = "BUY" | "SELL";

export interface NewTrade {
  chainId: number;
  tokenId: number;
  wallet: string;
  side: TradeSide;
  /** Raw on-chain integer amount (base units), as a decimal string. */
  quoteAmount: string;
  /** Raw on-chain integer amount (base units), as a decimal string. */
  tokenAmount: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  timestamp: Date;
}

export interface TradesRepo {
  /** Inserts the trade, ignoring the write if (chainId, txHash, logIndex) already exists. Returns true if a new row was inserted. */
  insertIfNew(trade: NewTrade): Promise<boolean>;
  countTrades(): Promise<number>;
}

export function createTradesRepo(db: Database): TradesRepo {
  return {
    async insertIfNew(trade) {
      const inserted = await db
        .insert(trades)
        .values(trade)
        .onConflictDoNothing({ target: [trades.chainId, trades.txHash, trades.logIndex] })
        .returning({ id: trades.id });
      return inserted.length > 0;
    },

    async countTrades() {
      const rows = await db.select({ value: count() }).from(trades);
      return rows[0]?.value ?? 0;
    },
  };
}
