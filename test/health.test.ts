import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/logger.js";

describe("GET /health", () => {
  it("returns 200 with real watcher/database/tokens status", async () => {
    const app = buildServer({
      logger: createLogger("silent"),
      chainId: 4663,
      watcher: { getStatus: () => ({ wsConnected: true, lastBlock: 12345n }) },
      checkDatabase: async () => "ok",
      countTrackedTokens: async () => 7,
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      chainId: 4663,
      wsConnected: true,
      lastBlock: 12345,
      database: "ok",
      trackedTokens: 7,
    });

    await app.close();
  });

  it("reports database errors and a null lastBlock before the first block", async () => {
    const app = buildServer({
      logger: createLogger("silent"),
      chainId: 4663,
      watcher: { getStatus: () => ({ wsConnected: false, lastBlock: null }) },
      checkDatabase: async () => "error",
      countTrackedTokens: async () => 0,
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.json()).toEqual({
      status: "ok",
      chainId: 4663,
      wsConnected: false,
      lastBlock: null,
      database: "error",
      trackedTokens: 0,
    });

    await app.close();
  });
});
