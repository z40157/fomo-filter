import { afterEach, describe, expect, it, vi } from "vitest";
import { createResonanceDetector, type MarketSnapshot, type WatchlistBuyEvent } from "../src/signals/resonanceDetector.js";
import type { NewSignal, NewSignalWallet, SignalsRepo } from "../src/db/signals.js";
import type { WalletEntry } from "../src/db/walletWatchlist.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeSignalsRepo(): SignalsRepo & { signals: NewSignal[]; walletRows: NewSignalWallet[] } {
  const signals: NewSignal[] = [];
  const walletRows: NewSignalWallet[] = [];
  let nextId = 1;
  return {
    signals,
    walletRows,
    async create(signal) {
      signals.push(signal);
      return nextId++;
    },
    async addWallets(wallets) {
      walletRows.push(...wallets);
    },
    async countSince() {
      return 0;
    },
    async lastTriggeredAt() {
      return null;
    },
  };
}

function walletEntry(overrides: Partial<WalletEntry> = {}): WalletEntry {
  return {
    address: "0x1111111111111111111111111111111111111a",
    name: "KOL_test",
    type: "KOL",
    tier: "B",
    ownerGroup: "owner-1",
    enabled: true,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

function buyEvent(overrides: Partial<WatchlistBuyEvent> = {}): WatchlistBuyEvent {
  return {
    tokenId: 1,
    tokenAddress: "0xTOKEN",
    tokenSymbol: "TEST",
    wallet: walletEntry(),
    quoteAmount: 100n,
    timestamp: FIXED_NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ResonanceDetector — persistence shape", () => {
  it("persists a signal and a wallet row for each participant once condition A fires", async () => {
    const signalsRepo = fakeSignalsRepo();
    const detector = createResonanceDetector({ signalsRepo, logger: fakeLogger(), now: () => FIXED_NOW });

    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x1", ownerGroup: "a" }) }));
    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x2", ownerGroup: "b" }) }));
    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x3", ownerGroup: "c" }) }));

    expect(signalsRepo.signals).toHaveLength(1);
    expect(signalsRepo.signals[0]).toMatchObject({
      tokenId: 1,
      triggerConditions: ["A"],
      distinctOwnerGroups: 3,
      tierACount: 0,
      hasRepeatAccumulation: false,
      windowMinutes: 20,
      escalation: false,
    });
    expect(signalsRepo.walletRows).toHaveLength(3);
    detector.stop();
  });

  it("does not persist anything when no condition is satisfied", async () => {
    const signalsRepo = fakeSignalsRepo();
    const detector = createResonanceDetector({ signalsRepo, logger: fakeLogger(), now: () => FIXED_NOW });

    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x1", ownerGroup: "a" }) }));

    expect(signalsRepo.signals).toHaveLength(0);
    detector.stop();
  });

  it("aggregates buyCount/buyAmount per wallet across multiple buys within the window", async () => {
    const signalsRepo = fakeSignalsRepo();
    const detector = createResonanceDetector({ signalsRepo, logger: fakeLogger(), now: () => FIXED_NOW });

    const repeatWallet = walletEntry({ address: "0x1", ownerGroup: "a" });
    await detector.onWatchlistBuy(buyEvent({ wallet: repeatWallet, quoteAmount: 100n }));
    await detector.onWatchlistBuy(buyEvent({ wallet: repeatWallet, quoteAmount: 50n }));
    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x2", ownerGroup: "b" }) }));

    // condition C fires here (2 ownerGroups, one repeat-bought)
    expect(signalsRepo.signals).toHaveLength(1);
    const repeatRow = signalsRepo.walletRows.find((w) => w.walletAddress === "0x1");
    expect(repeatRow).toMatchObject({ buyCount: 2, buyAmount: "150" });
    detector.stop();
  });
});

describe("ResonanceDetector — market snapshot attachment", () => {
  it("attaches the market snapshot from getMarketSnapshot when available", async () => {
    const signalsRepo = fakeSignalsRepo();
    const snapshot: MarketSnapshot = { marketCap: 12345, liquidity: 6789, volume5m: 42 };
    const detector = createResonanceDetector({
      signalsRepo,
      logger: fakeLogger(),
      now: () => FIXED_NOW,
      getMarketSnapshot: () => snapshot,
    });

    for (const addr of ["0x1", "0x2", "0x3"]) {
      await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: addr, ownerGroup: addr }) }));
    }

    expect(signalsRepo.signals[0]).toMatchObject({ marketCap: 12345, liquidity: 6789, volume5m: 42 });
    detector.stop();
  });

  it("stores null market fields when no snapshot is available yet", async () => {
    const signalsRepo = fakeSignalsRepo();
    const detector = createResonanceDetector({ signalsRepo, logger: fakeLogger(), now: () => FIXED_NOW }); // no getMarketSnapshot at all

    for (const addr of ["0x1", "0x2", "0x3"]) {
      await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: addr, ownerGroup: addr }) }));
    }

    expect(signalsRepo.signals[0]).toMatchObject({ marketCap: null, liquidity: null, volume5m: null });
    detector.stop();
  });
});

