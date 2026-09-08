import type { GateResult, RiskLevel } from "./types.js";
import type { SellabilityStatus } from "../chains/types.js";

// Spec A.7-A.10. PASS / REJECT / UNKNOWN_REVIEW — UNKNOWN can never
// collapse into PASS (A.7), and a REJECT here must be based on a real,
// verified capability/fact, never guessed from a name or pattern (A.8).

export interface HardGateInputs {
  ageMs: number;
  sellability: SellabilityStatus;
  /** null = can't reliably compute yet (spec A.8: "无法可靠计算：UNKNOWN"). */
  creatorLaunches24h: number | null;
  /** Confirmed, verified red-flag capability names only (e.g.
   * "infinite_mint", "blacklist", "transfer_blocking") — never inferred
   * from a token's name/symbol. Empty array means none were found, which
   * is only meaningful together with `contractRedFlagsCheckable: true`. */
  contractRedFlags: string[];
  contractRedFlagsCheckable: boolean;
  /** Only meaningful once a real pool exists (protocolState POOL_ACTIVE
   * or later) — spec A.8: "正式pool已建立后：liquidity极薄到几乎无法退出". */
  liquidityThinness: "OK" | "THIN" | "UNKNOWN";
  /** null = no evidence either way (not itself an UNKNOWN_REVIEW trigger —
   * spec only calls out CRITICAL dumping severity as gate-relevant). */
  creatorDumpSeverity: RiskLevel | null;
  /** A.10 — only gate-relevant once ageMs >= 3m (A.9: younger than that,
   * concentration can never directly REJECT). */
  topTraderConcentration: { top3SharePct: number | null; uniqueTraders: number | null };
  /** A.9's dilution-trajectory read, only consulted once ageMs >= 3m. */
  holderConcentrationTrend: "IMPROVING" | "STAGNANT" | "UNKNOWN" | null;
}

export interface HardGateConfig {
  /** A.8 default: "launches24h >20". */
  maxCreatorLaunches24h: number;
  /** A.10 defaults — RULE_VERSION_1_GUESS, tune later against outcomes. */
  washTradeTop3SharePct: number;
  washTradeMaxUniqueTraders: number;
}

export const DEFAULT_HARD_GATE_CONFIG: HardGateConfig = {
  maxCreatorLaunches24h: 20,
  washTradeTop3SharePct: 70,
  washTradeMaxUniqueTraders: 5,
};

const CONCENTRATION_AGE_THRESHOLD_MS = 3 * 60_000;

export function evaluateHardGate(inputs: HardGateInputs, config: HardGateConfig = DEFAULT_HARD_GATE_CONFIG): GateResult {
  const reasons: string[] = [];
  let hasReject = false;
  let hasUnknown = false;

  if (inputs.sellability === "FAIL") {
    hasReject = true;
    reasons.push("SELLABILITY_FAIL");
  } else if (inputs.sellability === "UNKNOWN") {
    hasUnknown = true;
    reasons.push("SELLABILITY_UNKNOWN");
  }

  if (inputs.creatorLaunches24h === null) {
    hasUnknown = true;
    reasons.push("CREATOR_LAUNCHES_24H_UNKNOWN");
  } else if (inputs.creatorLaunches24h > config.maxCreatorLaunches24h) {
    hasReject = true;
    reasons.push(`CREATOR_LAUNCH_SPAM_${inputs.creatorLaunches24h}`);
  }

  if (!inputs.contractRedFlagsCheckable) {
    hasUnknown = true;
    reasons.push("CONTRACT_CAPABILITIES_UNKNOWN");
  } else if (inputs.contractRedFlags.length > 0) {
    hasReject = true;
    for (const flag of inputs.contractRedFlags) reasons.push(`CONTRACT_RED_FLAG_${flag}`);
  }

  if (inputs.liquidityThinness === "UNKNOWN") {
    hasUnknown = true;
    reasons.push("LIQUIDITY_UNKNOWN");
  } else if (inputs.liquidityThinness === "THIN") {
    hasReject = true;
    reasons.push("LIQUIDITY_TOO_THIN");
  }

  if (inputs.creatorDumpSeverity === "CRITICAL") {
    hasReject = true;
    reasons.push("CREATOR_DUMPING_CRITICAL");
  }

  if (inputs.ageMs >= CONCENTRATION_AGE_THRESHOLD_MS) {
    const { top3SharePct, uniqueTraders } = inputs.topTraderConcentration;
    if (
      top3SharePct !== null &&
      uniqueTraders !== null &&
      top3SharePct > config.washTradeTop3SharePct &&
      uniqueTraders <= config.washTradeMaxUniqueTraders
    ) {
      hasReject = true;
      reasons.push("WASH_TRADE_CONCENTRATION_RULE_VERSION_1_GUESS");
    }
    if (inputs.holderConcentrationTrend === "UNKNOWN") {
      hasUnknown = true;
      reasons.push("HOLDER_CONCENTRATION_TREND_UNKNOWN");
    }
  }

  if (hasReject) return { status: "REJECT", reasons };
  if (hasUnknown) return { status: "UNKNOWN_REVIEW", reasons };
  return { status: "PASS", reasons };
}
