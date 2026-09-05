import { describe, expect, it, vi } from "vitest";
import { createOutcomeTracker, type OutcomeMarketSource } from "../src/outcomes/outcomeTracker.js";
import type {
  DuePoint,
  NewSignalOutcome,
  RecordPointInput,
  SignalOutcomesRepo,
} from "../src/db/signalOutcomes.js";
import type { Logger } from "../src/logger.js";
import type { ScoreBreakdown } from "../src/signals/scoring.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const SCORE_BREAKDOWN = {
  resonance: { score: 2.2, max: 3, reasons: [] },
  flow: { score: 0.3, max: 2, reasons: [] },
  acceleration: { score: 0.4, max: 2, reasons: [] },
  marketQuality: { score: 0.5, max: 1, reasons: [] },
  narrative: { score: 0, max: 1, reasons: [] },
  earlyness: { score: 1, max: 1, reasons: [] },
  total: 4.6,
} satisfies ScoreBreakdown;

interface StoredOutcome extends NewSignalOutcome {
  id: number;
  baselineAvailable: boolean;
  summary: { maxPrice: number | null; minPrice: number | null; maxReturnPct: number | null; maxDrawdownPct: number | null };
}
interface StoredPoint {
  id: number;
  signalOutcomeId: number;
  offsetLabel: string;
  dueAt: Date;
  recordedAt: Date | null;
  price: number | null;
  input: RecordPointInput | null;
}

/** In-memory repo that actually persists, so a fresh tracker over the same
 * store simulates a process restart. */
function memRepo() {
  const outcomes: StoredOutcome[] = [];
  const points: StoredPoint[] = [];
  let outcomeSeq = 0;
  let pointSeq = 0;

  const repo: SignalOutcomesRepo = {
    async createOutcome(input) {
      const existing = outcomes.find((o) => o.signalId === input.signalId);
      if (existing) return { outcomeId: existing.id, created: false };
      const id = ++outcomeSeq;
      outcomes.push({
        ...input,
        id,
        baselineAvailable: input.baselinePrice !== null,
        summary: { maxPrice: null, minPrice: null, maxReturnPct: null, maxDrawdownPct: null },
      });
      for (const p of input.points) {
        points.push({
          id: ++pointSeq,
          signalOutcomeId: id,
          offsetLabel: p.offsetLabel,
          dueAt: p.dueAt,
          recordedAt: null,
          price: null,
          input: null,
        });
      }
      return { outcomeId: id, created: true };
    },
    async listDuePendingPoints(now, limit) {
      return points
        .filter((p) => p.recordedAt === null && p.dueAt.getTime() <= now.getTime())
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
        .slice(0, limit)
        .map((p): DuePoint => {
          const o = outcomes.find((x) => x.id === p.signalOutcomeId)!;
          return {
            pointId: p.id,
            signalOutcomeId: p.signalOutcomeId,
            offsetLabel: p.offsetLabel as DuePoint["offsetLabel"],
            dueAt: p.dueAt,
            tokenId: o.tokenId,
            tokenAddress: `0xtoken${o.tokenId}`,
            baselinePrice: o.baselinePrice,
            baselineMarketCap: o.baselineMarketCap,
            baselineAvailable: o.baselineAvailable,
          };
        });
    },
    async recordPoint(pointId, input) {
      const p = points.find((x) => x.id === pointId)!;
      p.recordedAt = input.recordedAt;
      p.price = input.price;
      p.input = input;
    },
    async listRecordedPoints(signalOutcomeId) {
      return points
        .filter((p) => p.signalOutcomeId === signalOutcomeId && p.recordedAt !== null)
        .map((p) => ({ dueAt: p.dueAt, price: p.price }));
    },
    async updateSummary(signalOutcomeId, summary) {
      outcomes.find((o) => o.id === signalOutcomeId)!.summary = summary;
    },
    async countTracked() {
      const ids = new Set(points.filter((p) => p.recordedAt === null).map((p) => p.signalOutcomeId));
      return ids.size;
    },
    async countPendingPoints() {
      return points.filter((p) => p.recordedAt === null).length;
    },
    async listForAnalysis() {
      return [];
    },
  };
  return { repo, outcomes, points };
}

function fakeMarket(price: number | null): OutcomeMarketSource & { getTokenSnapshot: ReturnType<typeof vi.fn> } {
  return {
    getTokenSnapshot: vi.fn(async () =>
      price === null ? null : { priceUsd: price, marketCap: price * 1000, liquidityUsd: 5000, volume5m: 42 },
    ),
  } as OutcomeMarketSource & { getTokenSnapshot: ReturnType<typeof vi.fn> };
}

