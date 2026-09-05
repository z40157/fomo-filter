// Pure, DB/RPC-free logic for scripts/mineWallets.ts — kept separate so the
// scoring/early-buyer math can be unit-tested without a live database.
//
// IMPORTANT CAVEAT (repeated in the script's console/JSON output too): we
// have no price data yet (that's Phase 5's job), so none of this measures
// real profit, price change, or market cap. "Token performance score" here
// is a PROXY built only from trade-count/participation/timing shape —
// useful for picking which tokens look active enough to mine early buyers
// from, not a claim about which tokens actually made money.

export interface TokenTradeStats {
  tokenId: number;
  address: string;
  symbol: string | null;
  totalTrades: number;
  uniqueBuyers: number;
  buys: number;
  sells: number;
  firstTradeAt: Date;
  lastTradeAt: Date;
  /**
   * buyQuoteSum - sellQuoteSum, in the token's OWN quote-currency raw base
   * units. NOT comparable in absolute terms across tokens with different
   * quote currencies/decimals (we don't have pricing to normalize this to
   * USD) — only ever used here via its cross-token percentile rank, never
   * its raw magnitude.
   */
  netInflowRaw: number;
}

export interface ScoreComponents {
  totalTradesRank: number;
  uniqueBuyersRank: number;
  buyRatioRank: number;
  durationRank: number;
  netInflowRank: number;
}

export interface ScoredToken extends TokenTradeStats {
  buyRatio: number;
  durationSeconds: number;
  score: number;
  components: ScoreComponents;
}

/** Equal-weighted average of percentile ranks — see module doc comment for why raw magnitudes aren't combined directly. */
const SCORE_WEIGHTS = {
  totalTrades: 0.2,
  uniqueBuyers: 0.2,
  buyRatio: 0.2,
  duration: 0.2,
  netInflow: 0.2,
} as const;

/** 0 (lowest) to 1 (highest), by sorted position. Ties get distinct adjacent ranks (fine for a proxy score, not a statistical test). */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 1);
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(n);
  order.forEach((originalIndex, sortedPosition) => {
    ranks[originalIndex] = sortedPosition / (n - 1);
  });
  return ranks;
}

export function scoreTokens(tokenStats: TokenTradeStats[]): ScoredToken[] {
  const buyRatios = tokenStats.map((t) => (t.buys + t.sells > 0 ? t.buys / (t.buys + t.sells) : 0));
  const durations = tokenStats.map((t) => (t.lastTradeAt.getTime() - t.firstTradeAt.getTime()) / 1000);
  const totalTradesRanks = percentileRanks(tokenStats.map((t) => t.totalTrades));
  const uniqueBuyersRanks = percentileRanks(tokenStats.map((t) => t.uniqueBuyers));
  const buyRatioRanks = percentileRanks(buyRatios);
  const durationRanks = percentileRanks(durations);
  const netInflowRanks = percentileRanks(tokenStats.map((t) => t.netInflowRaw));

  return tokenStats.map((t, i) => {
    const components: ScoreComponents = {
      totalTradesRank: totalTradesRanks[i]!,
      uniqueBuyersRank: uniqueBuyersRanks[i]!,
      buyRatioRank: buyRatioRanks[i]!,
      durationRank: durationRanks[i]!,
      netInflowRank: netInflowRanks[i]!,
    };
    const score =
      components.totalTradesRank * SCORE_WEIGHTS.totalTrades +
      components.uniqueBuyersRank * SCORE_WEIGHTS.uniqueBuyers +
      components.buyRatioRank * SCORE_WEIGHTS.buyRatio +
      components.durationRank * SCORE_WEIGHTS.duration +
      components.netInflowRank * SCORE_WEIGHTS.netInflow;
    return { ...t, buyRatio: buyRatios[i]!, durationSeconds: durations[i]!, score, components };
  });
}

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
    const ranks = candidate.hits
      .map((h) => h.rankAmongFirstN)
      .filter((v): v is number => v !== undefined);
    candidate.avgEntryRank = ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;

    const minutes = candidate.hits
      .map((h) => h.minutesAfterFirstTrade)
      .filter((v): v is number => v !== undefined);
    candidate.avgEntryMinutes = minutes.length > 0 ? minutes.reduce((a, b) => a + b, 0) / minutes.length : null;
  }

  return [...byWallet.values()];
}
