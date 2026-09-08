// Pure, DB/RPC-free wallet-discovery logic. Moved here (from
// scripts/lib/mining.ts, which now re-exports these) so it ships in the
// production build and src/discovery/walletDiscoveryJob.ts can run this same
// early-buyer analysis continuously, not just as a one-off manual script.

export interface TradeForMining {
  wallet: string;
  side: "BUY" | "SELL";
  timestamp: Date;
}

export interface EarlyBuyerHit {
  wallet: string;
  rankAmongFirstN: number;
}

export interface EarlyBuyerTimeHit {
  wallet: string;
  minutesAfterFirstTrade: number;
}

/** `trades` must already be sorted ascending (block_number, log_index). Only the first `topN` trades (any side) are considered; returns each BUY wallet's first (best) rank within that window. */
export function findEarlyBuyersByCount(trades: TradeForMining[], topN: number): EarlyBuyerHit[] {
  const firstN = trades.slice(0, topN);
  const seen = new Map<string, number>();
  firstN.forEach((t, index) => {
    if (t.side === "BUY" && !seen.has(t.wallet)) {
      seen.set(t.wallet, index + 1);
    }
  });
  return [...seen.entries()].map(([wallet, rankAmongFirstN]) => ({ wallet, rankAmongFirstN }));
}

/** `trades` must already be sorted ascending by timestamp. Returns each BUY wallet's first entry time within `windowMinutes` of the token's first trade. */
export function findEarlyBuyersByTime(trades: TradeForMining[], windowMinutes: number): EarlyBuyerTimeHit[] {
  if (trades.length === 0) return [];
  const firstTradeMs = trades[0]!.timestamp.getTime();
  const cutoffMs = firstTradeMs + windowMinutes * 60_000;
  const seen = new Map<string, number>();
  for (const t of trades) {
    const tradeMs = t.timestamp.getTime();
    if (tradeMs > cutoffMs) break;
    if (t.side === "BUY" && !seen.has(t.wallet)) {
      seen.set(t.wallet, (tradeMs - firstTradeMs) / 60_000);
    }
  }
  return [...seen.entries()].map(([wallet, minutesAfterFirstTrade]) => ({ wallet, minutesAfterFirstTrade }));
}

export interface TokenHitInfo {
  tokenAddress: string;
  symbol: string | null;
  criteria: ("topN" | "timeWindow")[];
  rankAmongFirstN?: number;
  minutesAfterFirstTrade?: number;
}

export interface CandidateWallet {
  address: string;
  /** Distinct performing tokens this wallet was an early buyer in, via EITHER criterion — the primary ranking metric. */
  hitCount: number;
  hitCountTopN: number;
  hitCountTimeWindow: number;
  hits: TokenHitInfo[];
  avgEntryRank: number | null;
  avgEntryMinutes: number | null;
}

export interface PerTokenEarlyBuyers {
  tokenAddress: string;
  symbol: string | null;
  byCount: EarlyBuyerHit[];
  byTime: EarlyBuyerTimeHit[];
}

export function aggregateCandidates(perToken: PerTokenEarlyBuyers[]): CandidateWallet[] {
  const byWallet = new Map<string, CandidateWallet>();

  for (const token of perToken) {
    const byCountMap = new Map(token.byCount.map((h) => [h.wallet, h] as const));
    const byTimeMap = new Map(token.byTime.map((h) => [h.wallet, h] as const));
    const wallets = new Set([...byCountMap.keys(), ...byTimeMap.keys()]);

    for (const wallet of wallets) {
      let candidate = byWallet.get(wallet);
      if (!candidate) {
        candidate = {
          address: wallet,
          hitCount: 0,
          hitCountTopN: 0,
          hitCountTimeWindow: 0,
          hits: [],
          avgEntryRank: null,
          avgEntryMinutes: null,
        };
        byWallet.set(wallet, candidate);
      }

      const countHit = byCountMap.get(wallet);
      const timeHit = byTimeMap.get(wallet);
      const criteria: ("topN" | "timeWindow")[] = [];
      if (countHit) {
        criteria.push("topN");
        candidate.hitCountTopN++;
      }
      if (timeHit) {
        criteria.push("timeWindow");
        candidate.hitCountTimeWindow++;
      }
      candidate.hitCount++;
      candidate.hits.push({
        tokenAddress: token.tokenAddress,
        symbol: token.symbol,
        criteria,
        rankAmongFirstN: countHit?.rankAmongFirstN,
        minutesAfterFirstTrade: timeHit?.minutesAfterFirstTrade,
      });
    }
  }

  for (const candidate of byWallet.values()) {
    const ranks = candidate.hits.map((h) => h.rankAmongFirstN).filter((v): v is number => v !== undefined);
    candidate.avgEntryRank = ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;

    const minutes = candidate.hits.map((h) => h.minutesAfterFirstTrade).filter((v): v is number => v !== undefined);
    candidate.avgEntryMinutes = minutes.length > 0 ? minutes.reduce((a, b) => a + b, 0) / minutes.length : null;
  }

  return [...byWallet.values()];
}

// ---------------------------------------------------------------------------
// Real-performance token ranking (unlike scripts/lib/mining.ts's scoreTokens,
// which is a trade-count/participation PROXY built for when no price data
// exists at all). Phase 5 (token_snapshots) is live now, so continuous
// discovery can rank tokens by their actual observed price movement instead.
// ---------------------------------------------------------------------------

export interface TokenPriceSnapshot {
  price: number;
  snapshotAt: Date;
}

export interface TokenForRanking {
  tokenId: number;
  address: string;
  symbol: string | null;
  /** Must be sorted ascending by snapshotAt; only snapshots with a known price. */
  snapshots: TokenPriceSnapshot[];
}

export interface RankedToken {
  tokenId: number;
  address: string;
  symbol: string | null;
  /** (peak price seen / earliest known price - 1) * 100. Only ever computed from real recorded snapshots — never a live/estimated price. */
  maxGainPct: number;
  snapshotCount: number;
}

/**
 * Ranks tokens by real observed price performance instead of a trade-shape
 * proxy. `minSnapshots` guards against a token with only 1-2 snapshots
 * producing a misleadingly extreme (or trivially 0%) gain figure — needs a
 * few real price points before "peak vs earliest" means anything.
 */
export function rankTokensByRealPerformance(tokens: TokenForRanking[], minSnapshots: number): RankedToken[] {
  const ranked: RankedToken[] = [];
  for (const token of tokens) {
    if (token.snapshots.length < minSnapshots) continue;
    const earliestPrice = token.snapshots[0]!.price;
    if (!(earliestPrice > 0)) continue; // never divide by a zero/negative baseline
    const peakPrice = Math.max(...token.snapshots.map((s) => s.price));
    ranked.push({
      tokenId: token.tokenId,
      address: token.address,
      symbol: token.symbol,
      maxGainPct: ((peakPrice - earliestPrice) / earliestPrice) * 100,
      snapshotCount: token.snapshots.length,
    });
  }
  return ranked.sort((a, b) => b.maxGainPct - a.maxGainPct);
}
