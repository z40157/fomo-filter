import Fastify from "fastify";
import type { Logger } from "../logger.js";
import type { WatcherStatus } from "../chain/watcher.js";
import { healthRoutes } from "./routes/health.js";

export interface AppContext {
  logger: Logger;
  chainId: number;
  watcher: { getStatus: () => WatcherStatus };
  checkDatabase: () => Promise<"ok" | "error">;
  countTrackedTokens: () => Promise<number>;
}

export function buildServer(ctx: AppContext) {
  const app = Fastify({ loggerInstance: ctx.logger });

  app.register(healthRoutes(ctx));

  return app;
}

export type Server = ReturnType<typeof buildServer>;
