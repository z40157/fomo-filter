// Spec B2 — Breakout Scoring. RULE_VERSION_1: every weight/threshold below
// is an initial hypothesis (spec: "第一版：全部属于初始假设，未来通过outcome
// 校准"), never bump BREAKOUT_RULE_VERSION without an explicit decision —
// it exists so signal_outcomes-equivalent analysis can segment old vs new
// scoring runs (mirrors V1's SCORING_RULE_VERSION, signals/scoring.ts).
import type { ConfidenceLevel, RiskLevel } from "./types.js";

export const BREAKOUT_RULE_VERSION = 1;

export interface DimensionScore {
  score: number;
  max: number;
  reasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------
// A. Organic Momentum — MAX 2.0 (B2.3). Rewards velocity/acceleration/
// spread, never raw volume size (spec: "不要奖励volume绝对值大").
// ---------------------------------------------------------------------
export interface OrganicMomentumInputs {
  volumeVelocity: number | null;
  volumeAcceleration: number | null;
  uniqueBuyerVelocity: number | null;
  netBuyFlowUsd: number | null;
}

export function scoreOrganicMomentum(inputs: OrganicMomentumInputs): DimensionScore {
  const MAX = 2.0;
  const reasons: string[] = [];
  let score = 0;
  let hadAnySignal = false;

  if (inputs.volumeVelocity !== null) {
    hadAnySignal = true;
    score += clamp(inputs.volumeVelocity, 0, 1) * 0.6;
    reasons.push(`volumeVelocity=${inputs.volumeVelocity.toFixed(2)}`);
  }
  if (inputs.volumeAcceleration !== null) {
    hadAnySignal = true;
    score += clamp(inputs.volumeAcceleration, 0, 1) * 0.5;
    reasons.push(`volumeAcceleration=${inputs.volumeAcceleration.toFixed(2)}`);
  }
  if (inputs.uniqueBuyerVelocity !== null) {
    hadAnySignal = true;
    score += clamp(inputs.uniqueBuyerVelocity, 0, 1) * 0.6;
    reasons.push(`uniqueBuyerVelocity=${inputs.uniqueBuyerVelocity.toFixed(2)}`);
  }
  if (inputs.netBuyFlowUsd !== null) {
    hadAnySignal = true;
    score += inputs.netBuyFlowUsd > 0 ? 0.3 : 0;
    reasons.push(`netBuyFlowUsd=${inputs.netBuyFlowUsd.toFixed(0)}`);
  }
  if (!hadAnySignal) reasons.push("NO_DATA");
  return { score: clamp(score, 0, MAX), max: MAX, reasons };
}

// ---------------------------------------------------------------------
// B. Distribution / Growth — MAX 1.5 (B2.5). Rewards unique-buyer growth
// and repeat-trade health, not raw buy count.
// ---------------------------------------------------------------------
export interface DistributionInputs {
  uniqueBuyerVelocity: number | null;
  holderGrowth: number | null; // positive = growing holder count
  top10HolderPct: number | null; // 0-100
  sameWalletBuyRatio: number | null; // 0-1, fraction of buys that are repeats from the same wallet
}

export function scoreDistribution(inputs: DistributionInputs): DimensionScore {
  const MAX = 1.5;
  const reasons: string[] = [];
  let score = 0;
  let hadAnySignal = false;

  if (inputs.uniqueBuyerVelocity !== null) {
    hadAnySignal = true;
    score += clamp(inputs.uniqueBuyerVelocity, 0, 1) * 0.5;
    reasons.push(`uniqueBuyerVelocity=${inputs.uniqueBuyerVelocity.toFixed(2)}`);
  }
  if (inputs.holderGrowth !== null) {
    hadAnySignal = true;
    score += inputs.holderGrowth > 0 ? 0.4 : 0;
    reasons.push(`holderGrowth=${inputs.holderGrowth}`);
  }
  if (inputs.top10HolderPct !== null) {
    hadAnySignal = true;
    // Healthier (lower) concentration contributes more — inverted, capped.
    score += clamp((100 - inputs.top10HolderPct) / 100, 0, 1) * 0.4;
    reasons.push(`top10HolderPct=${inputs.top10HolderPct.toFixed(1)}`);
  }
  if (inputs.sameWalletBuyRatio !== null) {
    hadAnySignal = true;
    score += clamp(1 - inputs.sameWalletBuyRatio, 0, 1) * 0.2;
    reasons.push(`sameWalletBuyRatio=${inputs.sameWalletBuyRatio.toFixed(2)}`);
  }
  if (!hadAnySignal) reasons.push("NO_DATA");
  return { score: clamp(score, 0, MAX), max: MAX, reasons };
}

// ---------------------------------------------------------------------
// C. Liquidity / Exit Quality — MAX 1.5 (B2.6). Sellability FAIL/UNKNOWN
// is handled by the Hard Gate, not here — this only scores what's left
// once a candidate has passed/not-yet-failed that gate.
// ---------------------------------------------------------------------
export interface LiquidityInputs {
  liquidityUsd: number | null;
  liquidityGrowth: number | null;
  liquidityToMcRatio: number | null;
  sellabilityStatus: "PASS" | "FAIL" | "UNKNOWN";
}

export function scoreLiquidity(inputs: LiquidityInputs): DimensionScore {
  const MAX = 1.5;
  const reasons: string[] = [];
  let score = 0;
  let hadAnySignal = false;

  if (inputs.sellabilityStatus === "PASS") {
    hadAnySignal = true;
    score += 0.5;
    reasons.push("SELLABILITY_PASS");
  } else if (inputs.sellabilityStatus === "UNKNOWN") {
    reasons.push("SELLABILITY_UNKNOWN");
  }
  if (inputs.liquidityGrowth !== null) {
    hadAnySignal = true;
    score += inputs.liquidityGrowth > 0 ? 0.5 : 0;
    reasons.push(`liquidityGrowth=${inputs.liquidityGrowth}`);
  }
  if (inputs.liquidityToMcRatio !== null) {
    hadAnySignal = true;
    score += clamp(inputs.liquidityToMcRatio, 0, 1) * 0.5;
    reasons.push(`liquidityToMcRatio=${inputs.liquidityToMcRatio.toFixed(2)}`);
  }
  if (!hadAnySignal && inputs.sellabilityStatus !== "PASS") reasons.push("NO_DATA");
  return { score: clamp(score, 0, MAX), max: MAX, reasons };
}

// ---------------------------------------------------------------------
// D. Creator / Security — MAX 1.0 (B2.7). Only what creator_profiles can
// actually compute — never guess rugLikeCount without evidence.
// ---------------------------------------------------------------------
export interface CreatorInputs {
  launchesTotal: number | null;
  earlySellCount: number | null;
  survived24hRatio: number | null; // survived24h / graduatedCount, 0-1
}

export function scoreCreator(inputs: CreatorInputs): DimensionScore {
  const MAX = 1.0;
  const reasons: string[] = [];
  let score = 0;
  let hadAnySignal = false;

  if (inputs.launchesTotal !== null) {
    hadAnySignal = true;
    // A first-time creator isn't penalized (no evidence either way); a
    // creator with real launch history contributes only if it's clean.
    if (inputs.launchesTotal <= 1) {
      score += 0.3;
      reasons.push("FIRST_TIME_CREATOR");
    }
  }
  if (inputs.earlySellCount !== null) {
    hadAnySignal = true;
    score += inputs.earlySellCount === 0 ? 0.4 : 0;
    reasons.push(`earlySellCount=${inputs.earlySellCount}`);
  }
  if (inputs.survived24hRatio !== null) {
    hadAnySignal = true;
    score += clamp(inputs.survived24hRatio, 0, 1) * 0.3;
    reasons.push(`survived24hRatio=${inputs.survived24hRatio.toFixed(2)}`);
  }
  if (!hadAnySignal) reasons.push("NO_CREATOR_HISTORY");
  return { score: clamp(score, 0, MAX), max: MAX, reasons };
}

// ---------------------------------------------------------------------
// E. Launch / Lifecycle — MAX 1.0 (B2.8). Reads protocolState only —
// never radarState (spec: "不要混淆radarState").
// ---------------------------------------------------------------------
export interface LifecycleInputs {
  protocolState: "UNKNOWN" | "CURVE_ACTIVE" | "NEAR_GRADUATION" | "GRADUATED" | "POOL_PENDING" | "POOL_ACTIVE" | "SURVIVING" | "DECAYING";
}

export function scoreLifecycle(inputs: LifecycleInputs): DimensionScore {
  const MAX = 1.0;
  const table: Record<LifecycleInputs["protocolState"], number> = {
    UNKNOWN: 0,
    CURVE_ACTIVE: 0.5,
    NEAR_GRADUATION: 0.8,
    GRADUATED: 1.0,
    POOL_PENDING: 0.6,
    POOL_ACTIVE: 0.8,
    SURVIVING: 1.0,
    DECAYING: 0.2,
  };
  const score = table[inputs.protocolState];
  return { score, max: MAX, reasons: [`protocolState=${inputs.protocolState}`] };
}

// ---------------------------------------------------------------------
// F. Narrative — MAX 0.5 (B2.9). Manual/rule-based only in this version —
// no AI crawler, no guessed official token addresses.
// ---------------------------------------------------------------------
export interface NarrativeInputs {
  manualBoost: number | null; // 0-1, from a human-curated flag (mirrors V1's narrative_flags)
}

export function scoreNarrative(inputs: NarrativeInputs): DimensionScore {
  const MAX = 0.5;
  if (inputs.manualBoost === null) return { score: 0, max: MAX, reasons: ["NO_NARRATIVE_FLAG"] };
  return { score: clamp(inputs.manualBoost, 0, 1) * MAX, max: MAX, reasons: [`manualBoost=${inputs.manualBoost}`] };
}

// ---------------------------------------------------------------------
// G. Earlyness — MAX 0.5 (B2.10). <10s can't be full marks (no data yet);
// 3-10m is the sweet spot; >30m is EXPIRED and never scored at all.
// ---------------------------------------------------------------------
export function scoreEarlyness(ageMs: number): DimensionScore {
  const MAX = 0.5;
  const min = 60_000;
  const tenMin = 10 * 60_000;
  const thirtyMin = 30 * 60_000;
  let score: number;
  let reason: string;
  if (ageMs < 10_000) {
    score = MAX * 0.2;
    reason = "TOO_EARLY_INSUFFICIENT_DATA";
  } else if (ageMs <= 3 * 60_000) {
    score = MAX * 0.7;
    reason = "EARLY_LOW_CONFIDENCE_WINDOW";
  } else if (ageMs <= tenMin) {
    score = MAX;
    reason = "SWEET_SPOT";
  } else if (ageMs <= 20 * 60_000) {
    score = MAX * 0.6;
    reason = "MID_WINDOW";
  } else if (ageMs <= thirtyMin) {
    score = MAX * 0.3;
    reason = "LATE_WINDOW";
  } else {
    score = 0;
    reason = "EXPIRED";
  }
  void min;
  return { score, max: MAX, reasons: [reason] };
}

// ---------------------------------------------------------------------
// H. KOL / Smart Money — MAX 2.0 normally, MAX 1.0 under
// NO_ACTOR_CLUSTERING (spec B2.11/B2.12 — Phase 0 confirmed decision).
// ---------------------------------------------------------------------
export interface KolWalletBuy {
  wallet: string;
  /** null = this wallet has no known ownerGroup (spec A.12/Phase 0: the
   * legacy watchlist has one, auto-discovered candidates don't). */
  ownerGroup: string | null;
  tier: "A" | "B" | "C";
}

export interface KolScoreResult extends DimensionScore {
  distinctActors: number;
  clusteringAvailable: boolean;
}

export function scoreKol(buys: KolWalletBuy[]): KolScoreResult {
  if (buys.length === 0) {
    return { score: 0, max: 2.0, reasons: ["NO_WATCHLIST_ACTIVITY"], distinctActors: 0, clusteringAvailable: true };
  }

  const clusteringAvailable = buys.every((b) => b.ownerGroup !== null);
  const groups = clusteringAvailable
    ? new Set(buys.map((b) => b.ownerGroup!))
    : new Set(buys.map((b) => b.wallet.toLowerCase()));
  const distinctActors = groups.size;
  const max = clusteringAvailable ? 2.0 : 1.0;

  let base: number;
  if (distinctActors <= 0) base = 0;
  else if (distinctActors === 1) base = 0.4;
  else if (distinctActors === 2) base = 1.0;
  else if (distinctActors === 3) base = 1.5;
  else base = 1.8;

  const hasTierA = buys.some((b) => b.tier === "A");
  const bonus = hasTierA ? 0.2 : 0;

  const reasons = [`distinctActors=${distinctActors}`, clusteringAvailable ? "OWNER_GROUP_CLUSTERING" : "NO_ACTOR_CLUSTERING"];
  if (hasTierA) reasons.push("TIER_A_BONUS");

  return { score: clamp(base + bonus, 0, max), max, reasons, distinctActors, clusteringAvailable };
}

// ---------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------
export interface ScoreBreakdown {
  organicMomentum: DimensionScore;
  distribution: DimensionScore;
  liquidity: DimensionScore;
  creator: DimensionScore;
  lifecycle: DimensionScore;
  narrative: DimensionScore;
  earlyness: DimensionScore;
  kol: KolScoreResult;
  organicScore: number;
  breakoutScore: number;
  ruleVersion: number;
}

export function aggregateScore(dims: {
  organicMomentum: DimensionScore;
  distribution: DimensionScore;
  liquidity: DimensionScore;
  creator: DimensionScore;
  lifecycle: DimensionScore;
  narrative: DimensionScore;
  earlyness: DimensionScore;
  kol: KolScoreResult;
}): ScoreBreakdown {
  const organicScore = clamp(
    dims.organicMomentum.score +
      dims.distribution.score +
      dims.liquidity.score +
      dims.creator.score +
      dims.lifecycle.score +
      dims.narrative.score +
      dims.earlyness.score,
    0,
    8.0,
  );
  const breakoutScore = clamp(organicScore + dims.kol.score, 0, 10.0);
  return { ...dims, organicScore, breakoutScore, ruleVersion: BREAKOUT_RULE_VERSION };
}

// ---------------------------------------------------------------------
// Confidence (B2.14) — independent of score/risk. Missing data can only
// ever lower Confidence, never Risk (spec: "数据缺失：绝对不能降低Risk").
// ---------------------------------------------------------------------
export interface ConfidenceInputs {
  marketDataComplete: boolean;
  holderDataComplete: boolean;
  creatorDataComplete: boolean;
  sellabilityKnown: boolean;
  walletAttributionReliable: boolean;
  /** 0-1 — how many of the windows this evaluation used had real data. */
  windowCompleteness: number;
}

export function computeConfidence(inputs: ConfidenceInputs): { level: ConfidenceLevel; reasons: string[] } {
  const missing: string[] = [];
  if (!inputs.marketDataComplete) missing.push("MARKET_DATA_INCOMPLETE");
  if (!inputs.holderDataComplete) missing.push("HOLDER_DATA_INCOMPLETE");
  if (!inputs.creatorDataComplete) missing.push("CREATOR_DATA_INCOMPLETE");
  if (!inputs.sellabilityKnown) missing.push("SELLABILITY_UNKNOWN");
  if (!inputs.walletAttributionReliable) missing.push("WALLET_ATTRIBUTION_UNRELIABLE");
  if (inputs.windowCompleteness < 1) missing.push("PARTIAL_WINDOW_DATA");

  const level: ConfidenceLevel = missing.length === 0 ? "HIGH" : missing.length <= 2 ? "MEDIUM" : "LOW";
  return { level, reasons: missing };
}

// ---------------------------------------------------------------------
// Risk (supports B3's override ladder — CRITICAL/HIGH act as alert-tier
// caps there). RULE_VERSION_1: driven directly by the Hard Gate result
// plus a small set of specifically-called-out escalators (A.8/A.10),
// never by data being merely missing (that's Confidence's job).
// ---------------------------------------------------------------------
export interface RiskInputs {
  gateStatus: "PASS" | "REJECT" | "UNKNOWN_REVIEW";
  creatorDumpSeverity: RiskLevel | null;
  washTradeShaped: boolean; // A.10 pattern present but age < 3m (gate doesn't reject it yet)
}

export function computeRisk(inputs: RiskInputs): { level: RiskLevel; reasons: string[] } {
  if (inputs.gateStatus === "REJECT") return { level: "CRITICAL", reasons: ["HARD_GATE_REJECT"] };
  const reasons: string[] = [];
  if (inputs.creatorDumpSeverity === "HIGH") reasons.push("CREATOR_DUMPING_HIGH");
  if (inputs.washTradeShaped) reasons.push("WASH_TRADE_SHAPED_UNDER_3M");
  if (reasons.length > 0) return { level: "HIGH", reasons };
  if (inputs.gateStatus === "UNKNOWN_REVIEW") return { level: "MEDIUM", reasons: ["GATE_UNKNOWN_REVIEW"] };
  return { level: "LOW", reasons: [] };
}
