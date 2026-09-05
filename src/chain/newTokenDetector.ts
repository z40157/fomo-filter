import { parseAbiItem } from "viem";
import type { Logger } from "../logger.js";
import type { NewToken, TokensRepo } from "../db/tokens.js";
import type { HttpClient } from "./client.js";
import { resolveTokenMetadata } from "./erc20.js";

// Verified against github.com/whetstoneresearch/doppler (Airlock.sol) and
// confirmed live on-chain (chainId 4663) via Blockscout's ABI-based log
// decoder — the token/pool address is `asset`/`poolOrHook`, there is no
// `deployer` field, so deployer is resolved from the launch tx's sender.
export const DOPPLER_CREATE_EVENT = parseAbiItem(
  "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)",
);

// Verified against github.com/ponsdotdev/ponsfamily (contractsV1/src/PonsLaunchFactory.sol)
// and confirmed live on-chain. launchToken() also emits an earlier
// `TokenDeployed` event without a pool address — we only need
// `TokenLaunched`, which fires once the pool exists and carries everything.
export const PONS_TOKEN_LAUNCHED_EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
);

export interface DopplerCreateArgs {
  asset: `0x${string}`;
  numeraire: `0x${string}`;
  initializer: `0x${string}`;
  poolOrHook: `0x${string}`;
}

export interface PonsTokenLaunchedArgs {
  token: `0x${string}`;
  deployer: `0x${string}`;
  dexFactory: `0x${string}`;
  pairToken: `0x${string}`;
  pool: `0x${string}`;
  dexId: bigint;
  launchConfigId: bigint;
  positionId: bigint;
  restrictionsEndBlock: bigint;
  initialBuyAmount: bigint;
}

