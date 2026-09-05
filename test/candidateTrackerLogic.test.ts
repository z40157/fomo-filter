import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACKER_CONFIG,
  isActive,
  isDueForRefresh,
  refreshIntervalMs,
  shouldExitTracking,
  type CandidateState,
} from "../src/market/candidateTrackerLogic.js";

function candidate(overrides: Partial<CandidateState> = {}): CandidateState {
  return {
    tokenId: 1,
    address: "0x1234567890123456789012345678901234567890",
    launchTime: new Date("2026-01-01T00:00:00Z"),
    trackingStartedAt: new Date("2026-01-01T00:00:00Z"),
    lastRefreshAt: null,
    lastTradeAt: null,
    ...overrides,
  };
}

const NOW = new Date("2026-01-01T01:00:00Z");

describe("isActive", () => {
  it("is false when there's never been a trade", () => {
    expect(isActive(candidate({ lastTradeAt: null }), NOW, DEFAULT_TRACKER_CONFIG.activityWindowMs)).toBe(false);
  });

  it("is true when the last trade was within the activity window", () => {
    const c = candidate({ lastTradeAt: new Date(NOW.getTime() - 5 * 60 * 1000) }); // 5 min ago
    expect(isActive(c, NOW, DEFAULT_TRACKER_CONFIG.activityWindowMs)).toBe(true);
  });

  it("is false once the last trade is older than the activity window", () => {
    const c = candidate({ lastTradeAt: new Date(NOW.getTime() - 20 * 60 * 1000) }); // 20 min ago, window is 15
    expect(isActive(c, NOW, DEFAULT_TRACKER_CONFIG.activityWindowMs)).toBe(false);
  });
});

describe("refreshIntervalMs / isDueForRefresh — active vs inactive cadence", () => {
  it("uses the active refresh cadence for a recently-traded candidate", () => {
    const c = candidate({ lastTradeAt: new Date(NOW.getTime() - 60 * 1000) });
    expect(refreshIntervalMs(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(DEFAULT_TRACKER_CONFIG.activeRefreshMs);
  });

  it("uses the inactive refresh cadence for a candidate with no recent trades", () => {
    const c = candidate({ lastTradeAt: null });
    expect(refreshIntervalMs(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(DEFAULT_TRACKER_CONFIG.inactiveRefreshMs);
  });

  it("is always due on the first check (lastRefreshAt is null)", () => {
    expect(isDueForRefresh(candidate({ lastRefreshAt: null }), NOW, DEFAULT_TRACKER_CONFIG)).toBe(true);
  });

  it("an active candidate is due again after its shorter interval but not before", () => {
    const c = candidate({
      lastTradeAt: new Date(NOW.getTime() - 60_000),
      lastRefreshAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.activeRefreshMs - 1_000)),
    });
    expect(isDueForRefresh(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(false);

    const cDue = candidate({
      lastTradeAt: new Date(NOW.getTime() - 60_000),
      lastRefreshAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.activeRefreshMs + 1_000)),
    });
    expect(isDueForRefresh(cDue, NOW, DEFAULT_TRACKER_CONFIG)).toBe(true);
  });

  it("an inactive candidate is NOT due yet even after the active interval — it needs the longer inactive interval", () => {
    const c = candidate({
      lastTradeAt: null,
      lastRefreshAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.activeRefreshMs + 1_000)),
    });
    expect(isDueForRefresh(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(false);

    const cDue = candidate({
      lastTradeAt: null,
      lastRefreshAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.inactiveRefreshMs + 1_000)),
    });
    expect(isDueForRefresh(cDue, NOW, DEFAULT_TRACKER_CONFIG)).toBe(true);
  });
});

describe("shouldExitTracking", () => {
  it("never exits before the minimum tracking duration, even with zero activity", () => {
    const c = candidate({
      trackingStartedAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.minTrackingDurationMs - 60_000)),
      lastTradeAt: null,
    });
    expect(shouldExitTracking(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(false);
  });

  it("exits once past the minimum duration with no recent activity", () => {
    const c = candidate({
      trackingStartedAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.minTrackingDurationMs + 60_000)),
      lastTradeAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.exitInactivityWindowMs + 60_000)),
    });
    expect(shouldExitTracking(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(true);
  });

  it("stays tracked past the minimum duration if it's still active", () => {
    const c = candidate({
      trackingStartedAt: new Date(NOW.getTime() - (DEFAULT_TRACKER_CONFIG.minTrackingDurationMs + 60_000)),
      lastTradeAt: new Date(NOW.getTime() - 60_000),
    });
    expect(shouldExitTracking(c, NOW, DEFAULT_TRACKER_CONFIG)).toBe(false);
  });
});
