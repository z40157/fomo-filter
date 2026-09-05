import { describe, expect, it } from "vitest";
import {
  MIN_RELIABLE_SAMPLE,
  buildOutcomeReport,
  type OutcomeAnalysisRow,
} from "../src/outcomes/analyzeOutcomesLogic.js";

function row(overrides: Partial<OutcomeAnalysisRow> = {}): OutcomeAnalysisRow {
  return {
    importanceScore: 7.5,
    riskLevel: "LOW",
    confidence: "HIGH",
    baselineAvailable: true,
    maxReturnPct: 50,
    maxDrawdownPct: -20,
    return1hPct: 10,
    return24hPct: 25,
    ...overrides,
  };
}

describe("buildOutcomeReport", () => {
  it("buckets by importance score with the right boundaries", () => {
    const report = buildOutcomeReport([
      row({ importanceScore: 6.0 }),
      row({ importanceScore: 6.9 }),
      row({ importanceScore: 7.0 }),
      row({ importanceScore: 8.5 }),
      row({ importanceScore: 9.9 }),
    ]);
    const counts = Object.fromEntries(report.byImportanceBucket.map((g) => [g.label, g.count]));
    expect(counts["6.0-6.9"]).toBe(2);
    expect(counts["7.0-7.9"]).toBe(1);
    expect(counts["8.0-8.9"]).toBe(1);
    expect(counts["9.0+"]).toBe(1);
  });

  it("excludes baseline-unavailable rows from every statistic, counting them separately", () => {
    const report = buildOutcomeReport([
      row({ importanceScore: 7.2, return24hPct: 100, baselineAvailable: true }),
      row({ importanceScore: 7.3, return24hPct: 999, baselineAvailable: false }), // must not affect the mean
      row({ importanceScore: 7.4, return24hPct: 200, baselineAvailable: true }),
    ]);
    const bucket = report.byImportanceBucket.find((g) => g.label === "7.0-7.9")!;
    expect(bucket.count).toBe(3);
    expect(bucket.dataComplete).toBe(2);
    expect(bucket.excluded).toBe(1);
    expect(bucket.return24h.mean).toBeCloseTo(150); // (100 + 200) / 2, the 999 excluded
    expect(bucket.return24h.n).toBe(2);
  });

  it("computes mean, median and the positive-return share correctly", () => {
    const report = buildOutcomeReport([
      row({ importanceScore: 8.1, return24hPct: -30 }),
      row({ importanceScore: 8.2, return24hPct: 10 }),
      row({ importanceScore: 8.3, return24hPct: 50 }),
    ]);
    const bucket = report.byImportanceBucket.find((g) => g.label === "8.0-8.9")!;
    expect(bucket.return24h.mean).toBeCloseTo(10);
    expect(bucket.return24h.median).toBeCloseTo(10);
    expect(bucket.positiveRatio24h).toBeCloseTo(2 / 3);
  });

  it("flags a group as insufficient when its data-complete sample is under the reliable threshold", () => {
    const few = Array.from({ length: MIN_RELIABLE_SAMPLE - 1 }, () => row({ importanceScore: 7.5 }));
    const enough = Array.from({ length: MIN_RELIABLE_SAMPLE }, () => row({ importanceScore: 8.5 }));
    const report = buildOutcomeReport([...few, ...enough]);
    expect(report.byImportanceBucket.find((g) => g.label === "7.0-7.9")!.insufficient).toBe(true);
    expect(report.byImportanceBucket.find((g) => g.label === "8.0-8.9")!.insufficient).toBe(false);
    expect(report.overall.insufficient).toBe(false); // 9+9 data-complete >= 10 total? -> 9 + 10 = 19
  });

  it("marks the overall report insufficient when too few data-complete outcomes exist", () => {
    const report = buildOutcomeReport([row(), row({ baselineAvailable: false })]);
    expect(report.overall.total).toBe(2);
    expect(report.overall.dataComplete).toBe(1);
    expect(report.overall.excluded).toBe(1);
    expect(report.overall.insufficient).toBe(true);
  });

  it("cross-tabulates by risk level and confidence, dropping empty groups", () => {
    const report = buildOutcomeReport([
      row({ riskLevel: "HIGH", confidence: "LOW" }),
      row({ riskLevel: "HIGH", confidence: "MEDIUM" }),
      row({ riskLevel: "UNKNOWN", confidence: "LOW" }),
    ]);
    expect(report.byRisk.map((g) => g.label).sort()).toEqual(["HIGH", "UNKNOWN"]);
    expect(report.byRisk.find((g) => g.label === "HIGH")!.count).toBe(2);
    expect(report.byConfidence.map((g) => g.label).sort()).toEqual(["LOW", "MEDIUM"]);
  });

  it("leaves means null (not 0) for a group with no usable data", () => {
    const report = buildOutcomeReport([
      row({ importanceScore: 9.5, return1hPct: null, return24hPct: null, maxReturnPct: null, maxDrawdownPct: null }),
    ]);
    const bucket = report.byImportanceBucket.find((g) => g.label === "9.0+")!;
    expect(bucket.return1h.mean).toBeNull();
    expect(bucket.return24h.mean).toBeNull();
    expect(bucket.positiveRatio24h).toBeNull();
    expect(bucket.avgMaxReturnPct).toBeNull();
    expect(bucket.avgMaxDrawdownPct).toBeNull();
  });
});
