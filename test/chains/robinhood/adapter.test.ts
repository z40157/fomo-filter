import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { createRobinhoodAdapter } from "../../../src/chains/robinhood/adapter.js";
import type { HttpClient, WsClient } from "../../../src/chain/client.js";
import { createLogger } from "../../../src/logger.js";
import { DOPPLER_CREATE_EVENT, PONS_TOKEN_LAUNCHED_EVENT } from "../../../src/chain/newTokenDetector.js";
import { DOPPLER_SWAP_EVENT, DOPPLER_MODIFY_LIQUIDITY_EVENT } from "../../../src/chain/tradeDetector.js";

/** Always-valid 40-hex-char address from a short seed — avoids miscounted
 * hand-typed hex literals throughout this file. */
function addr(seed: string): `0x${string}` {
  return `0x${seed.padStart(40, "0")}` as `0x${string}`;
}

const AIRLOCK = addr("a1");
const FACTORY = addr("fa");
const NATIVE_QUOTE = addr("0"); // native ETH sentinel — all-zero address

interface FakeWatch {
  address: string | string[];
  event: unknown;
  onLogs: (logs: unknown[]) => void;
  onError: (err: Error) => void;
}

/** Records every watchEvent registration so a test can push fake logs into
 * it and assert on subscribe/unsubscribe churn — stands in for a real WSS
 * connection (spec B6: "RH launch WSS" / "RH trade WSS/batching fallback" /
 * "RH holder dynamic-address subscription"). */
function fakeWsClient(watches: FakeWatch[]): WsClient {
  return {
    watchEvent: (args: FakeWatch) => {
      watches.push(args);
      return vi.fn();
    },
  } as unknown as WsClient;
}

function fakeHttpClient(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}): HttpClient {
  return {
    getTransaction: async ({ hash }: { hash: string }) => ({ from: addr("d10"), to: null, hash }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: 1_700_000_000n + blockNumber,
      hash: `0xblock${blockNumber}` as const,
    }),
    getTransactionReceipt: async () => ({ logs: [] }),
    getBalance: async () => 1_000_000n,
    getBlockNumber: async () => 500n,
    getLogs: async () => [],
    readContract: async () => null,
    ...overrides,
  } as unknown as HttpClient;
}

const logger = createLogger("silent");

describe("createRobinhoodAdapter — launch discovery", () => {
  it("subscribes both Doppler Create and Pons TokenLaunched, and normalizes a Doppler launch", async () => {
    const watches: FakeWatch[] = [];
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
    });

    const onLaunch = vi.fn();
    await adapter.startLaunchDiscovery(onLaunch);

    expect(watches).toHaveLength(2);
    expect(watches[0]?.event).toBe(DOPPLER_CREATE_EVENT);
    expect(watches[1]?.event).toBe(PONS_TOKEN_LAUNCHED_EVENT);

    const asset = addr("aa1");
    watches[0]?.onLogs([
      {
        args: { asset, numeraire: NATIVE_QUOTE, initializer: addr("111"), poolOrHook: addr("1001") },
        transactionHash: "0xtx1",
        blockNumber: 100n,
      },
    ]);

    await vi.waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    const event = onLaunch.mock.calls[0][0];
    expect(event.chain).toBe("robinhood");
    expect(event.source).toBe("doppler");
    expect(event.tokenAddress).toBe(asset);
    expect(event.creator).toBe(addr("d10"));
    expect(event.launchBlockNumber).toBe(100n);
  });

  it("normalizes a Pons launch using the event's own deployer field (no extra RPC call)", async () => {
    const watches: FakeWatch[] = [];
    const getTransaction = vi.fn();
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient({ getTransaction }),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
    });

    const onLaunch = vi.fn();
    await adapter.startLaunchDiscovery(onLaunch);

    const token = addr("bb1");
    const deployer = addr("d20");
    watches[1]?.onLogs([
      {
        args: {
          token,
          deployer,
          dexFactory: FACTORY,
          pairToken: NATIVE_QUOTE,
          pool: addr("9001"),
          dexId: 1n,
          launchConfigId: 1n,
          positionId: 1n,
          restrictionsEndBlock: 1n,
          initialBuyAmount: 1n,
        },
        transactionHash: "0xtx2",
        blockNumber: 200n,
      },
    ]);

    await vi.waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(onLaunch.mock.calls[0][0].creator).toBe(deployer);
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

