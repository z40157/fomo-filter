import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTCOME_OFFSETS,
  OUTCOME_TRACKING_MIN_IMPORTANCE,
  buildPointSchedule,
  computeActualDelaySeconds,
  computeChangePct,
  computeOutcomeSummary,
  isDelayed,
  isPointDue,
  shouldTrackOutcome,
} from "../src/outcomes/outcomeTrackerLogic.js";

describe("shouldTrackOutcome", () => {
  it("tracks at exactly 6.0 (below the 7.0 alert threshold, on purpose)", () => {
    expect(OUTCOME_TRACKING_MIN_IMPORTANCE).toBe(6.0);
    expect(shouldTrackOutcome(6.0)).toBe(true);
    expect(shouldTrackOutcome(6.4)).toBe(true);
    expect(shouldTrackOutcome(9.9)).toBe(true);
  });
  it("does not track below 6.0", () => {
    expect(shouldTrackOutcome(5.9)).toBe(false);
    expect(shouldTrackOutcome(1.0)).toBe(false);
  });
});

describe("buildPointSchedule", () => {
  it("produces the five fixed offsets from the baseline", () => {
    const baseline = new Date("2026-01-01T00:00:00Z");
    const points = buildPointSchedule(baseline);
    expect(points.map((p) => p.label)).toEqual(["5m", "15m", "1h", "6h", "24h"]);
    expect(points[0]!.dueAt.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    expect(points[1]!.dueAt.toISOString()).toBe("2026-01-01T00:15:00.000Z");
    expect(points[2]!.dueAt.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(points[3]!.dueAt.toISOString()).toBe("2026-01-01T06:00:00.000Z");
    expect(points[4]!.dueAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("honours overridden offsets while keeping the label set", () => {
    const baseline = new Date("2026-01-01T00:00:00Z");
    const shortened = DEFAULT_OUTCOME_OFFSETS.map((o, i) => ({ ...o, ms: (i + 1) * 1000 }));
    const points = buildPointSchedule(baseline, shortened);
    expect(points.map((p) => p.label)).toEqual(["5m", "15m", "1h", "6h", "24h"]);
    expect(points[0]!.dueAt.toISOString()).toBe("2026-01-01T00:00:01.000Z");
    expect(points[4]!.dueAt.toISOString()).toBe("2026-01-01T00:00:05.000Z");
  });
});

describe("isPointDue", () => {
  it("is due exactly at and after dueAt, not before", () => {
    const due = new Date("2026-01-01T00:05:00Z");
    expect(isPointDue(due, new Date("2026-01-01T00:04:59Z"))).toBe(false);
    expect(isPointDue(due, due)).toBe(true);
    expect(isPointDue(due, new Date("2026-01-01T00:06:00Z"))).toBe(true);
  });
});

describe("computeActualDelaySeconds / isDelayed", () => {
  it("reports the real gap between due and recorded", () => {
    const due = new Date("2026-01-01T00:05:00Z");
    const recorded = new Date("2026-01-01T00:13:00Z"); // 8 min late
    expect(computeActualDelaySeconds(due, recorded)).toBe(480);
  });

  it("flags a +5m point delayed only past its 3-minute tolerance", () => {
    expect(isDelayed("5m", 179)).toBe(false);
    expect(isDelayed("5m", 180)).toBe(false);
    expect(isDelayed("5m", 181)).toBe(true);
    // a +8m-late +5m point is delayed
    expect(isDelayed("5m", 480)).toBe(true);
  });

  it("uses the wider tolerance for later offsets", () => {
    // +24h tolerance is 1h
    expect(isDelayed("24h", 3599)).toBe(false);
    expect(isDelayed("24h", 3601)).toBe(true);
  });
});

describe("computeChangePct", () => {
  it("computes a straightforward percentage change", () => {
    expect(computeChangePct(100, 125)).toBeCloseTo(25);
    expect(computeChangePct(100, 40)).toBeCloseTo(-60);
    expect(computeChangePct(0.001, 0.01)).toBeCloseTo(900);
  });

  it("returns null (never 0) when either side is missing or the baseline is unusable", () => {
    expect(computeChangePct(null, 10)).toBeNull();
    expect(computeChangePct(10, null)).toBeNull();
    expect(computeChangePct(null, null)).toBeNull();
    expect(computeChangePct(0, 10)).toBeNull();
    expect(computeChangePct(-5, 10)).toBeNull();
    expect(computeChangePct(Number.NaN, 10)).toBeNull();
  });
});

describe("computeOutcomeSummary", () => {
  const d = (min: number) => new Date(2026, 0, 1, 0, min, 0);

  it("is all-null when no sampled point has a price", () => {
    const s = computeOutcomeSummary(100, [
      { dueAt: d(5), price: null },
      { dueAt: d(15), price: null },
    ]);
    expect(s).toEqual({ maxPrice: null, minPrice: null, maxReturnPct: null, maxDrawdownPct: null });
  });

  it("tracks max/min price and best return across the sampled points", () => {
    const s = computeOutcomeSummary(100, [
      { dueAt: d(5), price: 120 },
      { dueAt: d(15), price: 150 },
      { dueAt: d(60), price: 90 },
    ]);
    expect(s.maxPrice).toBe(150);
    expect(s.minPrice).toBe(90);
    expect(s.maxReturnPct).toBeCloseTo(50); // (150-100)/100
  });

  it("measures max drawdown from the running peak, in chronological order", () => {
    const s = computeOutcomeSummary(100, [
      { dueAt: d(5), price: 200 }, // peak
      { dueAt: d(15), price: 120 }, // -40% from peak
      { dueAt: d(60), price: 260 }, // new peak
      { dueAt: d(360), price: 130 }, // -50% from the 260 peak
    ]);
    expect(s.maxDrawdownPct).toBeCloseTo(-50);
  });

  it("still computes price stats but leaves maxReturnPct null when the baseline price is unavailable", () => {
    const s = computeOutcomeSummary(null, [
      { dueAt: d(5), price: 120 },
      { dueAt: d(15), price: 90 },
    ]);
    expect(s.maxPrice).toBe(120);
    expect(s.minPrice).toBe(90);
    expect(s.maxReturnPct).toBeNull();
  });

  it("ignores non-priced points but keeps the priced ones", () => {
    const s = computeOutcomeSummary(100, [
      { dueAt: d(5), price: null },
      { dueAt: d(15), price: 140 },
      { dueAt: d(60), price: null },
    ]);
    expect(s.maxPrice).toBe(140);
    expect(s.maxReturnPct).toBeCloseTo(40);
  });
});
