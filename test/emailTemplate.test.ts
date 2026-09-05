import { describe, expect, it } from "vitest";
import { renderAlertEmail, buildSubject } from "../src/alerts/emailTemplate.js";
import type { AlertContext } from "../src/alerts/alertTypes.js";
import type { ScoreBreakdown } from "../src/signals/scoring.js";
import type { RiskBreakdown } from "../src/signals/risk.js";

function dim(score: number, max: number, reasons: string[] = ["reason"]) {
  return { score, max, reasons };
}

const SCORE_BREAKDOWN: ScoreBreakdown = {
  resonance: dim(2.4, 3),
  flow: dim(1.7, 2),
  acceleration: dim(1.6, 2),
  marketQuality: dim(0.6, 1),
  narrative: dim(1.0, 1, ["official stock pair: SPY"]),
  earlyness: dim(0.8, 1),
  total: 8.1,
};

const RISK_BREAKDOWN: RiskBreakdown = {
  liquidity: { level: "MEDIUM", reason: "liquidity $24000 < $30,000" },
  marketCapEntry: { level: "LOW", reason: "market cap $420000, age 0.4h" },
  buySellImbalance: { level: "HIGH", reason: "12 sells vs 3 buys in the last 5m" },
  suddenLargeSell: { level: "LOW", reason: "largest recent sell was only 1.2% of pool liquidity" },
  watchlistExiting: { level: "LOW", reason: "watchlist wallets are net buyers" },
  deployerSelling: { level: "LOW", reason: "no deployer sells observed" },
  overall: "HIGH",
};

function baseContext(overrides: Partial<AlertContext> = {}): AlertContext {
  return {
    signalId: 42,
    tokenId: 7,
    tokenAddress: "0xAbCdEf0000000000000000000000000000001234",
    tokenSymbol: "MOLLIE",
    tokenName: "Mollie Coin",
    ageMs: 22 * 60_000,
    triggerConditions: ["A", "B"],
    windowMinutes: 20,
    distinctOwnerGroups: 4,
    tierACount: 2,
    hasRepeatAccumulation: true,
    marketCap: 420_000,
    liquidity: 24_000,
    volume5m: 45_000,
    buys5m: 12,
    sells5m: 4,
    aggregateWatchedBuyUsd: 15_300,
    aggregateWatchedSellUsd: 3_000,
    repeatBuyerCount: 2,
    importanceScore: 8.4,
    scoreBreakdown: SCORE_BREAKDOWN,
    riskLevel: "HIGH",
    riskBreakdown: RISK_BREAKDOWN,
    confidence: "MEDIUM",
    confidenceReasons: ["only 3 market snapshot(s) so far — trend data is thin"],
    wallets: [
      { address: "0x1111", name: "Alice", tier: "A", buyAmount: 5_000_000_000_000_000_000n, buyCount: 2, sellAmount: 0n, sellCount: 0 },
      { address: "0x2222", name: "Bob", tier: "B", buyAmount: 1_000_000_000_000_000_000n, buyCount: 1, sellAmount: 500_000_000_000_000_000n, sellCount: 1 },
    ],
    level: "STRONG",
    ...overrides,
  };
}

describe("buildSubject", () => {
  it("formats the base subject with score, symbol, market cap, and smart wallet count", () => {
    const subject = buildSubject(baseContext({ level: "NORMAL", importanceScore: 7.4 }));
    expect(subject).toBe("[RH 7.4/10] MOLLIE | MC $420.0K | 4 Smart Wallets");
  });

  it("tags STRONG in the subject for 8.0-8.9", () => {
    const subject = buildSubject(baseContext({ level: "STRONG", importanceScore: 8.4 }));
    expect(subject).toContain("STRONG");
    expect(subject).toContain("8.4/10");
  });

  it("tags URGENT in the subject for >= 9.0", () => {
    const subject = buildSubject(baseContext({ level: "URGENT", importanceScore: 9.2 }));
    expect(subject).toContain("URGENT");
    expect(subject).toContain("9.2/10");
  });
});