function signalInput(overrides: Partial<Parameters<ReturnType<typeof createOutcomeTracker>["onSignalCreated"]>[0]> = {}) {
  return {
    signalId: 1,
    tokenId: 7,
    tokenAddress: "0xtoken7",
    importanceScore: 6.5,
    riskLevel: "LOW" as const,
    confidence: "MEDIUM" as const,
    scoreBreakdown: SCORE_BREAKDOWN,
    triggeredAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("createOutcomeTracker — onSignalCreated", () => {
  it("creates an outcome with five scheduled points for a signal scoring >= 6.0", async () => {
    const { repo, outcomes, points } = memRepo();
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: fakeMarket(0.01),
      scoringRuleVersion: 1,
      logger: fakeLogger(),
    });

    await tracker.onSignalCreated(signalInput());

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ signalId: 1, tokenId: 7, baselineAvailable: true, scoringRuleVersion: 1 });
    expect(outcomes[0]!.baselinePrice).toBe(0.01);
    expect(points.map((p) => p.offsetLabel)).toEqual(["5m", "15m", "1h", "6h", "24h"]);
    expect(points[4]!.dueAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does NOT create an outcome for a signal scoring below 6.0", async () => {
    const { repo, outcomes } = memRepo();
    const market = fakeMarket(0.01);
    const tracker = createOutcomeTracker({ outcomesRepo: repo, marketSource: market, scoringRuleVersion: 1, logger: fakeLogger() });

    await tracker.onSignalCreated(signalInput({ importanceScore: 5.9 }));

    expect(outcomes).toHaveLength(0);
    expect(market.getTokenSnapshot).not.toHaveBeenCalled();
  });

  it("still creates the outcome + schedule when DexScreener has no baseline, marking baselineAvailable=false", async () => {
    const { repo, outcomes, points } = memRepo();
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: fakeMarket(null),
      scoringRuleVersion: 1,
      logger: fakeLogger(),
    });

    await tracker.onSignalCreated(signalInput());

    expect(outcomes[0]).toMatchObject({ baselineAvailable: false });
    expect(outcomes[0]!.baselinePrice).toBeNull();
    expect(points).toHaveLength(5);
  });

  it("is idempotent — a second call for the same signal does not duplicate", async () => {
    const { repo, outcomes, points } = memRepo();
    const tracker = createOutcomeTracker({ outcomesRepo: repo, marketSource: fakeMarket(0.01), scoringRuleVersion: 1, logger: fakeLogger() });
    await tracker.onSignalCreated(signalInput());
    await tracker.onSignalCreated(signalInput());
    expect(outcomes).toHaveLength(1);
    expect(points).toHaveLength(5);
  });

  it("never throws even if the repo blows up", async () => {
    const { repo } = memRepo();
    repo.createOutcome = vi.fn(async () => {
      throw new Error("db down");
    });
    const logger = fakeLogger();
    const tracker = createOutcomeTracker({ outcomesRepo: repo, marketSource: fakeMarket(0.01), scoringRuleVersion: 1, logger });
    await expect(tracker.onSignalCreated(signalInput())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createOutcomeTracker — runOnce sweeper", () => {
  it("records only points whose dueAt has passed, computing returnPct vs baseline", async () => {
    const { repo, points } = memRepo();
    let clock = new Date("2026-01-01T00:00:00Z");
    const market = fakeMarket(0.01); // baseline 0.01
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: market,
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await tracker.onSignalCreated(signalInput()); // baseline captured at 0.01

    // price rises to 0.012 (+20%); move to +7 minutes: only the +5m point is due
    market.getTokenSnapshot.mockResolvedValue({ priceUsd: 0.012, marketCap: 12, liquidityUsd: 5000, volume5m: 42 });
    clock = new Date("2026-01-01T00:07:00Z");
    const res = await tracker.runOnce();

    expect(res.recorded).toBe(1);
    const p5 = points.find((p) => p.offsetLabel === "5m")!;
    const p15 = points.find((p) => p.offsetLabel === "15m")!;
    expect(p5.recordedAt).not.toBeNull();
    expect(p15.recordedAt).toBeNull();
    expect(p5.input!.dataAvailable).toBe(true);
    expect(p5.input!.returnPct).toBeCloseTo(20); // 0.012 vs 0.01
    expect(p5.input!.delayed).toBe(false); // 2 min late, tolerance 3
  });

  it("records dataAvailable=false and null derived metrics (not 0) when DexScreener returns nothing", async () => {
    const { repo, points } = memRepo();
    let clock = new Date("2026-01-01T00:00:00Z");
    const market = fakeMarket(0.01);
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: market,
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await tracker.onSignalCreated(signalInput()); // baseline captured as 0.01

    market.getTokenSnapshot.mockResolvedValue(null); // DexScreener goes dark
    clock = new Date("2026-01-01T00:07:00Z");
    await tracker.runOnce();

    const p5 = points.find((p) => p.offsetLabel === "5m")!;
    expect(p5.input!.dataAvailable).toBe(false);
    expect(p5.input!.price).toBeNull();
    expect(p5.input!.returnPct).toBeNull();
    expect(p5.input!.marketCapChangePct).toBeNull();
  });

  it("leaves returnPct null (not 0) when the outcome had no baseline", async () => {
    const { repo, points } = memRepo();
    let clock = new Date("2026-01-01T00:00:00Z");
    const market = fakeMarket(null); // no baseline
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: market,
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await tracker.onSignalCreated(signalInput());

    market.getTokenSnapshot.mockResolvedValue({ priceUsd: 0.05, marketCap: 50, liquidityUsd: 5000, volume5m: 1 });
    clock = new Date("2026-01-01T00:07:00Z");
    await tracker.runOnce();

    const p5 = points.find((p) => p.offsetLabel === "5m")!;
    expect(p5.input!.dataAvailable).toBe(true);
    expect(p5.input!.price).toBe(0.05);
    expect(p5.input!.returnPct).toBeNull();
  });

  it("records the true delay and flags delayed when a point is recorded well past its tolerance", async () => {
    const { repo, points } = memRepo();
    let clock = new Date("2026-01-01T00:00:00Z");
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: fakeMarket(0.01),
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await tracker.onSignalCreated(signalInput());

    // Simulate a downtime: the +5m point is only swept at +20m
    clock = new Date("2026-01-01T00:20:00Z");
    await tracker.runOnce();

    const p5 = points.find((p) => p.offsetLabel === "5m")!;
    expect(p5.input!.actualDelaySeconds).toBe(15 * 60); // due 00:05, recorded 00:20
    expect(p5.input!.delayed).toBe(true);
  });

  it("recovers pending work from the store after a simulated restart (no in-memory timers)", async () => {
    const store = memRepo();
    let clock = new Date("2026-01-01T00:00:00Z");

    const before = createOutcomeTracker({
      outcomesRepo: store.repo,
      marketSource: fakeMarket(0.01),
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await before.onSignalCreated(signalInput());
    before.stop();

    // "restart": brand-new tracker instance, fresh closure state, same store
    clock = new Date("2026-01-01T02:00:00Z"); // +5m/+15m/+1h all now overdue
    const after = createOutcomeTracker({
      outcomesRepo: store.repo,
      marketSource: fakeMarket(0.02),
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    const res = await after.runOnce();

    expect(res.recorded).toBe(3); // 5m, 15m, 1h
    expect(store.points.filter((p) => p.recordedAt !== null).map((p) => p.offsetLabel).sort()).toEqual(["15m", "1h", "5m"]);
    expect(store.points.filter((p) => p.recordedAt === null).map((p) => p.offsetLabel).sort()).toEqual(["24h", "6h"]);
  });

  it("rolls up maxReturn / maxDrawdown from the sampled points across multiple sweeps", async () => {
    const store = memRepo();
    let clock = new Date("2026-01-01T00:00:00Z");
    const market = fakeMarket(0.01); // baseline 0.01
    const tracker = createOutcomeTracker({
      outcomesRepo: store.repo,
      marketSource: market,
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await tracker.onSignalCreated(signalInput());

    // +5m: price 0.03 (+200%)
    market.getTokenSnapshot.mockResolvedValue({ priceUsd: 0.03, marketCap: 30, liquidityUsd: 5000, volume5m: 1 });
    clock = new Date("2026-01-01T00:06:00Z");
    await tracker.runOnce();

    // +15m: price 0.012 (drawdown from the 0.03 peak)
    market.getTokenSnapshot.mockResolvedValue({ priceUsd: 0.012, marketCap: 12, liquidityUsd: 5000, volume5m: 1 });
    clock = new Date("2026-01-01T00:16:00Z");
    await tracker.runOnce();

    const o = store.outcomes[0]!;
    expect(o.summary.maxPrice).toBe(0.03);
    expect(o.summary.minPrice).toBe(0.012);
    expect(o.summary.maxReturnPct).toBeCloseTo(200); // (0.03-0.01)/0.01
    expect(o.summary.maxDrawdownPct).toBeCloseTo(-60); // (0.012-0.03)/0.03
  });

  it("does nothing when there are no due points yet", async () => {
    const { repo } = memRepo();
    const clock = new Date("2026-01-01T00:00:00Z");
    const tracker = createOutcomeTracker({
      outcomesRepo: repo,
      marketSource: fakeMarket(0.01),
      scoringRuleVersion: 1,
      logger: fakeLogger(),
      now: () => clock,
    });
    await tracker.onSignalCreated(signalInput());
    const res = await tracker.runOnce(); // still at T0, nothing due
    expect(res.recorded).toBe(0);
  });
});
