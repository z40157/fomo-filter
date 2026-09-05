import { describe, expect, it } from "vitest";
import {
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  computeConfidence,
  computeImportanceScore,
  scoreAcceleration,
  scoreEarlyness,
  scoreFlow,
  scoreMarketQuality,
  scoreNarrative,
  scoreResonance,
  type ImportanceScoreInput,
} from "../src/signals/scoring.js";

describe("scoreResonance — dimension A (max 3.0)", () => {
  it("jumps from 2.2 (3 ownerGroups) to the 3.0 cap (4 ownerGroups) — the explicit boundary", () => {
    expect(scoreResonance(3, 0).score).toBeCloseTo(2.2);
    expect(scoreResonance(4, 0).score).toBeCloseTo(3.0);
  });

  it("matches the full given tier table", () => {
    expect(scoreResonance(1, 0).score).toBeCloseTo(0.5);
    expect(scoreResonance(2, 0).score).toBeCloseTo(1.5);
    expect(scoreResonance(3, 0).score).toBeCloseTo(2.2);
    expect(scoreResonance(10, 0).score).toBeCloseTo(3.0);
  });

  it("adds 0.3 per Tier-A ownerGroup but never exceeds the 3.0 cap (clamp)", () => {
    const result = scoreResonance(3, 5); // 2.2 + 1.5 = 3.7 uncapped
    expect(result.score).toBe(3.0);
    expect(result.reasons.some((r) => r.includes("clamped"))).toBe(true);
  });

  it("a small Tier-A bonus that doesn't hit the cap is added exactly", () => {
    const result = scoreResonance(1, 1); // 0.5 + 0.3 = 0.8
    expect(result.score).toBeCloseTo(0.8);
  });
});

describe("scoreFlow — dimension B (max 2.0)", () => {
  it("gives a large positive score for strong net buying with repeat buyers", () => {
    const result = scoreFlow({ aggregateWatchedBuyUsd: 25_000, aggregateWatchedSellUsd: 0, repeatBuyerCount: 2 });
    expect(result.score).toBeCloseTo(2.0); // 1.2 + 0.5 + 0.3
  });

  it("scores net outflow (selling > buying) significantly lower than net inflow of the same magnitude", () => {
    const buying = scoreFlow({ aggregateWatchedBuyUsd: 10_000, aggregateWatchedSellUsd: 0, repeatBuyerCount: 0 });
    const selling = scoreFlow({ aggregateWatchedBuyUsd: 10_000, aggregateWatchedSellUsd: 20_000, repeatBuyerCount: 0 });
    expect(selling.score).toBeLessThan(buying.score);
  });

  it("severe net selling (watchlist exiting) drags the score to (or near) the floor", () => {
    const result = scoreFlow({ aggregateWatchedBuyUsd: 10_000, aggregateWatchedSellUsd: 20_000, repeatBuyerCount: 0 });
    // magnitude 1.0 (buy=$10k) + direction -1.0 (sold 2x what was bought, sellRatio 1.0 > 0.5) + repeat 0 = 0
    expect(result.score).toBe(0);
    expect(result.reasons.some((r) => r.toLowerCase().includes("severe net selling"))).toBe(true);
  });

  it("treats both-zero usd amounts as unknown data, not zero flow — gives baseline credit, not a penalty", () => {
    const result = scoreFlow({ aggregateWatchedBuyUsd: 0, aggregateWatchedSellUsd: 0, repeatBuyerCount: 0 });
    expect(result.score).toBeCloseTo(0.3);
    expect(result.reasons.some((r) => r.includes("not backfilled"))).toBe(true);
  });

  it("never exceeds the 2.0 dimension max", () => {
    const result = scoreFlow({ aggregateWatchedBuyUsd: 1_000_000, aggregateWatchedSellUsd: 0, repeatBuyerCount: 10 });
    expect(result.score).toBeLessThanOrEqual(2.0);
  });
});

