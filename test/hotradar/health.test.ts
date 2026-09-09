import { describe, expect, it } from "vitest";
import { buildV2Health } from "../../src/hotradar/health.js";
import type { RpcMetricsSnapshot } from "../../src/chain/rpcMetrics.js";
import type { RpcBudgetSnapshot } from "../../src/hotradar/rpcBudget.js";
import type { ManagerCounters } from "../../src/hotradar/manager.js";

const rpcMetrics: RpcMetricsSnapshot = {
  rpcRequests1m: 10,
  rpcRequests24h: 1000,
  ethGetLogs1m: 1,
  ethGetLogs24h: 5,
  ethCall1m: 0,
  ethCall24h: 0,
  ethGetTransaction1m: 2,
  ethGetTransaction24h: 20,
  ethGetReceipt1m: 0,
  ethGetReceipt24h: 0,
  ethGetBlock1m: 2,
  ethGetBlock24h: 20,
  wsEvents1m: 50,
  wsEvents24h: 5000,
};

const rpcBudget: RpcBudgetSnapshot = { estimatedRpcCredits24h: 500, rpcBudget24h: 10000, rpcBudgetUsagePct: 5, status: "OK" };

const counters: ManagerCounters = {
  launchesTotal: 12,
  hardRejected: 3,
  unknownReview: 4,
  passedGate: 5,
  alertsByTier: { WATCH: 2, EARLY_RADAR: 1, STRONG: 0, URGENT: 0 },
  duplicateTransfers: 0,
};

describe("buildV2Health", () => {
  it("carries over all required new B5 fields", () => {
    const health = buildV2Health({
      chainId: 4663,
      wsConnected: true,
      counters,
      rpcMetrics,
      rpcBudget,
      holderBalanceMapHealth: { balanceTableTokens: 3, balanceTableAddresses: 40, balanceTableEvictions: 0 },
    });

    expect(health.status).toBe("ok");
    expect(health.launchesLast30m).toBe(12);
    expect(health.hardRejectedLast30m).toBe(3);
    expect(health.unknownReviewLast30m).toBe(4);
    expect(health.watchCandidates).toBe(2);
    expect(health.earlyRadarToday).toBe(1);
    expect(health.rpcRequests1m).toBe(10);
    expect(health.ethGetLogs24h).toBe(5);
    expect(health.estimatedRpcCredits24h).toBe(500);
    expect(health.rpcBudgetUsagePct).toBe(5);
    expect(health.balanceTableTokens).toBe(3);
    expect(health.balanceTableAddresses).toBe(40);
  });

  it("windowedOverrides take priority over the manager's all-time counters", () => {
    const health = buildV2Health({
      chainId: 4663,
      wsConnected: true,
      counters,
      rpcMetrics,
      rpcBudget,
      holderBalanceMapHealth: { balanceTableTokens: 0, balanceTableAddresses: 0, balanceTableEvictions: 0 },
      windowedOverrides: { launchesLast30m: 2 },
    });
    expect(health.launchesLast30m).toBe(2);
  });
});
