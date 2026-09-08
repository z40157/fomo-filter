/**
 * Phase 0 (V2 planning) observability only — no business logic depends on
 * this. Tracks RPC call volume per method category plus raw WS
 * block-number push events, exposed via /health, so V1's real request
 * rate can be measured instead of estimated. Approximate by design: each
 * method has a per-UTC-minute bucket ring; "1m" is calls in the current
 * in-progress minute (not a strict trailing 60s window), "24h" sums the
 * last 1440 one-minute buckets. Good enough for a cost/health gauge.
 */

const MINUTES_PER_DAY = 24 * 60;

class RollingMinuteCounter {
  private readonly buckets = new Uint32Array(MINUTES_PER_DAY);
  private currentMinute = -1;

  private rotate(nowMs: number): void {
    const minute = Math.floor(nowMs / 60_000);
    if (minute === this.currentMinute) return;
    if (this.currentMinute < 0 || minute - this.currentMinute >= MINUTES_PER_DAY) {
      this.buckets.fill(0);
    } else {
      for (let m = this.currentMinute + 1; m <= minute; m++) {
        this.buckets[m % MINUTES_PER_DAY] = 0;
      }
    }
    this.currentMinute = minute;
  }

  record(nowMs: number): void {
    this.rotate(nowMs);
    const idx = ((this.currentMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    this.buckets[idx] = (this.buckets[idx] ?? 0) + 1;
  }

  snapshot(nowMs: number): { last1m: number; last24h: number } {
    this.rotate(nowMs);
    if (this.currentMinute < 0) return { last1m: 0, last24h: 0 };
    const idx = ((this.currentMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const last1m = this.buckets[idx] ?? 0;
    let last24h = 0;
    for (let i = 0; i < MINUTES_PER_DAY; i++) last24h += this.buckets[i] ?? 0;
    return { last1m, last24h };
  }
}

export type RpcMethodCategory =
  | "ethGetLogs"
  | "ethCall"
  | "ethGetTransaction"
  | "ethGetReceipt"
  | "ethGetBlock"
  | "other";

const METHOD_CATEGORY: Record<string, RpcMethodCategory> = {
  eth_getLogs: "ethGetLogs",
  eth_call: "ethCall",
  eth_getTransactionByHash: "ethGetTransaction",
  eth_getTransactionReceipt: "ethGetReceipt",
  eth_getBlockByNumber: "ethGetBlock",
  eth_getBlockByHash: "ethGetBlock",
};

export interface RpcMetricsSnapshot {
  rpcRequests1m: number;
  rpcRequests24h: number;
  ethGetLogs1m: number;
  ethGetLogs24h: number;
  ethCall1m: number;
  ethCall24h: number;
  ethGetTransaction1m: number;
  ethGetTransaction24h: number;
  ethGetReceipt1m: number;
  ethGetReceipt24h: number;
  ethGetBlock1m: number;
  ethGetBlock24h: number;
  wsEvents1m: number;
  wsEvents24h: number;
}

export class RpcMetrics {
  private readonly total = new RollingMinuteCounter();
  private readonly wsEvents = new RollingMinuteCounter();
  private readonly byCategory: Record<RpcMethodCategory, RollingMinuteCounter> = {
    ethGetLogs: new RollingMinuteCounter(),
    ethCall: new RollingMinuteCounter(),
    ethGetTransaction: new RollingMinuteCounter(),
    ethGetReceipt: new RollingMinuteCounter(),
    ethGetBlock: new RollingMinuteCounter(),
    other: new RollingMinuteCounter(),
  };

  record(method: string, nowMs: number = Date.now()): void {
    this.total.record(nowMs);
    const category = METHOD_CATEGORY[method] ?? "other";
    this.byCategory[category].record(nowMs);
  }

  recordWsEvent(nowMs: number = Date.now()): void {
    this.wsEvents.record(nowMs);
  }

  snapshot(nowMs: number = Date.now()): RpcMetricsSnapshot {
    const total = this.total.snapshot(nowMs);
    const ws = this.wsEvents.snapshot(nowMs);
    const logs = this.byCategory.ethGetLogs.snapshot(nowMs);
    const call = this.byCategory.ethCall.snapshot(nowMs);
    const tx = this.byCategory.ethGetTransaction.snapshot(nowMs);
    const receipt = this.byCategory.ethGetReceipt.snapshot(nowMs);
    const block = this.byCategory.ethGetBlock.snapshot(nowMs);
    return {
      rpcRequests1m: total.last1m,
      rpcRequests24h: total.last24h,
      ethGetLogs1m: logs.last1m,
      ethGetLogs24h: logs.last24h,
      ethCall1m: call.last1m,
      ethCall24h: call.last24h,
      ethGetTransaction1m: tx.last1m,
      ethGetTransaction24h: tx.last24h,
      ethGetReceipt1m: receipt.last1m,
      ethGetReceipt24h: receipt.last24h,
      ethGetBlock1m: block.last1m,
      ethGetBlock24h: block.last24h,
      wsEvents1m: ws.last1m,
      wsEvents24h: ws.last24h,
    };
  }
}

/** Process-wide singleton — one RPC budget to observe, regardless of how
 * many viem clients/transports are constructed. */
export const rpcMetrics = new RpcMetrics();
