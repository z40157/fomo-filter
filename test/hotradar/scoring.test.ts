import { describe, expect, it } from "vitest";
import {
  aggregateScore,
  computeConfidence,
  computeRisk,
  scoreCreator,
  scoreDistribution,
  scoreEarlyness,
  scoreKol,
  scoreLifecycle,
  scoreLiquidity,
  scoreNarrative,
  scoreOrganicMomentum,
} from "../../src/hotradar/scoring.js";

const ZERO_ORGANIC = scoreOrganicMomentum({ volumeVelocity: null, volumeAcceleration: null, uniqueBuyerVelocity: null, netBuyFlowUsd: null });
const ZERO_DIST = scoreDistribution({ uniqueBuyerVelocity: null, holderGrowth: null, top10HolderPct: null, sameWalletBuyRatio: null });
const ZERO_LIQ = scoreLiquidity({ liquidityUsd: null, liquidityGrowth: null, liquidityToMcRatio: null, sellabilityStatus: "UNKNOWN" });
const ZERO_CREATOR = scoreCreator({ launchesTotal: null, earlySellCount: null, survived24hRatio: null });
const LIFECYCLE = scoreLifecycle({ protocolState: "CURVE_ACTIVE" });
const NO_NARRATIVE = scoreNarrative({ manualBoost: null });

describe("scoreOrganicMomentum — partial data never fabricates a value", () => {
  it("scores 0 with no data at all, and says so", () => {
    expect(ZERO_ORGANIC.score).toBe(0);
    expect(ZERO_ORGANIC.reasons).toContain("NO_DATA");
  });

  it("rewards positive velocity/acceleration/buyer-growth, capped at 2.0", () => {
    const result = scoreOrganicMomentum({ volumeVelocity: 5, volumeAcceleration: 5, uniqueBuyerVelocity: 5, netBuyFlowUsd: 1000 });
    expect(result.score).toBe(2.0);
  });
});

describe("scoreKol — organic-only breakout must still be possible (B2 core change from V1)", () => {
  it("with 0 KOL/watchlist buys, KOL score is 0 but a high organic score can still stand alone", () => {
    const kol = scoreKol([]);
    expect(kol.score).toBe(0);
    expect(kol.reasons).toContain("NO_WATCHLIST_ACTIVITY");

    const strongOrganic = scoreOrganicMomentum({ volumeVelocity: 1, volumeAcceleration: 1, uniqueBuyerVelocity: 1, netBuyFlowUsd: 1000 });
    const aggregate = aggregateScore({
      organicMomentum: strongOrganic,
      distribution: ZERO_DIST,
      liquidity: ZERO_LIQ,
      creator: ZERO_CREATOR,
      lifecycle: LIFECYCLE,
      narrative: NO_NARRATIVE,
      earlyness: scoreEarlyness(5 * 60_000),
      kol,
    });
    expect(aggregate.breakoutScore).toBeGreaterThan(0);
    expect(aggregate.kol.score).toBe(0);
  });

  it("dedups multiple wallets under the same ownerGroup to one actor", () => {
    const result = scoreKol([
      { wallet: "0xa", ownerGroup: "same-person", tier: "B" },
      { wallet: "0xb", ownerGroup: "same-person", tier: "B" },
      { wallet: "0xc", ownerGroup: "same-person", tier: "B" },
      { wallet: "0xd", ownerGroup: "same-person", tier: "B" },
      { wallet: "0xe", ownerGroup: "same-person", tier: "B" },
    ]);
    expect(result.distinctActors).toBe(1);
    expect(result.score).toBe(0.4); // 1-actor tier, not 4+
  });

  it("counts genuinely distinct ownerGroups as distinct actors, applying the actor-count table", () => {
    const result = scoreKol([
      { wallet: "0xa", ownerGroup: "group-1", tier: "B" },
      { wallet: "0xb", ownerGroup: "group-2", tier: "B" },
      { wallet: "0xc", ownerGroup: "group-3", tier: "B" },
    ]);
    expect(result.distinctActors).toBe(3);
    expect(result.score).toBe(1.5);
  });

  it("degrades to NO_ACTOR_CLUSTERING (max 1.0) when any wallet has no ownerGroup — Phase 0 decision", () => {
    const result = scoreKol([
      { wallet: "0xa", ownerGroup: "group-1", tier: "B" },
      { wallet: "0xb", ownerGroup: null, tier: "B" },
      { wallet: "0xc", ownerGroup: null, tier: "B" },
    ]);
    expect(result.clusteringAvailable).toBe(false);
    expect(result.max).toBe(1.0);
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.reasons).toContain("NO_ACTOR_CLUSTERING");
  });

  it("applies the Tier A bonus and still respects the max cap", () => {
    const result = scoreKol([
      { wallet: "0xa", ownerGroup: "g1", tier: "A" },
      { wallet: "0xb", ownerGroup: "g2", tier: "B" },
      { wallet: "0xc", ownerGroup: "g3", tier: "B" },
      { wallet: "0xd", ownerGroup: "g4", tier: "B" },
    ]);
    expect(result.score).toBe(2.0); // 1.8 base (4+ actors) + 0.2 bonus, capped at 2.0
  });
});

