// Spec §4 — Outcome Tracking for HOT/PASS/ALERT candidates. Pure math only
// (offset table, return/drawdown from a price series) — DB scheduling and
// the hot-pipeline/cold-sample split live in db/outcomePointsRepo.ts and
// indexV2.ts respectively, same separation as V1's outcomes/outcomeTrackerLogic.ts
// vs outcomes/outcomeTracker.ts.

export type OutcomeOffsetLabel = "5m" | "15m" | "30m" | "1h" | "2h" | "6h" | "24h";

export interface OutcomeOffset {
  label: OutcomeOffsetLabel;
  ms: number;
}

/** §4.1 — 5m/15m/30m are still inside the candidate's <=30m hot window and
 * must be filled from the hot pipeline's own snapshots (no extra RPC/API
 * call); 1h/2h/6h/24h need an independent cold sample after the candidate
 * has expired. */
export const OUTCOME_OFFSETS: readonly OutcomeOffset[] = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "2h", ms: 2 * 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
];

export const HOT_PIPELINE_OFFSETS = new Set<OutcomeOffsetLabel>(["5m", "15m", "30m"]);

export function isHotPipelineOffset(label: OutcomeOffsetLabel): boolean {
  return HOT_PIPELINE_OFFSETS.has(label);
}

/** Return relative to the baseline price captured when the candidate first
 * crossed into outcome tracking (HOT/PASS/ALERT). Null propagates — never
 * guess a return from a missing price on either side (spec §4: "禁止猜测"). */
export function computeReturnPct(baselinePrice: number | null, samplePrice: number | null): number | null {
  if (baselinePrice === null || samplePrice === null || baselinePrice <= 0) return null;
  return ((samplePrice - baselinePrice) / baselinePrice) * 100;
}

export interface PricePoint {
  at: Date;
  price: number | null;
}

/** Max return / max drawdown "to this point" (spec §4: maxReturn/maxDrawdown
 * are defined "到该时点为止", i.e. over the prefix of the series up to and
 * including `upTo`) — computed from whatever priced points exist in the
 * prefix; points with a null price are skipped rather than treated as 0. */
export function computeMaxReturnAndDrawdown(
  baselinePrice: number | null,
  series: readonly PricePoint[],
  upTo: Date,
): { maxReturnPct: number | null; maxDrawdownPct: number | null } {
  if (baselinePrice === null || baselinePrice <= 0) return { maxReturnPct: null, maxDrawdownPct: null };
  const prefix = series.filter((p) => p.at.getTime() <= upTo.getTime() && p.price !== null);
  if (prefix.length === 0) return { maxReturnPct: null, maxDrawdownPct: null };

  let maxReturnPct: number | null = null;
  let maxDrawdownPct: number | null = null;
  for (const point of prefix) {
    const ret = computeReturnPct(baselinePrice, point.price);
    if (ret === null) continue;
    if (maxReturnPct === null || ret > maxReturnPct) maxReturnPct = ret;
    if (maxDrawdownPct === null || ret < maxDrawdownPct) maxDrawdownPct = ret;
  }
  return { maxReturnPct, maxDrawdownPct };
}

/** Finds the series point whose timestamp is closest to `target`, for
 * filling a 5m/15m/30m outcome point from the hot pipeline's existing score
 * snapshots (spec §4.1) instead of an independent sample. Null if the
 * series is empty or nothing is within `toleranceMs`. */
export function nearestPoint<T extends { at: Date }>(series: readonly T[], target: Date, toleranceMs: number): T | null {
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const point of series) {
    const delta = Math.abs(point.at.getTime() - target.getTime());
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }
  if (best === null || bestDelta > toleranceMs) return null;
  return best;
}