describe("scoreAcceleration — dimension C (max 2.0)", () => {
  it("degrades to a flagged flat score when fewer than 2 snapshots exist", () => {
    const result = scoreAcceleration({
      volume5m: 1000,
      buys5m: 5,
      sells5m: 1,
      recentSnapshots: [{ snapshotAt: new Date(), volume5m: 1000 }],
    });
    expect(result.reasons.some((r) => r.includes("insufficient snapshot history"))).toBe(true);
  });

  it("does not reward absolute volume magnitude alone without any trend — flash-pump shape isn't auto-high", () => {
    // Flat trend (no growth) despite a large absolute volume number.
    const flatButHuge = scoreAcceleration({
      volume5m: 500_000,
      buys5m: 50,
      sells5m: 45,
      recentSnapshots: [
        { snapshotAt: new Date(0), volume5m: 480_000 },
        { snapshotAt: new Date(1), volume5m: 500_000 }, // +4%, "flat"
      ],
    });
    // momentum flat=0.4, activity(50 buys)=0.6, ratio(50/45=1.11)=0.25 => 1.25, well under the 2.0 cap
    expect(flatButHuge.score).toBeLessThan(2.0);
    expect(flatButHuge.score).toBeCloseTo(1.25);
  });

  it("rewards a genuinely accelerating trend between the two most recent snapshots", () => {
    const result = scoreAcceleration({
      volume5m: 2000,
      buys5m: 6,
      sells5m: 1,
      recentSnapshots: [
        { snapshotAt: new Date(0), volume5m: 500 },
        { snapshotAt: new Date(1), volume5m: 2000 }, // +300%
      ],
    });
    expect(result.reasons.some((r) => r.includes("rapidly accelerating"))).toBe(true);
  });

  it("scores a declining trend low", () => {
    const result = scoreAcceleration({
      volume5m: 100,
      buys5m: 1,
      sells5m: 1,
      recentSnapshots: [
        { snapshotAt: new Date(0), volume5m: 1000 },
        { snapshotAt: new Date(1), volume5m: 100 }, // -90%
      ],
    });
    expect(result.reasons.some((r) => r.includes("declining"))).toBe(true);
  });
});

describe("scoreMarketQuality — dimension D (max 1.0)", () => {
  it("rewards deep liquidity and a healthy mc/liquidity ratio", () => {
    const result = scoreMarketQuality({ liquidity: 60_000, marketCap: 50_000, totalBuys: 100, totalSells: 20 });
    expect(result.score).toBeCloseTo(1.0); // 0.5 + 0.3 (ratio<=1) + 0.2 (buys/sells>=1.5)
  });

  it("gives zero ratio credit when market cap dwarfs liquidity (thin liquidity)", () => {
    const result = scoreMarketQuality({ liquidity: 10_000, marketCap: 200_000, totalBuys: 10, totalSells: 10 });
    // ratio = 20 -> 0 credit
    expect(result.reasons.some((r) => r.includes("mc/liquidity ratio: 0"))).toBe(true);
  });

  it("never estimates Insider/Sniper/Bundler percentages — none of those concepts appear in the inputs or reasons", () => {
    const result = scoreMarketQuality({ liquidity: 10_000, marketCap: 10_000, totalBuys: 5, totalSells: 5 });
    const text = result.reasons.join(" ").toLowerCase();
    expect(text).not.toMatch(/insider|sniper|bundler/);
  });
});

