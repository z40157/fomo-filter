import { describe, expect, it, vi } from "vitest";
import { ChainWatcher, type MinimalHttpClient, type MinimalWsClient } from "../src/chain/watcher.js";
import type { ScannerStateRepo } from "../src/db/scannerState.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeRepo(initial: { lastProcessedBlock: bigint } | null): ScannerStateRepo & {
  saveState: ReturnType<typeof vi.fn>;
} {
  let state = initial;
  return {
    getState: vi.fn(async () => state),
    saveState: vi.fn(async (_chainId: number, block: bigint) => {
      state = { lastProcessedBlock: block };
    }),
  };
}

describe("ChainWatcher persistence", () => {
  it("on first-ever startup, persists the current head and does not backfill", async () => {
    const repo = fakeRepo(null);
    const getBlock = vi.fn();
    const httpClient: MinimalHttpClient = {
      getBlockNumber: vi.fn(async () => 100n),
      getBlock,
    };
    const wsClient: MinimalWsClient = { watchBlockNumber: () => () => {} };

    const watcher = new ChainWatcher({
      chainId: 4663,
      httpClient,
      createWsClient: () => wsClient,
      scannerStateRepo: repo,
      logger: fakeLogger(),
    });

    await watcher.start();

    expect(getBlock).not.toHaveBeenCalled();
    expect(repo.saveState).toHaveBeenCalledWith(4663, 100n);
    expect(watcher.getStatus().lastBlock).toBe(100n);
  });

  it("persists lastProcessedBlock as new blocks arrive over the ws subscription", async () => {
    const repo = fakeRepo(null);
    const httpClient: MinimalHttpClient = {
      getBlockNumber: vi.fn(async () => 100n),
      getBlock: vi.fn(),
    };
    let handlers: Parameters<MinimalWsClient["watchBlockNumber"]>[0] | undefined;
    const wsClient: MinimalWsClient = {
      watchBlockNumber: (h) => {
        handlers = h;
        return () => {};
      },
    };

    const watcher = new ChainWatcher({
      chainId: 4663,
      httpClient,
      createWsClient: () => wsClient,
      scannerStateRepo: repo,
      logger: fakeLogger(),
    });

    await watcher.start();
    expect(handlers).toBeDefined();

    handlers?.onBlockNumber(101n);
    await Promise.resolve();
    await Promise.resolve();

    expect(repo.saveState).toHaveBeenCalledWith(4663, 101n);
    expect(watcher.getStatus()).toEqual({ wsConnected: true, lastBlock: 101n });
  });
});

describe("ChainWatcher restart recovery / backfill", () => {
  it("fetches every missing block and persists the new chain head", async () => {
    const repo = fakeRepo({ lastProcessedBlock: 100n });
    const getBlock = vi.fn<MinimalHttpClient["getBlock"]>(async () => ({}));
    const httpClient: MinimalHttpClient = {
      getBlockNumber: vi.fn(async () => 105n),
      getBlock,
    };
    const wsClient: MinimalWsClient = { watchBlockNumber: () => () => {} };

    const watcher = new ChainWatcher({
      chainId: 4663,
      httpClient,
      createWsClient: () => wsClient,
      scannerStateRepo: repo,
      logger: fakeLogger(),
    });

    await watcher.start();

    const fetchedBlocks = getBlock.mock.calls.map((call) => call[0]?.blockNumber);
    expect(fetchedBlocks).toEqual([101n, 102n, 103n, 104n, 105n]);
    expect(repo.saveState).toHaveBeenCalledWith(4663, 105n);
    expect(watcher.getStatus().lastBlock).toBe(105n);
  });

  it("skips backfill entirely when already caught up", async () => {
    const repo = fakeRepo({ lastProcessedBlock: 100n });
    const getBlock = vi.fn();
    const httpClient: MinimalHttpClient = {
      getBlockNumber: vi.fn(async () => 100n),
      getBlock,
    };
    const wsClient: MinimalWsClient = { watchBlockNumber: () => () => {} };

    const watcher = new ChainWatcher({
      chainId: 4663,
      httpClient,
      createWsClient: () => wsClient,
      scannerStateRepo: repo,
      logger: fakeLogger(),
    });

    await watcher.start();

    expect(getBlock).not.toHaveBeenCalled();
    expect(repo.saveState).not.toHaveBeenCalled();
    expect(watcher.getStatus().lastBlock).toBe(100n);
  });
});