export interface DecodedLog<TArgs> {
  args: TArgs;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

/** Minimal, hand-shaped RPC surface the detector needs — kept independent
 * of viem's generic client types so it stays easy to mock in tests. */
export interface DetectorHttpClient {
  getDopplerCreateLogs: (args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<DecodedLog<DopplerCreateArgs>[]>;
  getPonsTokenLaunchedLogs: (args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<DecodedLog<PonsTokenLaunchedArgs>[]>;
  getTransactionSender: (hash: `0x${string}`) => Promise<`0x${string}`>;
  getBlockTimestamp: (blockNumber: bigint) => Promise<bigint>;
  readTokenMetadata: (
    tokenAddress: `0x${string}`,
  ) => Promise<{ name: string | null; symbol: string | null }>;
}

/** Wraps a real viem PublicClient into the minimal shape above. */
export function createDetectorHttpClient(client: HttpClient, logger: Logger): DetectorHttpClient {
  return {
    async getDopplerCreateLogs({ address, fromBlock, toBlock }) {
      const logs = await client.getLogs({
        address,
        event: DOPPLER_CREATE_EVENT,
        fromBlock,
        toBlock,
      });
      // getLogs({ event }) always decodes every named param for a matched
      // log; viem's parseAbiItem inference just can't prove that statically.
      return logs.map((log) => ({
        args: log.args as DopplerCreateArgs,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      }));
    },

    async getPonsTokenLaunchedLogs({ address, fromBlock, toBlock }) {
      const logs = await client.getLogs({
        address,
        event: PONS_TOKEN_LAUNCHED_EVENT,
        fromBlock,
        toBlock,
      });
      return logs.map((log) => ({
        args: log.args as PonsTokenLaunchedArgs,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      }));
    },

    async getTransactionSender(hash) {
      const tx = await client.getTransaction({ hash });
      return tx.from;
    },

    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      return block.timestamp;
    },

    async readTokenMetadata(tokenAddress) {
      return resolveTokenMetadata(client, tokenAddress, logger);
    },
  };
}

export interface BlockChunk {
  fromBlock: bigint;
  toBlock: bigint;
}

/** Splits [fromBlock, toBlock] into inclusive chunks no wider than
 * `chunkSize` — this RPC's plan caps `eth_getLogs` at a 5-block range. */
export function chunkBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): BlockChunk[] {
  const chunks: BlockChunk[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    chunks.push({ fromBlock: start, toBlock: end });
  }
  return chunks;
}

export interface NewTokenDetectorDeps {
  dopplerAirlockAddress: `0x${string}`;
  ponsV1FactoryAddress: `0x${string}`;
  httpClient: DetectorHttpClient;
  tokensRepo: TokensRepo;
  logger: Logger;
  /** Max block span per getLogs call. Default 5 (QuickNode's plan limit for this chain). */
  maxLogsBlockRange?: bigint;
}

export interface NewTokenDetector {
  processBlockRange: (fromBlock: bigint, toBlock: bigint) => Promise<void>;
}

export function createNewTokenDetector(deps: NewTokenDetectorDeps): NewTokenDetector {
  const chunkSize = deps.maxLogsBlockRange ?? 5n;

  async function recordToken(token: NewToken): Promise<void> {
    const inserted = await deps.tokensRepo.insertIfNew(token);
    if (inserted) {
      deps.logger.info(
        {
          launchSource: token.launchSource,
          address: token.address,
          deployer: token.deployer,
          pairToken: token.pairToken,
        },
        "new token detected",
      );
    } else {
      deps.logger.debug({ address: token.address }, "token already tracked, skipping duplicate");
    }
  }

  async function handleDopplerLog(log: DecodedLog<DopplerCreateArgs>): Promise<void> {
    try {
      const [deployer, timestamp, metadata] = await Promise.all([
        deps.httpClient.getTransactionSender(log.transactionHash),
        deps.httpClient.getBlockTimestamp(log.blockNumber),
        deps.httpClient.readTokenMetadata(log.args.asset),
      ]);

      await recordToken({
        address: log.args.asset,
        symbol: metadata.symbol,
        name: metadata.name,
        launchSource: "doppler",
        deployer,
        pairToken: log.args.numeraire,
        pool: log.args.poolOrHook,
        launchBlock: log.blockNumber,
        launchTime: new Date(Number(timestamp) * 1000),
        launchTx: log.transactionHash,
      });
    } catch (err) {
      deps.logger.error(
        { err, tx: log.transactionHash },
        "failed to process Doppler Create log",
      );
    }
  }

  async function handlePonsLog(log: DecodedLog<PonsTokenLaunchedArgs>): Promise<void> {
    try {
      const [timestamp, metadata] = await Promise.all([
        deps.httpClient.getBlockTimestamp(log.blockNumber),
        deps.httpClient.readTokenMetadata(log.args.token),
      ]);

      await recordToken({
        address: log.args.token,
        symbol: metadata.symbol,
        name: metadata.name,
        launchSource: "pons_v1",
        deployer: log.args.deployer,
        pairToken: log.args.pairToken,
        pool: log.args.pool,
        launchBlock: log.blockNumber,
        launchTime: new Date(Number(timestamp) * 1000),
        launchTx: log.transactionHash,
      });
    } catch (err) {
      deps.logger.error({ err, tx: log.transactionHash }, "failed to process Pons TokenLaunched log");
    }
  }

  async function processDoppler(fromBlock: bigint, toBlock: bigint): Promise<void> {
    for (const chunk of chunkBlockRange(fromBlock, toBlock, chunkSize)) {
      const logs = await deps.httpClient.getDopplerCreateLogs({
        address: deps.dopplerAirlockAddress,
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
      });
      for (const log of logs) {
        await handleDopplerLog(log);
      }
    }
  }

  async function processPons(fromBlock: bigint, toBlock: bigint): Promise<void> {
    for (const chunk of chunkBlockRange(fromBlock, toBlock, chunkSize)) {
      const logs = await deps.httpClient.getPonsTokenLaunchedLogs({
        address: deps.ponsV1FactoryAddress,
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
      });
      for (const log of logs) {
        await handlePonsLog(log);
      }
    }
  }

  return {
    async processBlockRange(fromBlock, toBlock) {
      await Promise.all([processDoppler(fromBlock, toBlock), processPons(fromBlock, toBlock)]);
    },
  };
}
