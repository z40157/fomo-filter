import { describe, expect, it, vi } from "vitest";
import { createDexScreenerClient } from "../src/market/dexscreener.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

// Real DexScreener response shape (BUNEE, chainId 4663), verified live on 2026-09-05.
function realPairResponse(overrides: Record<string, unknown> = {}) {
  return [
    {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: "0x8f4F723f10fc7bAD28742d25c91158C728557C4c",
      baseToken: { address: "0x055650555Be80649397084Cd3f8a09b4350e8612", name: "Bunee Madaf", symbol: "BUNEE" },
      quoteToken: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", name: "WETH", symbol: "WETH" },
      priceNative: "0.000000008574",
      priceUsd: "0.00002105",
      txns: { m5: { buys: 1, sells: 2 }, h1: { buys: 0, sells: 0 }, h6: { buys: 3, sells: 2 }, h24: { buys: 26, sells: 23 } },
      volume: { h24: 4114.7, h6: 820.03, h1: 12.5, m5: 3.2 },
      liquidity: { usd: 13464.02, base: 399698486, quote: 2.05678 },
      fdv: 21052,
      marketCap: 21052,
      pairCreatedAt: 1783980962000,
      ...overrides,
    },
  ];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("DexScreener client — response parsing", () => {
  it("extracts exactly the requested fields from a real-format response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(realPairResponse()));
    const client = createDexScreenerClient(fakeLogger(), { fetchImpl });

    const snapshot = await client.getTokenSnapshot("0x055650555Be80649397084Cd3f8a09b4350e8612");

    expect(snapshot).toEqual({
      tokenAddress: "0x055650555Be80649397084Cd3f8a09b4350e8612",
      priceUsd: 0.00002105,
      marketCap: 21052,
      fdv: 21052,
      liquidityUsd: 13464.02,
      volume5m: 3.2,
      volume1h: 12.5,
      buys5m: 1,
      sells5m: 2,
      fetchedAt: expect.any(Date),
    });
  });

  it("picks the pair with the deepest liquidity when multiple pairs are returned", async () => {
    const pairs = [
      ...realPairResponse({ liquidity: { usd: 500 }, priceUsd: "0.001" }),
      ...realPairResponse({ liquidity: { usd: 50000 }, priceUsd: "0.002" }),
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(pairs));
    const client = createDexScreenerClient(fakeLogger(), { fetchImpl });

    const snapshot = await client.getTokenSnapshot("0xsome");
    expect(snapshot?.liquidityUsd).toBe(50000);
    expect(snapshot?.priceUsd).toBe(0.002);
  });
});

describe("DexScreener client — token not found", () => {
  it("returns null (not 0 / not guessed) when DexScreener has no pair indexed yet", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createDexScreenerClient(fakeLogger(), { fetchImpl });

    const snapshot = await client.getTokenSnapshot("0xnotindexedyet");
    expect(snapshot).toBeNull();
  });
});

describe("DexScreener client — caching", () => {
  it("only calls the API once for repeated queries within the cache TTL", async () => {
    let currentTime = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(realPairResponse()));
    const client = createDexScreenerClient(fakeLogger(), {
      fetchImpl,
      cacheTtlMs: 15_000,
      now: () => currentTime,
    });

    await client.getTokenSnapshot("0xabc");
    currentTime += 5_000;
    await client.getTokenSnapshot("0xabc");
    currentTime += 5_000;
    await client.getTokenSnapshot("0xabc");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cache TTL has elapsed", async () => {
    let currentTime = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(realPairResponse()));
    const client = createDexScreenerClient(fakeLogger(), {
      fetchImpl,
      cacheTtlMs: 15_000,
      now: () => currentTime,
    });

    await client.getTokenSnapshot("0xabc");
    currentTime += 20_000;
    await client.getTokenSnapshot("0xabc");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("also caches a not-found (null) result, avoiding repeat calls for un-indexed tokens", async () => {
    let currentTime = 0;
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createDexScreenerClient(fakeLogger(), { fetchImpl, cacheTtlMs: 15_000, now: () => currentTime });

    await client.getTokenSnapshot("0xnew");
    currentTime += 1_000;
    await client.getTokenSnapshot("0xnew");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("DexScreener client — rate limiting", () => {
  it("waits for a slot once the per-minute limit is reached, instead of exceeding it", async () => {
    let currentTime = 0;
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      currentTime += ms; // simulate time passing while "asleep"
    });
    const fetchImpl = vi.fn(async () => jsonResponse(realPairResponse()));

    const client = createDexScreenerClient(fakeLogger(), {
      fetchImpl,
      cacheTtlMs: 0, // force every call to hit the limiter
      rateLimitPerMinute: 2,
      now: () => currentTime,
      sleep,
    });

    await client.getTokenSnapshot("0x1");
    await client.getTokenSnapshot("0x2");
    // third distinct call exceeds the 2-per-minute cap and must wait
    await client.getTokenSnapshot("0x3");

    expect(sleep).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("DexScreener client — retry with backoff", () => {
  it("retries on a 500 and succeeds once the API recovers", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt++;
      if (attempt < 3) return jsonResponse({}, 503);
      return jsonResponse(realPairResponse());
    });
    const sleep = vi.fn(async () => {});

    const client = createDexScreenerClient(fakeLogger(), { fetchImpl, sleep, maxAttempts: 3 });
    const snapshot = await client.getTokenSnapshot("0xflaky");

    expect(snapshot?.priceUsd).toBe(0.00002105);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and returns null rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const sleep = vi.fn(async () => {});
    const logger = fakeLogger();

    const client = createDexScreenerClient(logger, { fetchImpl, sleep, maxAttempts: 3 });
    const snapshot = await client.getTokenSnapshot("0xdead");

    expect(snapshot).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("DexScreener client — status", () => {
  it("reports 'ok' before any calls and after successful ones", async () => {
    const client = createDexScreenerClient(fakeLogger(), { fetchImpl: vi.fn(async () => jsonResponse([])) });
    expect(client.getStatus()).toBe("ok");
    await client.getTokenSnapshot("0xabc");
    expect(client.getStatus()).toBe("ok");
  });

  it("reports 'down' when every recent call has failed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const client = createDexScreenerClient(fakeLogger(), {
      fetchImpl,
      sleep: vi.fn(async () => {}),
      maxAttempts: 1,
    });

    await client.getTokenSnapshot("0x1");
    await client.getTokenSnapshot("0x2");

    expect(client.getStatus()).toBe("down");
  });

  it("does not count a valid 'not found' response as a failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createDexScreenerClient(fakeLogger(), { fetchImpl, cacheTtlMs: 0 });

    await client.getTokenSnapshot("0x1");
    await client.getTokenSnapshot("0x2");

    expect(client.getStatus()).toBe("ok");
  });
});
