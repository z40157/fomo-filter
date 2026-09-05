// Phase 9 — pure report builder for `npm run outcomes:analyze`. Takes the
// already-fetched outcome rows and produces a plain data structure the
// script renders as console tables. No I/O, no formatting here.
//
// Two hard rules, enforced here so the script can't get them wrong:
//  - rows with baseline_available = false are EXCLUDED from every
//    statistic (counted separately as "excluded"), never mixed in.
//  - a group whose data-complete sample is below MIN_RELIABLE_SAMPLE is
//    flagged `insufficient` so the renderer can warn instead of presenting
//    an authoritative-looking number.

import type { RiskLevel } from "../signals/risk.js";
import type { ConfidenceLevel } from "../signals/scoring.js";

export const MIN_RELIABLE_SAMPLE = 10;

export interface OutcomeAnalysisRow {
  importanceScore: number;
  riskLevel: RiskLevel | null;
  confidence: ConfidenceLevel | null;
  baselineAvailable: boolean;
  maxReturnPct: number | null;
  maxDrawdownPct: number | null;
  /** returnPct (%) from the recorded '1h' point, or null. */
  return1hPct: number | null;
  /** returnPct (%) from the recorded '24h' point, or null. */
  return24hPct: number | null;
}

export interface MeanMedian {
  mean: number | null;
  median: number | null;
  /** how many rows actually contributed (non-null) */
  n: number;
}

export interface GroupStats {
  label: string;
  count: number;
  dataComplete: number;
  excluded: number;
  return1h: MeanMedian;
  return24h: MeanMedian;
  /** fraction of data-complete rows with a non-null +24h return that is > 0; null if none */
  positiveRatio24h: number | null;
  avgMaxReturnPct: number | null;
  avgMaxDrawdownPct: number | null;
  insufficient: boolean;
}

export interface OutcomeReport {
  overall: {
    total: number;
    dataComplete: number;
    excluded: number;
    insufficient: boolean;
  };
  byImportanceBucket: GroupStats[];
  byRisk: GroupStats[];
  byConfidence: GroupStats[];
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function meanMedian(xs: (number | null)[]): MeanMedian {
  const present = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return { mean: mean(present), median: median(present), n: present.length };
}

function groupStats(label: string, rows: OutcomeAnalysisRow[]): GroupStats {
  const complete = rows.filter((r) => r.baselineAvailable);
  const excluded = rows.length - complete.length;

  const ret1h = complete.map((r) => r.return1hPct);
  const ret24h = complete.map((r) => r.return24hPct);
  const ret24hPresent = ret24h.filter((x): x is number => x !== null && Number.isFinite(x));
  const maxReturns = complete.map((r) => r.maxReturnPct).filter((x): x is number => x !== null && Number.isFinite(x));
  const maxDrawdowns = complete.map((r) => r.maxDrawdownPct).filter((x): x is number => x !== null && Number.isFinite(x));

  return {
    label,
    count: rows.length,
    dataComplete: complete.length,
    excluded,
    return1h: meanMedian(ret1h),
    return24h: meanMedian(ret24h),
    positiveRatio24h: ret24hPresent.length === 0 ? null : ret24hPresent.filter((x) => x > 0).length / ret24hPresent.length,
    avgMaxReturnPct: mean(maxReturns),
    avgMaxDrawdownPct: mean(maxDrawdowns),
    insufficient: complete.length < MIN_RELIABLE_SAMPLE,
  };
}

const IMPORTANCE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "6.0-6.9", min: 6.0, max: 7.0 },
  { label: "7.0-7.9", min: 7.0, max: 8.0 },
  { label: "8.0-8.9", min: 8.0, max: 9.0 },
  { label: "9.0+", min: 9.0, max: Infinity },
];

const RISK_LEVELS: (RiskLevel | null)[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN", null];
const CONFIDENCE_LEVELS: (ConfidenceLevel | null)[] = ["HIGH", "MEDIUM", "LOW", null];

export function buildOutcomeReport(rows: OutcomeAnalysisRow[]): OutcomeReport {
  const dataComplete = rows.filter((r) => r.baselineAvailable).length;

  return {
    overall: {
      total: rows.length,
      dataComplete,
      excluded: rows.length - dataComplete,
      insufficient: dataComplete < MIN_RELIABLE_SAMPLE,
    },
    byImportanceBucket: IMPORTANCE_BUCKETS.map((b) =>
      groupStats(
        b.label,
        rows.filter((r) => r.importanceScore >= b.min && r.importanceScore < b.max),
      ),
    ),
    byRisk: RISK_LEVELS.map((lvl) =>
      groupStats(
        lvl ?? "(unrated)",
        rows.filter((r) => r.riskLevel === lvl),
      ),
    ).filter((g) => g.count > 0),
    byConfidence: CONFIDENCE_LEVELS.map((lvl) =>
      groupStats(
        lvl ?? "(unrated)",
        rows.filter((r) => r.confidence === lvl),
      ),
    ).filter((g) => g.count > 0),
  };
}