describe("createRobinhoodAdapter — trade feed", () => {
  async function launchOneDoppler(adapter: ReturnType<typeof createRobinhoodAdapter>, watches: FakeWatch[]) {
    const onLaunch = vi.fn();
    await adapter.startLaunchDiscovery(onLaunch);
    const asset = addr("aa1");
    watches[0]?.onLogs([
      {
        args: { asset, numeraire: NATIVE_QUOTE, initializer: addr("111"), poolOrHook: addr("1001") },
        transactionHash: "0xtx1",
        blockNumber: 100n,
      },
    ]);
    await vi.waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    return asset;
  }

  it("subscribes Doppler Swap+ModifyLiquidity on the initializer address and classifies a BUY", async () => {
    const watches: FakeWatch[] = [];
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
      resubscribeIntervalMs: 100_000, // don't let the interval fire mid-test
    });
    const asset = await launchOneDoppler(adapter, watches);

    const onTrade = vi.fn();
    await adapter.startHotTradeFeed(() => [asset], onTrade);

    const tradeWatches = watches.filter((w) => w.event === DOPPLER_SWAP_EVENT || w.event === DOPPLER_MODIFY_LIQUIDITY_EVENT);
    expect(tradeWatches).toHaveLength(2);

    const modifyWatch = watches.find((w) => w.event === DOPPLER_MODIFY_LIQUIDITY_EVENT)!;
    const [currency0, currency1] = BigInt(asset) < BigInt(NATIVE_QUOTE) ? [asset, NATIVE_QUOTE] : [NATIVE_QUOTE, asset];
    const poolKey = { currency0, currency1, fee: 8388608, tickSpacing: 60, hooks: addr("1001") };
    modifyWatch.onLogs([{ args: { key: poolKey, params: { tickLower: 0, tickUpper: 0, liquidityDelta: 0n, salt: "0x0" } } }]);

    const swapWatch = watches.find((w) => w.event === DOPPLER_SWAP_EVENT)!;
    const assetIsCurrency0 = currency0.toLowerCase() === asset.toLowerCase();
    const POOL_KEY_ABI_PARAM = {
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    } as const;
    const poolId = keccak256(encodeAbiParameters([POOL_KEY_ABI_PARAM], [poolKey]));

    swapWatch.onLogs([
      {
        args: {
          sender: addr("5e1"),
          poolId,
          params: { zeroForOne: true, amountSpecified: 0n, sqrtPriceLimitX96: 0n },
          amount0: assetIsCurrency0 ? 500n : -200n,
          amount1: assetIsCurrency0 ? -200n : 500n,
          hookData: "0x",
        },
        blockNumber: 105n,
        transactionHash: "0xswaptx1",
        logIndex: 3,
      },
    ]);

    await vi.waitFor(() => expect(onTrade).toHaveBeenCalledTimes(1));
    const trade = onTrade.mock.calls[0][0];
    expect(trade.side).toBe("BUY");
    expect(trade.tokenAddress).toBe(asset);
    expect(trade.tokenAmount).toBe(500n);
  });

  it("resubscribes only when the hot address set actually changes", async () => {
    const watches: FakeWatch[] = [];
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
      resubscribeIntervalMs: 5,
    });
    const asset = await launchOneDoppler(adapter, watches);

    let hot: string[] = [asset];
    await adapter.startHotTradeFeed(() => hot, vi.fn());
    const countAfterFirst = watches.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Same address set — refresh() must be a no-op (spec A.3 dynamic
    // subscription refresh should not tear down/rebuild an unchanged set).
    await new Promise((r) => setTimeout(r, 30));
    expect(watches.length).toBe(countAfterFirst);

    // Address set drops to empty — must unsubscribe (no new watch entries
    // since there's nothing left to watch).
    hot = [];
    await new Promise((r) => setTimeout(r, 30));
    expect(watches.length).toBe(countAfterFirst);

    // A different, non-empty set — must resubscribe (new watch entries).
    const otherAsset = addr("cc1");
    watches[0]?.onLogs([
      {
        args: { asset: otherAsset, numeraire: NATIVE_QUOTE, initializer: addr("222"), poolOrHook: addr("2002") },
        transactionHash: "0xtx3",
        blockNumber: 300n,
      },
    ]);
    hot = [otherAsset];
    await new Promise((r) => setTimeout(r, 30));
    expect(watches.length).toBeGreaterThan(countAfterFirst);

    await adapter.stopHotTradeFeed();
  });
});

describe("createRobinhoodAdapter — WS reconnect recovery (B1.8)", () => {
  it("backfills the gap via a bounded getLogs call before resuming the live subscription", async () => {
    const watches: FakeWatch[] = [];
    const getLogs = vi.fn(async () => []);
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient({ getLogs, getBlockNumber: async () => 500n }),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
      resubscribeIntervalMs: 100_000,
    });

    // Launch discovery sees a log at block 100 -> lastKnownBlock becomes 100.
    const onLaunch = vi.fn();
    await adapter.startLaunchDiscovery(onLaunch);
    const asset = addr("aa1");
    watches[0]?.onLogs([
      {
        args: { asset, numeraire: NATIVE_QUOTE, initializer: addr("init1"), poolOrHook: addr("hook1") },
        transactionHash: "0xtx1",
        blockNumber: 100n,
      },
    ]);
    await vi.waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));

    // Starting the trade feed now (chain head is 500 per the mock) should
    // trigger a gap backfill for blocks 101-500 on the Doppler swap event,
    // before/alongside the live subscription resuming.
    await adapter.startHotTradeFeed(() => [asset], vi.fn());

    await vi.waitFor(() => expect(getLogs).toHaveBeenCalled());
    const call = getLogs.mock.calls.find(([args]) => (args as { fromBlock?: bigint }).fromBlock === 101n);
    expect(call).toBeDefined();
    const args = call![0] as { fromBlock: bigint; toBlock: bigint };
    expect(args.toBlock).toBe(500n);

    await adapter.stopHotTradeFeed();
  });

  it("forces a resubscribe on the next timer tick when a live watch errors, even if the address set is unchanged", async () => {
    const watches: FakeWatch[] = [];
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
      resubscribeIntervalMs: 10,
    });
    const token = addr("701");
    await adapter.startHolderFeed!(() => [token], vi.fn());
    const countBefore = watches.length;

    const holderWatch = watches.find((w) => w.event !== DOPPLER_CREATE_EVENT && w.event !== PONS_TOKEN_LAUNCHED_EVENT)!;
    holderWatch.onError(new Error("connection reset"));

    await new Promise((r) => setTimeout(r, 30));
    expect(watches.length).toBeGreaterThan(countBefore);

    await adapter.stopHolderFeed!();
  });
});

