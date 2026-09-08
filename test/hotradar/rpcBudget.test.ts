import { describe, expect, it } from "vitest";
import {
  DEFAULT_RPC_CREDIT_WEIGHTS,
  computeRpcBudgetSnapshot,
  parseRpcCreditWeights,
  shouldDegradeNonCriticalPolling,
} from "../../src/hotradar/rpcBudget.js";
import type { RpcMetricsSnapshot } from "../../src/chain/rpcMetrics.js";

function metrics(overrides: Partial<RpcMetricsSnapshot> = {}): RpcMetricsSnapshot {
  return {
    rpcRequests1m: 0,
    rpcRequests24h: 0,
    ethGetLogs1m: 0,
    ethGetLogs24h: 0,
    ethCall1m: 0,
    ethCall24h: 0,
    ethGetTransaction1m: 0,
    ethGetTransaction24h: 0,
    ethGetReceipt1m: 0,
    ethGetReceipt24h: 0,
    ethGetBlock1m: 0,
    ethGetBlock24h: 0,
    wsEvents1m: 0,
    wsEvents24h: 0,
    ...overrides,
  };
}

describe("parseRpcCreditWeights", () => {
  it("falls back to defaults when unset", () => {
    expect(parseRpcCreditWeights(undefined)).toEqual(DEFAULT_RPC_CREDIT_WEIGHTS);
  });

  it("falls back to defaults on invalid JSON, never throws", () => {
    expect(() => parseRpcCreditWeights("{not json")).not.toThrow();
    expect(parseRpcCreditWeights("{not json")).toEqual(DEFAULT_RPC_CREDIT_WEIGHTS);
  });

  it("merges a partial override onto the defaults", () => {
    const weights = parseRpcCreditWeights(JSON.stringify({ ethGetLogs: 999 }));
    expect(weights.ethGetLogs).toBe(999);
    expect(weights.ethCall).toBe(DEFAULT_RPC_CREDIT_WEIGHTS.ethCall);
  });
});

describe("computeRpcBudgetSnapshot", () => {
  it("with no budget configured, still computes credits but reports no usage percentage", () => {
    const result = computeRpcBudgetSnapshot(metrics({ ethGetLogs24h: 100 }), DEFAULT_RPC_CREDIT_WEIGHTS, null);
    expect(result.estimatedRpcCredits24h).toBe(100 * DEFAULT_RPC_CREDIT_WEIGHTS.ethGetLogs);
    expect(result.rpcBudget24h).toBeNull();
    expect(result.rpcBudgetUsagePct).toBeNull();
    expect(result.status).toBe("OK");
  });

  it("charges uncategorized requests at the 'other' weight", () => {
    const result = computeRpcBudgetSnapshot(metrics({ rpcRequests24h: 10 }), DEFAULT_RPC_CREDIT_WEIGHTS, null);
    expect(result.estimatedRpcCredits24h).toBe(10 * DEFAULT_RPC_CREDIT_WEIGHTS.other);
  });

  it("status is OK under the high watermark", () => {
    const result = computeRpcBudgetSnapshot(metrics({ ethGetLogs24h: 1 }), DEFAULT_RPC_CREDIT_WEIGHTS, 1000);
    expect(result.status).toBe("OK");
  });

  it("status is RPC_BUDGET_HIGH between 80% and 100%", () => {
    const weights = { ...DEFAULT_RPC_CREDIT_WEIGHTS, ethGetLogs: 1 };
    const result = computeRpcBudgetSnapshot(metrics({ ethGetLogs24h: 85 }), weights, 100);
    expect(result.status).toBe("RPC_BUDGET_HIGH");
  });

  it("status is RPC_BUDGET_EXCEEDED over 100%, never crashes/throws", () => {
    const weights = { ...DEFAULT_RPC_CREDIT_WEIGHTS, ethGetLogs: 1 };
    const result = computeRpcBudgetSnapshot(metrics({ ethGetLogs24h: 500 }), weights, 100);
    expect(result.status).toBe("RPC_BUDGET_EXCEEDED");
    expect(result.rpcBudgetUsagePct).toBeGreaterThan(100);
  });
});

describe("shouldDegradeNonCriticalPolling", () => {
  it("only true once the budget is actually exceeded, not merely high", () => {
    expect(shouldDegradeNonCriticalPolling({ estimatedRpcCredits24h: 0, rpcBudget24h: 100, rpcBudgetUsagePct: 85, status: "RPC_BUDGET_HIGH" })).toBe(false);
    expect(shouldDegradeNonCriticalPolling({ estimatedRpcCredits24h: 0, rpcBudget24h: 100, rpcBudgetUsagePct: 120, status: "RPC_BUDGET_EXCEEDED" })).toBe(true);
  });
});
