// Ties resonanceLogic.ts's pure math to real state: an in-memory sliding
// window per token, cooldown tracking, DB persistence, and logging.
//
// Called synchronously from the trade-detection pipeline on every
// watchlist wallet's BUY (see chain/tradeDetector.ts) — never a polling
// scan, so a signal is never missed by a scan interval falling outside
// the window.

import type { Logger } from "../logger.js";
import type { WalletEntry, WalletTier } from "../db/walletWatchlist.js";
import type { SignalsRepo } from "../db/signals.js";
import {
  DEFAULT_RESONANCE_CONFIG,
  computeWindowStats,
  decideTrigger,
  evaluateConditions,
  pruneWindow,
  type CooldownState,
  type ResonanceConfig,
  type WindowEntry,
} from "./resonanceLogic.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export interface MarketSnapshot {
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
}

export interface WatchlistBuyEvent {
  tokenId: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  wallet: WalletEntry;
  /** Raw on-chain integer quote amount for this BUY (already absolute-valued). */
  quoteAmount: bigint;
  timestamp: Date;
}

export interface ResonanceDetectorDeps {
  signalsRepo: SignalsRepo;
  logger: Logger;
  config?: Partial<ResonanceConfig>;
  /** Pulls the latest known market data for a token from candidateTracker's in-memory state — undefined/null fields if none is available yet. */
  getMarketSnapshot?: (tokenId: number) => MarketSnapshot | undefined;
  now?: () => Date;
  cleanupIntervalMs?: number;
}

export interface ResonanceDetector {
  onWatchlistBuy(event: WatchlistBuyEvent): Promise<void>;
  stop(): void;
  /** Diagnostic: current in-memory window size for a token (0 if untracked or pruned away). Mainly for tests/observability. */
  getWindowEntryCount(tokenId: number): number;
}

function resolveOwnerGroup(wallet: WalletEntry): { ownerGroup: string; isFallback: boolean } {
  const trimmed = wallet.ownerGroup.trim();
  if (trimmed.length > 0) return { ownerGroup: trimmed, isFallback: false };
  // No ownerGroup on file — treat this one address as its own independent
  // group rather than silently dropping it from resonance counting.
  return { ownerGroup: wallet.address.toLowerCase(), isFallback: true };
}

export function createResonanceDetector(deps: ResonanceDetectorDeps): ResonanceDetector {
  const config: ResonanceConfig = { ...DEFAULT_RESONANCE_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());
  const windows = new Map<number, WindowEntry[]>();
  const cooldowns = new Map<number, CooldownState>();

  const cleanupTimer = setInterval(() => {
    const nowDate = now();
    for (const [tokenId, entries] of [...windows.entries()]) {
      const pruned = pruneWindow(entries, nowDate, config.windowMinutes);
      if (pruned.length === 0) {
        windows.delete(tokenId);
      } else {
        windows.set(tokenId, pruned);
      }
    }
  }, deps.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return {
    async onWatchlistBuy(event) {
      const nowDate = now();
      const { ownerGroup, isFallback } = resolveOwnerGroup(event.wallet);
      if (isFallback) {
        deps.logger.warn(
          { wallet: event.wallet.address, name: event.wallet.name },
          "watchlist wallet has no ownerGroup set — treating it as its own independent group for resonance counting; assign a real ownerGroup to fix this",
        );
      }

      const existing = windows.get(event.tokenId) ?? [];
      const pruned = pruneWindow(existing, nowDate, config.windowMinutes);
      pruned.push({
        wallet: event.wallet.address.toLowerCase(),
        name: event.wallet.name,
        tier: event.wallet.tier,
        ownerGroup,
        ownerGroupIsFallback: isFallback,
        timestamp: event.timestamp,
        quoteAmount: event.quoteAmount,
      });
      windows.set(event.tokenId, pruned);

      const stats = computeWindowStats(pruned);
      const conditions = evaluateConditions(stats);
      if (conditions.length === 0) return;

      const cooldown = cooldowns.get(event.tokenId) ?? null;
      const decision = decideTrigger(conditions, stats, cooldown, nowDate, config.cooldownMinutes);
      if (!decision.shouldFire) return;

      cooldowns.set(event.tokenId, {
        lastTriggeredAt: nowDate,
        distinctOwnerGroups: stats.distinctOwnerGroups,
        hadTierA: stats.tierAOwnerGroups > 0,
      });

      const snapshot = deps.getMarketSnapshot?.(event.tokenId);

      const walletBreakdown = summarizeByWallet(pruned);

      let signalId: number;
      try {
        signalId = await deps.signalsRepo.create({
          tokenId: event.tokenId,
          triggeredAt: nowDate,
          triggerConditions: conditions,
          distinctOwnerGroups: stats.distinctOwnerGroups,
          tierACount: stats.tierAOwnerGroups,
          hasRepeatAccumulation: stats.hasRepeatAccumulation,
          windowMinutes: config.windowMinutes,
          escalation: decision.escalation,
          marketCap: snapshot?.marketCap ?? null,
          liquidity: snapshot?.liquidity ?? null,
          volume5m: snapshot?.volume5m ?? null,
        });
      } catch (err) {
        deps.logger.error({ err, token: event.tokenAddress }, "failed to persist resonance signal");
        return;
      }

      try {
        await deps.signalsRepo.addWallets(
          walletBreakdown.map((w) => ({
            signalId,
            walletAddress: w.wallet,
            walletName: w.name,
            tier: w.tier,
            ownerGroup: w.ownerGroup,
            buyCount: w.buyCount,
            buyAmount: w.buyAmount.toString(),
          })),
        );
      } catch (err) {
        deps.logger.error({ err, signalId, token: event.tokenAddress }, "failed to persist signal wallet breakdown");
      }

      deps.logger.info(
        {
          token: event.tokenAddress,
          symbol: event.tokenSymbol,
          conditions,
          distinctOwnerGroups: stats.distinctOwnerGroups,
          tierACount: stats.tierAOwnerGroups,
          hasRepeatAccumulation: stats.hasRepeatAccumulation,
          escalation: decision.escalation,
          windowMinutes: config.windowMinutes,
          wallets: walletBreakdown.map((w) => `${w.name} (Tier ${w.tier})`),
          marketCap: snapshot?.marketCap ?? null,
          liquidity: snapshot?.liquidity ?? null,
          volume5m: snapshot?.volume5m ?? null,
        },
        "resonance signal triggered — this is a detection trigger for review, not a buy recommendation",
      );
    },

    stop() {
      clearInterval(cleanupTimer);
    },

    getWindowEntryCount(tokenId) {
      return windows.get(tokenId)?.length ?? 0;
    },
  };
}

interface WalletBreakdown {
  wallet: string;
  name: string;
  tier: WalletTier;
  ownerGroup: string;
  buyCount: number;
  buyAmount: bigint;
}

function summarizeByWallet(entries: WindowEntry[]): WalletBreakdown[] {
  const byWallet = new Map<string, WalletBreakdown>();
  for (const entry of entries) {
    const existing = byWallet.get(entry.wallet);
    if (existing) {
      existing.buyCount += 1;
      existing.buyAmount += entry.quoteAmount;
    } else {
      byWallet.set(entry.wallet, {
        wallet: entry.wallet,
        name: entry.name,
        tier: entry.tier,
        ownerGroup: entry.ownerGroup,
        buyCount: 1,
        buyAmount: entry.quoteAmount,
      });
    }
  }
  return [...byWallet.values()];
}