describe("ResonanceDetector — empty ownerGroup fallback", () => {
  it("treats a wallet with no ownerGroup as its own independent group, and warns about it", async () => {
    const signalsRepo = fakeSignalsRepo();
    const logger = fakeLogger();
    const detector = createResonanceDetector({ signalsRepo, logger, now: () => FIXED_NOW });

    const noGroupWallet = walletEntry({ address: "0xNoGroup", ownerGroup: "  " }); // blank after trim
    await detector.onWatchlistBuy(buyEvent({ wallet: noGroupWallet }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: "0xNoGroup" }),
      expect.stringContaining("no ownerGroup"),
    );
    detector.stop();
  });
});

describe("ResonanceDetector — cooldown integration", () => {
  it("suppresses a second trigger within the cooldown, then escalates once ownerGroups grow by 2+", async () => {
    const signalsRepo = fakeSignalsRepo();
    let currentTime = new Date("2026-01-01T00:00:00Z").getTime();
    const detector = createResonanceDetector({
      signalsRepo,
      logger: fakeLogger(),
      config: { cooldownMinutes: 10, windowMinutes: 20 },
      now: () => new Date(currentTime),
    });

    // Fire condition A with 3 owners.
    for (const addr of ["0x1", "0x2", "0x3"]) {
      await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: addr, ownerGroup: addr }) }));
    }
    expect(signalsRepo.signals).toHaveLength(1);

    // 2 minutes later, one more owner buys — still within cooldown, only +1 group, should be suppressed.
    currentTime += 2 * 60_000;
    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x4", ownerGroup: "0x4" }) }));
    expect(signalsRepo.signals).toHaveLength(1);

    // 1 more minute later, a 5th owner buys. Every buy is checked immediately
    // (not batched), so this is the exact moment distinctOwnerGroups first
    // reaches the baseline(3)+2 escalation threshold — the signal fires here,
    // not later.
    currentTime += 1 * 60_000;
    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x5", ownerGroup: "0x5" }) }));

    expect(signalsRepo.signals).toHaveLength(2);
    expect(signalsRepo.signals[1]).toMatchObject({ escalation: true, distinctOwnerGroups: 5 });

    // A 6th owner buying right after lands within the NEW cooldown (baseline
    // now 5), and +1 alone doesn't clear the threshold again — suppressed.
    await detector.onWatchlistBuy(buyEvent({ wallet: walletEntry({ address: "0x6", ownerGroup: "0x6" }) }));
    expect(signalsRepo.signals).toHaveLength(2);
    detector.stop();
  });
});

describe("ResonanceDetector — periodic cleanup (memory)", () => {
  it("prunes a token's window entries after they age out, even with no further activity on that token", async () => {
    vi.useFakeTimers();
    let currentTime = new Date("2026-01-01T00:00:00Z").getTime();
    const signalsRepo = fakeSignalsRepo();
    const detector = createResonanceDetector({
      signalsRepo,
      logger: fakeLogger(),
      config: { windowMinutes: 20, cooldownMinutes: 10 },
      now: () => new Date(currentTime),
      cleanupIntervalMs: 1_000,
    });

    await detector.onWatchlistBuy(buyEvent({ tokenId: 42 }));
    expect(detector.getWindowEntryCount(42)).toBe(1);

    // Move logical time past the window without any new activity on this token.
    currentTime += 25 * 60_000;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(detector.getWindowEntryCount(42)).toBe(0);
    detector.stop();
  });
});
