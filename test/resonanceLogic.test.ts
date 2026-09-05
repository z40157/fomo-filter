import { describe, expect, it } from "vitest";
import {
  computeWindowStats,
  decideTrigger,
  evaluateConditions,
  pruneWindow,
  type CooldownState,
  type WindowEntry,
  type WindowStats,
} from "../src/signals/resonanceLogic.js";

function entry(overrides: Partial<WindowEntry> = {}): WindowEntry {
  return {
    wallet: "0x1111111111111111111111111111111111111a",
    name: "KOL_test",
    tier: "B",
    ownerGroup: "owner-1",
    ownerGroupIsFallback: false,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    quoteAmount: 100n,
    ...overrides,
  };
}

function stats(distinctOwnerGroups: number, tierAOwnerGroups: number, hasRepeatAccumulation: boolean): WindowStats {
  return { distinctOwnerGroups, tierAOwnerGroups, hasRepeatAccumulation };
}

describe("evaluateConditions — condition A (>=3 distinct ownerGroups)", () => {
  it("fires when 3 different wallets from 3 different ownerGroups bought", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", ownerGroup: "a" }),
      entry({ wallet: "0x2", ownerGroup: "b" }),
      entry({ wallet: "0x3", ownerGroup: "c" }),
    ]);
    expect(windowStats.distinctOwnerGroups).toBe(3);
    expect(evaluateConditions(windowStats)).toContain("A");
  });

  it("does NOT fire when 3 addresses all belong to the same ownerGroup — the whole point of the dedup", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", ownerGroup: "same-owner" }),
      entry({ wallet: "0x2", ownerGroup: "same-owner" }),
      entry({ wallet: "0x3", ownerGroup: "same-owner" }),
    ]);
    expect(windowStats.distinctOwnerGroups).toBe(1);
    expect(evaluateConditions(windowStats)).not.toContain("A");
  });
});

describe("evaluateConditions — condition B (>=2 distinct Tier-A ownerGroups)", () => {
  it("fires when 2 Tier-A wallets from 2 different ownerGroups bought", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", tier: "A", ownerGroup: "a" }),
      entry({ wallet: "0x2", tier: "A", ownerGroup: "b" }),
    ]);
    expect(evaluateConditions(windowStats)).toContain("B");
  });

  it("does NOT fire when 2 Tier-A addresses share the same ownerGroup", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", tier: "A", ownerGroup: "same-owner" }),
      entry({ wallet: "0x2", tier: "A", ownerGroup: "same-owner" }),
    ]);
    expect(windowStats.tierAOwnerGroups).toBe(1);
    expect(evaluateConditions(windowStats)).not.toContain("B");
  });

  it("non-Tier-A wallets never count toward condition B", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", tier: "A", ownerGroup: "a" }),
      entry({ wallet: "0x2", tier: "B", ownerGroup: "b" }),
      entry({ wallet: "0x3", tier: "C", ownerGroup: "c" }),
    ]);
    expect(evaluateConditions(windowStats)).not.toContain("B");
  });
});

describe("evaluateConditions — condition C (>=2 ownerGroups, one repeat-bought)", () => {
  it("fires when one ownerGroup bought twice and another bought once", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", ownerGroup: "a" }),
      entry({ wallet: "0x1", ownerGroup: "a", timestamp: new Date("2026-01-01T00:05:00Z") }),
      entry({ wallet: "0x2", ownerGroup: "b" }),
    ]);
    expect(windowStats.hasRepeatAccumulation).toBe(true);
    expect(evaluateConditions(windowStats)).toContain("C");
  });

  it("counts a repeat buy from a DIFFERENT wallet in the same ownerGroup too", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", ownerGroup: "a" }),
      entry({ wallet: "0x1b", ownerGroup: "a" }), // same owner, second address
      entry({ wallet: "0x2", ownerGroup: "b" }),
    ]);
    expect(evaluateConditions(windowStats)).toContain("C");
  });

  it("does NOT fire when both ownerGroups only bought once", () => {
    const windowStats = computeWindowStats([entry({ wallet: "0x1", ownerGroup: "a" }), entry({ wallet: "0x2", ownerGroup: "b" })]);
    expect(windowStats.hasRepeatAccumulation).toBe(false);
    expect(evaluateConditions(windowStats)).not.toContain("C");
  });

  it("does NOT fire with only 1 distinct ownerGroup even if it repeat-bought many times", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", ownerGroup: "a" }),
      entry({ wallet: "0x1", ownerGroup: "a", timestamp: new Date("2026-01-01T00:05:00Z") }),
      entry({ wallet: "0x1", ownerGroup: "a", timestamp: new Date("2026-01-01T00:10:00Z") }),
    ]);
    expect(evaluateConditions(windowStats)).not.toContain("C");
  });
});

describe("evaluateConditions — multiple conditions at once", () => {
  it("reports every satisfied condition, not just the first", () => {
    const windowStats = computeWindowStats([
      entry({ wallet: "0x1", tier: "A", ownerGroup: "a" }),
      entry({ wallet: "0x2", tier: "A", ownerGroup: "b" }),
      entry({ wallet: "0x3", tier: "C", ownerGroup: "c" }),
    ]);
    // 3 distinct ownerGroups -> A; 2 distinct Tier-A ownerGroups -> B
    const conditions = evaluateConditions(windowStats);
    expect(conditions).toContain("A");
    expect(conditions).toContain("B");
  });
});

