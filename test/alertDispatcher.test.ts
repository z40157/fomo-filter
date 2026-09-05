import { describe, expect, it, vi } from "vitest";
import { createAlertDispatcher, type AlertDispatchInput } from "../src/alerts/alertDispatcher.js";
import type { AlertsRepo, NewAlert, PriorAlert, AlertChannel } from "../src/db/alerts.js";
import type { EmailClient, SendResult } from "../src/alerts/resendClient.js";
import type { TelegramClient } from "../src/alerts/telegramClient.js";
import type { Logger } from "../src/logger.js";
import type { ScoreBreakdown } from "../src/signals/scoring.js";
import type { RiskBreakdown } from "../src/signals/risk.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeAlertsRepo(
  opts: { lastSent?: Partial<Record<AlertChannel, PriorAlert | null>>; crossedNine?: Partial<Record<AlertChannel, boolean>> } = {},
) {
  const created: NewAlert[] = [];
  const repo: AlertsRepo = {
    async create(alert) {
      created.push(alert);
      return created.length;
    },
    async getLastSentAlert(_tokenId, channel) {
      return opts.lastSent?.[channel] ?? null;
    },
    async hasSentAtOrAbove(_tokenId, channel) {
      return opts.crossedNine?.[channel] ?? false;
    },
  };
  return { repo, created };
}

const SCORE_BREAKDOWN: ScoreBreakdown = {
  resonance: { score: 2.4, max: 3, reasons: [] },
  flow: { score: 1.7, max: 2, reasons: [] },
  acceleration: { score: 1.6, max: 2, reasons: [] },
  marketQuality: { score: 0.6, max: 1, reasons: [] },
  narrative: { score: 1.0, max: 1, reasons: [] },
  earlyness: { score: 0.8, max: 1, reasons: [] },
  total: 8.1,
};

const RISK_BREAKDOWN: RiskBreakdown = {
  liquidity: { level: "LOW", reason: "ok" },
  marketCapEntry: { level: "LOW", reason: "ok" },
  buySellImbalance: { level: "LOW", reason: "ok" },
  suddenLargeSell: { level: "LOW", reason: "ok" },
  watchlistExiting: { level: "LOW", reason: "ok" },
  deployerSelling: { level: "LOW", reason: "ok" },
  overall: "LOW",
};

function baseInput(overrides: Partial<AlertDispatchInput> = {}): AlertDispatchInput {
  return {
    signalId: 1,
    tokenId: 10,
    tokenAddress: "0xTOKEN",
    tokenSymbol: "MOLLIE",
    tokenName: "Mollie",
    quoteTokenSymbol: "WETH",
    ageMs: 60_000,
    triggerConditions: ["A"],
    windowMinutes: 20,
    distinctOwnerGroups: 3,
    tierACount: 1,
    hasRepeatAccumulation: false,
    marketCap: 100_000,
    liquidity: 20_000,
    volume5m: 5_000,
    buys5m: 5,
    sells5m: 1,
    aggregateWatchedBuyUsd: 5_000,
    aggregateWatchedSellUsd: 0,
    repeatBuyerCount: 0,
    importanceScore: 7.5,
    scoreBreakdown: SCORE_BREAKDOWN,
    riskLevel: "LOW",
    riskBreakdown: RISK_BREAKDOWN,
    confidence: "HIGH",
    confidenceReasons: ["all data available"],
    wallets: [{ address: "0xWALLET", name: "Alice", tier: "A", buyAmount: 1_000_000_000_000_000_000n, buyCount: 1 }],
    ...overrides,
  };
}

function okTelegramClient(): TelegramClient {
  return { sendMessage: vi.fn(async () => ({ ok: true }) as SendResult) };
}

function okEmailClient(): EmailClient {
  return { sendEmail: vi.fn(async () => ({ ok: true }) as SendResult) };
}