describe("createRobinhoodAdapter — holder feed", () => {
  it("subscribes ERC20 Transfer directly on token addresses and normalizes events", async () => {
    const watches: FakeWatch[] = [];
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
      resubscribeIntervalMs: 100_000,
    });

    const token = addr("701");
    const onTransfer = vi.fn();
    await adapter.startHolderFeed!(() => [token], onTransfer);

    const holderWatch = watches.find((w) => w.event !== DOPPLER_CREATE_EVENT && w.event !== PONS_TOKEN_LAUNCHED_EVENT);
    expect(holderWatch).toBeDefined();
    expect(holderWatch!.address).toEqual([token]);

    const from = addr("f01");
    const to = addr("701a");
    holderWatch!.onLogs([
      { address: token, args: { from, to, value: 42n }, blockNumber: 10n, transactionHash: "0xtxfer", logIndex: 1 },
    ]);

    expect(onTransfer).toHaveBeenCalledTimes(1);
    expect(onTransfer.mock.calls[0][0]).toMatchObject({ tokenAddress: token, amount: 42n, from, to });
  });

  it("backfillHolderTransfers does a one-time chunked getLogs from launchBlock, not a live subscription (A.13 step 2)", async () => {
    const getLogs = vi.fn(async () => [
      { address: addr("701"), args: { from: addr("f01"), to: addr("701a"), value: 7n }, blockNumber: 50n, transactionHash: "0xbackfill1", logIndex: 0 },
    ]);
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient({ getLogs, getBlockNumber: async () => 60n }),
      createWsClient: () => fakeWsClient([]),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
    });

    const token = addr("701");
    const onTransfer = vi.fn();
    await adapter.backfillHolderTransfers!(token, 10n, onTransfer);

    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: token, fromBlock: 10n, toBlock: 60n }));
    expect(onTransfer).toHaveBeenCalledTimes(1);
    expect(onTransfer.mock.calls[0][0]).toMatchObject({ tokenAddress: token, amount: 7n });
  });
});

describe("createRobinhoodAdapter — honesty (never fabricate PASS/liquidityUsd)", () => {
  it("simulateSellability returns UNKNOWN with a real reason, never a fabricated PASS/FAIL", async () => {
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient([]),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
    });
    const result = await adapter.simulateSellability(addr("abc1"), [100, 500]);
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.estimatedExitSlippagePctByUsd).toEqual({ 100: null, 500: null });
  });

  it("getLiquiditySnapshot never guesses a USD value it can't compute on-chain", async () => {
    const watches: FakeWatch[] = [];
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient(watches),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
    });
    const onLaunch = vi.fn();
    await adapter.startLaunchDiscovery(onLaunch);
    const asset = addr("aa1");
    watches[0]?.onLogs([
      {
        args: { asset, numeraire: NATIVE_QUOTE, initializer: addr("111"), poolOrHook: addr("1001") },
        transactionHash: "0xtx1",
        blockNumber: 100n,
      },
    ]);
    await vi.waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));

    const snapshot = await adapter.getLiquiditySnapshot(asset);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.liquidityUsd).toBeNull();
    expect(snapshot!.liquidityNative).toBe(1_000_000n);
    expect(snapshot!.source).toBe("onchain");
  });
});

describe("createRobinhoodAdapter — describeSources", () => {
  it("reports the fixed protocol-level launch sources", () => {
    const adapter = createRobinhoodAdapter({
      httpClient: fakeHttpClient(),
      createWsClient: () => fakeWsClient([]),
      dopplerAirlockAddress: AIRLOCK,
      ponsV1FactoryAddress: FACTORY,
      logger,
    });
    const sources = adapter.describeSources();
    expect(sources).toContainEqual({ source: "doppler", role: "airlock", address: AIRLOCK, eventName: "Create" });
    expect(sources).toContainEqual({ source: "pons_v1", role: "factory", address: FACTORY, eventName: "TokenLaunched" });
  });
});
