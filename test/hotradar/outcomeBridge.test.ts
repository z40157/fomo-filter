import { describe, expect, it } from "vitest";
import { buildOutcomeTriggerSignal, crossesOutcomeThreshold } from "../../src/hotradar/outcomeBridge.js";

describe("crossesOutcomeThreshold", () => {
  it("matches the spec's Hot Score >= 5.5 threshold exactly", () => {
    expect(crossesOutcomeThreshold(5.49)).toBe(false);
    expect(crossesOutcomeThreshold(5.5)).toBe(true);
    expect(crossesOutcomeThreshold(9)).toBe(true);
  });
});

describe("buildOutcomeTriggerSignal", () => {
  it("produces a valid V1 NewSignal shape reusing distinctActors as distinctOwnerGroups", () => {
    const signal = buildOutcomeTriggerSignal({
      tokenId: 42,
      triggeredAt: new Date("2026-01-01T00:00:00Z"),
      breakoutScore: 7.3,
      kol: { score: 1.0, max: 2.0, reasons: [], distinctActors: 2, clusteringAvailable: true },
      risk: { level: "MEDIUM", reasons: [] },
      confidence: { level: "MEDIUM", reasons: ["PARTIAL_WINDOW_DATA"] },
      marketCapUsd: 126_000,
      liquidityUsd: 39_000,
      volume5mUsd: 61_000,
    });

    expect(signal.tokenId).toBe(42);
    expect(signal.distinctOwnerGroups).toBe(2);
    expect(signal.importanceScore).toBe(7.3);
    expect(signal.riskLevel).toBe("MEDIUM");
    expect(signal.confidence).toBe("MEDIUM");
    expect(signal.confidenceReasons).toEqual(["PARTIAL_WINDOW_DATA"]);
    expect(signal.scoreBreakdown).toBeUndefined(); // never fabricates a V1-shaped breakdown
  });
});
