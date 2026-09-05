import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "./config/index.js";
import { createLogger } from "./logger.js";
import { buildServer } from "./api/server.js";
import { createDb, checkDatabase } from "./db/client.js";
import { createScannerStateRepo } from "./db/scannerState.js";
import { createTokensRepo } from "./db/tokens.js";
import { createTradesRepo } from "./db/trades.js";
import { createWalletWatchlistRepo } from "./db/walletWatchlist.js";
import { createTokenSnapshotsRepo } from "./db/tokenSnapshots.js";
import { createSignalsRepo } from "./db/signals.js";
import { createNarrativeFlagsRepo } from "./db/narrativeFlags.js";
import { createAlertsRepo } from "./db/alerts.js";
import { createWatchlistCache } from "./watchlist/watchlistCache.js";
import { CHAIN_ID, createHttpClient, createWsClient } from "./chain/client.js";
import { ChainWatcher } from "./chain/watcher.js";
import { createDetectorHttpClient, createNewTokenDetector } from "./chain/newTokenDetector.js";
import { createTradeDetectorHttpClient, createTradeDetector } from "./chain/tradeDetector.js";
import { createDexScreenerClient } from "./market/dexscreener.js";
import { createCandidateTracker } from "./market/candidateTracker.js";
import type { TrackerConfig } from "./market/candidateTrackerLogic.js";
import { createErc20DecimalsResolver, createUsdEnrichmentJob } from "./market/usdEnrichment.js";
import { resolveTokenMetadata } from "./chain/erc20.js";
import { createResonanceDetector } from "./signals/resonanceDetector.js";
import type { ResonanceConfig } from "./signals/resonanceLogic.js";
import { createAlertDispatcher } from "./alerts/alertDispatcher.js";
import { createResendClient } from "./alerts/resendClient.js";
import { createTelegramClient } from "./alerts/telegramClient.js";

const WATCHLIST_REFRESH_INTERVAL_MS = 60_000;
const USD_ENRICHMENT_INTERVAL_MS = 30_000;

function trackerConfigFromEnv(env: {
  CANDIDATE_ACTIVE_REFRESH_MS?: number;
  CANDIDATE_INACTIVE_REFRESH_MS?: number;
  CANDIDATE_MIN_TRACKING_HOURS?: number;
  CANDIDATE_EXIT_INACTIVITY_HOURS?: number;
}): Partial<TrackerConfig> {
  const overrides: Partial<TrackerConfig> = {};
  if (env.CANDIDATE_ACTIVE_REFRESH_MS !== undefined) overrides.activeRefreshMs = env.CANDIDATE_ACTIVE_REFRESH_MS;
  if (env.CANDIDATE_INACTIVE_REFRESH_MS !== undefined) overrides.inactiveRefreshMs = env.CANDIDATE_INACTIVE_REFRESH_MS;
  if (env.CANDIDATE_MIN_TRACKING_HOURS !== undefined) {
    overrides.minTrackingDurationMs = env.CANDIDATE_MIN_TRACKING_HOURS * 60 * 60 * 1000;
  }
  if (env.CANDIDATE_EXIT_INACTIVITY_HOURS !== undefined) {
    overrides.exitInactivityWindowMs = env.CANDIDATE_EXIT_INACTIVITY_HOURS * 60 * 60 * 1000;
  }
  return overrides;
}

function resonanceConfigFromEnv(env: {
  RESONANCE_WINDOW_MINUTES?: number;
  RESONANCE_COOLDOWN_MINUTES?: number;
}): Partial<ResonanceConfig> {
  const overrides: Partial<ResonanceConfig> = {};
  if (env.RESONANCE_WINDOW_MINUTES !== undefined) overrides.windowMinutes = env.RESONANCE_WINDOW_MINUTES;
  if (env.RESONANCE_COOLDOWN_MINUTES !== undefined) overrides.cooldownMinutes = env.RESONANCE_COOLDOWN_MINUTES;
  return overrides;
}

/**
 * Manually-curated official Robinhood stock-token addresses (config/stockTokens.json),
 * used only by scoring.ts's Narrative dimension — never inferred or guessed.
 * Empty by default; the file is filled in by hand as tokens are confirmed.
 */
