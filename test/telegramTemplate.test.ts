import { describe, expect, it } from "vitest";
import { renderTelegramMessage, escapeTelegramHtml } from "../src/alerts/telegramTemplate.js";
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

describe("escapeTelegramHtml", () => {
  it("escapes the three HTML-significant characters and nothing else", () => {
    expect(escapeTelegramHtml('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d "e" \'f\'');
  });
});

describe("renderTelegramMessage", () => {
  it("includes every required section and field", () => {
    const ctx = baseContext();
    const msg = renderTelegramMessage(ctx);

    // score / risk / confidence
    expect(msg).toContain("8.4/10");
    expect(msg).toContain("Risk: <b>HIGH</b>");
    expect(msg).toContain("Confidence: <b>MEDIUM</b>");

    // symbol / CA (code-wrapped) / market cap / liquidity / age
    expect(msg).toContain("MOLLIE");
    expect(msg).toContain("Mollie Coin");
    expect(msg).toContain(`CA: <code>${ctx.tokenAddress}</code>`);
    expect(msg).toContain("MC $420.0K");
    expect(msg).toContain("Liq $24.0K");
    expect(msg).toContain("Age 22min");

    // score breakdown — all six dimensions
    expect(msg).toContain("Wallet resonance");
    expect(msg).toContain("2.4/3");
    expect(msg).toContain("Smart flow");
    expect(msg).toContain("1.7/2");
    expect(msg).toContain("Acceleration");
    expect(msg).toContain("1.6/2");
    expect(msg).toContain("Market quality");
    expect(msg).toContain("0.6/1");
    expect(msg).toContain("Narrative");
    expect(msg).toContain("1.0/1");
    expect(msg).toContain("Earlyness");
    expect(msg).toContain("0.8/1");

    // why triggered (plain-language)
    expect(msg).toContain("Why triggered");
    expect(msg).toContain("4 independent ownerGroups bought within the 20-minute window");
    expect(msg).toContain("2 Tier-A");

    // participating watchlist wallets — name + tier + buy amount
    expect(msg).toContain("Alice (A) — bought ~5");
    expect(msg).toContain("Bob (B) — bought ~1");

    // links
    expect(msg).toContain(`<a href="https://dexscreener.com/robinhood/${ctx.tokenAddress}">DexScreener</a>`);
    expect(msg).toContain(`<a href="https://robinhoodchain.blockscout.com/token/${ctx.tokenAddress}">Blockscout</a>`);

    // fixed footer
    expect(msg).toContain("This is a monitoring signal, NOT a buy recommendation.");
  });

  it("shows no STRONG/URGENT tag for a NORMAL (7.0-7.9) signal", () => {
    const msg = renderTelegramMessage(baseContext({ level: "NORMAL", importanceScore: 7.4 }));
    expect(msg).toContain("📡 <b>7.4/10</b>");
    expect(msg).not.toContain("STRONG");
    expect(msg).not.toContain("URGENT");
  });

  it("tags STRONG for an 8.0-8.9 signal", () => {
    const msg = renderTelegramMessage(baseContext({ level: "STRONG", importanceScore: 8.4 }));
    expect(msg).toContain("<b>STRONG</b>");
    expect(msg).toContain("8.4/10");
  });

  it("tags URGENT for a >= 9.0 signal", () => {
    const msg = renderTelegramMessage(baseContext({ level: "URGENT", importanceScore: 9.2 }));
    expect(msg).toContain("<b>URGENT</b>");
    expect(msg).toContain("9.2/10");
  });

  it("flags UNKNOWN risk at the very top, before the token section", () => {
    const msg = renderTelegramMessage(baseContext({ riskLevel: "UNKNOWN" }));
    const warnIdx = msg.indexOf("RISK UNKNOWN");
    const tokenIdx = msg.indexOf("<b>Token</b>");
    expect(warnIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeLessThan(tokenIdx);
  });

  it("flags LOW confidence at the very top, before the token section", () => {
    const msg = renderTelegramMessage(baseContext({ confidence: "LOW" }));
    const warnIdx = msg.indexOf("LOW CONFIDENCE");
    const tokenIdx = msg.indexOf("<b>Token</b>");
    expect(warnIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeLessThan(tokenIdx);
  });

  it("has no warning banner when risk and confidence are both fine", () => {
    const msg = renderTelegramMessage(baseContext({ riskLevel: "LOW", confidence: "HIGH" }));
    expect(msg).not.toContain("RISK UNKNOWN");
    expect(msg).not.toContain("LOW CONFIDENCE");
  });

  it("escapes HTML in token/wallet names to avoid markup injection", () => {
    const msg = renderTelegramMessage(
      baseContext({
        tokenSymbol: "<b>x</b>",
        wallets: [{ address: "0x1", name: "<i>evil</i>", tier: "A", buyAmount: 1n, buyCount: 1, sellAmount: 0n, sellCount: 0 }],
      }),
    );
    expect(msg).not.toContain("<b>x</b>");
    expect(msg).not.toContain("<i>evil</i>");
    expect(msg).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(msg).toContain("&lt;i&gt;evil&lt;/i&gt;");
  });

  it("shows unknown market fields without fabricating zeros", () => {
    const msg = renderTelegramMessage(
      baseContext({ marketCap: null, liquidity: null, volume5m: null, buys5m: null, sells5m: null }),
    );
    expect(msg).toContain("MC unknown");
    expect(msg).toContain("Liq unknown");
    expect(msg).toContain("5m vol unknown");
  });

  it("notes a wallet's sells when it has sold", () => {
    const msg = renderTelegramMessage(baseContext());
    expect(msg).toContain("Bob (B) — bought ~1, sold ~0.5");
  });
});
