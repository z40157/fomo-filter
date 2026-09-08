// Spec A.11 — expensive checks must be layered, never all run at launch.
// Launch -> Cheap Gate -> Survivor -> Medium Checks -> (organic score
// clears the Top Candidate bar) -> Expensive Checks. This module only
// decides WHICH tier a candidate should be evaluated at next; the actual
// check implementations (adapter calls, DB reads) live in the caller.

export type CheckTier = "CHEAP" | "MEDIUM" | "EXPENSIVE";

/** RULE_VERSION_1_GUESS — the Organic Score (max 8.0, spec B2.3) bar a
 * candidate must clear before expensive per-candidate checks (sell
 * simulation, full holder analysis, cluster analysis) are worth their
 * cost. Tune against outcome data once there's a real sample (see
 * PROGRESS.md's Phase 9 outcome-sample-size note). */
export const DEFAULT_EXPENSIVE_CHECK_ORGANIC_SCORE_THRESHOLD = 4.0;

export interface CheckTierInputs {
  /** Cheap Gate = age / launch source / basic trade existence / basic
   * pool-liquidity presence / creator 24h launch count — all cheap,
   * already-available data. false means the candidate hasn't survived
   * even that bar yet. */
  cheapGatePassed: boolean;
  /** Current Organic Score (0-8), or null if not yet computed. */
  organicScore: number | null;
  organicScoreThreshold?: number;
}

export function nextCheckTier(inputs: CheckTierInputs): CheckTier {
  if (!inputs.cheapGatePassed) return "CHEAP";
  const threshold = inputs.organicScoreThreshold ?? DEFAULT_EXPENSIVE_CHECK_ORGANIC_SCORE_THRESHOLD;
  if (inputs.organicScore === null || inputs.organicScore < threshold) return "MEDIUM";
  return "EXPENSIVE";
}
