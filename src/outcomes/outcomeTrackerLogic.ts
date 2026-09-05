// Phase 9 — Outcome Tracker: pure, DB/timer-free decisions. The core
// principle for everything here is data honesty: a missing input yields
// `null`, never `0` and never a carried-forward previous value.

/** Stable identifiers, not durations — the ms mapping can be shrunk for a
 * test without invalidating rows already written with these labels. */
export type OutcomeOffsetLabel = "5m" | "15m" | "1h" | "6h" | "24h";

export interface OutcomeOffset {
  label: OutcomeOffsetLabel;
  ms: number;
  /** How late a point may be recorded before it's flagged `delayed`. */
  delayToleranceMs: number;
}

// Default production offsets. index.ts can override the ms/tolerance via
// OUTCOME_OFFSETS_MS (labels stay fixed) — used by the real-verification
// step to exercise the whole path in seconds instead of a day.
export const DEFAULT_OUTCOME_OFFSETS: readonly OutcomeOffset[] = [
  { label: "5m", ms: 5 * 60_000, delayToleranceMs: 3 * 60_000 },
  { label: "15m", ms: 15 * 60_000, delayToleranceMs: 5 * 60_000 },
  { label: "1h", ms: 60 * 60_000, delayToleranceMs: 10 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000, delayToleranceMs: 30 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000, delayToleranceMs: 60 * 60_000 },
] as const;

/** The importance floor for tracking an outcome at all — deliberately
 * below the 7.0 alert threshold so "alerted vs not" stays comparable. */
export const OUTCOME_TRACKING_MIN_IMPORTANCE = 6.0;

export function shouldTrackOutcome(importanceScore: number): boolean {
  return importanceScore >= OUTCOME_TRACKING_MIN_IMPORTANCE;
}

export interface ScheduledPoint {
  label: OutcomeOffsetLabel;
  dueAt: Date;
}

export function buildPointSchedule(baselineAt: Date, offsets: readonly OutcomeOffset[] = DEFAULT_OUTCOME_OFFSETS): ScheduledPoint[] {
  return offsets.map((o) => ({ label: o.label, dueAt: new Date(baselineAt.getTime() + o.ms) }));
}

export function isPointDue(dueAt: Date, now: Date): boolean {
  return now.getTime() >= dueAt.getTime();
}

/** recordedAt - dueAt, in whole seconds. Can be negative only if called
 * before the point is due (callers don't). */
export function computeActualDelaySeconds(dueAt: Date, recordedAt: Date): number {
  return Math.round((recordedAt.getTime() - dueAt.getTime()) / 1000);
}

export function isDelayed(label: OutcomeOffsetLabel, actualDelaySeconds: number, offsets: readonly OutcomeOffset[] = DEFAULT_OUTCOME_OFFSETS): boolean {
  const offset = offsets.find((o) => o.label === label);
  const toleranceSeconds = offset ? offset.delayToleranceMs / 1000 : DEFAULT_OUTCOME_OFFSETS[0]!.delayToleranceMs / 1000;
  return actualDelaySeconds > toleranceSeconds;
}

/** Percentage change of `current` vs `baseline`. Null if either side is
 * missing or the baseline isn't a usable positive number — never 0. */
export function computeChangePct(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null) return null;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  if (!Number.isFinite(current)) return null;
  return ((current - baseline) / baseline) * 100;
}

export interface SampledPricePoint {
  /** ordering key — points are folded in chronological order */
  dueAt: Date;
  /** null when DexScreener had no data at that point */
  price: number | null;
}

export interface OutcomeSummary {
  maxPrice: number | null;
  minPrice: number | null;
  /** highest returnPct (%) vs baseline seen at any sampled point */
  maxReturnPct: number | null;
  /** worst drop (%) from the running max of the points seen so far — order-aware, negative */
  maxDrawdownPct: number | null;
}

/**
 * Recompute the rolled-up summary from scratch given the baseline and the
 * points recorded so far. Done from-scratch on every point insert (rather
 * than incrementally) so it's naturally correct after a restart and never
 * drifts. Only points with a real price participate; if none do, every
 * field is null.
 *
 * IMPORTANT: this is over 5 discrete samples, not a continuous feed — the
 * real intra-sample high/low is not observed and callers/reports must say so.
 */
export function computeOutcomeSummary(baselinePrice: number | null, points: SampledPricePoint[]): OutcomeSummary {
  const priced = points
    .filter((p): p is SampledPricePoint & { price: number } => p.price !== null && Number.isFinite(p.price))
    .slice()
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  if (priced.length === 0) {
    return { maxPrice: null, minPrice: null, maxReturnPct: null, maxDrawdownPct: null };
  }

  let maxPrice = priced[0]!.price;
  let minPrice = priced[0]!.price;
  let runningMax = priced[0]!.price;
  let maxDrawdownPct: number | null = null;

  for (const p of priced) {
    if (p.price > maxPrice) maxPrice = p.price;
    if (p.price < minPrice) minPrice = p.price;
    if (p.price > runningMax) runningMax = p.price;
    if (runningMax > 0) {
      const drawdown = ((p.price - runningMax) / runningMax) * 100;
      if (maxDrawdownPct === null || drawdown < maxDrawdownPct) maxDrawdownPct = drawdown;
    }
  }

  const maxReturnPct =
    baselinePrice !== null && Number.isFinite(baselinePrice) && baselinePrice > 0
      ? ((maxPrice - baselinePrice) / baselinePrice) * 100
      : null;

  return { maxPrice, minPrice, maxReturnPct, maxDrawdownPct };
}
