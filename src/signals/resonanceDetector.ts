// Ties resonanceLogic.ts's pure math to real state: an in-memory sliding
// window per token, cooldown tracking, DB persistence, and logging. Also
// orchestrates Phase 7 scoring (importance/risk/confidence) once a signal
// fires — see signals/scoring.ts and signals/risk.ts for the actual rules.
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
import { computeConfidence, computeImportanceScore, type SnapshotPoint } from "./scoring.js";
import { computeRisk } from "./risk.js";
import { formatUsd } from "../format.js";
import type { AlertDispatcher, AlertDispatchInput } from "../alerts/alertDispatcher.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const RECENT_SNAPSHOTS_FOR_TREND = 5;

export interface MarketSnapshot {
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
  buys5m: number | null;
  sells5m: number | null;
}

export interface WatchedFlowState {
  aggregateWatchedBuyUsd: number;
  aggregateWatchedSellUsd: number;
  repeatBuyerCount: number;
}

export interface WatchlistBuyEvent {
  tokenId: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenPairToken: string;
  tokenDeployer: string;
  tokenLaunchTime: Date;
  wallet: WalletEntry;
  /** Raw on-chain integer quote amount for this BUY (already absolute-valued). */
  quoteAmount: bigint;
  timestamp: Date;
}

export interface ResonanceDetectorDeps {
  signalsRepo: SignalsRepo;
  logger: Logger;
  config?: Partial<ResonanceConfig>;
  /** Pulls the latest known DexScreener data for a token from candidateTracker's in-memory state — undefined if none is available yet. */
  getMarketSnapshot?: (tokenId: number) => MarketSnapshot | undefined;
  /** Pulls the current watchlist flow aggregate from candidateTracker's in-memory state (Phase 5) — undefined if not computed yet. */
  getWatchedFlowState?: (tokenId: number) => WatchedFlowState | undefined;
  /** Oldest-first recent market snapshots, for the Acceleration dimension's trend calculation. */
  getRecentSnapshots?: (tokenId: number, limit: number) => Promise<SnapshotPoint[]>;
  /** All-time BUY/SELL counts for the token across all traders. */
  getTradeTotals?: (tokenId: number) => Promise<{ buys: number; sells: number }>;
  /** Has this token's deployer ever sold it? Null if undeterminable. */
  hasDeployerSold?: (tokenId: number, deployer: string) => Promise<boolean | null>;
  /** Largest single SELL (usd) up to `before`, within `windowMinutes` — null if none qualify. */
  getLargestRecentSellUsd?: (tokenId: number, before: Date, windowMinutes: number) => Promise<number | null>;
  /** Latest manually-set narrative boost (0-1) for the token, or null. */
  getNarrativeBoost?: (tokenId: number) => Promise<number | null>;
  /** The quote/pair token's ERC-20 symbol for display in alerts (e.g. "WETH"), given the token's pairToken address. Null when it can't be resolved (e.g. the native-currency sentinel). Expected to be cached upstream. */
  getQuoteTokenSymbol?: (pairToken: string) => Promise<string | null>;
  /** Lowercased official Robinhood stock-token addresses, from config/stockTokens.json. Empty by default. */
  officialStockTokens?: ReadonlySet<string>;
  /** Phase 8: fires email/Telegram alerts for signals that clear the importance threshold and dedup rules — undefined means alerting is off entirely (never crashes or blocks signal persistence either way). */
  alertDispatcher?: AlertDispatcher;
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
  const officialStockTokens = deps.officialStockTokens ?? new Set<string>();

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

      const walletBreakdown = summarizeByWallet(pruned);

