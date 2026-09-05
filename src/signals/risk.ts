// Risk grading (Phase 7) — pure, rule-based, no ML. V1 only evaluates
// signals we can reliably compute from data we actually have. It never
// fabricates Insider%/Sniper%/Bundler%-style metrics we don't have the
// data for, and never estimates them via other numbers standing in for
// them.
//
// If enough key data is missing to make any real judgment, the overall
// result is UNKNOWN — never defaulted to LOW. A LOW risk grade is a
// claim ("we checked, and it looks OK"), not the absence of information.

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

const SEVERITY_RANK: Record<Exclude<RiskLevel, "UNKNOWN">, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export interface RiskFactorResult {
  level: RiskLevel;
  reason: string;
}

export interface RiskBreakdown {
  liquidity: RiskFactorResult;
  marketCapEntry: RiskFactorResult;
  buySellImbalance: RiskFactorResult;
  suddenLargeSell: RiskFactorResult;
  watchlistExiting: RiskFactorResult;
  deployerSelling: RiskFactorResult;
  overall: RiskLevel;
}

// --- Individual factors -------------------------------------------------

/** Absolute liquidity depth. Unknown when DexScreener has no data for this token yet. */
export function liquidityRisk(liquidity: number | null): RiskFactorResult {
  if (liquidity === null) return { level: "UNKNOWN", reason: "no DexScreener liquidity data" };
  if (liquidity < 2_000) return { level: "CRITICAL", reason: `liquidity $${liquidity.toFixed(0)} < $2,000` };
  if (liquidity < 10_000) return { level: "HIGH", reason: `liquidity $${liquidity.toFixed(0)} < $10,000` };
  if (liquidity < 30_000) return { level: "MEDIUM", reason: `liquidity $${liquidity.toFixed(0)} < $30,000` };
  return { level: "LOW", reason: `liquidity $${liquidity.toFixed(0)} >= $30,000` };
}

/** Is this an already-large / already-late entry? Combines absolute cap with token age. */
export function marketCapEntryRisk(marketCap: number | null, ageMs: number): RiskFactorResult {
  if (marketCap === null) return { level: "UNKNOWN", reason: "no DexScreener market cap data" };
  const ageHours = ageMs / 3_600_000;
  if (marketCap > 500_000) {
    return { level: "HIGH", reason: `market cap $${marketCap.toFixed(0)} already > $500,000` };
  }
  if (ageHours > 3 && marketCap > 100_000) {
    return {
      level: "MEDIUM",
      reason: `token is ${ageHours.toFixed(1)}h old with market cap $${marketCap.toFixed(0)} — a late entry into meaningful size`,
    };
  }
  return { level: "LOW", reason: `market cap $${marketCap.toFixed(0)}, age ${ageHours.toFixed(1)}h` };
}

/** Recent (5m) sell pressure vs buy pressure. */
export function buySellImbalanceRisk(buys5m: number | null, sells5m: number | null): RiskFactorResult {
  if (buys5m === null || sells5m === null) return { level: "UNKNOWN", reason: "no DexScreener 5m txn data" };
  if (sells5m >= 3 && sells5m > buys5m * 2) {
    return { level: "HIGH", reason: `${sells5m} sells vs ${buys5m} buys in the last 5m (>2x sell pressure)` };
  }
  if (sells5m > buys5m) {
    return { level: "MEDIUM", reason: `${sells5m} sells vs ${buys5m} buys in the last 5m` };
  }
  return { level: "LOW", reason: `${buys5m} buys vs ${sells5m} sells in the last 5m` };
}

/** A single outsized sell relative to pool liquidity — a real "someone just dumped" signal, not a guess. */
export function suddenLargeSellRisk(largestRecentSellUsd: number | null, liquidity: number | null): RiskFactorResult {
  if (largestRecentSellUsd === null || liquidity === null || liquidity === 0) {
    return { level: "UNKNOWN", reason: "no usd-valued recent sell or liquidity data available" };
  }
  const ratio = largestRecentSellUsd / liquidity;
  if (ratio >= 0.2) {
    return { level: "CRITICAL", reason: `a single sell moved ${(ratio * 100).toFixed(0)}% of pool liquidity` };
  }
  if (ratio >= 0.1) {
    return { level: "HIGH", reason: `a single sell moved ${(ratio * 100).toFixed(0)}% of pool liquidity` };
  }
  if (ratio >= 0.05) {
    return { level: "MEDIUM", reason: `a single sell moved ${(ratio * 100).toFixed(0)}% of pool liquidity` };
  }
  return { level: "LOW", reason: `largest recent sell was only ${(ratio * 100).toFixed(1)}% of pool liquidity` };
}

