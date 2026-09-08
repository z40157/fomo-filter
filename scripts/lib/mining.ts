// Pure, DB/RPC-free logic for scripts/mineWallets.ts — kept separate so the
// scoring/early-buyer math can be unit-tested without a live database.
//
// IMPORTANT CAVEAT (repeated in the script's console/JSON output too): we
// have no price data yet (that's Phase 5's job), so none of this measures
// real profit, price change, or market cap. "Token performance score" here
// is a PROXY built only from trade-count/participation/timing shape —
// useful for picking which tokens look active enough to mine early buyers
// from, not a claim about which tokens actually made money.
//
// The early-buyer/aggregation functions now live in
// src/discovery/miningLogic.ts (re-exported below) so
// src/discovery/walletDiscoveryJob.ts can reuse the exact same logic
// continuously in production — scripts/ is dev-tooling only and isn't part
// of the compiled dist/ image. scoreTokens/percentileRanks stay here: they're
// a proxy score only useful for this one-off historical-mining tool, now
// superseded by rankTokensByRealPerformance (miningLogic.ts) wherever real
// snapshot price data is available.

export type {
  TradeForMining,
  EarlyBuyerHit,
  EarlyBuyerTimeHit,
  TokenHitInfo,
  CandidateWallet,
  PerTokenEarlyBuyers,
} from "../../src/discovery/miningLogic.js";
export { findEarlyBuyersByCount, findEarlyBuyersByTime, aggregateCandidates } from "../../src/discovery/miningLogic.js";

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