describe("createAlertDispatcher — Telegram is the primary channel", () => {
  it("does nothing (no throw, no alerts row) when Telegram is not configured", async () => {
    const { repo, created } = fakeAlertsRepo();
    const logger = fakeLogger();
    const dispatcher = createAlertDispatcher({ alertsRepo: repo, logger });
    await expect(dispatcher.dispatch(baseInput())).resolves.toBeUndefined();
    expect(created).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("sends a Telegram message and records a 'sent' alert row (channel telegram) on the first crossing of 7.0", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const dispatcher = createAlertDispatcher({
      alertsRepo: repo,
      logger: fakeLogger(),
      telegramClient,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await dispatcher.dispatch(baseInput());

    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ channel: "telegram", deliveryStatus: "sent", triggerReason: "first_cross_7" });
  });

  it("does not send below the 7.0 threshold", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const dispatcher = createAlertDispatcher({ alertsRepo: repo, logger: fakeLogger(), telegramClient });
    await dispatcher.dispatch(baseInput({ importanceScore: 6.5 }));
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("suppresses a duplicate within the cooldown window", async () => {
    const { repo, created } = fakeAlertsRepo({
      lastSent: {
        telegram: { sentAt: new Date("2026-01-01T00:05:00Z"), importanceAtSend: 7.5, distinctOwnerGroups: 3, tierACount: 1 },
      },
    });
    const telegramClient = okTelegramClient();
    const dispatcher = createAlertDispatcher({
      alertsRepo: repo,
      logger: fakeLogger(),
      telegramClient,
      now: () => new Date("2026-01-01T00:08:00Z"),
    });
    await dispatcher.dispatch(baseInput({ importanceScore: 7.6, distinctOwnerGroups: 3, tierACount: 1 }));
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("re-sends within cooldown on escalation (a new Tier-A wallet), recording the escalation reason", async () => {
    const { repo, created } = fakeAlertsRepo({
      lastSent: {
        telegram: { sentAt: new Date("2026-01-01T00:05:00Z"), importanceAtSend: 7.5, distinctOwnerGroups: 3, tierACount: 0 },
      },
    });
    const telegramClient = okTelegramClient();
    const dispatcher = createAlertDispatcher({
      alertsRepo: repo,
      logger: fakeLogger(),
      telegramClient,
      now: () => new Date("2026-01-01T00:08:00Z"),
    });
    await dispatcher.dispatch(baseInput({ importanceScore: 7.7, distinctOwnerGroups: 3, tierACount: 2 }));
    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(created[0]).toMatchObject({ channel: "telegram", triggerReason: "new_tier_a" });
  });

  it("records deliveryStatus 'failed' with the error message when the Telegram send fails, and does not throw", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient: TelegramClient = { sendMessage: vi.fn(async () => ({ ok: false, error: "boom" }) as SendResult) };
    const dispatcher = createAlertDispatcher({ alertsRepo: repo, logger: fakeLogger(), telegramClient });

    await expect(dispatcher.dispatch(baseInput())).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ channel: "telegram", deliveryStatus: "failed", errorMessage: "boom" });
  });

  it("tags the message STRONG in the 8.0-8.9 band", async () => {
    const { repo } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const dispatcher = createAlertDispatcher({ alertsRepo: repo, logger: fakeLogger(), telegramClient });

    await dispatcher.dispatch(baseInput({ importanceScore: 8.4 }));

    const sentText = (telegramClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sentText).toContain("<b>STRONG</b>");
    expect(sentText).toContain("8.4/10");
  });

  it("tags the message URGENT at/above 9.0", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const dispatcher = createAlertDispatcher({ alertsRepo: repo, logger: fakeLogger(), telegramClient });

    await dispatcher.dispatch(baseInput({ importanceScore: 9.3 }));

    const sentText = (telegramClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sentText).toContain("<b>URGENT</b>");
    expect(created[0]).toMatchObject({ channel: "telegram", triggerReason: "first_cross_7" });
  });
});

describe("createAlertDispatcher — email (Resend) is retained but off by default", () => {
  it("sends only Telegram (one row, channel telegram) when email is not configured — no warning about it", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const logger = fakeLogger();
    const dispatcher = createAlertDispatcher({ alertsRepo: repo, logger, telegramClient });

    await dispatcher.dispatch(baseInput());

    expect(created.filter((a) => a.channel === "telegram")).toHaveLength(1);
    expect(created.filter((a) => a.channel === "email")).toHaveLength(0);
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(warnArgs).not.toMatch(/email|resend/i);
  });

  it("sends an email alongside Telegram (two rows) when email is fully configured", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const emailClient = okEmailClient();
    const dispatcher = createAlertDispatcher({
      alertsRepo: repo,
      logger: fakeLogger(),
      telegramClient,
      emailClient,
      emailFrom: "a@b.com",
      emailTo: "c@d.com",
    });

    await dispatcher.dispatch(baseInput());

    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    expect(created.filter((a) => a.channel === "telegram")).toHaveLength(1);
    expect(created.filter((a) => a.channel === "email")).toHaveLength(1);
  });

  it("still records the Telegram row even if the follow-on email send fails", async () => {
    const { repo, created } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const emailClient: EmailClient = { sendEmail: vi.fn(async () => ({ ok: false, error: "smtp nope" }) as SendResult) };
    const dispatcher = createAlertDispatcher({
      alertsRepo: repo,
      logger: fakeLogger(),
      telegramClient,
      emailClient,
      emailFrom: "a@b.com",
      emailTo: "c@d.com",
    });

    await dispatcher.dispatch(baseInput());

    expect(created.filter((a) => a.channel === "telegram" && a.deliveryStatus === "sent")).toHaveLength(1);
    expect(created.filter((a) => a.channel === "email" && a.deliveryStatus === "failed")).toHaveLength(1);
  });
});

describe("createAlertDispatcher — wallet sell enrichment", () => {
  it("fills in per-wallet sell totals from the injected provider", async () => {
    const { repo } = fakeAlertsRepo();
    const telegramClient = okTelegramClient();
    const getWalletSells = vi.fn(async () => new Map([["0xwallet", { sellAmount: 500_000_000_000_000_000n, sellCount: 1 }]]));
    const dispatcher = createAlertDispatcher({
      alertsRepo: repo,
      logger: fakeLogger(),
      telegramClient,
      getWalletSells,
    });

    await dispatcher.dispatch(baseInput());

    expect(getWalletSells).toHaveBeenCalledWith(10, ["0xWALLET"], expect.any(Date));
    const sentText = (telegramClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sentText).toContain("Alice (A) — bought 1 WETH, sold 0.5 WETH");
  });
});