/** Is the watchlist itself net-selling this token? */
export function watchlistExitingRisk(aggregateWatchedBuyUsd: number, aggregateWatchedSellUsd: number): RiskFactorResult {
  if (aggregateWatchedBuyUsd === 0 && aggregateWatchedSellUsd === 0) {
    return { level: "UNKNOWN", reason: "usd value not backfilled yet for watchlist trades" };
  }
  if (aggregateWatchedSellUsd > aggregateWatchedBuyUsd * 2) {
    return {
      level: "CRITICAL",
      reason: `watchlist wallets have sold $${aggregateWatchedSellUsd.toFixed(0)} vs bought $${aggregateWatchedBuyUsd.toFixed(0)} (2x+)`,
    };
  }
  if (aggregateWatchedSellUsd > aggregateWatchedBuyUsd) {
    return {
      level: "HIGH",
      reason: `watchlist wallets have sold more ($${aggregateWatchedSellUsd.toFixed(0)}) than bought ($${aggregateWatchedBuyUsd.toFixed(0)})`,
    };
  }
  return {
    level: "LOW",
    reason: `watchlist wallets are net buyers ($${aggregateWatchedBuyUsd.toFixed(0)} bought vs $${aggregateWatchedSellUsd.toFixed(0)} sold)`,
  };
}

/** Has the deployer sold any of their own token? A direct on-chain fact, not an estimate. */
export function deployerSellingRisk(hasDeployerSold: boolean | null): RiskFactorResult {
  if (hasDeployerSold === null) return { level: "UNKNOWN", reason: "could not determine deployer trading history" };
  if (hasDeployerSold) return { level: "HIGH", reason: "the deployer has sold some of their own token" };
  return { level: "LOW", reason: "no deployer sells observed" };
}

// --- Aggregation ---------------------------------------------------------

export interface RiskInput {
  liquidity: number | null;
  marketCap: number | null;
  ageMs: number;
  buys5m: number | null;
  sells5m: number | null;
  largestRecentSellUsd: number | null;
  aggregateWatchedBuyUsd: number;
  aggregateWatchedSellUsd: number;
  hasDeployerSold: boolean | null;
}

/**
 * Liquidity is the one foundational input every other market-based check
 * implicitly depends on — if DexScreener has no data at all for this
 * token, we genuinely cannot assess risk, so the whole result is UNKNOWN
 * rather than silently grading on whatever partial signals happen to be
 * available. Otherwise, overall risk is the single worst KNOWN factor
 * ("worst case wins") — a factor we couldn't evaluate is recorded as
 * UNKNOWN in the breakdown but doesn't by itself force the overall grade
 * down, since the ones we DID check still stand.
 */
export function computeRisk(input: RiskInput): { level: RiskLevel; breakdown: RiskBreakdown } {
  const liquidity = liquidityRisk(input.liquidity);
  const marketCapEntry = marketCapEntryRisk(input.marketCap, input.ageMs);
  const buySellImbalance = buySellImbalanceRisk(input.buys5m, input.sells5m);
  const suddenLargeSell = suddenLargeSellRisk(input.largestRecentSellUsd, input.liquidity);
  const watchlistExiting = watchlistExitingRisk(input.aggregateWatchedBuyUsd, input.aggregateWatchedSellUsd);
  const deployerSelling = deployerSellingRisk(input.hasDeployerSold);

  const factors = [liquidity, marketCapEntry, buySellImbalance, suddenLargeSell, watchlistExiting, deployerSelling];

  let overall: RiskLevel;
  if (input.liquidity === null) {
    overall = "UNKNOWN";
  } else {
    const known = factors.filter((f): f is RiskFactorResult & { level: Exclude<RiskLevel, "UNKNOWN"> } => f.level !== "UNKNOWN");
    overall = known.reduce<RiskLevel>(
      (worst, f) => (worst === "UNKNOWN" || SEVERITY_RANK[f.level] > SEVERITY_RANK[worst as Exclude<RiskLevel, "UNKNOWN">] ? f.level : worst),
      "LOW",
    );
  }

  return {
    level: overall,
    breakdown: { liquidity, marketCapEntry, buySellImbalance, suddenLargeSell, watchlistExiting, deployerSelling, overall },
  };
}
