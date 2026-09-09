import type { Logger } from "../logger.js";
import { ExponentialBackoff, type BackoffOptions } from "./backoff.js";
import { computeBackfillRange } from "./recovery.js";
import type { ScannerStateRepo } from "../db/scannerState.js";

/** Above this many missed blocks, per-block backfill doesn't scale — jump
 * straight to the current head instead of grinding through a multi-day gap
 * one block at a time. ~50k blocks is roughly an hour of downtime on a
 * fast-block chain; longer outages just lose history rather than blocking
 * startup for hours. */
const DEFAULT_MAX_BACKFILL_BLOCKS = 50_000n;

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
  /** Missed-range size above which backfill is skipped entirely in favor of
   * jumping to the current head. Default `DEFAULT_MAX_BACKFILL_BLOCKS`. */
  maxBackfillBlocks?: bigint;
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
  /** Latest block number observed over the WS subscription — updated
   * synchronously so `getStatus()` always reflects the real chain tip, even
   * while that block's detection work is still in flight. */
  private lastProcessedBlock: bigint | null = null;
  /** Highest block number whose onBlockRange call has actually completed
   * and been persisted. The gap between this and `lastProcessedBlock` is
   * exactly the backlog `drainQueue` coalesces into one range per cycle. */
  private processedCursor: bigint | null = null;
  /** Highest block number seen that still needs processing. */
  private pendingTarget: bigint | null = null;
  private draining = false;
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
      this.processedCursor = this.lastProcessedBlock;
      if (priorBlock === null) {
        this.deps.logger.info(
          { chainId: this.deps.chainId, block: this.lastProcessedBlock.toString() },
          "no prior scanner_state found, starting from chain head",
        );
        await this.persist(this.lastProcessedBlock);
      }
      return;
    }

    const rangeSize = range.toBlock - range.fromBlock + 1n;
    const maxBackfillBlocks = this.deps.maxBackfillBlocks ?? DEFAULT_MAX_BACKFILL_BLOCKS;
    if (rangeSize > maxBackfillBlocks) {
      this.deps.logger.warn(
        {
          fromBlock: range.fromBlock.toString(),
          toBlock: range.toBlock.toString(),
          rangeSize: rangeSize.toString(),
          maxBackfillBlocks: maxBackfillBlocks.toString(),
        },
        "restart recovery: missed range too large to backfill — skipping to current head",
      );
      this.lastProcessedBlock = currentBlock;
      this.processedCursor = currentBlock;
      await this.persist(currentBlock);
      return;
    }

    this.deps.logger.info(
      { fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString() },
      "restart recovery: backfilling missed blocks",
    );
    await this.backfill(range.fromBlock, range.toBlock);
    await this.runOnBlockRange(range.fromBlock, range.toBlock);
    this.lastProcessedBlock = range.toBlock;
    this.processedCursor = range.toBlock;
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
    if (this.pendingTarget === null || blockNumber > this.pendingTarget) {
      this.pendingTarget = blockNumber;
    }
    this.deps.logger.debug({ blockNumber: blockNumber.toString() }, "new block observed");
    this.drainQueue();
  }

  /**
   * Coalesces bursts of new-block notifications into one range-covering
   * onBlockRange call at a time, instead of firing an independent concurrent
   * call per block. On a fast-block chain (this one runs ~250ms blocks),
   * per-block detection (~5 eth_getLogs calls) can take longer than the
   * block interval — without coalescing, every block spawns its own
   * in-flight batch of RPC calls, and the pile-up blows through the RPC
   * plan's requests/sec cap (confirmed live 2026-09-09: a sustained,
   * non-abating 429 storm, not a brief post-reconnect blip). Any block that
   * arrives while a range is already in flight is simply folded into the
   * next cycle's range rather than triggering its own call.
   */
  private drainQueue(): void {
    if (this.draining) return;
    if (this.processedCursor === null || this.pendingTarget === null) return;
    if (this.pendingTarget <= this.processedCursor) return;

    this.draining = true;
    const fromBlock = this.processedCursor + 1n;
    const toBlock = this.pendingTarget;
    this.processRange(fromBlock, toBlock)
      .catch((err: unknown) => {
        this.deps.logger.error(
          { err, fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
          "failed to persist processed block range",
        );
      })
      .finally(() => {
        this.processedCursor = toBlock;
        this.draining = false;
        this.drainQueue();
      });
  }

  private async processRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    await this.runOnBlockRange(fromBlock, toBlock);
    await this.persist(toBlock);
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
