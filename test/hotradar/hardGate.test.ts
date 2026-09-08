import { describe, expect, it } from "vitest";
import { evaluateHardGate, type HardGateInputs } from "../../src/hotradar/hardGate.js";

function baseInputs(overrides: Partial<HardGateInputs> = {}): HardGateInputs {
  return {
    ageMs: 60_000,
    sellability: "PASS",
    creatorLaunches24h: 1,
    contractRedFlags: [],
    contractRedFlagsCheckable: true,
    liquidityThinness: "OK",
    creatorDumpSeverity: null,
    topTraderConcentration: { top3SharePct: null, uniqueTraders: null },
    holderConcentrationTrend: null,
    ...overrides,
  };
}

describe("evaluateHardGate", () => {
  it("PASSes when every input is clean", () => {
    expect(evaluateHardGate(baseInputs())).toEqual({ status: "PASS", reasons: [] });
  });

  it("REJECTs on sellability FAIL", () => {
    const result = evaluateHardGate(baseInputs({ sellability: "FAIL" }));
    expect(result.status).toBe("REJECT");
    expect(result.reasons).toContain("SELLABILITY_FAIL");
  });

  it("UNKNOWN_REVIEW on sellability UNKNOWN, never PASS", () => {
    const result = evaluateHardGate(baseInputs({ sellability: "UNKNOWN" }));
    expect(result.status).toBe("UNKNOWN_REVIEW");
  });

  it("REJECTs creator launch spam over the threshold", () => {
    const result = evaluateHardGate(baseInputs({ creatorLaunches24h: 21 }));
    expect(result.status).toBe("REJECT");
    expect(result.reasons).toContain("CREATOR_LAUNCH_SPAM_21");
  });

  it("does not REJECT at exactly the threshold", () => {
    const result = evaluateHardGate(baseInputs({ creatorLaunches24h: 20 }));
    expect(result.status).toBe("PASS");
  });

  it("UNKNOWN_REVIEW when creator launch count can't be computed", () => {
    const result = evaluateHardGate(baseInputs({ creatorLaunches24h: null }));
    expect(result.status).toBe("UNKNOWN_REVIEW");
  });

  it("REJECTs a verified contract red flag", () => {
    const result = evaluateHardGate(baseInputs({ contractRedFlags: ["infinite_mint"] }));
    expect(result.status).toBe("REJECT");
    expect(result.reasons).toContain("CONTRACT_RED_FLAG_infinite_mint");
  });

  it("never treats un-checkable contract capabilities as a clean PASS", () => {
    const result = evaluateHardGate(baseInputs({ contractRedFlagsCheckable: false }));
    expect(result.status).toBe("UNKNOWN_REVIEW");
  });

  it("REJECTs thin liquidity once a pool exists", () => {
    const result = evaluateHardGate(baseInputs({ liquidityThinness: "THIN" }));
    expect(result.status).toBe("REJECT");
  });

  it("REJECTs CRITICAL creator dumping", () => {
    const result = evaluateHardGate(baseInputs({ creatorDumpSeverity: "CRITICAL" }));
    expect(result.status).toBe("REJECT");
  });

  it("does not REJECT on HIGH creator dumping (only CRITICAL is a hard reject per A.8)", () => {
    const result = evaluateHardGate(baseInputs({ creatorDumpSeverity: "HIGH" }));
    expect(result.status).toBe("PASS");
  });

  it("never REJECTs on concentration alone when age < 3m, even at extreme concentration", () => {
    const result = evaluateHardGate(
      baseInputs({
        ageMs: 90_000,
        topTraderConcentration: { top3SharePct: 99, uniqueTraders: 1 },
        holderConcentrationTrend: "STAGNANT",
      }),
    );
    expect(result.status).toBe("PASS");
  });

  it("REJECTs wash-trade-shaped concentration once age >= 3m", () => {
    const result = evaluateHardGate(
      baseInputs({ ageMs: 3 * 60_000, topTraderConcentration: { top3SharePct: 85, uniqueTraders: 3 } }),
    );
    expect(result.status).toBe("REJECT");
    expect(result.reasons).toContain("WASH_TRADE_CONCENTRATION_RULE_VERSION_1_GUESS");
  });

  it("does not REJECT on concentration alone if unique traders are healthy, even with a high top3 share", () => {
    const result = evaluateHardGate(
      baseInputs({ ageMs: 5 * 60_000, topTraderConcentration: { top3SharePct: 85, uniqueTraders: 50 } }),
    );
    expect(result.status).toBe("PASS");
  });

  it("REJECT takes priority over UNKNOWN when both are present", () => {
    const result = evaluateHardGate(baseInputs({ sellability: "UNKNOWN", contractRedFlags: ["blacklist"] }));
    expect(result.status).toBe("REJECT");
    expect(result.reasons).toContain("SELLABILITY_UNKNOWN");
    expect(result.reasons).toContain("CONTRACT_RED_FLAG_blacklist");
  });
});
