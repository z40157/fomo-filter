import { describe, expect, it } from "vitest";
import { buildDataStatus, unknownReasonBucket } from "../../src/hotradar/dataStatus.js";

describe("buildDataStatus", () => {
  it("marks all four dimensions UNKNOWN when the gate reports all four unresolved (spec §0 expected steady state)", () => {
    const status = buildDataStatus(
      ["SELLABILITY_UNKNOWN", "CREATOR_LAUNCHES_24H_UNKNOWN", "CONTRACT_CAPABILITIES_UNKNOWN", "LIQUIDITY_UNKNOWN"],
      true,
    );
    expect(status.sellability.status).toBe("UNKNOWN");
    expect(status.liquidity.status).toBe("UNKNOWN");
    expect(status.creatorHistory.status).toBe("UNKNOWN");
    expect(status.holderConcentration.status).toBe("OK"); // age < 3m — gate never raised it
    expect(status.marketData.status).toBe("OK");
  });

  it("marks marketData UNKNOWN when no trade has landed in any window yet", () => {
    const status = buildDataStatus([], false);
    expect(status.marketData.status).toBe("UNKNOWN");
  });

  it("both creator-related reasons collapse into the same creatorHistory bucket without overwriting an already-set reason", () => {
    const status = buildDataStatus(["CREATOR_LAUNCHES_24H_UNKNOWN", "CONTRACT_CAPABILITIES_UNKNOWN"], true);
    expect(status.creatorHistory.status).toBe("UNKNOWN");
    expect(status.creatorHistory.reason).toBe("CREATOR_LAUNCHES_24H_UNKNOWN");
  });

  it("a PASS-shaped reasons array (empty) yields all-OK", () => {
    const status = buildDataStatus([], true);
    expect(status.sellability.status).toBe("OK");
    expect(status.liquidity.status).toBe("OK");
    expect(status.creatorHistory.status).toBe("OK");
    expect(status.holderConcentration.status).toBe("OK");
  });
});

describe("unknownReasonBucket", () => {
  it("returns null when nothing is unknown", () => {
    expect(unknownReasonBucket(buildDataStatus([], true))).toBeNull();
  });

  it("returns the single bucket name when exactly one dimension is unknown", () => {
    expect(unknownReasonBucket(buildDataStatus(["LIQUIDITY_UNKNOWN"], true))).toBe("liquidity");
  });

  it("returns 'multiple' when more than one dimension is unknown (spec §0's expected steady state)", () => {
    expect(unknownReasonBucket(buildDataStatus(["SELLABILITY_UNKNOWN", "LIQUIDITY_UNKNOWN"], true))).toBe("multiple");
  });
});
