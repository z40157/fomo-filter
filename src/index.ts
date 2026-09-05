import { loadEnv } from "./config/index.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./api/server.js";
import { createDb, checkDatabase } from "./db/client.js";
import { createScannerStateRepo } from "./db/scannerState.js";
import { createTokensRepo } from "./db/tokens.js";
import { createTradesRepo } from "./db/trades.js";
import { createWalletWatchlistRepo } from "./db/walletWatchlist.js";
import { createWatchlistCache } from "./watchlist/watchlistCache.js";
import { CHAIN_ID, createHttpClient, createWsClient } from "./chain/client.js";
import { ChainWatcher } from "./chain/watcher.js";
import { createDetectorHttpClient, createNewTokenDetector } from "./chain/newTokenDetector.js";
import { createTradeDetectorHttpClient, createTradeDetector } from "./chain/tradeDetector.js";

const WATCHLIST_REFRESH_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const db = createDb(env.DATABASE_URL);
  const scannerStateRepo = createScannerStateRepo(db);
  const tokensRepo = createTokensRepo(db);
  const tradesRepo = createTradesRepo(db);
  const walletsRepo = createWalletWatchlistRepo(db);
  const watchlistCache = createWatchlistCache(walletsRepo, logger);
  const httpClient = createHttpClient(env.RH_RPC_HTTP);

  await watchlistCache.refresh();
  // Event-based refresh (on API writes) covers the common case immediately;
  // this periodic sweep also picks up out-of-band changes — e.g. someone
  // running `npm run wallets:import` in a separate process — that the live
  // server would otherwise never hear about.
  setInterval(() => {
    watchlistCache.refresh().catch((err: unknown) => {
      logger.error({ err }, "periodic watchlist cache refresh failed");
    });
  }, WATCHLIST_REFRESH_INTERVAL_MS).unref();

  const detector = createNewTokenDetector({
    dopplerAirlockAddress: env.DOPPLER_AIRLOCK_ADDRESS as `0x${string}`,
    ponsV1FactoryAddress: env.PONS_V1_FACTORY_ADDRESS as `0x${string}`,
    httpClient: createDetectorHttpClient(httpClient, logger),
    tokensRepo,
    logger,
  });

  const tradeDetector = createTradeDetector({
    chainId: CHAIN_ID,
    httpClient: createTradeDetectorHttpClient(httpClient),
    tokensRepo,
    tradesRepo,
    watchlistCache,
    logger,
  });

  const watcher = new ChainWatcher({
    chainId: CHAIN_ID,
    httpClient,
    createWsClient: () => createWsClient(env.RH_RPC_WS),
    scannerStateRepo,
    logger,
    onBlockRange: async (fromBlock, toBlock) => {
      // New-token discovery must run first so freshly launched tokens are
      // already in the DB before this same range is scanned for their trades.
      await detector.processBlockRange(fromBlock, toBlock);
      await tradeDetector.processBlockRange(fromBlock, toBlock);
    },
  });

  try {
    await watcher.start();
  } catch (err) {
    logger.error(err, "failed to start chain watcher (restart recovery / initial connect)");
    process.exit(1);
  }

  const app = buildServer({
    logger,
    chainId: CHAIN_ID,
    watcher,
    checkDatabase: () => checkDatabase(db),
    countTrackedTokens: () => tokensRepo.countTokens(),
    walletsRepo,
    watchlistCache,
    adminApiKey: env.ADMIN_API_KEY,
  });

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
