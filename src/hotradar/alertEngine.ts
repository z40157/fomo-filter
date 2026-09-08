// Spec B3 — Shadow Alert Engine. Pure decision logic only (tier +
// override ladder + re-alert eligibility) — actual delivery (Telegram
// send, DB write) is the caller's job, kept separate so this stays
// unit-testable without a network client (same separation V1 draws
// between signals/resonanceLogic.ts and alerts/alertDispatcher.ts).
import type { ConfidenceLevel, RiskLevel } from "./types.js";

export type AlertTier = "NONE" | "WATCH" | "EARLY_RADAR" | "STRONG" | "URGENT";

const TIER_ORDER: AlertTier[] = ["NONE", "WATCH", "EARLY_RADAR", "STRONG", "URGENT"];

function tierIndex(tier: AlertTier): number {
  return TIER_ORDER.indexOf(tier);
}

function downgradeTier(tier: AlertTier, levels: number): AlertTier {
  return TIER_ORDER[Math.max(0, tierIndex(tier) - levels)]!;
}

function capTier(tier: AlertTier, cap: AlertTier): AlertTier {
  return tierIndex(tier) > tierIndex(cap) ? cap : tier;
}

/** B3.1 base tier from breakoutScore alone, before any override. */
export function tierForScore(breakoutScore: number): AlertTier {
  if (breakoutScore >= 9.0) return "URGENT";
  if (breakoutScore >= 8.0) return "STRONG";
  if (breakoutScore >= 7.0) return "EARLY_RADAR";
  if (breakoutScore >= 5.5) return "WATCH";
  return "NONE";
}

export interface AlertDecisionInputs {
  breakoutScore: number;
  risk: RiskLevel;
  confidence: ConfidenceLevel;
  ageMs: number;
}

export interface AlertDecision {
  tier: AlertTier;
  /** true only for the Risk-CRITICAL case — a positive opportunity alert
   * is fully blocked, though a warning-only message may still be sent
   * (spec B3.2 #1: "不能正向包装"). */
  blocked: boolean;
  warningOnly: "HIGH_MOMENTUM_BLOCKED_BY_RISK" | null;
  reasons: string[];
}

/** B3.2 — the override ladder, applied in the spec's exact order. Each
 * step can only ever lower the tier from where the previous step left it. */
export function decideAlertTier(inputs: AlertDecisionInputs): AlertDecision {
  const reasons: string[] = [];
  let tier = tierForScore(inputs.breakoutScore);
  reasons.push(`baseTier=${tier}`);

  // 1. Risk CRITICAL — hard block, no normal opportunity alert at all.
  if (inputs.risk === "CRITICAL") {
    reasons.push("RISK_CRITICAL_BLOCKED");
    return {
      tier: "NONE",
      blocked: true,
      warningOnly: tier !== "NONE" ? "HIGH_MOMENTUM_BLOCKED_BY_RISK" : null,
      reasons,
    };
  }

  // 2. Risk HIGH — drop one tier.
  if (inputs.risk === "HIGH") {
    const before = tier;
    tier = downgradeTier(tier, 1);
    reasons.push(`RISK_HIGH_DOWNGRADE_${before}_TO_${tier}`);
  }

  // 3. Confidence LOW — cap at WATCH regardless of score (spec B2.15).
  if (inputs.confidence === "LOW" && tierIndex(tier) > tierIndex("WATCH")) {
    reasons.push("CONFIDENCE_LOW_CAP_WATCH");
    tier = capTier(tier, "WATCH");
  }

  // 4. Age < 10s — never a normal alert (spec A.6: DISCOVERED only records).
  if (inputs.ageMs < 10_000) {
    reasons.push("AGE_UNDER_10S_NO_ALERT");
    return { tier: "NONE", blocked: false, warningOnly: null, reasons };
  }

  // 5. Age 10s-3m — strict early-alert rule; anything short of it caps WATCH.
  if (inputs.ageMs <= 3 * 60_000) {
    const eligible =
      inputs.breakoutScore >= 8.5 &&
      (inputs.risk === "LOW" || inputs.risk === "MEDIUM") &&
      (inputs.confidence === "MEDIUM" || inputs.confidence === "HIGH");
    if (!eligible && tierIndex(tier) > tierIndex("WATCH")) {
      reasons.push("EARLY_WINDOW_STRICT_RULE_CAP_WATCH");
      tier = capTier(tier, "WATCH");
    }
  }

  return { tier, blocked: false, warningOnly: null, reasons };
}

// ---------------------------------------------------------------------
// Re-alert (B3.3 / B3.4)
// ---------------------------------------------------------------------
const MEANINGFUL_RISK_IMPROVEMENTS = new Set<string>([
  "CRITICAL->HIGH",
  "CRITICAL->MEDIUM",
  "CRITICAL->LOW",
  "HIGH->MEDIUM",
  "HIGH->LOW",
]);

export function isMeaningfulRiskImprovement(previous: RiskLevel, current: RiskLevel): boolean {
  return MEANINGFUL_RISK_IMPROVEMENTS.has(`${previous}->${current}`);
}

export interface ReAlertInputs {
  previousAlertedScore: number;
  currentScore: number;
  newIndependentKol: boolean;
  newTierA: boolean;
  previousVolumeVelocity: number | null;
  currentVolumeVelocity: number | null;
  protocolStateTransition: "graduation" | "pool_active" | null;
  previousRisk: RiskLevel;
  currentRisk: RiskLevel;
}