      // --- Gather everything Phase 7 scoring needs -----------------------
      const marketSnapshot = deps.getMarketSnapshot?.(event.tokenId);
      const flowState = deps.getWatchedFlowState?.(event.tokenId) ?? {
        aggregateWatchedBuyUsd: 0,
        aggregateWatchedSellUsd: 0,
        repeatBuyerCount: 0,
      };
      const [recentSnapshots, tradeTotals, hasDeployerSold, largestRecentSellUsd, narrativeBoost, quoteTokenSymbol] =
        await Promise.all([
          deps.getRecentSnapshots?.(event.tokenId, RECENT_SNAPSHOTS_FOR_TREND) ?? Promise.resolve([]),
          deps.getTradeTotals?.(event.tokenId) ?? Promise.resolve({ buys: 0, sells: 0 }),
          deps.hasDeployerSold?.(event.tokenId, event.tokenDeployer) ?? Promise.resolve(null),
          deps.getLargestRecentSellUsd?.(event.tokenId, nowDate, config.windowMinutes) ?? Promise.resolve(null),
          deps.getNarrativeBoost?.(event.tokenId) ?? Promise.resolve(null),
          deps.getQuoteTokenSymbol?.(event.tokenPairToken) ?? Promise.resolve(null),
        ]);

      const ageMs = nowDate.getTime() - event.tokenLaunchTime.getTime();
      const hasUsdFlowData = flowState.aggregateWatchedBuyUsd > 0 || flowState.aggregateWatchedSellUsd > 0;

      const { score: importanceScore, breakdown: scoreBreakdown } = computeImportanceScore({
        distinctOwnerGroups: stats.distinctOwnerGroups,
        tierAOwnerGroups: stats.tierAOwnerGroups,
        flow: flowState,
        acceleration: {
          volume5m: marketSnapshot?.volume5m ?? null,
          buys5m: marketSnapshot?.buys5m ?? null,
          sells5m: marketSnapshot?.sells5m ?? null,
          recentSnapshots,
        },
        marketQuality: {
          liquidity: marketSnapshot?.liquidity ?? null,
          marketCap: marketSnapshot?.marketCap ?? null,
          totalBuys: tradeTotals.buys,
          totalSells: tradeTotals.sells,
        },
        narrative: {
          pairTokenAddress: event.tokenPairToken,
          officialStockTokens,
          narrativeBoost,
        },
        ageMs,
      });

      const { level: riskLevel, breakdown: riskBreakdown } = computeRisk({
        liquidity: marketSnapshot?.liquidity ?? null,
        marketCap: marketSnapshot?.marketCap ?? null,
        ageMs,
        buys5m: marketSnapshot?.buys5m ?? null,
        sells5m: marketSnapshot?.sells5m ?? null,
        largestRecentSellUsd,
        aggregateWatchedBuyUsd: flowState.aggregateWatchedBuyUsd,
        aggregateWatchedSellUsd: flowState.aggregateWatchedSellUsd,
        hasDeployerSold,
      });

      const fallbackOwnerGroupCount = walletBreakdown.filter((w) => w.ownerGroupIsFallback).length;
      const { level: confidenceLevel, reasons: confidenceReasons } = computeConfidence({
        hasMarketData: marketSnapshot !== undefined,
        snapshotCount: recentSnapshots.length,
        hasUsdFlowData,
        fallbackOwnerGroupCount,
        ageMs,
      });

