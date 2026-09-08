import { describe, expect, it } from "vitest";
import { rankTokensByRealPerformance, type TokenForRanking } from "../../src/discovery/miningLogic.js";

function token(overrides: Partial<TokenForRanking> = {}): TokenForRanking {
  return {
    tokenId: 1,
    address: "0x1111111111111111111111111111111111111111",
    symbol: "TEST",
    snapshots: [],
    ...overrides,
  };
}

describe("rankTokensByRealPerformance", () => {
  it("ranks by real peak-vs-earliest price gain, highest first", () => {
    const weak = token({
      tokenId: 1,
      symbol: "WEAK",
      snapshots: Array.from({ length: 5 }, (_, i) => ({ price: 1 + i * 0.01, snapshotAt: new Date(2026, 0, 1, i) })),
    });
    const strong = token({
      tokenId: 2,
      symbol: "STRONG",
      snapshots: Array.from({ length: 5 }, (_, i) => ({ price: 1 + i, snapshotAt: new Date(2026, 0, 1, i) })),
    });

    const ranked = rankTokensByRealPerformance([weak, strong], 5);

    expect(ranked.map((r) => r.symbol)).toEqual(["STRONG", "WEAK"]);
    expect(ranked[0]!.maxGainPct).toBeCloseTo(400, 5); // 1 -> 5 = +400%
    expect(ranked[1]!.maxGainPct).toBeCloseTo(4, 5); // 1 -> 1.04 = +4%
  });

  it("excludes tokens with fewer than minSnapshots real price points", () => {
    const tooFew = token({
      snapshots: [
        { price: 1, snapshotAt: new Date(2026, 0, 1) },
        { price: 10, snapshotAt: new Date(2026, 0, 2) },
      ],
    });

    expect(rankTokensByRealPerformance([tooFew], 5)).toEqual([]);
  });

  it("never divides by a zero or negative earliest price", () => {
    const badBaseline = token({
      snapshots: [
        { price: 0, snapshotAt: new Date(2026, 0, 1) },
        { price: 5, snapshotAt: new Date(2026, 0, 2) },
        { price: 5, snapshotAt: new Date(2026, 0, 3) },
      ],
    });

    expect(rankTokensByRealPerformance([badBaseline], 3)).toEqual([]);
  });

  it("uses the FIRST snapshot as baseline, not the minimum (peak could precede a later dip)", () => {
    const t = token({
      snapshots: [
        { price: 2, snapshotAt: new Date(2026, 0, 1) },
        { price: 10, snapshotAt: new Date(2026, 0, 2) },
        { price: 1, snapshotAt: new Date(2026, 0, 3) },
      ],
    });

    const [ranked] = rankTokensByRealPerformance([t], 3);
    expect(ranked!.maxGainPct).toBeCloseTo(400, 5); // peak 10 vs baseline (first) 2 = +400%
  });
});
