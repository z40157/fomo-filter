import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "./config/index.js";
import { createLogger, type Logger } from "./logger.js";
import { buildServer } from "./api/server.js";
import { createDb, checkDatabase, type Database } from "./db/client.js";
import { ExponentialBackoff } from "./chain/backoff.js";
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
import { SCORING_RULE_VERSION } from "./signals/scoring.js";
import { createSignalOutcomesRepo } from "./db/signalOutcomes.js";
import { createOutcomeTracker } from "./outcomes/outcomeTracker.js";
import { DEFAULT_OUTCOME_OFFSETS, type OutcomeOffset } from "./outcomes/outcomeTrackerLogic.js";
import { createAlertDispatcher } from "./alerts/alertDispatcher.js";
import { createResendClient } from "./alerts/resendClient.js";
import { createTelegramClient } from "./alerts/telegramClient.js";
import { createDiscoveryRepo } from "./db/discovery.js";
import { createWalletDiscoveryJob } from "./discovery/walletDiscoveryJob.js";

const WATCHLIST_REFRESH_INTERVAL_MS = 60_000;
const USD_ENRICHMENT_INTERVAL_MS = 30_000;
const OUTCOME_SWEEP_INTERVAL_MS = 30_000;
const WALLET_DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse OUTCOME_OFFSETS_MS ("ms,ms,ms,ms,ms") into the tracker's offset
 * table, keeping the fixed +5m/+15m/+1h/+6h/+24h label set. Only for a
 * live pipeline test where waiting a real day isn't practical — returns
 * undefined (use production defaults) when unset or malformed.
 */
function outcomeOffsetsFromEnv(raw: string | undefined, logger: ReturnType<typeof createLogger>): readonly OutcomeOffset[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== DEFAULT_OUTCOME_OFFSETS.length || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    logger.warn(
      { raw },
      `OUTCOME_OFFSETS_MS must be ${DEFAULT_OUTCOME_OFFSETS.length} positive numbers — ignoring it and using production offsets`,
    );
    return undefined;
  }
  const overridden = DEFAULT_OUTCOME_OFFSETS.map((o, i) => ({
    label: o.label,
    ms: parts[i]!,
    delayToleranceMs: Math.max(10_000, Math.round(parts[i]! / 2)),
  }));
  logger.warn({ offsetsMs: parts }, "OUTCOME_OFFSETS_MS override active — outcome schedule is NOT production timing");
  return overridden;
}

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
 * Railway's private-network DNS may not be resolvable in the first instant a
 * container starts. Retries the DB reachability check with backoff (up to
 * ~30s total) before letting startup proceed, rather than failing on
 * whichever query happens to run first. Deployment robustness only — no
 * change to what "ready" means beyond "a query round-trips".
 */
async function waitForDatabaseReady(db: Database, logger: Logger): Promise<void> {
  const backoff = new ExponentialBackoff({ initialMs: 1_000, maxMs: 5_000, factor: 2 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await checkDatabase(db)) === "ok") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("database not reachable after 30s of retries at startup");
    }
    const delay = Math.min(backoff.next(), remaining);
    logger.warn({ delayMs: delay }, "database not ready yet, retrying...");
    await new Promise((r) => setTimeout(r, delay));
  }
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
  try {
    await waitForDatabaseReady(db, logger);
  } catch (err) {
    logger.error(err, "database did not become ready at startup");
    process.exit(1);
  }
  const scannerStateRepo = createScannerStateRepo(db);
  const tokensRepo = createTokensRepo(db);
  const tradesRepo = createTradesRepo(db);
  const walletsRepo = createWalletWatchlistRepo(db);
  const snapshotsRepo = createTokenSnapshotsRepo(db);
  const signalsRepo = createSignalsRepo(db);
  const narrativeFlagsRepo = createNarrativeFlagsRepo(db);
  const alertsRepo = createAlertsRepo(db);
  const signalOutcomesRepo = createSignalOutcomesRepo(db);
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

  // Phase 9: Outcome Tracker — records what happened to every signal
  // scoring >= 6.0 at +5m/+15m/+1h/+6h/+24h. Uses a restart-tolerant DB
  // sweep (not per-signal timers). Reuses the shared `dexscreener` client
  // so its calls go through the same rate limiter as candidateTracker.
  const outcomeTracker = createOutcomeTracker({
    outcomesRepo: signalOutcomesRepo,
    marketSource: dexscreener,
    scoringRuleVersion: SCORING_RULE_VERSION,
    logger,
    offsets: outcomeOffsetsFromEnv(env.OUTCOME_OFFSETS_MS, logger),
  });

  const resonanceDetector = createResonanceDetector({
    signalsRepo,
    logger,
    config: resonanceConfigFromEnv(env),
    getQuoteTokenSymbol,
    outcomeTracker,
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

  // Phase 9: the outcome sweeper — fills in due-and-pending outcome points
  // from the DB on its own timer, fully decoupled from signal generation.
  outcomeTracker.start(env.OUTCOME_SWEEP_INTERVAL_MS ?? OUTCOME_SWEEP_INTERVAL_MS);

  // Continuous wallet discovery (2026-09-08): the manually-curated 72-wallet
  // FOMO Top100 list turned out to have zero on-chain activity in production
  // (see PROGRESS.md) — this replaces "mine once, review, import by hand"
  // with a daily automated pass over real production trade + price data.
  // New candidates always land `enabled: false` (never auto-activates real
  // alerting) and a Telegram summary is sent for manual review.
  const discoveryRepo = createDiscoveryRepo(db);
  const walletDiscoveryJob = createWalletDiscoveryJob({
    discoveryRepo,
    walletsRepo,
    watchlistCache,
    httpClient,
    telegramClient,
    logger,
    extraExclusions: [env.DOPPLER_AIRLOCK_ADDRESS, env.PONS_V1_FACTORY_ADDRESS],
  });
  walletDiscoveryJob.start(env.DISCOVERY_INTERVAL_MS ?? WALLET_DISCOVERY_INTERVAL_MS);

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
    countTrackedOutcomes: () => signalOutcomesRepo.countTracked(),
    countPendingOutcomePoints: () => signalOutcomesRepo.countPendingPoints(),
  });

  try {
    // Railway's private networking is IPv6-only. "::" is the IPv6 wildcard
    // address and binds dual-stack by default (also accepts IPv4), unlike
    // "0.0.0.0" which is IPv4-only.
    await app.listen({ port: env.PORT, host: "::" });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }

  // Railway sends SIGTERM on every redeploy. Without a clean shutdown, each
  // deploy leaves a dangling DB connection and an unclosed WS subscription —
  // Railway Postgres's max_connections isn't high, and a few deploys in a
  // row would exhaust it. Order: stop accepting new HTTP requests first,
  // then every background loop via its existing stop() method (nothing new
  // added to those modules — this only calls what they already expose),
  // then the DB pool last. watchlistCache's own refresh setInterval has no
  // stop() and isn't called here — it's .unref()'d (see its call site
  // above), so it never keeps the process alive and needs no explicit
  // teardown; process.exit() below ends it regardless.
  const SHUTDOWN_TIMEOUT_MS = 15_000;
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown requested");

    const timeout = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    try {
      logger.info("stopping http server");
      await app.close();

      logger.info("stopping chain watcher");
      watcher.stop();

      logger.info("stopping background jobs");
      candidateTracker.stop();
      usdEnrichmentJob.stop();
      outcomeTracker.stop();
      walletDiscoveryJob.stop();
      resonanceDetector.stop();

      logger.info("closing database");
      await db.$client.end();

      clearTimeout(timeout);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(timeout);
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(1));
  });
}

main();
