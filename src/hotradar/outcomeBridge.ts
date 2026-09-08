// Spec B4 — Outcome Tracker. "保留现有Outcome" / "不要为了V2做tick-level PnL
// engine": rather than building a second discrete-sampling system, this
// bridges a Hot Candidate that just crossed the Hot Score >=5.5 threshold
// into V1's existing, unmodified signals/signal_outcomes/signal_outcome_points
// tables + outcomeTracker.ts — both already live in the shared shadow
// schema (db/shadowSchema.ts re-exports V1's schema.ts unchanged).
//
// Honesty note: V1's `signals` table bakes in resonance-detector-specific
// concepts (triggerConditions, distinctOwnerGroups, windowMinutes) that
// don't map 1:1 onto V2's organic-momentum-driven trigger. Rather than
// fabricate values for fields V2 has no real equivalent for, this maps
// only what's genuinely equivalent and uses clearly-labeled placeholders
// (documented per-field below) for the rest — V2's own rich breakdown
// lives in candidate_score_history.breakdown (jsonb, spec A.16), not
// forced into V1's typed scoreBreakdown/riskBreakdown columns.
import type { NewSignal, TriggerCondition } from "../db/signals.js";
import type { ConfidenceLevel, RiskLevel } from "./types.js";
import type { KolScoreResult } from "./scoring.js";

export const HOT_SCORE_OUTCOME_THRESHOLD = 5.5;

export interface OutcomeBridgeInputs {
  tokenId: number;
  triggeredAt: Date;
  breakoutScore: number;
  kol: KolScoreResult;
  risk: { level: RiskLevel; reasons: string[] };
  confidence: { level: ConfidenceLevel; reasons: string[] };
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
}

/** True the moment a candidate's breakoutScore first reaches the outcome
 * threshold — callers should only bridge once per candidate (track via
 * the same "already alerted at this tier" bookkeeping the manager already
 * does for re-alerts). */
export function crossesOutcomeThreshold(breakoutScore: number): boolean {
  return breakoutScore >= HOT_SCORE_OUTCOME_THRESHOLD;
}

export function buildOutcomeTriggerSignal(inputs: OutcomeBridgeInputs): NewSignal {
  const tierACount = 0; // V1 tracks this per-wallet from signal_wallets rows written separately; not reconstructable from KolScoreResult alone (which only has distinctActors) — real value needs the manager's raw kolBuys list, left to the caller when writing signal_wallets rows.
  const triggerConditions: TriggerCondition[] = ["A"]; // placeholder: V2's trigger is "breakoutScore >= threshold", not one of V1's A/B/C resonance conditions — "A" reused only so the (non-optional) column has a valid enum value.
  return {
    tokenId: inputs.tokenId,
    triggeredAt: inputs.triggeredAt,
    triggerConditions,
    distinctOwnerGroups: inputs.kol.distinctActors,
    tierACount,
    hasRepeatAccumulation: false, // no V2 equivalent computed yet — honestly false, not guessed
    windowMinutes: 0, // V2 has no fixed resonance window; scoring is continuous
    escalation: false,
    marketCap: inputs.marketCapUsd,
    liquidity: inputs.liquidityUsd,
    volume5m: inputs.volume5mUsd,
    importanceScore: inputs.breakoutScore,
    // scoreBreakdown/riskBreakdown deliberately omitted — see file header.
    riskLevel: inputs.risk.level,
    confidence: inputs.confidence.level,
    confidenceReasons: inputs.confidence.reasons,
  };
}
