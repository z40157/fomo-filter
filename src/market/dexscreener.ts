// DexScreener client — the only external market-data source in V1.
//
// Verified live on 2026-09-05 (not guessed from docs, which don't show
// Robinhood Chain's own identifier):
//   curl 'https://api.dexscreener.com/latest/dex/search?q=<a real BUNEE address>'
// returned `"chainId":"robinhood"` with a pair address matching exactly
// what Phase 3 already independently discovered on-chain — confirming
// both the chain slug and that DexScreener has real coverage of this chain.
//
// Endpoint used: GET /tokens/v1/{chainId}/{tokenAddress} — per
// docs.dexscreener.com/api/reference.md, this and every other listed
// endpoint (including /token-pairs/v1 and /latest/dex/search) share one
// documented limit: "60 requests per minute". No API key is required or
// mentioned anywhere in the docs.
//
// Verified response shape (real BUNEE/SEXCOIN/MOLLIE queries): the
// endpoint returns a JSON ARRAY of pair objects directly (not wrapped in
// `{pairs: [...]}` the way /latest/dex/search is), and an unindexed token
// returns HTTP 200 with an empty array `[]` — never a 404 — which is how
// we detect "not yet indexed" rather than treating it as an error.

import { ExponentialBackoff } from "../chain/backoff.js";
import type { Logger } from "../logger.js";

const API_BASE_URL = "https://api.dexscreener.com";
export const ROBINHOOD_DEXSCREENER_CHAIN_ID = "robinhood";

// DexScreener's documented limit is 60/min; we cap ourselves lower to
// leave real headroom rather than ride the edge of their limit.
const DEFAULT_RATE_LIMIT_PER_MINUTE = 50;
const RATE_LIMIT_WINDOW_MS = 60_000;

const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const STATUS_HISTORY_SIZE = 20;

export interface DexScreenerSnapshot {
  tokenAddress: string;
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  volume5m: number | null;
  volume1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  fetchedAt: Date;
}

export type DexScreenerStatus = "ok" | "degraded" | "down";

export interface DexScreenerClient {
  /** Null means "no data" — token not indexed yet, or the request ultimately failed. Never fabricated as 0. */
  getTokenSnapshot(tokenAddress: string): Promise<DexScreenerSnapshot | null>;
  /** Rolling health of recent real API calls (not cache hits, not "token not found" responses — those aren't failures). */
  getStatus(): DexScreenerStatus;
}

interface RawTxnWindow {
  buys?: number;
  sells?: number;
}

interface RawPair {
  liquidity?: { usd?: number };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  volume?: { m5?: number; h1?: number };
  txns?: { m5?: RawTxnWindow };
}

/** Sliding-window limiter: blocks `acquire()` until a slot opens, rather than dropping/erroring requests. */
class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxPerWindow) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0]!;
      await this.sleep(this.windowMs - (now - oldest) + 10);
    }
  }
}

function pickDeepestLiquidityPair(pairs: RawPair[]): RawPair | undefined {
  if (pairs.length === 0) return undefined;
  return pairs.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best));
}

function toSnapshot(tokenAddress: string, pair: RawPair, fetchedAt: Date): DexScreenerSnapshot {
  const priceUsd = pair.priceUsd !== undefined ? Number(pair.priceUsd) : null;
  return {
    tokenAddress,
    priceUsd: priceUsd !== null && Number.isFinite(priceUsd) ? priceUsd : null,
    marketCap: typeof pair.marketCap === "number" ? pair.marketCap : null,
    fdv: typeof pair.fdv === "number" ? pair.fdv : null,
    liquidityUsd: typeof pair.liquidity?.usd === "number" ? pair.liquidity.usd : null,
    volume5m: typeof pair.volume?.m5 === "number" ? pair.volume.m5 : null,
    volume1h: typeof pair.volume?.h1 === "number" ? pair.volume.h1 : null,
    buys5m: typeof pair.txns?.m5?.buys === "number" ? pair.txns.m5.buys : null,
    sells5m: typeof pair.txns?.m5?.sells === "number" ? pair.txns.m5.sells : null,
    fetchedAt,
  };
}

export interface DexScreenerClientOptions {
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createDexScreenerClient(logger: Logger, options: DexScreenerClientOptions = {}): DexScreenerClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const rateLimiter = new SlidingWindowRateLimiter(
    options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
    RATE_LIMIT_WINDOW_MS,
    now,
    sleep,
  );

  const cache = new Map<string, { snapshot: DexScreenerSnapshot | null; expiresAt: number }>();
  // true = a real API call that got a valid HTTP response (found or not-found both count); false = it ultimately failed.
  const recentOutcomes: boolean[] = [];

  function recordOutcome(ok: boolean): void {
    recentOutcomes.push(ok);
    if (recentOutcomes.length > STATUS_HISTORY_SIZE) recentOutcomes.shift();
  }

  async function fetchFromApi(tokenAddress: string): Promise<DexScreenerSnapshot | null> {
    await rateLimiter.acquire();
    const backoff = new ExponentialBackoff({ initialMs: 1_000, maxMs: 10_000, factor: 2 });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(
          `${API_BASE_URL}/tokens/v1/${ROBINHOOD_DEXSCREENER_CHAIN_ID}/${tokenAddress}`,
          { signal: controller.signal },
        );
        clearTimeout(timeoutId);

        if (response.status === 429 || response.status >= 500) {
          if (attempt === maxAttempts) {
            logger.warn({ tokenAddress, status: response.status }, "DexScreener request failed after retries");
            recordOutcome(false);
            return null;
          }
          await sleep(backoff.next());
          continue;
        }

        if (!response.ok) {
          logger.warn({ tokenAddress, status: response.status }, "DexScreener returned an unexpected status");
          recordOutcome(false);
          return null;
        }

        const pairs = (await response.json()) as RawPair[];
        recordOutcome(true);
        const best = pickDeepestLiquidityPair(pairs);
        if (!best) {
          logger.debug({ tokenAddress }, "DexScreener has no pair indexed for this token yet");
          return null;
        }
        return toSnapshot(tokenAddress, best, new Date(now()));
      } catch (err) {
        clearTimeout(timeoutId);
        if (attempt === maxAttempts) {
          logger.warn({ err, tokenAddress }, "DexScreener request errored after retries");
          recordOutcome(false);
          return null;
        }
        await sleep(backoff.next());
      }
    }
    return null;
  }

  return {
    async getTokenSnapshot(tokenAddress) {
      const key = tokenAddress.toLowerCase();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        return cached.snapshot;
      }
      const snapshot = await fetchFromApi(tokenAddress);
      cache.set(key, { snapshot, expiresAt: now() + cacheTtlMs });
      return snapshot;
    },

    getStatus() {
      if (recentOutcomes.length === 0) return "ok";
      const failureRate = recentOutcomes.filter((ok) => !ok).length / recentOutcomes.length;
      if (failureRate >= 1) return "down";
      if (failureRate > 0.2) return "degraded";
      return "ok";
    },
  };
}
