import { describe, expect, it, vi } from "vitest";
import {
  chunkBlockRange,
  createNewTokenDetector,
  type DecodedLog,
  type DetectorHttpClient,
  type DopplerCreateArgs,
  type PonsTokenLaunchedArgs,
} from "../src/chain/newTokenDetector.js";
import type { NewToken, TokensRepo } from "../src/db/tokens.js";
import type { Logger } from "../src/logger.js";

const DOPPLER_ADDRESS = "0xd0dd1e00000000000000000000000000000001" as const;
const PONS_ADDRESS = "0xf0f5000000000000000000000000000000002" as const;

const ASSET = "0x1111111111111111111111111111111111111a" as const;
const NUMERAIRE = "0x2222222222222222222222222222222222222b" as const;
const INITIALIZER = "0x3333333333333333333333333333333333333c" as const;
const POOL_OR_HOOK = "0x4444444444444444444444444444444444444d" as const;
const DEPLOYER_FROM_TX = "0x5555555555555555555555555555555555555e" as const;
const TX_HASH = "0xaaaa111111111111111111111111111111111111111111111111111111aa" as const;

const PONS_TOKEN = "0x6666666666666666666666666666666666666f" as const;
const PONS_DEPLOYER = "0x7777777777777777777777777777777777777a" as const;
const PONS_DEX_FACTORY = "0x8888888888888888888888888888888888888b" as const;
const PONS_PAIR = "0x9999999999999999999999999999999999999c" as const;
const PONS_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad" as const;
const PONS_TX_HASH = "0xbbbb222222222222222222222222222222222222222222222222222222bb" as const;

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeTokensRepo(): TokensRepo & { rows: Map<string, NewToken> } {
  const rows = new Map<string, NewToken>();
  return {
    rows,
    async insertIfNew(token) {
      if (rows.has(token.address)) {
        return false;
      }
      rows.set(token.address, token);
      return true;
    },
    async countTokens() {
      return rows.size;
    },
    async listAll() {
      return [];
    },
    async setPoolId() {
      // not exercised by these tests
    },
  };
}

function dopplerLog(overrides: Partial<DecodedLog<DopplerCreateArgs>> = {}): DecodedLog<DopplerCreateArgs> {
  return {
    args: {
      asset: ASSET,
      numeraire: NUMERAIRE,
      initializer: INITIALIZER,
      poolOrHook: POOL_OR_HOOK,
    },
    blockNumber: 100n,
    transactionHash: TX_HASH,
    ...overrides,
  };
}

function ponsLog(overrides: Partial<DecodedLog<PonsTokenLaunchedArgs>> = {}): DecodedLog<PonsTokenLaunchedArgs> {
  return {
    args: {
      token: PONS_TOKEN,
      deployer: PONS_DEPLOYER,
      dexFactory: PONS_DEX_FACTORY,
      pairToken: PONS_PAIR,
      pool: PONS_POOL,
      dexId: 0n,
      launchConfigId: 0n,
      positionId: 673450n,
      restrictionsEndBlock: 25741081n,
      initialBuyAmount: 46000000000000000n,
    },
    blockNumber: 200n,
    transactionHash: PONS_TX_HASH,
    ...overrides,
  };
}

describe("chunkBlockRange", () => {
  it("splits a wide range into inclusive chunks no wider than chunkSize", () => {
    expect(chunkBlockRange(100n, 112n, 5n)).toEqual([
      { fromBlock: 100n, toBlock: 104n },
      { fromBlock: 105n, toBlock: 109n },
      { fromBlock: 110n, toBlock: 112n },
    ]);
  });

  it("returns a single chunk when the range already fits", () => {
    expect(chunkBlockRange(100n, 100n, 5n)).toEqual([{ fromBlock: 100n, toBlock: 100n }]);
  });
});

describe("NewTokenDetector — Doppler Create parsing", () => {
  it("maps a Create log to a token row, resolving deployer from the launch tx sender", async () => {
    const repo = fakeTokensRepo();
    const logger = fakeLogger();
    const httpClient: DetectorHttpClient = {
      getDopplerCreateLogs: vi.fn(async () => [dopplerLog()]),
      getPonsTokenLaunchedLogs: vi.fn(async () => []),
      getTransactionSender: vi.fn(async () => DEPLOYER_FROM_TX),
      getBlockTimestamp: vi.fn(async () => 1_700_000_000n),
      readTokenMetadata: vi.fn(async () => ({ name: "Test Token", symbol: "TEST" })),
    };

    const detector = createNewTokenDetector({
      dopplerAirlockAddress: DOPPLER_ADDRESS,
      ponsV1FactoryAddress: PONS_ADDRESS,
      httpClient,
      tokensRepo: repo,
      logger,
    });

    await detector.processBlockRange(100n, 100n);

    expect(repo.rows.size).toBe(1);
    const token = repo.rows.get(ASSET);
    expect(token).toMatchObject({
      address: ASSET,
      launchSource: "doppler",
      deployer: DEPLOYER_FROM_TX,
      pairToken: NUMERAIRE,
      pool: POOL_OR_HOOK,
      symbol: "TEST",
      name: "Test Token",
      launchBlock: 100n,
      launchTx: TX_HASH,
    });
    expect(token?.launchTime).toEqual(new Date(1_700_000_000 * 1000));
    expect(httpClient.getTransactionSender).toHaveBeenCalledWith(TX_HASH);

    expect(logger.info).toHaveBeenCalledWith(
      { launchSource: "doppler", address: ASSET, deployer: DEPLOYER_FROM_TX, pairToken: NUMERAIRE },
      "new token detected",
    );
  });
});

