import { loadEnv } from "./config/index.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./api/server.js";
import { createDb, checkDatabase } from "./db/client.js";
import { createScannerStateRepo } from "./db/scannerState.js";
import { createTokensRepo } from "./db/tokens.js";
import { CHAIN_ID, createHttpClient, createWsClient } from "./chain/client.js";
import { ChainWatcher } from "./chain/watcher.js";
import { createDetectorHttpClient, createNewTokenDetector } from "./chain/newTokenDetector.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const db = createDb(env.DATABASE_URL);
  const scannerStateRepo = createScannerStateRepo(db);
  const tokensRepo = createTokensRepo(db);
  const httpClient = createHttpClient(env.RH_RPC_HTTP);

  const detector = createNewTokenDetector({
    dopplerAirlockAddress: env.DOPPLER_AIRLOCK_ADDRESS as `0x${string}`,
    ponsV1FactoryAddress: env.PONS_V1_FACTORY_ADDRESS as `0x${string}`,
    httpClient: createDetectorHttpClient(httpClient, logger),
    tokensRepo,
    logger,
  });

  const watcher = new ChainWatcher({
    chainId: CHAIN_ID,
    httpClient,
    createWsClient: () => createWsClient(env.RH_RPC_WS),
    scannerStateRepo,
    logger,
    onBlockRange: (fromBlock, toBlock) => detector.processBlockRange(fromBlock, toBlock),
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
  });

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