function loadOfficialStockTokens(logger: ReturnType<typeof createLogger>): ReadonlySet<string> {
  try {
    const filePath = resolve(process.cwd(), "config/stockTokens.json");
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("config/stockTokens.json must contain a JSON array of addresses");
    }
    return new Set(parsed.map((a) => String(a).toLowerCase()));
  } catch (err) {
    logger.warn({ err }, "could not load config/stockTokens.json — Narrative dimension's official-stock-pair bonus will never apply");
    return new Set();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const db = createDb(env.DATABASE_URL);
  const scannerStateRepo = createScannerStateRepo(db);
  const tokensRepo = createTokensRepo(db);
  const tradesRepo = createTradesRepo(db);
  const walletsRepo = createWalletWatchlistRepo(db);
  const snapshotsRepo = createTokenSnapshotsRepo(db);
  const signalsRepo = createSignalsRepo(db);
  const narrativeFlagsRepo = createNarrativeFlagsRepo(db);
  const alertsRepo = createAlertsRepo(db);
  const watchlistCache = createWatchlistCache(walletsRepo, logger);
  const officialStockTokens = loadOfficialStockTokens(logger);
  const httpClient = createHttpClient(env.RH_RPC_HTTP);
  const dexscreener = createDexScreenerClient(logger);

  // Phase 8 (revised): Telegram is the primary + required alert channel and
  // carries the full layered-threshold logic (< 7.0 nothing, 7.0-7.9 normal,
  // 8.0-8.9 STRONG, >= 9.0 URGENT). Missing config disables alerting entirely
  // (alertDispatcher logs a warning and no-ops per signal rather than
  // crashing startup).
  const telegramClient =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? createTelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, logger)
      : undefined;
  if (!telegramClient) {
    logger.warn("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured — alerting is disabled");
  }
  // Email (Resend) is retained but disabled by default — it only sends when
  // all three vars are set, alongside every Telegram alert. Its absence is
  // intentionally silent (no warning, no error).
  const emailClient =
    env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO
      ? createResendClient(env.RESEND_API_KEY, logger)
      : undefined;
  if (emailClient) {
    logger.info("Resend email alerting is enabled (secondary channel alongside Telegram)");
  }

  const alertDispatcher = createAlertDispatcher({
    alertsRepo,
    logger,
    telegramClient,
    emailClient,
    emailFrom: env.ALERT_EMAIL_FROM,
    emailTo: env.ALERT_EMAIL_TO,
    getWalletSells: (tokenId, wallets, before) => tradesRepo.getSellTotalsByWallets(tokenId, wallets, before),
  });

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

  // Constructed before tradeDetector since resonanceDetector reads its
  // in-memory market snapshots — started later, after the watcher.
  const candidateTracker = createCandidateTracker({
    tokensRepo,
    tradesRepo,
    snapshotsRepo,
    dexscreener,
    watchlistCache,
    logger,
    config: trackerConfigFromEnv(env),
  });

  // Resolve each pair/quote token's ERC-20 symbol once, for display in alert
  // messages ("bought 0.0037 WETH" instead of a bare number). Cached per
  // process; the all-zero address is this chain's native-currency sentinel.
  const quoteSymbolCache = new Map<string, string | null>();
  async function getQuoteTokenSymbol(pairToken: string): Promise<string | null> {
    const key = pairToken.toLowerCase();
    const cached = quoteSymbolCache.get(key);
    if (cached !== undefined) return cached;
    let symbol: string | null = null;
    if (/^0x0+$/.test(key)) {
      symbol = "ETH";
    } else {
      symbol = (await resolveTokenMetadata(httpClient, pairToken as `0x${string}`, logger)).symbol;
    }
    quoteSymbolCache.set(key, symbol);
    return symbol;
  }

  const resonanceDetector = createResonanceDetector({
    signalsRepo,
    logger,
    config: resonanceConfigFromEnv(env),
    getQuoteTokenSymbol,
    getMarketSnapshot: (tokenId) => candidateTracker.getLatestMarketSnapshot(tokenId),
    getWatchedFlowState: (tokenId) => candidateTracker.getAggregateState(tokenId),
    getRecentSnapshots: (tokenId, limit) => snapshotsRepo.listRecent(tokenId, limit),
    getTradeTotals: (tokenId) => tradesRepo.countTotalBuysSells(tokenId),
    hasDeployerSold: (tokenId, deployer) => tradesRepo.hasWalletSold(tokenId, deployer),
    getLargestRecentSellUsd: (tokenId, before, windowMinutes) =>
      tradesRepo.getLargestSellUsdSince(tokenId, before, windowMinutes),
    getNarrativeBoost: (tokenId) => narrativeFlagsRepo.getLatestBoost(tokenId),
    officialStockTokens,
    alertDispatcher,
  });

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
    resonanceDetector,
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

  await candidateTracker.start();

  // Backfills trades.usd_value from DexScreener snapshots. Runs on its own
  // timer, fully decoupled from the chain watcher / trade detector above —
  // it must never block real-time trade recording.
  const usdEnrichmentJob = createUsdEnrichmentJob({
    tradesRepo,
    snapshotsRepo,
    decimalsResolver: createErc20DecimalsResolver(httpClient, logger),
    logger,
  });
  usdEnrichmentJob.start(USD_ENRICHMENT_INTERVAL_MS);

  const app = buildServer({
    logger,
    chainId: CHAIN_ID,
    watcher,
    checkDatabase: () => checkDatabase(db),
    countTrackedTokens: () => tokensRepo.countTokens(),
    walletsRepo,
    watchlistCache,
    adminApiKey: env.ADMIN_API_KEY,
    countActiveCandidates: () => candidateTracker.getActiveCandidateCount(),
    getDexScreenerStatus: () => dexscreener.getStatus(),
    countSignalsToday: () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      return signalsRepo.countSince(startOfDay);
    },
    getLastSignalAt: () => signalsRepo.lastTriggeredAt(),
  });

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
