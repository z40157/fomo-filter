import { describe, expect, it } from "vitest";
import { nextCheckTier } from "../../src/hotradar/checkTiers.js";

describe("nextCheckTier", () => {
  it("stays CHEAP until the cheap gate is survived", () => {
    expect(nextCheckTier({ cheapGatePassed: false, organicScore: 9 })).toBe("CHEAP");
  });

  it("moves to MEDIUM once the cheap gate passes but organic score is null or below the bar", () => {
    expect(nextCheckTier({ cheapGatePassed: true, organicScore: null })).toBe("MEDIUM");
    expect(nextCheckTier({ cheapGatePassed: true, organicScore: 1 })).toBe("MEDIUM");
  });

  it("moves to EXPENSIVE once organic score clears the configured threshold", () => {
    expect(nextCheckTier({ cheapGatePassed: true, organicScore: 4, organicScoreThreshold: 4 })).toBe("EXPENSIVE");
    expect(nextCheckTier({ cheapGatePassed: true, organicScore: 3.99, organicScoreThreshold: 4 })).toBe("MEDIUM");
  });
});