describe("pruneWindow — sliding window time boundary", () => {
  it("a wallet buying at the 21st minute (relative to the window start) ages the first buyer out — condition A does not fire", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const entries = [
      entry({ wallet: "0x1", ownerGroup: "a", timestamp: t0 }),
      entry({ wallet: "0x2", ownerGroup: "b", timestamp: new Date(t0.getTime() + 10 * 60_000) }),
      entry({ wallet: "0x3", ownerGroup: "c", timestamp: new Date(t0.getTime() + 21 * 60_000) }),
    ];
    const now = new Date(t0.getTime() + 21 * 60_000); // "now" is when the 3rd wallet buys
    const pruned = pruneWindow(entries, now, 20);

    // wallet 1's buy is 21 minutes before "now" — outside a 20-minute window
    expect(pruned.map((e) => e.wallet)).toEqual(["0x2", "0x3"]);
    expect(evaluateConditions(computeWindowStats(pruned))).not.toContain("A");
  });

  it("the same scenario but the 3rd wallet buys at minute 19 instead — still within the window, condition A fires", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const entries = [
      entry({ wallet: "0x1", ownerGroup: "a", timestamp: t0 }),
      entry({ wallet: "0x2", ownerGroup: "b", timestamp: new Date(t0.getTime() + 10 * 60_000) }),
      entry({ wallet: "0x3", ownerGroup: "c", timestamp: new Date(t0.getTime() + 19 * 60_000) }),
    ];
    const now = new Date(t0.getTime() + 19 * 60_000);
    const pruned = pruneWindow(entries, now, 20);

    expect(pruned).toHaveLength(3);
    expect(evaluateConditions(computeWindowStats(pruned))).toContain("A");
  });

  it("drops entries older than the window and keeps the rest, regardless of order", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const entries = [
      entry({ wallet: "0x1", timestamp: new Date(now.getTime() - 25 * 60_000) }), // too old
      entry({ wallet: "0x2", timestamp: new Date(now.getTime() - 5 * 60_000) }), // fine
    ];
    expect(pruneWindow(entries, now, 20).map((e) => e.wallet)).toEqual(["0x2"]);
  });
});

const NOW = new Date("2026-01-01T00:30:00Z");

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

describe("decideTrigger — cooldown suppression", () => {
  it("fires when there is no prior cooldown state", () => {
    expect(decideTrigger(["A"], stats(3, 0, false), null, NOW, 10)).toEqual({
      shouldFire: true,
      escalation: false,
    });
  });

  it("suppresses a repeat trigger within the cooldown window when the signal hasn't gotten stronger", () => {
    const cooldown: CooldownState = { lastTriggeredAt: NOW, distinctOwnerGroups: 3, hadTierA: false };
    const decision = decideTrigger(["A"], stats(3, 0, false), cooldown, addMinutes(NOW, 5), 10);
    expect(decision).toEqual({ shouldFire: false, escalation: false });
  });

  it("fires again (not an escalation) once the cooldown has fully elapsed", () => {
    const cooldown: CooldownState = { lastTriggeredAt: NOW, distinctOwnerGroups: 3, hadTierA: false };
    const decision = decideTrigger(["A"], stats(3, 0, false), cooldown, addMinutes(NOW, 11), 10);
    expect(decision).toEqual({ shouldFire: true, escalation: false });
  });
});

describe("decideTrigger — escalation breaks through an active cooldown", () => {
  it("escalates when distinctOwnerGroups increases by 2 or more", () => {
    const cooldown: CooldownState = { lastTriggeredAt: NOW, distinctOwnerGroups: 3, hadTierA: false };
    const decision = decideTrigger(["A"], stats(5, 0, false), cooldown, addMinutes(NOW, 3), 10);
    expect(decision).toEqual({ shouldFire: true, escalation: true });
  });

  it("does NOT escalate for only a +1 increase in distinctOwnerGroups", () => {
    const cooldown: CooldownState = { lastTriggeredAt: NOW, distinctOwnerGroups: 3, hadTierA: false };
    const decision = decideTrigger(["A"], stats(4, 0, false), cooldown, addMinutes(NOW, 3), 10);
    expect(decision).toEqual({ shouldFire: false, escalation: false });
  });

  it("escalates when a Tier-A ownerGroup appears for the first time", () => {
    const cooldown: CooldownState = { lastTriggeredAt: NOW, distinctOwnerGroups: 3, hadTierA: false };
    const decision = decideTrigger(["B"], stats(3, 1, false), cooldown, addMinutes(NOW, 3), 10);
    expect(decision).toEqual({ shouldFire: true, escalation: true });
  });

  it("does NOT escalate for Tier-A if one was already present at the last signal", () => {
    const cooldown: CooldownState = { lastTriggeredAt: NOW, distinctOwnerGroups: 3, hadTierA: true };
    const decision = decideTrigger(["B"], stats(3, 1, false), cooldown, addMinutes(NOW, 3), 10);
    expect(decision).toEqual({ shouldFire: false, escalation: false });
  });

  it("never fires at all when no condition is satisfied, cooldown or not", () => {
    expect(decideTrigger([], stats(0, 0, false), null, NOW, 10)).toEqual({
      shouldFire: false,
      escalation: false,
    });
  });
});
