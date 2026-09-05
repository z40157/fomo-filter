// Background usd_value backfill for the trades table (left null by Phase
// 3). Runs on its own timer, entirely decoupled from the chain
// watcher/trade-detection pipeline — a slow or failing enrichment pass must
// never hold up real-time trade recording.

import type { Logger } from "../logger.js";
import type { TradesRepo } from "../db/trades.js";
import type { TokenSnapshotsRepo } from "../db/tokenSnapshots.js";
import { resolveTokenDecimals, type MinimalReadClient } from "../chain/erc20.js";

const DEFAULT_BATCH_SIZE = 200;
// Don't use a snapshot older than this relative to the trade — a stale
// price is not meaningfully different from guessing.
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000;

export interface DecimalsResolver {
  resolveDecimals(tokenAddress: string): Promise<number | null>;
}

export function createErc20DecimalsResolver(client: MinimalReadClient, logger: Logger): DecimalsResolver {
  return {
    resolveDecimals(tokenAddress) {
      return resolveTokenDecimals(client, tokenAddress as `0x${string}`, logger);
    },
  };
}

export interface UsdEnrichmentDeps {
  tradesRepo: TradesRepo;
  snapshotsRepo: TokenSnapshotsRepo;
  decimalsResolver: DecimalsResolver;
  logger: Logger;
  batchSize?: number;
  maxSnapshotAgeMs?: number;
}

export interface UsdEnrichmentResult {
  updated: number;
  skippedNoSnapshot: number;
  skippedNoDecimals: number;
}

export interface UsdEnrichmentJob {
  runOnce(): Promise<UsdEnrichmentResult>;
  start(intervalMs: number): void;
  stop(): void;
}

/** tokenAmount is a raw base-unit integer string; decimals converts it to human units before multiplying by a USD price. */
export function computeUsdValue(tokenAmountRaw: string, decimals: number, priceUsd: number): number {
  const tokenAmount = Number(BigInt(tokenAmountRaw)) / 10 ** decimals;
  return tokenAmount * priceUsd;
}

export function createUsdEnrichmentJob(deps: UsdEnrichmentDeps): UsdEnrichmentJob {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxSnapshotAgeMs = deps.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  // decimals() never changes for a token — cache for the process lifetime.
  // A null (failed lookup) is retried on the next run rather than cached,
  // since a fresh launch's decimals() call can be transiently flaky.
  const decimalsCache = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function resolveDecimalsCached(tokenAddress: string): Promise<number | null> {
    const cached = decimalsCache.get(tokenAddress.toLowerCase());
    if (cached !== undefined) return cached;
    const decimals = await deps.decimalsResolver.resolveDecimals(tokenAddress);
    if (decimals !== null) decimalsCache.set(tokenAddress.toLowerCase(), decimals);
    return decimals;
  }

  async function runOnce(): Promise<UsdEnrichmentResult> {
    const pending = await deps.tradesRepo.listPendingUsdValue(batchSize);
    let updated = 0;
    let skippedNoSnapshot = 0;
    let skippedNoDecimals = 0;

    for (const trade of pending) {
      const snapshot = await deps.snapshotsRepo.findNearestPriceBefore(
        trade.tokenId,
        trade.timestamp,
        maxSnapshotAgeMs,
      );
      if (!snapshot) {
        skippedNoSnapshot++;
        continue;
      }

      const decimals = await resolveDecimalsCached(trade.tokenAddress);
      if (decimals === null) {
        skippedNoDecimals++;
        continue;
      }

      const usdValue = computeUsdValue(trade.tokenAmount, decimals, snapshot.price);
      await deps.tradesRepo.setUsdValue(trade.id, usdValue);
      updated++;
    }

    deps.logger.debug(
      { updated, skippedNoSnapshot, skippedNoDecimals, batchSize: pending.length },
      "usd enrichment pass complete",
    );
    return { updated, skippedNoSnapshot, skippedNoDecimals };
  }

  return {
    runOnce,

    start(intervalMs) {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err: unknown) => {
          deps.logger.error({ err }, "usd enrichment pass failed");
        });
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