describe("scoreNarrative — dimension E (max 1.0)", () => {
  it("does not error when the official stock token list is empty", () => {
    const result = scoreNarrative({
      pairTokenAddress: "0xabc",
      officialStockTokens: new Set(),
      narrativeBoost: null,
    });
    expect(result.score).toBe(0);
  });

  it("awards the stock-pair bonus when the pair token is in the configured list (case-insensitive)", () => {
    const result = scoreNarrative({
      pairTokenAddress: "0xABC",
      officialStockTokens: new Set(["0xabc"]),
      narrativeBoost: null,
    });
    expect(result.score).toBeCloseTo(0.6);
  });

  it("scales a manual narrative boost into the remaining budget", () => {
    const result = scoreNarrative({
      pairTokenAddress: "0xdead",
      officialStockTokens: new Set(),
      narrativeBoost: 1.0,
    });
    expect(result.score).toBeCloseTo(0.4);
  });

  it("never exceeds the 1.0 max even with both a stock pair and full narrative boost", () => {
    const result = scoreNarrative({
      pairTokenAddress: "0xabc",
      officialStockTokens: new Set(["0xabc"]),
      narrativeBoost: 1.0,
    });
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});

describe("scoreEarlyness — dimension F (max 1.0)", () => {
  it("is monotonically decreasing with age", () => {
    const points = [5, 20, 45, 120, 300].map((min) => scoreEarlyness(min * 60_000).score);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeLessThan(points[i - 1]!);
    }
  });

  it("matches the given table exactly", () => {
    expect(scoreEarlyness(10 * 60_000).score).toBe(1.0);
    expect(scoreEarlyness(20 * 60_000).score).toBe(0.8);
    expect(scoreEarlyness(45 * 60_000).score).toBe(0.6);
    expect(scoreEarlyness(2 * 3_600_000).score).toBe(0.4);
    expect(scoreEarlyness(4 * 3_600_000).score).toBe(0.2);
  });
});

function fullInput(overrides: Partial<ImportanceScoreInput> = {}): ImportanceScoreInput {
  return {
    distinctOwnerGroups: 3,
    tierAOwnerGroups: 1,
    flow: { aggregateWatchedBuyUsd: 5_000, aggregateWatchedSellUsd: 0, repeatBuyerCount: 1 },
    acceleration: {
      volume5m: 1000,
      buys5m: 3,
      sells5m: 1,
      recentSnapshots: [
        { snapshotAt: new Date(0), volume5m: 500 },
        { snapshotAt: new Date(1), volume5m: 1000 },
      ],
    },
    marketQuality: { liquidity: 20_000, marketCap: 20_000, totalBuys: 10, totalSells: 3 },
    narrative: { pairTokenAddress: "0xabc", officialStockTokens: new Set(), narrativeBoost: null },
    ageMs: 10 * 60_000,
    ...overrides,
  };
}

describe("computeImportanceScore — total", () => {
  it("sums all six dimensions and clamps to [1.0, 10.0]", () => {
    const { score, breakdown } = computeImportanceScore(fullInput());
    expect(score).toBeGreaterThanOrEqual(IMPORTANCE_MIN);
    expect(score).toBeLessThanOrEqual(IMPORTANCE_MAX);
    const rawSum =
      breakdown.resonance.score +
      breakdown.flow.score +
      breakdown.acceleration.score +
      breakdown.marketQuality.score +
      breakdown.narrative.score +
      breakdown.earlyness.score;
    expect(score).toBeCloseTo(Math.max(IMPORTANCE_MIN, Math.min(IMPORTANCE_MAX, rawSum)));
  });

  it("never produces a total below 1.0 even for a maximally weak input", () => {
    const { score } = computeImportanceScore(
      fullInput({
        distinctOwnerGroups: 0,
        tierAOwnerGroups: 0,
        flow: { aggregateWatchedBuyUsd: 10_000, aggregateWatchedSellUsd: 10_000, repeatBuyerCount: 0 },
        marketQuality: { liquidity: null, marketCap: null, totalBuys: 0, totalSells: 0 },
        ageMs: 10 * 3_600_000,
      }),
    );
    expect(score).toBeGreaterThanOrEqual(IMPORTANCE_MIN);
  });

  it("every dimension in the breakdown carries its own score, max, and reasons — fully traceable", () => {
    const { breakdown } = computeImportanceScore(fullInput());
    for (const dim of [
      breakdown.resonance,
      breakdown.flow,
      breakdown.acceleration,
      breakdown.marketQuality,
      breakdown.narrative,
      breakdown.earlyness,
    ]) {
      expect(dim.reasons.length).toBeGreaterThan(0);
      expect(typeof dim.score).toBe("number");
      expect(typeof dim.max).toBe("number");
    }
  });
});

describe("computeConfidence — independent of importance/risk", () => {
  it("is HIGH when all data is complete", () => {
    const { level } = computeConfidence({
      hasMarketData: true,
      snapshotCount: 5,
      hasUsdFlowData: true,
      fallbackOwnerGroupCount: 0,
      ageMs: 60 * 60_000,
    });
    expect(level).toBe("HIGH");
  });

  it("drops to LOW when several key inputs are missing, independent of how high importance scored", () => {
    // A deliberately HIGH-importance scenario...
    const importance = computeImportanceScore(
      fullInput({ distinctOwnerGroups: 6, tierAOwnerGroups: 3, flow: { aggregateWatchedBuyUsd: 50_000, aggregateWatchedSellUsd: 0, repeatBuyerCount: 3 } }),
    );
    expect(importance.score).toBeGreaterThan(7);

    // ...paired with a LOW-confidence data situation for the same signal.
    const { level, reasons } = computeConfidence({
      hasMarketData: false,
      snapshotCount: 0,
      hasUsdFlowData: false,
      fallbackOwnerGroupCount: 2,
      ageMs: 5 * 60_000,
    });
    expect(level).toBe("LOW");
    expect(reasons.length).toBeGreaterThan (1);
  });

  it("flags a fallback ownerGroup count as a reason", () => {
    const { reasons } = computeConfidence({
      hasMarketData: true,
      snapshotCount: 5,
      hasUsdFlowData: true,
      fallbackOwnerGroupCount: 2,
      ageMs: 60 * 60_000,
    });
    expect(reasons.some((r) => r.includes("no ownerGroup"))).toBe(true);
  });
});