describe("scoreEarlyness — age boundaries (A.6/B2.10)", () => {
  it("under 10s is not full marks (insufficient data)", () => {
    expect(scoreEarlyness(5_000).score).toBeLessThan(scoreEarlyness(5 * 60_000).score);
  });

  it("3-10m is the sweet spot — maximum score", () => {
    expect(scoreEarlyness(5 * 60_000).score).toBe(0.5);
  });

  it("past 30m scores 0 (EXPIRED — never actually reached in practice since expired candidates aren't scored)", () => {
    expect(scoreEarlyness(31 * 60_000).score).toBe(0);
  });
});

describe("aggregateScore — dimension caps sum to spec totals", () => {
  it("organicScore caps at 8.0 and breakoutScore caps at 10.0 even with maxed inputs", () => {
    const maxOrganic = scoreOrganicMomentum({ volumeVelocity: 999, volumeAcceleration: 999, uniqueBuyerVelocity: 999, netBuyFlowUsd: 999999 });
    const maxDist = scoreDistribution({ uniqueBuyerVelocity: 999, holderGrowth: 999, top10HolderPct: 0, sameWalletBuyRatio: 0 });
    const maxLiq = scoreLiquidity({ liquidityUsd: 999999, liquidityGrowth: 999, liquidityToMcRatio: 999, sellabilityStatus: "PASS" });
    const maxCreator = scoreCreator({ launchesTotal: 1, earlySellCount: 0, survived24hRatio: 1 });
    const maxKol = scoreKol([
      { wallet: "0xa", ownerGroup: "g1", tier: "A" },
      { wallet: "0xb", ownerGroup: "g2", tier: "A" },
      { wallet: "0xc", ownerGroup: "g3", tier: "A" },
      { wallet: "0xd", ownerGroup: "g4", tier: "A" },
    ]);
    const aggregate = aggregateScore({
      organicMomentum: maxOrganic,
      distribution: maxDist,
      liquidity: maxLiq,
      creator: maxCreator,
      lifecycle: scoreLifecycle({ protocolState: "GRADUATED" }),
      narrative: scoreNarrative({ manualBoost: 1 }),
      earlyness: scoreEarlyness(5 * 60_000),
      kol: maxKol,
    });
    expect(aggregate.organicScore).toBeLessThanOrEqual(8.0);
    expect(aggregate.breakoutScore).toBeLessThanOrEqual(10.0);
    expect(aggregate.ruleVersion).toBe(1);
  });
});

describe("computeConfidence — missing data lowers Confidence, never Risk", () => {
  it("HIGH when everything is complete", () => {
    const result = computeConfidence({
      marketDataComplete: true,
      holderDataComplete: true,
      creatorDataComplete: true,
      sellabilityKnown: true,
      walletAttributionReliable: true,
      windowCompleteness: 1,
    });
    expect(result.level).toBe("HIGH");
  });

  it("LOW when several inputs are missing", () => {
    const result = computeConfidence({
      marketDataComplete: false,
      holderDataComplete: false,
      creatorDataComplete: false,
      sellabilityKnown: false,
      walletAttributionReliable: true,
      windowCompleteness: 1,
    });
    expect(result.level).toBe("LOW");
  });
});

describe("computeRisk", () => {
  it("a Hard Gate REJECT always implies CRITICAL risk", () => {
    expect(computeRisk({ gateStatus: "REJECT", creatorDumpSeverity: null, washTradeShaped: false }).level).toBe("CRITICAL");
  });

  it("UNKNOWN_REVIEW gate with no other red flags is MEDIUM, not LOW or CRITICAL", () => {
    expect(computeRisk({ gateStatus: "UNKNOWN_REVIEW", creatorDumpSeverity: null, washTradeShaped: false }).level).toBe("MEDIUM");
  });

  it("a clean PASS gate with no escalators is LOW", () => {
    expect(computeRisk({ gateStatus: "PASS", creatorDumpSeverity: null, washTradeShaped: false }).level).toBe("LOW");
  });

  it("wash-trade-shaped concentration under 3m (not gate-rejected yet) still elevates risk to HIGH", () => {
    expect(computeRisk({ gateStatus: "PASS", creatorDumpSeverity: null, washTradeShaped: true }).level).toBe("HIGH");
  });
});