      // --- Persist ---------------------------------------------------------
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
          marketCap: marketSnapshot?.marketCap ?? null,
          liquidity: marketSnapshot?.liquidity ?? null,
          volume5m: marketSnapshot?.volume5m ?? null,
          importanceScore,
          scoreBreakdown,
          riskLevel,
          riskBreakdown,
          confidence: confidenceLevel,
          confidenceReasons,
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
          marketCap: marketSnapshot?.marketCap ?? null,
          liquidity: marketSnapshot?.liquidity ?? null,
          volume5m: marketSnapshot?.volume5m ?? null,
          importanceScore,
          riskLevel,
          confidence: confidenceLevel,
        },
        "resonance signal triggered — this is a detection trigger for review, not a buy recommendation",
      );

      // Human-readable multi-line summary, for reading straight off a terminal.
      const netFlow = flowState.aggregateWatchedBuyUsd - flowState.aggregateWatchedSellUsd;
      const bsRatio5m =
        marketSnapshot?.buys5m != null && marketSnapshot.sells5m != null && marketSnapshot.sells5m > 0
          ? `${(marketSnapshot.buys5m / marketSnapshot.sells5m).toFixed(1)}:1`
          : "unknown";
      const mcLiqRatio =
        marketSnapshot?.marketCap != null && marketSnapshot.liquidity ? (marketSnapshot.marketCap / marketSnapshot.liquidity).toFixed(2) : "unknown";
      const summaryLines = [
        `[SIGNAL] ${event.tokenSymbol ?? event.tokenAddress} ${importanceScore.toFixed(1)}/10 | Risk: ${riskLevel} | Confidence: ${confidenceLevel}`,
        `  Resonance ${scoreBreakdown.resonance.score.toFixed(1)}/${scoreBreakdown.resonance.max} (${stats.distinctOwnerGroups} ownerGroups, ${stats.tierAOwnerGroups} Tier A)`,
        `  Flow ${scoreBreakdown.flow.score.toFixed(1)}/${scoreBreakdown.flow.max} (net ${netFlow >= 0 ? "+" : "-"}${formatUsd(Math.abs(netFlow))}, ${flowState.repeatBuyerCount} repeat buyers)`,
        `  Acceleration ${scoreBreakdown.acceleration.score.toFixed(1)}/${scoreBreakdown.acceleration.max} (5m vol ${marketSnapshot?.volume5m != null ? formatUsd(marketSnapshot.volume5m) : "unknown"}, buy/sell ${bsRatio5m})`,
        `  Market Quality ${scoreBreakdown.marketQuality.score.toFixed(1)}/${scoreBreakdown.marketQuality.max} (liq ${marketSnapshot?.liquidity != null ? formatUsd(marketSnapshot.liquidity) : "unknown"}, mc/liq ${mcLiqRatio})`,
        `  Narrative ${scoreBreakdown.narrative.score.toFixed(1)}/${scoreBreakdown.narrative.max} (${scoreBreakdown.narrative.reasons.join("; ")})`,
        `  Earlyness ${scoreBreakdown.earlyness.score.toFixed(1)}/${scoreBreakdown.earlyness.max} (age ${(ageMs / 60_000).toFixed(0)}min)`,
      ];
      deps.logger.info(summaryLines.join("\n"));

      // Phase 8: email/Telegram alerting — entirely best-effort. dispatch()
      // already catches everything internally, but the extra guard here
      // means even a misbehaving test double or future refactor can never
      // turn an alert failure into a lost/blocked signal.
      const alertInput: AlertDispatchInput = {
        signalId,
        tokenId: event.tokenId,
        tokenAddress: event.tokenAddress,
        tokenSymbol: event.tokenSymbol,
        tokenName: event.tokenName,
        quoteTokenSymbol: quoteTokenSymbol ?? null,
        ageMs,
        triggerConditions: conditions,
        windowMinutes: config.windowMinutes,
        distinctOwnerGroups: stats.distinctOwnerGroups,
        tierACount: stats.tierAOwnerGroups,
        hasRepeatAccumulation: stats.hasRepeatAccumulation,
        marketCap: marketSnapshot?.marketCap ?? null,
        liquidity: marketSnapshot?.liquidity ?? null,
        volume5m: marketSnapshot?.volume5m ?? null,
        buys5m: marketSnapshot?.buys5m ?? null,
        sells5m: marketSnapshot?.sells5m ?? null,
        aggregateWatchedBuyUsd: flowState.aggregateWatchedBuyUsd,
        aggregateWatchedSellUsd: flowState.aggregateWatchedSellUsd,
        repeatBuyerCount: flowState.repeatBuyerCount,
        importanceScore,
        scoreBreakdown,
        riskLevel,
        riskBreakdown,
        confidence: confidenceLevel,
        confidenceReasons,
        wallets: walletBreakdown.map((w) => ({
          address: w.wallet,
          name: w.name,
          tier: w.tier,
          buyAmount: w.buyAmount,
          buyCount: w.buyCount,
        })),
      };
      try {
        await deps.alertDispatcher?.dispatch(alertInput);
      } catch (err) {
        deps.logger.error({ err, signalId, token: event.tokenAddress }, "alert dispatch threw unexpectedly — signal itself is already safely persisted");
      }
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
  ownerGroupIsFallback: boolean;
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
        ownerGroupIsFallback: entry.ownerGroupIsFallback,
        buyCount: 1,
        buyAmount: entry.quoteAmount,
      });
    }
  }
  return [...byWallet.values()];
}
