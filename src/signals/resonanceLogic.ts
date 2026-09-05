// Pure, DB/timer-free resonance math — kept separate from
// resonanceDetector.ts's stateful window/DB wiring so it's directly
// unit-testable with an injected clock. No function here does any I/O.
//
// A signal produced by this logic is a TRIGGER for further investigation,
// not a buy recommendation — nothing in this module (or its callers)
// should be read as "you should buy this."

import { countDistinctOwnerGroups } from "../watchlist/watchlistCache.js";
import type { WalletTier } from "../db/walletWatchlist.js";

export interface ResonanceConfig {
  /** Sliding window size. Default 20 minutes. */
  windowMinutes: number;
  /** Minimum gap between two signals for the same token, unless escalation applies. Default 10 minutes. */
  cooldownMinutes: number;
}

export const DEFAULT_RESONANCE_CONFIG: ResonanceConfig = {
  windowMinutes: 20,
  cooldownMinutes: 10,
};

export interface WindowEntry {
  wallet: string;
  name: string;
  tier: WalletTier;
  /** Resolved owner group — see resonanceDetector.ts's resolveOwnerGroup for the empty-ownerGroup fallback. */
  ownerGroup: string;
  ownerGroupIsFallback: boolean;
  timestamp: Date;
  /** Raw on-chain integer quote amount for this BUY. */
  quoteAmount: bigint;
}

/** Drops entries older than the window — call before evaluating conditions. */
export function pruneWindow(entries: WindowEntry[], now: Date, windowMinutes: number): WindowEntry[] {
  const cutoff = now.getTime() - windowMinutes * 60_000;
  return entries.filter((entry) => entry.timestamp.getTime() >= cutoff);
}

export interface WindowStats {
  /** Distinct ownerGroups among all BUYs currently in the window (any tier). */
  distinctOwnerGroups: number;
  /** Distinct ownerGroups among Tier-A BUYs in the window. */
  tierAOwnerGroups: number;
  /** True if any single ownerGroup bought 2+ times within the window (via any of its wallets). */
  hasRepeatAccumulation: boolean;
}

export function computeWindowStats(entries: WindowEntry[]): WindowStats {
  const distinctOwnerGroups = countDistinctOwnerGroups(entries.map((e) => ({ ownerGroup: e.ownerGroup })));

  const tierAEntries = entries.filter((e) => e.tier === "A");
  const tierAOwnerGroups = countDistinctOwnerGroups(tierAEntries.map((e) => ({ ownerGroup: e.ownerGroup })));

  const buyCountByOwnerGroup = new Map<string, number>();
  for (const entry of entries) {
    buyCountByOwnerGroup.set(entry.ownerGroup, (buyCountByOwnerGroup.get(entry.ownerGroup) ?? 0) + 1);
  }
  const hasRepeatAccumulation = [...buyCountByOwnerGroup.values()].some((c) => c >= 2);

  return { distinctOwnerGroups, tierAOwnerGroups, hasRepeatAccumulation };
}

export type TriggerCondition = "A" | "B" | "C";

/**
 * A: >= 3 distinct ownerGroups bought.
 * B: >= 2 distinct Tier-A ownerGroups bought.
 * C: >= 2 distinct ownerGroups bought AND at least one of them bought 2+ times.
 * All three are independent checks — a window can satisfy more than one at once.
 */
export function evaluateConditions(stats: WindowStats): TriggerCondition[] {
  const conditions: TriggerCondition[] = [];
  if (stats.distinctOwnerGroups >= 3) conditions.push("A");
  if (stats.tierAOwnerGroups >= 2) conditions.push("B");
  if (stats.distinctOwnerGroups >= 2 && stats.hasRepeatAccumulation) conditions.push("C");
  return conditions;
}

export interface CooldownState {
  lastTriggeredAt: Date;
  /** distinctOwnerGroups at the last signal — the escalation baseline. */
  distinctOwnerGroups: number;
  /** Whether the last signal's window already had at least one Tier-A ownerGroup. */
  hadTierA: boolean;
}

export interface TriggerDecision {
  shouldFire: boolean;
  /** True if this fired by breaking through an active cooldown via a strictly stronger signal. */
  escalation: boolean;
}

/**
 * No cooldown state, or the cooldown has fully elapsed: fire normally.
 * Still within cooldown: only fire if the window has gotten strictly
 * stronger since the last signal — distinct ownerGroups up by 2+, or a
 * Tier-A ownerGroup appearing for the first time. Otherwise suppress.
 */
export function decideTrigger(
  conditions: TriggerCondition[],
  stats: WindowStats,
  cooldown: CooldownState | null,
  now: Date,
  cooldownMinutes: number,
): TriggerDecision {
  if (conditions.length === 0) return { shouldFire: false, escalation: false };
  if (!cooldown) return { shouldFire: true, escalation: false };

  const cooldownUntil = cooldown.lastTriggeredAt.getTime() + cooldownMinutes * 60_000;
  if (now.getTime() >= cooldownUntil) return { shouldFire: true, escalation: false };

  const ownerGroupsIncreased = stats.distinctOwnerGroups >= cooldown.distinctOwnerGroups + 2;
  const firstTierA = stats.tierAOwnerGroups >= 1 && !cooldown.hadTierA;
  if (ownerGroupsIncreased || firstTierA) {
    return { shouldFire: true, escalation: true };
  }
  return { shouldFire: false, escalation: false };
}
