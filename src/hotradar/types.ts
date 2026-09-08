import type { ChainKey } from "../chains/types.js";

// Chain-agnostic hot-candidate domain types (spec Phase A/B). Nothing here
// may import viem or any chain-specific type — see chains/types.ts's same
// rule for ChainAdapter.

/** Radar lifecycle: how long the Hot Radar keeps paying expensive attention
 * to a candidate. Deliberately separate from ProtocolState (spec A.4) —
 * a token can be EXPIRED_30M here while its protocol state keeps updating
 * forever after (e.g. later reaches GRADUATED). */
export type RadarState = "DISCOVERED" | "EARLY_OBSERVATION" | "HOT" | "REJECTED" | "EXPIRED_30M";

/** What state the launchpad/pool itself is in. Different launchpads use
 * only the subset that applies to them (spec A.4). */
export type ProtocolState =
  | "UNKNOWN"
  | "CURVE_ACTIVE"
  | "NEAR_GRADUATION"
  | "GRADUATED"
  | "POOL_PENDING"
  | "POOL_ACTIVE"
  | "SURVIVING"
  | "DECAYING";

export type GateStatus = "PASS" | "REJECT" | "UNKNOWN_REVIEW";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

/** Age boundaries in ms — spec A.6. Exported as named constants (not
 * magic numbers scattered through lifecycle.ts) so B2.10/B2.16's
 * age-bucket logic and any future tuning read from one place. */
export const AGE_BOUNDARIES_MS = {
  DISCOVERED_END: 10_000, // 0-10s
  EARLY_OBSERVATION_END: 3 * 60_000, // 10s-3m
  HOT_FIRST_END: 10 * 60_000, // 3-10m
  HOT_SECOND_END: 20 * 60_000, // 10-20m
  HOT_THIRD_END: 30 * 60_000, // 20-30m — beyond this is EXPIRED_30M
} as const;

export interface GateResult {
  status: GateStatus;
  reasons: string[];
}

export interface HotCandidate {
  chain: ChainKey;
  tokenAddress: string;
  source: string;
  discoveredAt: Date;
  launchedAt: Date;
  launchBlockNumber: bigint | null;
  launchBlockHash: string | null;
  expiresAt: Date;
  radarState: RadarState;
  protocolState: ProtocolState;
  gateStatus: GateStatus;
  gateReasons: string[];
  invalidated: boolean;
  invalidatedReason: string | null;
}