describe("ChainWatcher ws reconnect", () => {
  it("reconnects with exponentially increasing backoff and resets on success", async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo(null);
      const httpClient: MinimalHttpClient = {
        getBlockNumber: vi.fn(async () => 100n),
        getBlock: vi.fn(),
      };

      let connectCount = 0;
      const handlersByConnection: Array<Parameters<MinimalWsClient["watchBlockNumber"]>[0]> = [];
      const createWsClient = (): MinimalWsClient => {
        connectCount += 1;
        return {
          watchBlockNumber: (h) => {
            handlersByConnection.push(h);
            return () => {};
          },
        };
      };

      const watcher = new ChainWatcher({
        chainId: 4663,
        httpClient,
        createWsClient,
        scannerStateRepo: repo,
        logger: fakeLogger(),
        backoffOptions: { initialMs: 1000, maxMs: 60000, factor: 2 },
      });

      await watcher.start();
      expect(connectCount).toBe(1);

      // First disconnect -> reconnect after 1s
      handlersByConnection[0]?.onError(new Error("socket closed"));
      expect(watcher.getStatus().wsConnected).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      expect(connectCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectCount).toBe(2);

      // Second disconnect before ever reconnecting successfully -> 2s
      handlersByConnection[1]?.onError(new Error("socket closed again"));
      await vi.advanceTimersByTimeAsync(1999);
      expect(connectCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectCount).toBe(3);

      // A successful block resets the backoff
      handlersByConnection[2]?.onBlockNumber(101n);
      expect(watcher.getStatus().wsConnected).toBe(true);

      handlersByConnection[2]?.onError(new Error("socket closed once more"));
      await vi.advanceTimersByTimeAsync(999);
      expect(connectCount).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectCount).toBe(4); // back to 1s delay, not 4s
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ChainWatcher onBlockRange resilience", () => {
  it("still persists lastProcessedBlock for a live block even if onBlockRange throws", async () => {
    const repo = fakeRepo(null);
    const httpClient: MinimalHttpClient = {
      getBlockNumber: vi.fn(async () => 100n),
      getBlock: vi.fn(),
    };
    let handlers: Parameters<MinimalWsClient["watchBlockNumber"]>[0] | undefined;
    const wsClient: MinimalWsClient = {
      watchBlockNumber: (h) => {
        handlers = h;
        return () => {};
      },
    };
    const logger = fakeLogger();
    const onBlockRange = vi.fn(async () => {
      throw new Error("detector RPC method not supported on this plan");
    });

    const watcher = new ChainWatcher({
      chainId: 4663,
      httpClient,
      createWsClient: () => wsClient,
      scannerStateRepo: repo,
      logger,
      onBlockRange,
    });

    await watcher.start();
    handlers?.onBlockNumber(101n);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onBlockRange).toHaveBeenCalledWith(101n, 101n);
    expect(repo.saveState).toHaveBeenCalledWith(4663, 101n);
    expect(watcher.getStatus().lastBlock).toBe(101n);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: "101", toBlock: "101" }),
      "onBlockRange hook failed — continuing block tracking regardless",
    );
  });

  it("does not fail restart recovery if onBlockRange throws during backfill", async () => {
    const repo = fakeRepo({ lastProcessedBlock: 100n });
    const httpClient: MinimalHttpClient = {
      getBlockNumber: vi.fn(async () => 102n),
      getBlock: vi.fn(async () => ({})),
    };
    const wsClient: MinimalWsClient = { watchBlockNumber: () => () => {} };
    const onBlockRange = vi.fn(async () => {
      throw new Error("eth_getLogs not supported");
    });

    const watcher = new ChainWatcher({
      chainId: 4663,
      httpClient,
      createWsClient: () => wsClient,
      scannerStateRepo: repo,
      logger: fakeLogger(),
      onBlockRange,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    expect(repo.saveState).toHaveBeenCalledWith(4663, 102n);
    expect(watcher.getStatus().lastBlock).toBe(102n);
  });
});
