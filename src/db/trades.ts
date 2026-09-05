import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, max } from "drizzle-orm";
import type { Database } from "./client.js";
import { tokens, trades } from "./schema.js";

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

export interface PendingUsdValueTrade {
  id: number;
  tokenId: number;
  tokenAddress: string;
  /** Raw on-chain integer amount (base units), as a decimal string — needs the token's decimals() to convert to human units. */
  tokenAmount: string;
  timestamp: Date;
}

export interface WalletTradeForAggregates {
  wallet: string;
  side: TradeSide;
  usdValue: number | null;
}

export interface TradesRepo {
  /** Inserts the trade, ignoring the write if (chainId, txHash, logIndex) already exists. Returns true if a new row was inserted. */
  insertIfNew(trade: NewTrade): Promise<boolean>;
  countTrades(): Promise<number>;
  /** Oldest-first trades still missing usd_value, joined with the token's address (for a decimals() lookup). */
  listPendingUsdValue(limit: number): Promise<PendingUsdValueTrade[]>;
  setUsdValue(tradeId: number, usdValue: number): Promise<void>;
  /** This token's trades from the given (lowercased) wallet addresses — for watchlist aggregate stats. */
  listByTokenAndWallets(tokenId: number, wallets: string[]): Promise<WalletTradeForAggregates[]>;
  /** BUY count per wallet for a token, for repeat-buyer detection. */
  countBuysByWallet(tokenId: number): Promise<Map<string, number>>;
  /** Most recent trade timestamp per token, for the given token ids. */
  lastTradeAtByToken(tokenIds: number[]): Promise<Map<number, Date>>;
  /** All-time BUY/SELL counts for a token, across all traders — for scoring.ts's Market Quality structure check. */
  countTotalBuysSells(tokenId: number): Promise<{ buys: number; sells: number }>;
  /** Has this wallet (e.g. the token's deployer) ever sold this token? */
  hasWalletSold(tokenId: number, wallet: string): Promise<boolean>;
  /** The largest single SELL (by usd_value) for a token in the `windowMinutes` up to (and including) `before`, if any trade in that window has a known usd_value. Null if none qualify (including "none have usd_value yet"). Takes an explicit reference time rather than the wall clock so it works correctly for historical replay, not just live operation. */
  getLargestSellUsdSince(tokenId: number, before: Date, windowMinutes: number): Promise<number | null>;
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

    async listPendingUsdValue(limit) {
      return db
        .select({
          id: trades.id,
          tokenId: trades.tokenId,
          tokenAddress: tokens.address,
          tokenAmount: trades.tokenAmount,
          timestamp: trades.timestamp,
        })
        .from(trades)
        .innerJoin(tokens, eq(tokens.id, trades.tokenId))
        .where(isNull(trades.usdValue))
        .orderBy(asc(trades.timestamp))
        .limit(limit);
    },

    async setUsdValue(tradeId, usdValue) {
      await db
        .update(trades)
        .set({ usdValue: usdValue.toString() })
        .where(eq(trades.id, tradeId));
    },

    async listByTokenAndWallets(tokenId, wallets) {
      if (wallets.length === 0) return [];
      const rows = await db
        .select({ wallet: trades.wallet, side: trades.side, usdValue: trades.usdValue })
        .from(trades)
        .where(and(eq(trades.tokenId, tokenId), inArray(trades.wallet, wallets)));
      return rows.map((r) => ({
        wallet: r.wallet,
        side: r.side,
        usdValue: r.usdValue === null ? null : Number(r.usdValue),
      }));
    },

    async countBuysByWallet(tokenId) {
      const rows = await db
        .select({ wallet: trades.wallet, cnt: count() })
        .from(trades)
        .where(and(eq(trades.tokenId, tokenId), eq(trades.side, "BUY")))
        .groupBy(trades.wallet);
      return new Map(rows.map((r) => [r.wallet, Number(r.cnt)]));
    },

    async lastTradeAtByToken(tokenIds) {
      if (tokenIds.length === 0) return new Map();
      const rows = await db
        .select({ tokenId: trades.tokenId, lastAt: max(trades.timestamp) })
        .from(trades)
        .where(inArray(trades.tokenId, tokenIds))
        .groupBy(trades.tokenId);
      const result = new Map<number, Date>();
      for (const r of rows) {
        if (r.lastAt) result.set(r.tokenId, new Date(r.lastAt));
      }
      return result;
    },

    async countTotalBuysSells(tokenId) {
      const rows = await db
        .select({ side: trades.side, cnt: count() })
        .from(trades)
        .where(eq(trades.tokenId, tokenId))
        .groupBy(trades.side);
      let buys = 0;
      let sells = 0;
      for (const r of rows) {
        if (r.side === "BUY") buys = Number(r.cnt);
        else sells = Number(r.cnt);
      }
      return { buys, sells };
    },

    async hasWalletSold(tokenId, wallet) {
      const rows = await db
        .select({ id: trades.id })
        .from(trades)
        .where(and(eq(trades.tokenId, tokenId), eq(trades.wallet, wallet.toLowerCase()), eq(trades.side, "SELL")))
        .limit(1);
      return rows.length > 0;
    },

    async getLargestSellUsdSince(tokenId, before, windowMinutes) {
      const since = new Date(before.getTime() - windowMinutes * 60_000);
      const rows = await db
        .select({ usdValue: trades.usdValue })
        .from(trades)
        .where(
          and(
            eq(trades.tokenId, tokenId),
            eq(trades.side, "SELL"),
            gt(trades.timestamp, since),
            lte(trades.timestamp, before),
            isNotNull(trades.usdValue),
          ),
        )
        .orderBy(desc(trades.usdValue))
        .limit(1);
      const row = rows[0];
      return row?.usdValue === null || row?.usdValue === undefined ? null : Number(row.usdValue);
    },
  };
}
