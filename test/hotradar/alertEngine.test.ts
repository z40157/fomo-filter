import { describe, expect, it } from "vitest";
import {
  decideAlertTier,
  formatShadowAlertMessage,
  isMeaningfulRiskImprovement,
  isReAlertEligible,
  tierForScore,
} from "../../src/hotradar/alertEngine.js";

describe("tierForScore — B3.1 thresholds", () => {
  it.each([
    [5.4, "NONE"],
    [5.5, "WATCH"],
    [6.9, "WATCH"],
    [7.0, "EARLY_RADAR"],
    [7.9, "EARLY_RADAR"],
    [8.0, "STRONG"],
    [8.9, "STRONG"],
    [9.0, "URGENT"],
  ] as const)("%f -> %s", (score, expected) => {
    expect(tierForScore(score)).toBe(expected);
  });
});

describe("decideAlertTier — override ladder (B3.2)", () => {
  it("Risk CRITICAL fully blocks a positive alert even at score 9.5", () => {
    const result = decideAlertTier({ breakoutScore: 9.5, risk: "CRITICAL", confidence: "HIGH", ageMs: 10 * 60_000 });
    expect(result.tier).toBe("NONE");
    expect(result.blocked).toBe(true);
    expect(result.warningOnly).toBe("HIGH_MOMENTUM_BLOCKED_BY_RISK");
  });

  it("Risk CRITICAL with an already-NONE base tier has no warning to send", () => {
    const result = decideAlertTier({ breakoutScore: 2, risk: "CRITICAL", confidence: "HIGH", ageMs: 10 * 60_000 });
    expect(result.warningOnly).toBeNull();
  });

  it("Risk HIGH drops exactly one tier", () => {
    const result = decideAlertTier({ breakoutScore: 8.5, risk: "HIGH", confidence: "HIGH", ageMs: 10 * 60_000 });
    expect(result.tier).toBe("EARLY_RADAR"); // STRONG -> EARLY_RADAR
  });

  it("Confidence LOW caps at WATCH even for a 9.5 score, per spec even though risk alone wouldn't", () => {
    const result = decideAlertTier({ breakoutScore: 9.5, risk: "LOW", confidence: "LOW", ageMs: 10 * 60_000 });
    expect(result.tier).toBe("WATCH");
    expect(result.reasons).toContain("CONFIDENCE_LOW_CAP_WATCH");
  });

  it("age under 10s never produces a normal alert regardless of score", () => {
    const result = decideAlertTier({ breakoutScore: 9.9, risk: "LOW", confidence: "HIGH", ageMs: 5_000 });
    expect(result.tier).toBe("NONE");
  });

  it("age 10s-3m requires score>=8.5 AND risk<=MEDIUM AND confidence>=MEDIUM, else capped WATCH", () => {
    const capped = decideAlertTier({ breakoutScore: 8.0, risk: "LOW", confidence: "HIGH", ageMs: 60_000 });
    expect(capped.tier).toBe("WATCH");

    const allowed = decideAlertTier({ breakoutScore: 8.5, risk: "MEDIUM", confidence: "MEDIUM", ageMs: 60_000 });
    expect(allowed.tier).toBe("STRONG");
  });

  it("age past 3m is unaffected by the early-window strict rule", () => {
    const result = decideAlertTier({ breakoutScore: 8.0, risk: "LOW", confidence: "HIGH", ageMs: 5 * 60_000 });
    expect(result.tier).toBe("STRONG");
  });

  it("overrides stack: HIGH risk downgrade then LOW confidence cap both apply", () => {
    const result = decideAlertTier({ breakoutScore: 9.5, risk: "HIGH", confidence: "LOW", ageMs: 10 * 60_000 });
    expect(result.tier).toBe("WATCH");
  });
});

describe("isMeaningfulRiskImprovement — B3.3", () => {
  it("CRITICAL/HIGH -> anything lower counts as meaningful", () => {
    expect(isMeaningfulRiskImprovement("CRITICAL", "LOW")).toBe(true);
    expect(isMeaningfulRiskImprovement("HIGH", "MEDIUM")).toBe(true);
  });

  it("MEDIUM -> LOW alone does not count as meaningful", () => {
    expect(isMeaningfulRiskImprovement("MEDIUM", "LOW")).toBe(false);
  });

  it("no change, or a worsening, is never an improvement", () => {
    expect(isMeaningfulRiskImprovement("LOW", "LOW")).toBe(false);
    expect(isMeaningfulRiskImprovement("LOW", "HIGH")).toBe(false);
  });
});

describe("isReAlertEligible — B3.4", () => {
  const base = {
    previousAlertedScore: 7.0,
    currentScore: 7.0,
    newIndependentKol: false,
    newTierA: false,
    previousVolumeVelocity: null,
    currentVolumeVelocity: null,
    protocolStateTransition: null,
    previousRisk: "LOW" as const,
    currentRisk: "LOW" as const,
  };

  it("no change at all is not eligible", () => {
    expect(isReAlertEligible(base).eligible).toBe(false);
  });

  it("score increase of exactly 0.8 is eligible", () => {
    expect(isReAlertEligible({ ...base, currentScore: 7.8 }).eligible).toBe(true);
  });

  it("score increase under 0.8 alone is not eligible", () => {
    expect(isReAlertEligible({ ...base, currentScore: 7.5 }).eligible).toBe(false);
  });

  it("a new independent KOL alone is eligible", () => {
    expect(isReAlertEligible({ ...base, newIndependentKol: true }).eligible).toBe(true);
  });

  it("volume velocity doubling is eligible", () => {
    const result = isReAlertEligible({ ...base, previousVolumeVelocity: 1, currentVolumeVelocity: 2 });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toContain("VOLUME_VELOCITY_2X");
  });

  it("crossing 8 or 9 for the first time is independently eligible", () => {
    expect(isReAlertEligible({ ...base, previousAlertedScore: 7.9, currentScore: 8.0 }).reasons).toContain("FIRST_CROSS_8");
    expect(isReAlertEligible({ ...base, previousAlertedScore: 8.9, currentScore: 9.0 }).reasons).toContain("FIRST_CROSS_9");
  });

  it("a meaningful risk improvement alone is eligible", () => {
    const result = isReAlertEligible({ ...base, previousRisk: "HIGH", currentRisk: "LOW" });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toContain("MEANINGFUL_RISK_IMPROVEMENT");
  });
});

describe("formatShadowAlertMessage", () => {
  it("always includes the not-a-buy-recommendation disclaimer", () => {
    const message = formatShadowAlertMessage({
      tier: "EARLY_RADAR",
      chain: "RH",
      tokenSymbol: "XYZ",
      tokenAddress: "0xabc",
      ageSeconds: 258,
      breakoutScore: 7.3,
      organicScore: 6.3,
      kolScore: 1.0,
      risk: "MEDIUM",
      confidence: "MEDIUM",
      marketCapUsd: 126_000,
      liquidityUsd: 39_000,
      volume1mUsd: 7000,
      volume3mUsd: 23_000,
      volume5mUsd: 61_000,
      accelerationPct: 164,
      uniqueBuyers: [17, 38, 74],
      holders: [22, 51, 97],
      top10HolderPct: 24,
      devHoldingPct: 2.1,
      sellability: "PASS",
      independentKolCount: 2,
      scoreHistory: [5.9, 6.6, 7.3],
    });
    expect(message).toContain("Breakout Score is not a buy recommendation.");
    expect(message).toContain("XYZ");
    expect(message).toContain("7.3 / 10");
  });
});
