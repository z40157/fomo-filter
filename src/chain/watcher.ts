import type { Logger } from "../logger.js";
import { ExponentialBackoff, type BackoffOptions } from "./backoff.js";
import { computeBackfillRange } from "./recovery.js";
import type { ScannerStateRepo } from "../db/scannerState.js";

/** Minimal surface of viem's PublicClient this module depends on — keeps
 * the watcher testable without constructing a real viem client. */
export interface MinimalHttpClient {
  getBlockNumber: () => Promise<bigint>;
  getBlock: (args: { blockNumber: bigint }) => Promise<unknown>;
}

export interface MinimalWsClient {
  watchBlockNumber: (args: {
    onBlockNumber: (blockNumber: bigint) => void;
    onError: (error: Error) => void;
    emitMissed?: boolean;
  }) => () => void;
}

export interface WatcherDeps {
  chainId: number;
  httpClient: MinimalHttpClient;
  createWsClient: () => MinimalWsClient;
  scannerStateRepo: ScannerStateRepo;
  logger: Logger;
  backoffOptions?: Partial<BackoffOptions>;
  /** How many blocks to fetch concurrently during backfill. Default 10. */
  backfillBatchSize?: number;
  /**
   * Called with every block range the watcher has just fetched — once per
   * live block (fromBlock === toBlock) and once per restart-recovery
   * backfill batch. Lets other modules (e.g. the new-token detector) piggy
   * back on the same block pipeline instead of running a second WS
   * subscription with its own reconnect logic. Awaited before the range is
   * marked processed in scanner_state.
   */
  onBlockRange?: (fromBlock: bigint, toBlock: bigint) => Promise<void>;
}

export interface WatcherStatus {
  wsConnected: boolean;
  lastBlock: bigint | null;
}

export class ChainWatcher {
  private readonly deps: WatcherDeps;
  private readonly backoff: ExponentialBackoff;
  private wsConnected = false;
  private lastProcessedBlock: bigint | null = null;
  private unwatch: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(deps: WatcherDeps) {
    this.deps = deps;
    this.backoff = new ExponentialBackoff(deps.backoffOptions);
  }

  getStatus(): WatcherStatus {
    return { wsConnected: this.wsConnected, lastBlock: this.lastProcessedBlock };
  }

  async start(): Promise<void> {
    await this.recover();
    this.connectWs();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
  }

  private async recover(): Promise<void> {
    const state = await this.deps.scannerStateRepo.getState(this.deps.chainId);
    const currentBlock = await this.deps.httpClient.getBlockNumber();
    const priorBlock = state?.lastProcessedBlock ?? null;
    const range = computeBackfillRange(priorBlock, currentBlock);

    if (range === null) {
      this.lastProcessedBlock = priorBlock ?? currentBlock;
      if (priorBlock === null) {
        this.deps.logger.info(
          { chainId: this.deps.chainId, block: this.lastProcessedBlock.toString() },
          "no prior scanner_state found, starting from chain head",
        );
        await this.persist(this.lastProcessedBlock);
      }
      return;
    }

    this.deps.logger.info(
      { fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString() },
      "restart recovery: backfilling missed blocks",
    );
    await this.backfill(range.fromBlock, range.toBlock);
    await this.runOnBlockRange(range.fromBlock, range.toBlock);
    this.lastProcessedBlock = range.toBlock;
    await this.persist(this.lastProcessedBlock);
    this.deps.logger.info(
      { fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString() },
      "restart recovery: backfill complete",
    );
  }

  private async backfill(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const batchSize = BigInt(this.deps.backfillBatchSize ?? 10);
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = start + batchSize - 1n > toBlock ? toBlock : start + batchSize - 1n;
      const blockNumbers: bigint[] = [];
      for (let b = start; b <= end; b++) {
        blockNumbers.push(b);
      }
      await Promise.all(
        blockNumbers.map((blockNumber) => this.deps.httpClient.getBlock({ blockNumber })),
      );
    }
  }

  private connectWs(): void {
    if (this.stopped) {
      return;
    }
    const client = this.deps.createWsClient();
    this.unwatch = client.watchBlockNumber({
      emitMissed: false,
      onBlockNumber: (blockNumber) => {
        if (!this.wsConnected) {
          this.wsConnected = true;
          this.backoff.reset();
          this.deps.logger.info({ chainId: this.deps.chainId }, "ws connected");
        }
        this.handleNewBlock(blockNumber);
      },
      onError: (error) => {
        this.deps.logger.warn({ err: error }, "ws watch error");
        this.handleDisconnect();
      },
    });
  }

  private handleDisconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.wsConnected) {
      this.wsConnected = false;
      this.deps.logger.warn({ chainId: this.deps.chainId }, "ws disconnected");
    }
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    const delayMs = this.backoff.next();
    this.deps.logger.info({ delaySeconds: delayMs / 1000 }, "scheduling ws reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, delayMs);
  }

  private handleNewBlock(blockNumber: bigint): void {
    this.lastProcessedBlock = blockNumber;
    this.deps.logger.debug({ blockNumber: blockNumber.toString() }, "processed new block");
    this.processAndPersist(blockNumber).catch((err: unknown) => {
      this.deps.logger.error({ err }, "failed to process/persist new block");
    });
  }

  private async processAndPersist(blockNumber: bigint): Promise<void> {
    await this.runOnBlockRange(blockNumber, blockNumber);
    await this.persist(blockNumber);
  }

  /**
   * Runs the caller-supplied onBlockRange hook (e.g. the new-token
   * detector) without letting its failures affect block tracking —
   * scanner_state persistence and watcher startup must stay reliable even
   * if downstream event detection has a bad day (e.g. an RPC plan that
   * doesn't support eth_getLogs).
   */
  private async runOnBlockRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (!this.deps.onBlockRange) {
      return;
    }
    try {
      await this.deps.onBlockRange(fromBlock, toBlock);
    } catch (err) {
      this.deps.logger.error(
        { err, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
        "onBlockRange hook failed — continuing block tracking regardless",
      );
    }
  }

  private async persist(blockNumber: bigint): Promise<void> {
    await this.deps.scannerStateRepo.saveState(this.deps.chainId, blockNumber);
  }
}
