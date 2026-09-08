// Spec B1.9/B1.10 — RPC cost guard. V2-only module: reads V1's Phase 0
// rpcMetrics.ts (chain/rpcMetrics.ts, unmodified) since V2's adapter goes
// through the same instrumented client.ts transports — safe because V2
// runs as its own OS process with its own module-level rpcMetrics
// singleton, never sharing counters with V1's deployed process.
import type { RpcMetricsSnapshot } from "../chain/rpcMetrics.js";

export interface RpcCreditWeights {
  ethGetLogs: number;
  ethCall: number;
  ethGetTransaction: number;
  ethGetReceipt: number;
  ethGetBlock: number;
  /** Everything not individually categorized by rpcMetrics.ts (e.g.
   * eth_chainId, eth_subscribe control frames, eth_getCode). */
  other: number;
  /** WS-pushed subscription notifications — typically free/near-free on
   * most providers, but configurable rather than hard-coded (spec: "不要
   * hard-code QuickNode当前价格"). */
  wsEvent: number;
}

/** Placeholder weights — spec explicitly forbids hard-coding a specific
 * provider's real pricing; override via RPC_CREDIT_WEIGHTS_JSON. Relative
 * ordering (getLogs/call costliest, getBlock/getTransaction cheaper)
 * reflects typical RPC provider method-credit tables, not any one vendor's
 * actual numbers. */
export const DEFAULT_RPC_CREDIT_WEIGHTS: RpcCreditWeights = {
  ethGetLogs: 20,
  ethCall: 20,
  ethGetTransaction: 5,
  ethGetReceipt: 15,
  ethGetBlock: 5,
  other: 5,
  wsEvent: 0,
};

export function parseRpcCreditWeights(json: string | undefined): RpcCreditWeights {
  if (!json) return DEFAULT_RPC_CREDIT_WEIGHTS;
  try {
    const parsed = JSON.parse(json) as Partial<RpcCreditWeights>;
    return { ...DEFAULT_RPC_CREDIT_WEIGHTS, ...parsed };
  } catch {
    return DEFAULT_RPC_CREDIT_WEIGHTS;
  }
}

export type RpcBudgetStatus = "OK" | "RPC_BUDGET_HIGH" | "RPC_BUDGET_EXCEEDED";

export interface RpcBudgetSnapshot {
  estimatedRpcCredits24h: number;
  rpcBudget24h: number | null;
  rpcBudgetUsagePct: number | null;
  status: RpcBudgetStatus;
}

const HIGH_WATERMARK_PCT = 80;

export function computeRpcBudgetSnapshot(
  metrics: RpcMetricsSnapshot,
  weights: RpcCreditWeights,
  budget24h: number | null,
): RpcBudgetSnapshot {
  const categorized24h =
    metrics.ethGetLogs24h + metrics.ethCall24h + metrics.ethGetTransaction24h + metrics.ethGetReceipt24h + metrics.ethGetBlock24h;
  const otherCount24h = Math.max(0, metrics.rpcRequests24h - categorized24h);

  const estimatedRpcCredits24h =
    metrics.ethGetLogs24h * weights.ethGetLogs +
    metrics.ethCall24h * weights.ethCall +
    metrics.ethGetTransaction24h * weights.ethGetTransaction +
    metrics.ethGetReceipt24h * weights.ethGetReceipt +
    metrics.ethGetBlock24h * weights.ethGetBlock +
    otherCount24h * weights.other +
    metrics.wsEvents24h * weights.wsEvent;

  if (budget24h === null) {
    return { estimatedRpcCredits24h, rpcBudget24h: null, rpcBudgetUsagePct: null, status: "OK" };
  }

  const rpcBudgetUsagePct = budget24h > 0 ? (estimatedRpcCredits24h / budget24h) * 100 : 0;
  const status: RpcBudgetStatus =
    rpcBudgetUsagePct > 100 ? "RPC_BUDGET_EXCEEDED" : rpcBudgetUsagePct > HIGH_WATERMARK_PCT ? "RPC_BUDGET_HIGH" : "OK";

  return { estimatedRpcCredits24h, rpcBudget24h: budget24h, rpcBudgetUsagePct, status };
}

/** B1.10: over budget degrades non-critical polling (e.g. lower snapshot
 * refresh cadence) — it must NEVER stop launch discovery, and must never
 * crash the process. This just answers the yes/no question; the caller
 * decides what "non-critical" means for it. */
export function shouldDegradeNonCriticalPolling(snapshot: RpcBudgetSnapshot): boolean {
  return snapshot.status === "RPC_BUDGET_EXCEEDED";
}