export interface ReAlertDecision {
  eligible: boolean;
  reasons: string[];
}

/** Eligibility only — cooldown enforcement (a separate, time-based
 * concern) is the caller's job, same split V1's alertLogic.ts uses. */
export function isReAlertEligible(inputs: ReAlertInputs): ReAlertDecision {
  const reasons: string[] = [];
  // Rounded to avoid floating-point noise (e.g. 7.8 - 7.0 === 0.7999999999999998)
  // making a genuine 0.8 delta miss the threshold.
  const scoreDelta = Math.round((inputs.currentScore - inputs.previousAlertedScore) * 100) / 100;
  if (scoreDelta >= 0.8) reasons.push("SCORE_INCREASE_0.8");
  if (inputs.newIndependentKol) reasons.push("NEW_INDEPENDENT_KOL");
  if (inputs.newTierA) reasons.push("NEW_TIER_A");
  if (
    inputs.previousVolumeVelocity !== null &&
    inputs.currentVolumeVelocity !== null &&
    inputs.previousVolumeVelocity > 0 &&
    inputs.currentVolumeVelocity >= inputs.previousVolumeVelocity * 2
  ) {
    reasons.push("VOLUME_VELOCITY_2X");
  }
  if (inputs.protocolStateTransition !== null) reasons.push(`PROTOCOL_STATE_${inputs.protocolStateTransition.toUpperCase()}`);
  if (isMeaningfulRiskImprovement(inputs.previousRisk, inputs.currentRisk)) reasons.push("MEANINGFUL_RISK_IMPROVEMENT");
  if (inputs.previousAlertedScore < 8 && inputs.currentScore >= 8) reasons.push("FIRST_CROSS_8");
  if (inputs.previousAlertedScore < 9 && inputs.currentScore >= 9) reasons.push("FIRST_CROSS_9");
  return { eligible: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------
// Telegram formatting (B3.5)
// ---------------------------------------------------------------------
const TIER_EMOJI: Record<AlertTier, string> = {
  NONE: "",
  WATCH: "👀",
  EARLY_RADAR: "🟡",
  STRONG: "🟠",
  URGENT: "🔴",
};

export interface ShadowAlertMessageInputs {
  tier: AlertTier;
  chain: string;
  tokenSymbol: string | null;
  tokenAddress: string;
  ageSeconds: number;
  breakoutScore: number;
  organicScore: number;
  kolScore: number;
  risk: RiskLevel;
  confidence: ConfidenceLevel;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume1mUsd: number | null;
  volume3mUsd: number | null;
  volume5mUsd: number | null;
  accelerationPct: number | null;
  uniqueBuyers: [number | null, number | null, number | null];
  holders: [number | null, number | null, number | null];
  top10HolderPct: number | null;
  devHoldingPct: number | null;
  sellability: "PASS" | "FAIL" | "UNKNOWN";
  independentKolCount: number;
  scoreHistory: number[];
}

function formatAge(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function fmtUsd(value: number | null): string {
  return value === null ? "N/A" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtTriplet(values: readonly (number | null)[]): string {
  return values.map((v) => (v === null ? "?" : v.toString())).join(" → ");
}

export function formatShadowAlertMessage(inputs: ShadowAlertMessageInputs): string {
  const emoji = TIER_EMOJI[inputs.tier];
  const lines = [
    `${emoji} ${inputs.tier}`,
    "",
    `Chain: ${inputs.chain}`,
    `Token: ${inputs.tokenSymbol ?? "?"}`,
    `CA: ${inputs.tokenAddress}`,
    "",
    `Age: ${formatAge(inputs.ageSeconds)}`,
    "",
    `Breakout: ${inputs.breakoutScore.toFixed(1)} / 10`,
    `Organic: ${inputs.organicScore.toFixed(1)} / 8`,
    `KOL: ${inputs.kolScore.toFixed(1)} / 2`,
    "",
    `Risk: ${inputs.risk}`,
    `Confidence: ${inputs.confidence}`,
    "",
    `MC: ${fmtUsd(inputs.marketCapUsd)}`,
    `Liquidity: ${fmtUsd(inputs.liquidityUsd)}`,
    "",
    `Volume: 1m ${fmtUsd(inputs.volume1mUsd)} · 3m ${fmtUsd(inputs.volume3mUsd)} · 5m ${fmtUsd(inputs.volume5mUsd)}`,
    `Acceleration: ${inputs.accelerationPct === null ? "N/A" : `${inputs.accelerationPct >= 0 ? "+" : ""}${inputs.accelerationPct.toFixed(0)}%`}`,
    `Unique Buyers: ${fmtTriplet(inputs.uniqueBuyers)}`,
    `Holders: ${fmtTriplet(inputs.holders)}`,
    `Top10: ${inputs.top10HolderPct === null ? "N/A" : `${inputs.top10HolderPct.toFixed(0)}%`}`,
    `Dev: ${inputs.devHoldingPct === null ? "N/A" : `${inputs.devHoldingPct.toFixed(1)}%`}`,
    "",
    `Sellability: ${inputs.sellability}`,
    `KOL: ${inputs.independentKolCount} independent`,
    "",
    `Score: ${inputs.scoreHistory.map((s) => s.toFixed(1)).join(" → ")}`,
    "",
    "Breakout Score is not a buy recommendation.",
  ];
  return lines.join("\n");
}
