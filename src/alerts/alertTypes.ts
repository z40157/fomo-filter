// Shared shape passed from the resonance/scoring pipeline (Phase 6/7) into
// the alert dispatcher and its templates (Phase 8) — one plain object so
// email/Telegram rendering and the send-decision all read from the same
// already-computed data, nothing re-derived or guessed along the way.

import type { TriggerCondition } from "../db/signals.js";
import type { WalletTier } from "../db/walletWatchlist.js";
import type { ScoreBreakdown, ConfidenceLevel } from "../signals/scoring.js";
import type { RiskBreakdown, RiskLevel } from "../signals/risk.js";
import type { AlertLevel } from "./alertLogic.js";

export interface AlertWalletBreakdown {
  address: string;
  name: string;
  tier: WalletTier;
  /** Raw on-chain integer quote-currency units, same convention as signal_wallets.buy_amount. */
  buyAmount: bigint;
  buyCount: number;
  /** Raw on-chain integer quote-currency units. Zero/0 if this wallet hasn't sold. */
  sellAmount: bigint;
  sellCount: number;
}

export interface AlertContext {
  signalId: number;
  tokenId: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  ageMs: number;
  triggerConditions: TriggerCondition[];
  windowMinutes: number;
  distinctOwnerGroups: number;
  tierACount: number;
  hasRepeatAccumulation: boolean;
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
  buys5m: number | null;
  sells5m: number | null;
  aggregateWatchedBuyUsd: number;
  aggregateWatchedSellUsd: number;
  repeatBuyerCount: number;
  importanceScore: number;
  scoreBreakdown: ScoreBreakdown;
  riskLevel: RiskLevel;
  riskBreakdown: RiskBreakdown;
  confidence: ConfidenceLevel;
  confidenceReasons: string[];
  wallets: AlertWalletBreakdown[];
  level: AlertLevel;
}

/** "4 independent ownerGroups bought within the 20-minute window, including 2 Tier-A and repeat accumulation (conditions: A, B)." */
export function buildWhyTriggeredText(input: {
  distinctOwnerGroups: number;
  tierACount: number;
  hasRepeatAccumulation: boolean;
  windowMinutes: number;
  triggerConditions: TriggerCondition[];
}): string {
  const lead = `${input.distinctOwnerGroups} independent ownerGroup${input.distinctOwnerGroups === 1 ? "" : "s"} bought within the ${input.windowMinutes}-minute window`;
  const details: string[] = [];
  if (input.tierACount > 0) {
    details.push(`${input.tierACount} Tier-A ownerGroup${input.tierACount === 1 ? "" : "s"}`);
  }
  if (input.hasRepeatAccumulation) {
    details.push("at least one repeat buy (adding to an existing position)");
  }
  const detailClause = details.length > 0 ? `, including ${details.join(" and ")}` : "";
  return `${lead}${detailClause} (conditions: ${input.triggerConditions.join(", ")}).`;
}