describe("renderAlertEmail", () => {
  it("includes every required section and field from a full mock signal", () => {
    const ctx = baseContext();
    const { subject, html } = renderAlertEmail(ctx);

    expect(subject).toContain("MOLLIE");

    // Header block
    expect(html).toContain("Robinhood Alpha Radar");
    expect(html).toContain("IMPORTANCE: 8.4 / 10");
    expect(html).toContain("HIGH");
    expect(html).toContain("MEDIUM");

    // Token section
    expect(html).toContain("MOLLIE");
    expect(html).toContain("Mollie Coin");
    expect(html).toContain(ctx.tokenAddress);
    expect(html).toContain("22min");
    expect(html).toContain("$420.0K");
    expect(html).toContain("$24.0K");

    // Smart flow section
    expect(html).toContain("20M Smart Flow");
    expect(html).toContain("4</span>"); // distinctOwnerGroups
    expect(html).toContain("2</span>"); // tierACount appears somewhere

    // Market section
    expect(html).toContain("$45.0K");

    // Score breakdown — "Wallet resonance: 2.4 / 3" style
    expect(html).toContain("Wallet resonance");
    expect(html).toContain("2.4 / 3");
    expect(html).toContain("Smart flow");
    expect(html).toContain("1.7 / 2");
    expect(html).toContain("Acceleration");
    expect(html).toContain("1.6 / 2");
    expect(html).toContain("Market quality");
    expect(html).toContain("0.6 / 1");
    expect(html).toContain("Narrative");
    expect(html).toContain("1.0 / 1");
    expect(html).toContain("Earlyness");
    expect(html).toContain("0.8 / 1");

    // Why triggered
    expect(html).toContain("Why triggered");
    expect(html).toContain("4 independent ownerGroups");
    expect(html).toContain("20-minute window");
    expect(html).toContain("2 Tier-A");

    // Watched wallets table
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");

    // Risk section
    expect(html).toContain("Liquidity");
    expect(html).toContain("Buy/sell imbalance");
    expect(html).toContain("Deployer selling");

    // Confidence section
    expect(html).toContain("trend data is thin");

    // Links
    expect(html).toContain("dexscreener.com/robinhood/");
    expect(html).toContain("robinhoodchain.blockscout.com/token/");

    // Footer disclaimer
    expect(html).toContain("This is a monitoring signal, NOT an automatic buy recommendation.");
  });

  it("prominently flags UNKNOWN risk at the top of the email", () => {
    const { html } = renderAlertEmail(baseContext({ riskLevel: "UNKNOWN" }));
    const warningIndex = html.indexOf("RISK COULD NOT BE DETERMINED");
    const tokenSectionIndex = html.indexOf("Token</div>");
    expect(warningIndex).toBeGreaterThan(-1);
    expect(warningIndex).toBeLessThan(tokenSectionIndex);
  });

  it("prominently flags LOW confidence at the top of the email", () => {
    const { html } = renderAlertEmail(baseContext({ confidence: "LOW" }));
    const warningIndex = html.indexOf("LOW CONFIDENCE");
    const tokenSectionIndex = html.indexOf("Token</div>");
    expect(warningIndex).toBeGreaterThan(-1);
    expect(warningIndex).toBeLessThan(tokenSectionIndex);
  });

  it("shows no warning banner when risk and confidence are both fine", () => {
    const { html } = renderAlertEmail(baseContext({ riskLevel: "LOW", confidence: "HIGH" }));
    expect(html).not.toContain("RISK COULD NOT BE DETERMINED");
    expect(html).not.toContain("LOW CONFIDENCE");
  });

  it("escapes HTML in token/wallet names to avoid markup injection", () => {
    const { html } = renderAlertEmail(
      baseContext({
        tokenSymbol: "<script>alert(1)</script>",
        wallets: [{ address: "0x1", name: "<img src=x>", tier: "A", buyAmount: 1n, buyCount: 1, sellAmount: 0n, sellCount: 0 }],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x>");
  });
});
