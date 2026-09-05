import { describe, expect, it } from "vitest";
import {
  buySellImbalanceRisk,
  computeRisk,
  deployerSellingRisk,
  liquidityRisk,
  marketCapEntryRisk,
  suddenLargeSellRisk,
  watchlistExitingRisk,
  type RiskInput,
} from "../src/signals/risk.js";

describe("liquidityRisk", () => {
  it("returns UNKNOWN, not LOW, when liquidity data is missing", () => {
    expect(liquidityRisk(null).level).toBe("UNKNOWN");
  });

  it("grades by threshold", () => {
    expect(liquidityRisk(1_000).level).toBe("CRITICAL");
    expect(liquidityRisk(5_000).level).toBe("HIGH");
    expect(liquidityRisk(20_000).level).toBe("MEDIUM");
    expect(liquidityRisk(100_000).level).toBe("LOW");
  });
});

describe("marketCapEntryRisk", () => {
  it("is UNKNOWN without market cap data", () => {
    expect(marketCapEntryRisk(null, 60_000).level).toBe("UNKNOWN");
  });

  it("flags an already-large cap as HIGH regardless of age", () => {
    expect(marketCapEntryRisk(600_000, 5 * 60_000).level).toBe("HIGH");
  });

  it("flags a late, meaningfully-sized entry as MEDIUM", () => {
    expect(marketCapEntryRisk(150_000, 4 * 3_600_000).level).toBe("MEDIUM");
  });

  it("is LOW for a fresh, small-cap token", () => {
    expect(marketCapEntryRisk(20_000, 10 * 60_000).level).toBe("LOW");
  });
});

describe("buySellImbalanceRisk", () => {
  it("is UNKNOWN without txn data", () => {
    expect(buySellImbalanceRisk(null, null).level).toBe("UNKNOWN");
  });

  it("flags heavy recent sell pressure as HIGH", () => {
    expect(buySellImbalanceRisk(1, 5).level).toBe("HIGH");
  });

  it("flags mild sell-heavy imbalance as MEDIUM", () => {
    expect(buySellImbalanceRisk(2, 3).level).toBe("MEDIUM");
  });

  it("is LOW when buys lead", () => {
    expect(buySellImbalanceRisk(5, 1).level).toBe("LOW");
  });
});

describe("suddenLargeSellRisk", () => {
  it("is UNKNOWN without a usd-valued sell or liquidity", () => {
    expect(suddenLargeSellRisk(null, 10_000).level).toBe("UNKNOWN");
    expect(suddenLargeSellRisk(1_000, null).level).toBe("UNKNOWN");
  });

  it("grades by fraction of liquidity moved in a single sell", () => {
    expect(suddenLargeSellRisk(3_000, 10_000).level).toBe("CRITICAL"); // 30%
    expect(suddenLargeSellRisk(1_500, 10_000).level).toBe("HIGH"); // 15%
    expect(suddenLargeSellRisk(700, 10_000).level).toBe("MEDIUM"); // 7%
    expect(suddenLargeSellRisk(100, 10_000).level).toBe("LOW"); // 1%
  });
});

describe("watchlistExitingRisk", () => {
  it("is UNKNOWN when there's no usd flow data at all (both exactly zero)", () => {
    expect(watchlistExitingRisk(0, 0).level).toBe("UNKNOWN");
  });

  it("flags heavy net selling as CRITICAL", () => {
    expect(watchlistExitingRisk(1_000, 3_000).level).toBe("CRITICAL");
  });

  it("flags mild net selling as HIGH", () => {
    expect(watchlistExitingRisk(1_000, 1_500).level).toBe("HIGH");
  });

  it("is LOW when the watchlist is a net buyer", () => {
    expect(watchlistExitingRisk(5_000, 1_000).level).toBe("LOW");
  });
});

describe("deployerSellingRisk", () => {
  it("is UNKNOWN when we couldn't determine it", () => {
    expect(deployerSellingRisk(null).level).toBe("UNKNOWN");
  });

  it("flags a selling deployer as HIGH", () => {
    expect(deployerSellingRisk(true).level).toBe("HIGH");
  });

  it("is LOW when the deployer hasn't sold", () => {
    expect(deployerSellingRisk(false).level).toBe("LOW");
  });
});

function baseRiskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    liquidity: 50_000,
    marketCap: 30_000,
    ageMs: 10 * 60_000,
    buys5m: 5,
    sells5m: 1,
    largestRecentSellUsd: 100,
    aggregateWatchedBuyUsd: 5_000,
    aggregateWatchedSellUsd: 0,
    hasDeployerSold: false,
    ...overrides,
  };
}

describe("computeRisk — aggregation", () => {
  it("each factor is judged independently and recorded in the breakdown", () => {
    const { breakdown } = computeRisk(baseRiskInput());
    expect(breakdown.liquidity.level).toBe("LOW");
    expect(breakdown.marketCapEntry.level).toBe("LOW");
    expect(breakdown.buySellImbalance.level).toBe("LOW");
    expect(breakdown.suddenLargeSell.level).toBe("LOW");
    expect(breakdown.watchlistExiting.level).toBe("LOW");
    expect(breakdown.deployerSelling.level).toBe("LOW");
  });

  it("overall risk is the single worst known factor ('worst case wins')", () => {
    const { level } = computeRisk(baseRiskInput({ hasDeployerSold: true, liquidity: 50_000 }));
    expect(level).toBe("HIGH"); // deployer selling is HIGH, everything else is LOW
  });

  it("CRITICAL from any one factor makes the overall CRITICAL", () => {
    const { level } = computeRisk(baseRiskInput({ largestRecentSellUsd: 20_000, liquidity: 50_000 })); // 40% of liquidity
    expect(level).toBe("CRITICAL");
  });

  it("returns UNKNOWN overall when liquidity (the foundational input) is missing, never defaulting to LOW", () => {
    const { level, breakdown } = computeRisk(baseRiskInput({ liquidity: null }));
    expect(level).toBe("UNKNOWN");
    // but individual factors that COULD be judged are still recorded
    expect(breakdown.deployerSelling.level).toBe("LOW");
  });

  it("a single unresolvable non-foundational factor doesn't force the whole result to UNKNOWN", () => {
    const { level } = computeRisk(baseRiskInput({ hasDeployerSold: null }));
    expect(level).not.toBe("UNKNOWN");
    expect(level).toBe("LOW");
  });
});
