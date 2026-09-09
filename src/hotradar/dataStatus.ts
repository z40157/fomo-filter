// B3 shadow-run support — maps Hard Gate reasons (hardGate.ts) onto the
// four data dimensions spec §0 calls out as UNKNOWN this phase (sellability
// / liquidity / creator history / holder concentration), so persistence and
// /health can report which one is missing without re-deriving it from raw
// gate reason strings in multiple places.

export type DataItemStatus = "OK" | "UNKNOWN" | "ERROR";

export interface DataStatusItem {
  status: DataItemStatus;
  reason: string | null;
}

export interface DataStatus {
  sellability: DataStatusItem;
  liquidity: DataStatusItem;
  creatorHistory: DataStatusItem;
  holderConcentration: DataStatusItem;
  marketData: DataStatusItem;
}

const REASON_MAP: Record<string, keyof DataStatus> = {
  SELLABILITY_UNKNOWN: "sellability",
  LIQUIDITY_UNKNOWN: "liquidity",
  CREATOR_LAUNCHES_24H_UNKNOWN: "creatorHistory",
  CONTRACT_CAPABILITIES_UNKNOWN: "creatorHistory",
  HOLDER_CONCENTRATION_TREND_UNKNOWN: "holderConcentration",
};

/** Builds the per-dimension OK/UNKNOWN breakdown from a Hard Gate result's
 * reasons array. `hasMarketData` is passed separately since it's not a gate
 * reason (Hard Gate never looks at market data) but §2.2's dataStatus field
 * is documented as "每项数据", so market data completeness belongs here too. */
export function buildDataStatus(gateReasons: readonly string[], hasMarketData: boolean): DataStatus {
  const base: DataStatus = {
    sellability: { status: "OK", reason: null },
    liquidity: { status: "OK", reason: null },
    creatorHistory: { status: "OK", reason: null },
    holderConcentration: { status: "OK", reason: null },
    marketData: hasMarketData ? { status: "OK", reason: null } : { status: "UNKNOWN", reason: "no trade in any window yet" },
  };
  for (const reason of gateReasons) {
    const key = REASON_MAP[reason];
    if (!key) continue;
    // A candidate can hit both CREATOR_LAUNCHES_24H_UNKNOWN and
    // CONTRACT_CAPABILITIES_UNKNOWN — keep the first reason string, both map
    // to the same bucket.
    if (base[key].status === "OK") base[key] = { status: "UNKNOWN", reason };
  }
  return base;
}

export type UnknownReasonBucket = "sellability" | "liquidity" | "creatorHistory" | "holderConcentration" | "multiple";

/** §5.2 — which single bucket (or "multiple") explains why a candidate is
 * UNKNOWN_REVIEW. Only meaningful when gateStatus is actually UNKNOWN_REVIEW;
 * returns null for PASS/REJECT (nothing to attribute). */
export function unknownReasonBucket(dataStatus: DataStatus): UnknownReasonBucket | null {
  const unknownKeys = (["sellability", "liquidity", "creatorHistory", "holderConcentration"] as const).filter(
    (k) => dataStatus[k].status === "UNKNOWN",
  );
  if (unknownKeys.length === 0) return null;
  if (unknownKeys.length === 1) return unknownKeys[0]!;
  return "multiple";
}
