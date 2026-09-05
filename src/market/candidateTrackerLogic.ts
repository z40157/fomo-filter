// Pure, timer/DB-free scheduling decisions for the candidate tracker — kept
// separate so "does this candidate get refreshed now / does it exit
// tracking" can be unit-tested with an injected clock instead of real
// setInterval/database state.

export interface TrackerConfig {
  /** Every token is tracked for at least this long, no matter what. Default 24h. */
  minTrackingDurationMs: number;
  /** Refresh cadence for a candidate with recent trades. Default 20s (within the requested 15-30s range). */
  activeRefreshMs: number;
  /** Refresh cadence for a candidate with no recent trades. Default 5min. */
  inactiveRefreshMs: number;
  /** A candidate counts as "active" if it had a trade within this long ago. Default 15min. */
  activityWindowMs: number;
  /** After the minimum tracking duration, a candidate exits once it's had no trade for this long. Default 4h. */
  exitInactivityWindowMs: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  minTrackingDurationMs: 24 * 60 * 60 * 1000,
  activeRefreshMs: 20_000,
  inactiveRefreshMs: 5 * 60 * 1000,
  activityWindowMs: 15 * 60 * 1000,
  exitInactivityWindowMs: 4 * 60 * 60 * 1000,
};

export interface CandidateState {
  tokenId: number;
  address: string;
  launchTime: Date;
  trackingStartedAt: Date;
  lastRefreshAt: Date | null;
  lastTradeAt: Date | null;
}

export function isActive(candidate: CandidateState, now: Date, activityWindowMs: number): boolean {
  if (!candidate.lastTradeAt) return false;
  return now.getTime() - candidate.lastTradeAt.getTime() <= activityWindowMs;
}

export function refreshIntervalMs(candidate: CandidateState, now: Date, config: TrackerConfig): number {
  return isActive(candidate, now, config.activityWindowMs) ? config.activeRefreshMs : config.inactiveRefreshMs;
}

export function isDueForRefresh(candidate: CandidateState, now: Date, config: TrackerConfig): boolean {
  if (candidate.lastRefreshAt === null) return true;
  return now.getTime() - candidate.lastRefreshAt.getTime() >= refreshIntervalMs(candidate, now, config);
}

/** Every token is tracked at least `minTrackingDurationMs` regardless of activity. Only after that does inactivity end tracking. */
export function shouldExitTracking(candidate: CandidateState, now: Date, config: TrackerConfig): boolean {
  const trackedForMs = now.getTime() - candidate.trackingStartedAt.getTime();
  if (trackedForMs < config.minTrackingDurationMs) return false;
  return !isActive(candidate, now, config.exitInactivityWindowMs);
}
