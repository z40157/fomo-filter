import Fastify from "fastify";
import type { Logger } from "../logger.js";
import type { WatcherStatus } from "../chain/watcher.js";
import type { WalletWatchlistRepo } from "../db/walletWatchlist.js";
import type { WatchlistCache } from "../watchlist/watchlistCache.js";
import { healthRoutes } from "./routes/health.js";
import { walletRoutes } from "./routes/wallets.js";

export interface AppContext {
  logger: Logger;
  chainId: number;
  watcher: { getStatus: () => WatcherStatus };
  checkDatabase: () => Promise<"ok" | "error">;
  countTrackedTokens: () => Promise<number>;
  walletsRepo: WalletWatchlistRepo;
  watchlistCache: WatchlistCache;
  adminApiKey: string | undefined;
}

export function buildServer(ctx: AppContext) {
  const app = Fastify({ loggerInstance: ctx.logger });

  app.register(healthRoutes(ctx));
  app.register(walletRoutes(ctx));

  return app;
}

export type Server = ReturnType<typeof buildServer>;
