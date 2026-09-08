import { AGE_BOUNDARIES_MS, type GateStatus, type RadarState } from "./types.js";

export function ageMs(now: Date, launchedAt: Date): number {
  return now.getTime() - launchedAt.getTime();
}

/** Pure radarState transition (spec A.4/A.6). REJECTED and EXPIRED_30M are
 * both sticky — once a candidate leaves the live window it never re-enters
 * it, regardless of what its gate/age would otherwise compute (a token
 * can't un-expire by having its clock reset, and a rejected token doesn't
 * get reconsidered just because a later re-evaluation's gate inputs
 * changed — see A.7/A.8 gate contract). ProtocolState is untouched here on
 * purpose (A.4: independent axis) — callers update it separately. */
export function nextRadarState(params: {
  ageMs: number;
  currentState: RadarState;
  gateStatus: GateStatus;
}): RadarState {
  if (params.currentState === "REJECTED" || params.currentState === "EXPIRED_30M") {
    return params.currentState;
  }
  if (params.gateStatus === "REJECT") {
    return "REJECTED";
  }
  if (params.ageMs > AGE_BOUNDARIES_MS.HOT_THIRD_END) {
    return "EXPIRED_30M";
  }
  if (params.ageMs <= AGE_BOUNDARIES_MS.DISCOVERED_END) {
    return "DISCOVERED";
  }
  if (params.ageMs <= AGE_BOUNDARIES_MS.EARLY_OBSERVATION_END) {
    return "EARLY_OBSERVATION";
  }
  return "HOT";
}

/** Finer age phase than RadarState alone (HOT spans 3m-30m as one radar
 * state, but spec A.6/B1.12 treat its three sub-windows differently for
 * refresh cadence and "is acceleration still holding" scoring emphasis). */
export type AgePhase = "DISCOVERED" | "EARLY_OBSERVATION" | "HOT_FIRST" | "HOT_SECOND" | "HOT_THIRD" | "EXPIRED";

export function agePhase(ms: number): AgePhase {
  if (ms > AGE_BOUNDARIES_MS.HOT_THIRD_END) return "EXPIRED";
  if (ms <= AGE_BOUNDARIES_MS.DISCOVERED_END) return "DISCOVERED";
  if (ms <= AGE_BOUNDARIES_MS.EARLY_OBSERVATION_END) return "EARLY_OBSERVATION";
  if (ms <= AGE_BOUNDARIES_MS.HOT_FIRST_END) return "HOT_FIRST";
  if (ms <= AGE_BOUNDARIES_MS.HOT_SECOND_END) return "HOT_SECOND";
  return "HOT_THIRD";
}

/** B1.12 refresh cadence — polling/expensive-check fallback interval per
 * age phase. WSS-pushed events (trades/transfers) are always real-time
 * regardless of this; this only bounds market-snapshot/expensive-check
 * polling for a candidate still inside the 30m window. Returns null once
 * expired (spec A.6: stop all high-frequency refresh entirely). */
export function refreshCadenceMsForAge(ms: number): number | null {
  const phase = agePhase(ms);
  switch (phase) {
    case "DISCOVERED":
    case "EARLY_OBSERVATION":
      return 7_500; // 5-10s midpoint
    case "HOT_FIRST":
      return 12_500; // 10-15s midpoint
    case "HOT_SECOND":
      return 22_500; // 15-30s midpoint
    case "HOT_THIRD":
      return 45_000; // 30-60s midpoint
    case "EXPIRED":
      return null;
  }
}

export function isExpired(ms: number): boolean {
  return ms > AGE_BOUNDARIES_MS.HOT_THIRD_END;
}
