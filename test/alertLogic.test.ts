import { describe, expect, it } from "vitest";
import { classifyAlertLevel, decideAlert, type PriorAlertState } from "../src/alerts/alertLogic.js";

const NOW = new Date("2026-01-01T00:00:00Z");

function prior(overrides: Partial<PriorAlertState> = {}): PriorAlertState {
  return {
    sentAt: new Date(NOW.getTime() - 5 * 60_000), // 5 min ago — within the default 10min cooldown
    importanceAtSend: 7.5,
    distinctOwnerGroups: 3,
    tierACount: 0,
    hasCrossedNine: false,
    ...overrides,
  };
}

describe("classifyAlertLevel", () => {
  it("< 7.0 is NONE (dashboard only)", () => {
    expect(classifyAlertLevel(6.9)).toBe("NONE");
  });
  it("7.0 is NORMAL", () => {
    expect(classifyAlertLevel(7.0)).toBe("NORMAL");
  });
  it("7.9 is still NORMAL", () => {
    expect(classifyAlertLevel(7.9)).toBe("NORMAL");
  });
  it("8.0 is STRONG", () => {
    expect(classifyAlertLevel(8.0)).toBe("STRONG");
  });
  it("8.9 is still STRONG", () => {
    expect(classifyAlertLevel(8.9)).toBe("STRONG");
  });
  it("9.0 is URGENT", () => {
    expect(classifyAlertLevel(9.0)).toBe("URGENT");
  });
});

describe("decideAlert", () => {
  it("does not send below 7.0 even with no prior alert", () => {
    const decision = decideAlert({ importanceScore: 6.9, distinctOwnerGroups: 5, tierACount: 2 }, null, NOW);
    expect(decision.shouldSend).toBe(false);
    expect(decision.level).toBe("NONE");
  });

  it("sends on the first-ever crossing of 7.0", () => {
    const decision = decideAlert({ importanceScore: 7.2, distinctOwnerGroups: 2, tierACount: 0 }, null, NOW);
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("first_cross_7");
    expect(decision.level).toBe("NORMAL");
  });

  it("does not send a duplicate within cooldown with no escalation", () => {
    const decision = decideAlert({ importanceScore: 7.6, distinctOwnerGroups: 3, tierACount: 0 }, prior(), NOW);
    expect(decision.shouldSend).toBe(false);
  });

  it("sends within cooldown when the score jumps +1.0 or more since the last alert", () => {
    const decision = decideAlert(
      { importanceScore: 8.6, distinctOwnerGroups: 3, tierACount: 0 },
      prior({ importanceAtSend: 7.5 }),
      NOW,
    );
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("score_increase");
  });

  it("does NOT re-send on a sub-1.0 score bump within cooldown", () => {
    const decision = decideAlert(
      { importanceScore: 8.4, distinctOwnerGroups: 3, tierACount: 0 },
      prior({ importanceAtSend: 7.5 }),
      NOW,
    );
    expect(decision.shouldSend).toBe(false);
  });

  it("sends within cooldown when a Tier-A wallet newly appears", () => {
    const decision = decideAlert(
      { importanceScore: 7.6, distinctOwnerGroups: 3, tierACount: 1 },
      prior({ tierACount: 0 }),
      NOW,
    );
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("new_tier_a");
  });

  it("does not re-fire new_tier_a if Tier-A was already present last time", () => {
    const decision = decideAlert(
      { importanceScore: 7.6, distinctOwnerGroups: 3, tierACount: 2 },
      prior({ tierACount: 1 }),
      NOW,
    );
    expect(decision.shouldSend).toBe(false);
  });

  it("sends within cooldown when distinct ownerGroups grows by 2 or more", () => {
    const decision = decideAlert(
      { importanceScore: 7.6, distinctOwnerGroups: 5, tierACount: 0 },
      prior({ distinctOwnerGroups: 3 }),
      NOW,
    );
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("owner_group_increase");
  });

  it("does not re-fire on a +1 ownerGroup change within cooldown", () => {
    const decision = decideAlert(
      { importanceScore: 7.6, distinctOwnerGroups: 4, tierACount: 0 },
      prior({ distinctOwnerGroups: 3 }),
      NOW,
    );
    expect(decision.shouldSend).toBe(false);
  });

  it("sends on first crossing 9.0, even if an 8.x alert already fired for this token", () => {
    const decision = decideAlert(
      { importanceScore: 9.1, distinctOwnerGroups: 3, tierACount: 0 },
      prior({ importanceAtSend: 8.3, hasCrossedNine: false }),
      NOW,
    );
    // Also satisfies score_increase (9.1 - 8.3 = 0.8, actually < 1.0) — pick a
    // score gap under 1.0 so this test isolates the cross_9 rule specifically.
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("cross_9");
  });

  it("does not re-fire cross_9 once 9.0 has already been crossed before", () => {
    const decision = decideAlert(
      { importanceScore: 9.2, distinctOwnerGroups: 3, tierACount: 0 },
      prior({ importanceAtSend: 9.0, hasCrossedNine: true }),
      NOW,
    );
    expect(decision.shouldSend).toBe(false);
  });

  it("sends again once the cooldown has fully elapsed, with no escalation needed", () => {
    const decision = decideAlert(
      { importanceScore: 7.6, distinctOwnerGroups: 3, tierACount: 0 },
      prior({ sentAt: new Date(NOW.getTime() - 11 * 60_000) }),
      NOW,
      10,
    );
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("cooldown_expired");
  });

  it("respects a configurable cooldown duration", () => {
    const decision = decideAlert(
      { importanceScore: 7.6, distinctOwnerGroups: 3, tierACount: 0 },
      prior({ sentAt: new Date(NOW.getTime() - 4 * 60_000) }),
      NOW,
      3,
    );
    expect(decision.shouldSend).toBe(true);
    expect(decision.reason).toBe("cooldown_expired");
  });
});
