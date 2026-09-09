import { describe, expect, it } from "vitest";
import {
  computeMaxReturnAndDrawdown,
  computeReturnPct,
  isHotPipelineOffset,
  nearestPoint,
  OUTCOME_OFFSETS,
} from "../../src/hotradar/outcomeScheduler.js";

describe("computeReturnPct", () => {
  it("computes a positive return", () => {
    expect(computeReturnPct(1, 1.5)).toBeCloseTo(50, 5);
  });
  it("computes a negative return", () => {
    expect(computeReturnPct(2, 1)).toBeCloseTo(-50, 5);
  });
  it("returns null when either side is missing — never guesses", () => {
    expect(computeReturnPct(null, 1)).toBeNull();
    expect(computeReturnPct(1, null)).toBeNull();
    expect(computeReturnPct(0, 1)).toBeNull();
  });
});

describe("isHotPipelineOffset", () => {
  it("5m/15m/30m are hot-pipeline offsets; 1h+ are cold", () => {
    expect(isHotPipelineOffset("5m")).toBe(true);
    expect(isHotPipelineOffset("15m")).toBe(true);
    expect(isHotPipelineOffset("30m")).toBe(true);
    expect(isHotPipelineOffset("1h")).toBe(false);
    expect(isHotPipelineOffset("24h")).toBe(false);
  });

  it("OUTCOME_OFFSETS has exactly the 7 spec labels in order", () => {
    expect(OUTCOME_OFFSETS.map((o) => o.label)).toEqual(["5m", "15m", "30m", "1h", "2h", "6h", "24h"]);
  });
});

describe("computeMaxReturnAndDrawdown", () => {
  const base = new Date("2026-01-01T00:00:00Z");
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

  it("tracks the running max/min return up to (and including) the cutoff, ignoring later points", () => {
    const series = [
      { at: at(0), price: 1 },
      { at: at(5), price: 1.2 }, // +20%
      { at: at(10), price: 0.9 }, // -10%
      { at: at(15), price: 1.5 }, // +50% — after cutoff, must be excluded
    ];
    const { maxReturnPct, maxDrawdownPct } = computeMaxReturnAndDrawdown(1, series, at(10));
    expect(maxReturnPct).toBeCloseTo(20, 5);
    expect(maxDrawdownPct).toBeCloseTo(-10, 5);
  });

  it("skips null-priced points instead of treating them as 0", () => {
    const series = [
      { at: at(0), price: 1 },
      { at: at(5), price: null },
      { at: at(10), price: 1.1 },
    ];
    const { maxReturnPct, maxDrawdownPct } = computeMaxReturnAndDrawdown(1, series, at(10));
    expect(maxReturnPct).toBeCloseTo(10, 5);
    expect(maxDrawdownPct).toBeCloseTo(0, 5);
  });

  it("returns null/null when there is no baseline or no priced points in range", () => {
    expect(computeMaxReturnAndDrawdown(null, [{ at: at(0), price: 1 }], at(0))).toEqual({
      maxReturnPct: null,
      maxDrawdownPct: null,
    });
    expect(computeMaxReturnAndDrawdown(1, [], at(0))).toEqual({ maxReturnPct: null, maxDrawdownPct: null });
  });
});

describe("nearestPoint", () => {
  const base = new Date("2026-01-01T00:00:00Z");
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

  it("finds the closest point within tolerance", () => {
    const series = [{ at: at(0) }, { at: at(4) }, { at: at(9) }];
    const found = nearestPoint(series, at(5), 2 * 60_000);
    expect(found).toEqual({ at: at(4) });
  });

  it("returns null when the closest point is outside tolerance", () => {
    const series = [{ at: at(0) }, { at: at(20) }];
    expect(nearestPoint(series, at(10), 60_000)).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(nearestPoint([], at(0), 60_000)).toBeNull();
  });
});
