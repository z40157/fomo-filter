import { describe, expect, it } from "vitest";
import { agePhase, isExpired, nextRadarState, refreshCadenceMsForAge } from "../../src/hotradar/lifecycle.js";

describe("nextRadarState", () => {
  it("stays DISCOVERED for the first 10s", () => {
    expect(nextRadarState({ ageMs: 0, currentState: "DISCOVERED", gateStatus: "UNKNOWN_REVIEW" })).toBe("DISCOVERED");
    expect(nextRadarState({ ageMs: 9_999, currentState: "DISCOVERED", gateStatus: "UNKNOWN_REVIEW" })).toBe("DISCOVERED");
  });

  it("moves to EARLY_OBSERVATION between 10s and 3m", () => {
    expect(nextRadarState({ ageMs: 10_001, currentState: "DISCOVERED", gateStatus: "UNKNOWN_REVIEW" })).toBe(
      "EARLY_OBSERVATION",
    );
    expect(nextRadarState({ ageMs: 3 * 60_000, currentState: "EARLY_OBSERVATION", gateStatus: "PASS" })).toBe(
      "EARLY_OBSERVATION",
    );
  });

  it("moves to HOT from 3m through 30m", () => {
    expect(nextRadarState({ ageMs: 3 * 60_000 + 1, currentState: "EARLY_OBSERVATION", gateStatus: "PASS" })).toBe("HOT");
    expect(nextRadarState({ ageMs: 29 * 60_000, currentState: "HOT", gateStatus: "PASS" })).toBe("HOT");
  });

  it("expires past 30m and stays expired even if age input later drops (shouldn't happen, but must not un-expire)", () => {
    expect(nextRadarState({ ageMs: 30 * 60_000 + 1, currentState: "HOT", gateStatus: "PASS" })).toBe("EXPIRED_30M");
    expect(nextRadarState({ ageMs: 60_000, currentState: "EXPIRED_30M", gateStatus: "PASS" })).toBe("EXPIRED_30M");
  });

  it("REJECT gate status moves any non-terminal state to REJECTED", () => {
    expect(nextRadarState({ ageMs: 60_000, currentState: "EARLY_OBSERVATION", gateStatus: "REJECT" })).toBe("REJECTED");
  });

  it("REJECTED is sticky even if a later gate re-evaluation would PASS", () => {
    expect(nextRadarState({ ageMs: 60_000, currentState: "REJECTED", gateStatus: "PASS" })).toBe("REJECTED");
  });
});

describe("agePhase / refreshCadenceMsForAge", () => {
  it("returns null cadence once expired — no high-frequency refresh past 30m (A.6)", () => {
    expect(agePhase(31 * 60_000)).toBe("EXPIRED");
    expect(refreshCadenceMsForAge(31 * 60_000)).toBeNull();
  });

  it("returns a real cadence for every non-expired phase", () => {
    for (const ms of [0, 60_000, 5 * 60_000, 15 * 60_000, 25 * 60_000]) {
      expect(refreshCadenceMsForAge(ms)).not.toBeNull();
    }
  });

  it("isExpired matches the 30m boundary exactly", () => {
    expect(isExpired(30 * 60_000)).toBe(false);
    expect(isExpired(30 * 60_000 + 1)).toBe(true);
  });
});
