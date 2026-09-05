import type { FastifyInstance } from "fastify";
import type { AppContext } from "../server.js";
import type { DexScreenerStatus } from "../../market/dexscreener.js";

interface HealthResponse {
  status: "ok";
  chainId: number;
  wsConnected: boolean;
  lastBlock: number | null;
  database: "ok" | "error";
  trackedTokens: number;
  watchedWallets: number;
  activeCandidates: number;
  dexscreenerStatus: DexScreenerStatus;
  signalsToday: number;
  lastSignalAt: string | null;
  trackedOutcomes: number;
  pendingOutcomePoints: number;
}

export function healthRoutes(ctx: AppContext) {
  return async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
    app.get("/health", async (): Promise<HealthResponse> => {
      const [database, trackedTokens, signalsToday, lastSignalAt, trackedOutcomes, pendingOutcomePoints] =
        await Promise.all([
          ctx.checkDatabase(),
          ctx.countTrackedTokens(),
          ctx.countSignalsToday(),
          ctx.getLastSignalAt(),
          ctx.countTrackedOutcomes(),
          ctx.countPendingOutcomePoints(),
        ]);
      const status = ctx.watcher.getStatus();

      return {
        status: "ok",
        chainId: ctx.chainId,
        wsConnected: status.wsConnected,
        lastBlock: status.lastBlock === null ? null : Number(status.lastBlock),
        database,
        trackedTokens,
        watchedWallets: ctx.watchlistCache.size(),
        activeCandidates: ctx.countActiveCandidates(),
        dexscreenerStatus: ctx.getDexScreenerStatus(),
        signalsToday,
        lastSignalAt: lastSignalAt === null ? null : lastSignalAt.toISOString(),
        trackedOutcomes,
        pendingOutcomePoints,
      };
    });
  };
}
