// Ties the scheduling logic (candidateTrackerLogic.ts) and aggregate math
// (candidateAggregates.ts) to real DB/DexScreener I/O. Every token Phase 2
// discovers automatically enters tracking here — nothing else adds or
// removes a candidate.

import type { Logger } from "../logger.js";
import type { TokensRepo } from "../db/tokens.js";
import type { TradesRepo } from "../db/trades.js";
import type { TokenSnapshotsRepo } from "../db/tokenSnapshots.js";
import type { DexScreenerClient } from "./dexscreener.js";
import type { WatchlistCache } from "../watchlist/watchlistCache.js";
import {
  DEFAULT_TRACKER_CONFIG,
  isDueForRefresh,
  shouldExitTracking,
  type CandidateState,
  type TrackerConfig,
} from "./candidateTrackerLogic.js";
import { computeRepeatBuyerCount, computeWatchedAggregates } from "./candidateAggregates.js";

const DEFAULT_TICK_INTERVAL_MS = 5_000;

export interface CandidateAggregateState {
  tokenId: number;
  ageMs: number;
  watchedWalletBuyCount: number;
  independentOwnerCount: number;
  aggregateWatchedBuyUsd: number;
  aggregateWatchedSellUsd: number;
  repeatBuyerCount: number;
  computedAt: Date;
}

export interface LatestMarketSnapshot {
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
}

export interface CandidateTrackerDeps {
  tokensRepo: TokensRepo;
  tradesRepo: TradesRepo;
  snapshotsRepo: TokenSnapshotsRepo;
  dexscreener: DexScreenerClient;
  watchlistCache: WatchlistCache;
  logger: Logger;
  config?: Partial<TrackerConfig>;
  /** How often the internal loop checks which candidates are due. Default 5s — independent of the per-candidate refresh cadence. */
  tickIntervalMs?: number;
}

export interface CandidateTracker {
  start(): Promise<void>;
  stop(): void;
  getActiveCandidateCount(): number;
  getAggregateState(tokenId: number): CandidateAggregateState | undefined;
  /** The most recent DexScreener market data seen for this token, if any — for signals/resonanceDetector.ts to attach to a triggered signal. */
  getLatestMarketSnapshot(tokenId: number): LatestMarketSnapshot | undefined;
}

export function createCandidateTracker(deps: CandidateTrackerDeps): CandidateTracker {
  const config: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG, ...deps.config };
  const candidates = new Map<number, CandidateState>();
  const aggregateState = new Map<number, CandidateAggregateState>();
  const latestMarketSnapshots = new Map<number, LatestMarketSnapshot>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function discoverNewCandidates(): Promise<void> {
    const tokens = await deps.tokensRepo.listAll();
    const now = new Date();
    for (const token of tokens) {
      if (!candidates.has(token.id)) {
        candidates.set(token.id, {
          tokenId: token.id,
          address: token.address,
          launchTime: token.launchTime,
          trackingStartedAt: now,
          lastRefreshAt: null,
          lastTradeAt: null,
        });
      }
    }
  }

  async function refreshLastTradeTimes(): Promise<void> {
    const tokenIds = [...candidates.keys()];
    if (tokenIds.length === 0) return;
    const lastTrades = await deps.tradesRepo.lastTradeAtByToken(tokenIds);
    for (const [tokenId, candidate] of candidates) {
      const lastAt = lastTrades.get(tokenId);
      if (lastAt) candidate.lastTradeAt = lastAt;
    }
  }

  async function refreshCandidate(candidate: CandidateState, now: Date): Promise<void> {
    const snapshot = await deps.dexscreener.getTokenSnapshot(candidate.address);
    if (snapshot) {
      await deps.snapshotsRepo.insert({
        tokenId: candidate.tokenId,
        price: snapshot.priceUsd,
        marketCap: snapshot.marketCap,
        liquidity: snapshot.liquidityUsd,
        volume5m: snapshot.volume5m,
        volume1h: snapshot.volume1h,
        buys5m: snapshot.buys5m,
        sells5m: snapshot.sells5m,
        snapshotAt: now,
      });
      latestMarketSnapshots.set(candidate.tokenId, {
        marketCap: snapshot.marketCap,
        liquidity: snapshot.liquidityUsd,
        volume5m: snapshot.volume5m,
      });
    } else {
      deps.logger.debug({ token: candidate.address }, "no DexScreener data yet — skipping snapshot write");
    }

    const watchlistAddresses = deps.watchlistCache.entries().map((entry) => entry.address);
    const [watchlistTrades, buyCountsByWallet] = await Promise.all([
      deps.tradesRepo.listByTokenAndWallets(candidate.tokenId, watchlistAddresses),
      deps.tradesRepo.countBuysByWallet(candidate.tokenId),
    ]);

    const watched = computeWatchedAggregates(watchlistTrades, (address) => deps.watchlistCache.lookup(address));
    aggregateState.set(candidate.tokenId, {
      tokenId: candidate.tokenId,
      ageMs: now.getTime() - candidate.launchTime.getTime(),
      ...watched,
      repeatBuyerCount: computeRepeatBuyerCount(buyCountsByWallet),
      computedAt: now,
    });
  }

  async function tick(): Promise<void> {
    await discoverNewCandidates();
    await refreshLastTradeTimes();
    const now = new Date();

    for (const [tokenId, candidate] of [...candidates.entries()]) {
      if (isDueForRefresh(candidate, now, config)) {
        try {
          await refreshCandidate(candidate, now);
        } catch (err) {
          deps.logger.error({ err, token: candidate.address }, "failed to refresh candidate");
        }
        candidate.lastRefreshAt = now;
      }

      if (shouldExitTracking(candidate, now, config)) {
        candidates.delete(tokenId);
        aggregateState.delete(tokenId);
        latestMarketSnapshots.delete(tokenId);
        deps.logger.info(
          { token: candidate.address },
          "candidate exited tracking (past minimum duration with no recent activity)",
        );
      }
    }
  }

  return {
    async start() {
      await discoverNewCandidates();
      timer = setInterval(() => {
        tick().catch((err: unknown) => {
          deps.logger.error({ err }, "candidate tracker tick failed");
        });
      }, deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
      timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    getActiveCandidateCount() {
      return candidates.size;
    },

    getAggregateState(tokenId) {
      return aggregateState.get(tokenId);
    },

    getLatestMarketSnapshot(tokenId) {
      return latestMarketSnapshots.get(tokenId);
    },
  };
}
