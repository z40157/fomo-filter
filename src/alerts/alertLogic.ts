// Alert threshold classification + send/dedup decision (Phase 8) — pure,
// DB/timer-free, mirrors the same "cooldown, unless escalation" shape as
// signals/resonanceLogic.ts's decideTrigger, since that pattern already
// proved itself there. No I/O in this file.

export type AlertLevel = "NONE" | "NORMAL" | "STRONG" | "URGENT";

const NORMAL_THRESHOLD = 7.0;
const STRONG_THRESHOLD = 8.0;
/** >= 9.0 is URGENT; also the level at/above which the one-shot `cross_9` escalation fires. */
export const URGENT_THRESHOLD = 9.0;

/** < 7.0 dashboard-only, 7.0-7.9 normal, 8.0-8.9 STRONG, >= 9.0 URGENT. */
export function classifyAlertLevel(importanceScore: number): AlertLevel {
  if (importanceScore >= URGENT_THRESHOLD) return "URGENT";
  if (importanceScore >= STRONG_THRESHOLD) return "STRONG";
  if (importanceScore >= NORMAL_THRESHOLD) return "NORMAL";
  return "NONE";
}

export const DEFAULT_ALERT_COOLDOWN_MINUTES = 10;

export type AlertTriggerReason =
  | "first_cross_7"
  | "score_increase"
  | "new_tier_a"
  | "owner_group_increase"
  | "cross_9"
  /** Cooldown fully elapsed with no escalation needed — same "cooldown just expired, fire normally" case resonanceLogic.ts's decideTrigger has. */
  | "cooldown_expired";

export interface AlertDecisionInput {
  importanceScore: number;
  distinctOwnerGroups: number;
  tierACount: number;
}

/** State reconstructed from the alerts table: the last successfully-sent alert for this (token, channel), plus whether ANY prior alert (not just the last) ever crossed 9.0. */
export interface PriorAlertState {
  sentAt: Date;
  importanceAtSend: number;
  distinctOwnerGroups: number;
  tierACount: number;
  hasCrossedNine: boolean;
}

export interface AlertDecision {
  shouldSend: boolean;
  level: AlertLevel;
  reason: AlertTriggerReason | null;
}

/**
 * No prior alert: send iff already >= 7.0 (level != NONE) — this is
 * necessarily the token's first-ever crossing of 7.0.
 *
 * Prior alert exists: below 7.0 never sends. At/above 7.0, within the
 * cooldown window only one of the four escalation conditions (checked in
 * the order the spec lists them) re-opens sending; once the cooldown has
 * fully elapsed, sending resumes normally even without escalation — same
 * two-tier "escalation breaks an active cooldown, elapsed cooldown just
 * resets" shape as resonanceLogic.ts's decideTrigger.
 */
export function decideAlert(
  input: AlertDecisionInput,
  prior: PriorAlertState | null,
  now: Date,
  cooldownMinutes: number = DEFAULT_ALERT_COOLDOWN_MINUTES,
): AlertDecision {
  const level = classifyAlertLevel(input.importanceScore);
  if (level === "NONE") return { shouldSend: false, level, reason: null };

  if (!prior) return { shouldSend: true, level, reason: "first_cross_7" };

  if (input.importanceScore - prior.importanceAtSend >= 1.0) {
    return { shouldSend: true, level, reason: "score_increase" };
  }
  if (input.tierACount > 0 && prior.tierACount === 0) {
    return { shouldSend: true, level, reason: "new_tier_a" };
  }
  if (input.distinctOwnerGroups - prior.distinctOwnerGroups >= 2) {
    return { shouldSend: true, level, reason: "owner_group_increase" };
  }
  if (input.importanceScore >= URGENT_THRESHOLD && !prior.hasCrossedNine) {
    return { shouldSend: true, level, reason: "cross_9" };
  }

  const cooldownUntil = prior.sentAt.getTime() + cooldownMinutes * 60_000;
  if (now.getTime() >= cooldownUntil) {
    return { shouldSend: true, level, reason: "cooldown_expired" };
  }

  return { shouldSend: false, level, reason: null };
}