describe("NewTokenDetector — Pons V1 TokenLaunched parsing", () => {
  it("maps a TokenLaunched log to a token row using the deployer already in the event", async () => {
    const repo = fakeTokensRepo();
    const logger = fakeLogger();
    const httpClient: DetectorHttpClient = {
      getDopplerCreateLogs: vi.fn(async () => []),
      getPonsTokenLaunchedLogs: vi.fn(async () => [ponsLog()]),
      getTransactionSender: vi.fn(async (): Promise<`0x${string}`> => "0x0000000000000000000000000000000000dead"),
      getBlockTimestamp: vi.fn(async () => 1_700_100_000n),
      readTokenMetadata: vi.fn(async () => ({ name: "Pons Token", symbol: "PNS" })),
    };

    const detector = createNewTokenDetector({
      dopplerAirlockAddress: DOPPLER_ADDRESS,
      ponsV1FactoryAddress: PONS_ADDRESS,
      httpClient,
      tokensRepo: repo,
      logger,
    });

    await detector.processBlockRange(200n, 200n);

    expect(repo.rows.size).toBe(1);
    const token = repo.rows.get(PONS_TOKEN);
    expect(token).toMatchObject({
      address: PONS_TOKEN,
      launchSource: "pons_v1",
      deployer: PONS_DEPLOYER,
      pairToken: PONS_PAIR,
      pool: PONS_POOL,
      symbol: "PNS",
      name: "Pons Token",
      launchBlock: 200n,
      launchTx: PONS_TX_HASH,
    });
    // Pons's TokenLaunched event already carries `deployer` — no tx lookup needed.
    expect(httpClient.getTransactionSender).not.toHaveBeenCalled();

    expect(logger.info).toHaveBeenCalledWith(
      { launchSource: "pons_v1", address: PONS_TOKEN, deployer: PONS_DEPLOYER, pairToken: PONS_PAIR },
      "new token detected",
    );
  });
});

describe("NewTokenDetector — duplicate address handling", () => {
  it("does not insert the same token address twice or double-log it", async () => {
    const repo = fakeTokensRepo();
    const logger = fakeLogger();
    const httpClient: DetectorHttpClient = {
      getDopplerCreateLogs: vi.fn(async () => [dopplerLog()]),
      getPonsTokenLaunchedLogs: vi.fn(async () => []),
      getTransactionSender: vi.fn(async () => DEPLOYER_FROM_TX),
      getBlockTimestamp: vi.fn(async () => 1_700_000_000n),
      readTokenMetadata: vi.fn(async () => ({ name: "Test Token", symbol: "TEST" })),
    };

    const detector = createNewTokenDetector({
      dopplerAirlockAddress: DOPPLER_ADDRESS,
      ponsV1FactoryAddress: PONS_ADDRESS,
      httpClient,
      tokensRepo: repo,
      logger,
    });

    // Simulate the same launch log being observed twice (e.g. overlapping
    // restart-recovery windows) — the unique `address` constraint means
    // the second pass must be a no-op.
    await detector.processBlockRange(100n, 100n);
    await detector.processBlockRange(100n, 100n);

    expect(repo.rows.size).toBe(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith({ address: ASSET }, "token already tracked, skipping duplicate");
  });
});

describe("NewTokenDetector — RPC log-range chunking", () => {
  it("fetches logs in chunks no wider than the configured RPC block-range cap", async () => {
    const repo = fakeTokensRepo();
    const logger = fakeLogger();
    const getDopplerCreateLogs = vi.fn(async () => []);
    const getPonsTokenLaunchedLogs = vi.fn(async () => []);
    const httpClient: DetectorHttpClient = {
      getDopplerCreateLogs,
      getPonsTokenLaunchedLogs,
      getTransactionSender: vi.fn(),
      getBlockTimestamp: vi.fn(),
      readTokenMetadata: vi.fn(),
    };

    const detector = createNewTokenDetector({
      dopplerAirlockAddress: DOPPLER_ADDRESS,
      ponsV1FactoryAddress: PONS_ADDRESS,
      httpClient,
      tokensRepo: repo,
      logger,
      maxLogsBlockRange: 5n,
    });

    await detector.processBlockRange(100n, 112n);

    expect(getDopplerCreateLogs).toHaveBeenCalledTimes(3);
    expect(getDopplerCreateLogs).toHaveBeenNthCalledWith(1, {
      address: DOPPLER_ADDRESS,
      fromBlock: 100n,
      toBlock: 104n,
    });
    expect(getDopplerCreateLogs).toHaveBeenNthCalledWith(3, {
      address: DOPPLER_ADDRESS,
      fromBlock: 110n,
      toBlock: 112n,
    });
    expect(getPonsTokenLaunchedLogs).toHaveBeenCalledTimes(3);
  });
});
