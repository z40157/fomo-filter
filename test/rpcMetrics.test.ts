import { describe, expect, it } from "vitest";
import { RpcMetrics } from "../src/chain/rpcMetrics.js";

describe("RpcMetrics", () => {
  it("categorizes known methods and buckets unknown ones under total only", () => {
    const metrics = new RpcMetrics();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");

    metrics.record("eth_getLogs", t0);
    metrics.record("eth_getLogs", t0 + 1000);
    metrics.record("eth_call", t0 + 2000);
    metrics.record("eth_getTransactionByHash", t0 + 3000);
    metrics.record("eth_getTransactionReceipt", t0 + 4000);
    metrics.record("eth_getBlockByNumber", t0 + 5000);
    metrics.record("eth_chainId", t0 + 6000); // uncategorized, still counts toward total

    const snapshot = metrics.snapshot(t0 + 6000);
    expect(snapshot.rpcRequests1m).toBe(7);
    expect(snapshot.rpcRequests24h).toBe(7);
    expect(snapshot.ethGetLogs1m).toBe(2);
    expect(snapshot.ethCall1m).toBe(1);
    expect(snapshot.ethGetTransaction1m).toBe(1);
    expect(snapshot.ethGetReceipt1m).toBe(1);
    expect(snapshot.ethGetBlock1m).toBe(1);
  });

  it("drops calls out of the trailing minute bucket but keeps them in the 24h sum", () => {
    const metrics = new RpcMetrics();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");

    metrics.record("eth_getLogs", t0);
    const oneMinuteLater = t0 + 61_000;

    const snapshot = metrics.snapshot(oneMinuteLater);
    expect(snapshot.ethGetLogs1m).toBe(0);
    expect(snapshot.ethGetLogs24h).toBe(1);
  });

  it("drops calls out of the trailing 24h window entirely", () => {
    const metrics = new RpcMetrics();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");

    metrics.record("eth_getLogs", t0);
    const oneDayLater = t0 + 25 * 60 * 60 * 1000;

    const snapshot = metrics.snapshot(oneDayLater);
    expect(snapshot.ethGetLogs1m).toBe(0);
    expect(snapshot.ethGetLogs24h).toBe(0);
  });

  it("counts WS block-number push events separately from JSON-RPC calls", () => {
    const metrics = new RpcMetrics();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");

    metrics.recordWsEvent(t0);
    metrics.recordWsEvent(t0 + 100);
    metrics.record("eth_getLogs", t0 + 200);

    const snapshot = metrics.snapshot(t0 + 200);
    expect(snapshot.wsEvents1m).toBe(2);
    expect(snapshot.rpcRequests1m).toBe(1);
  });
});
