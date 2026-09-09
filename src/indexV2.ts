// V2 Hot Radar shadow process entrypoint (spec B3). Deployed as a
// completely separate Railway service (alpha-radar-v2-shadow) against a
// separate Shadow Postgres — never imports src/index.ts, src/config/env.ts,
// src/db/client.ts, or anything else that could read V1's DATABASE_URL /
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. See PROGRESS.md / the B3 deployment
// report for the isolation verification this was checked against.
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { loadEnvV2, checkTelegramIsolation } from "./config/envV2.js";
import { createLogger, type Logger } from "./logger.js";
import { createShadowDb, checkShadowDatabase } from "./db/shadowClient.js";
import { createHotRadarRepo } from "./db/hotRadarRepo.js";
import { createOutcomePointsRepo } from "./db/outcomePointsRepo.js";
import { ExponentialBackoff } from "./chain/backoff.js";
import { createHttpClient, createWsClient } from "./chain/client.js";
import { RpcMetrics } from "./chain/rpcMetrics.js";
import { computeRpcBudgetSnapshot, parseRpcCreditWeights } from "./hotradar/rpcBudget.js";
import { createRobinhoodAdapter, type RobinhoodAdapter } from "./chains/robinhood/adapter.js";
import { HotCandidateManager, type ScoreEvalContext } from "./hotradar/manager.js";
import { HolderBalanceMap } from "./hotradar/holderBalanceMap.js";
import { buildDataStatus } from "./hotradar/dataStatus.js";
import { formatShadowAlertMessage, type AlertTier } from "./hotradar/alertEngine.js";
import { buildV2Health } from "./hotradar/health.js";
import { createTelegramClient, type TelegramClient } from "./alerts/telegramClient.js";
import { computeMaxReturnAndDrawdown, computeReturnPct } from "./hotradar/outcomeScheduler.js";
import type { HotCandidate } from "./hotradar/types.js";

const OUTCOME_SWEEP_DEFAULT_MS = 60_000;
const HOT_PIPELINE_TOLERANCE_MS = 90_000; // half the manager's slowest refresh cadence (HOT_THIRD: 45s), doubled for margin
const OUTCOME_TRIGGER_TIERS = new Set<AlertTier>(["WATCH", "EARLY_RADAR", "STRONG", "URGENT"]);
const MAX_HOT_TELEGRAM_PER_MIN = 10;

async function waitForShadowDbReady(db: ReturnType<typeof createShadowDb>, logger: Logger): Promise<void> {
  const backoff = new ExponentialBackoff({ initialMs: 1_000, maxMs: 5_000, factor: 2 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await checkShadowDatabase(db)) === "ok") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("shadow database not reachable after 30s of retries at startup");
    const delay = Math.min(backoff.next(), remaining);
    logger.warn({ delayMs: delay }, "shadow database not ready yet, retrying...");
    await new Promise((r) => setTimeout(r, delay));
  }
}

interface CandidateBookkeeping {
  hotCandidateId: number;
  lastLoggedGateStatus: "PASS" | "REJECT" | "UNKNOWN_REVIEW" | null;
  lastAlertTier: AlertTier;
  outcomeScheduled: boolean;
}

async function main(): Promise<void> {
  const env = loadEnvV2();
  const logger = createLogger(env.LOG_LEVEL);
  const instanceId = env.INSTANCE_ID ?? process.env["RAILWAY_DEPLOYMENT_ID"] ?? randomUUID();
  const bootedAt = Date.now();

  logger.info({ instanceId }, "V2 shadow radar starting");

  const db = createShadowDb(env.SHADOW_DATABASE_URL);
  try {
    await waitForShadowDbReady(db, logger);
  } catch (err) {
    logger.error(err, "shadow database did not become ready at startup");
    process.exit(1);
  }
  const hotRadarRepo = createHotRadarRepo(db);
  const outcomePointsRepo = createOutcomePointsRepo(db);

  let dbWriteFailures = 0;
  async function safeDbWrite(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      dbWriteFailures++;
      logger.error({ err, label }, "V2 shadow: persistence write failed (best-effort — never blocks the pipeline)");
    }
  }

  // §4.2 — separate RPC counters for the hot (launch/trade/holder feeds) vs
  // outcome (cold 1h/2h/6h/24h sampling) paths, kept as two independent
  // RpcMetrics instances so neither's growth can mask the other's (see
  // chain/client.ts's injectable-metrics param, added for this). This run's
  // cold sampler makes no real RPC calls at all (see runOutcomeSweep's
  // comment — the one call the adapter offers there, getLiquiditySnapshot,
  // always returns liquidityUsd: null, so it isn't worth the RPC spend),
  // so rpcMetricsOutcome legitimately reads zero this phase — that's the
  // honest number, not a placeholder.
  const rpcMetricsHot = new RpcMetrics();
  const rpcMetricsOutcome = new RpcMetrics();
  const rpcWeights = parseRpcCreditWeights(env.RPC_CREDIT_WEIGHTS_JSON);
  const rpcBudget24h = env.RPC_CREDIT_BUDGET_24H ?? null;

  const httpClient = createHttpClient(env.RH_RPC_HTTP, rpcMetricsHot);
  const adapter: RobinhoodAdapter = createRobinhoodAdapter({
    httpClient,
    createWsClient: () => createWsClient(env.RH_RPC_WS, rpcMetricsHot),
    dopplerAirlockAddress: env.DOPPLER_AIRLOCK_ADDRESS as `0x${string}`,
    ponsV1FactoryAddress: env.PONS_V1_FACTORY_ADDRESS as `0x${string}`,
    logger,
  });

  // §3 — shadow Telegram is opt-in and fails closed. All four isolation
  // conditions must hold; if any doesn't, alerting stays off and we log
  // exactly which one failed (never silently guess/enable).
  const telegramCheck = checkTelegramIsolation(process.env);
  const shadowTelegram: TelegramClient | undefined = telegramCheck.eligible
    ? createTelegramClient(env.V2_TELEGRAM_BOT_TOKEN!, env.V2_TELEGRAM_CHAT_ID!, logger)
    : undefined;
  if (!shadowTelegram) {
    logger.warn({ reasons: telegramCheck.reasons }, "V2 shadow: Telegram disabled — isolation conditions not met (spec §3)");
  } else {
    logger.info("V2 shadow: Telegram alerting enabled (independent bot/chat, verified isolated from V1)");
  }

  // §3.1 — rate-limit HOT specifically (the only tier expected to fire
  // often per §0); other tiers are rare enough this phase (confidence is
  // always LOW under the 4 unresolved inputs, capping every alert at WATCH)
  // that they never need folding.
  let hotMessagesThisMinute = 0;
  let hotFoldedThisMinute = 0;
  let currentMinuteBucket = Math.floor(Date.now() / 60_000);
  function rollHotRateLimitBucket(): void {
    const bucket = Math.floor(Date.now() / 60_000);
    if (bucket === currentMinuteBucket) return;
    if (hotFoldedThisMinute > 0) {
      void shadowTelegram
        ?.sendMessage(`🔥 HOT (folded): ${hotFoldedThisMinute} additional candidates crossed HOT in the last minute — see Shadow DB for detail`)
        .catch(() => {});
    }
    currentMinuteBucket = bucket;
    hotMessagesThisMinute = 0;
    hotFoldedThisMinute = 0;
  }

  async function sendShadowAlert(kind: "HOT" | "HARD_GATE_PASS" | "SHADOW_ALERT" | "HARD_REJECT" | "SYSTEM_ERROR", text: string): Promise<void> {
    if (!shadowTelegram) return;
    if (kind === "HOT") {
      rollHotRateLimitBucket();
      if (hotMessagesThisMinute >= MAX_HOT_TELEGRAM_PER_MIN) {
        hotFoldedThisMinute++;
        return;
      }
      hotMessagesThisMinute++;
    }
    await shadowTelegram.sendMessage(text).catch((err: unknown) => {
      logger.error({ err, kind }, "V2 shadow: Telegram send failed");
    });
  }

  const bookkeeping = new Map<string, CandidateBookkeeping>();
  const holderBalanceMap = new HolderBalanceMap();

  const manager = new HotCandidateManager({
    adapter,
    logger,
    holderBalanceMap,
    tickIntervalMs: env.TICK_INTERVAL_MS,

    onLaunch(candidate: HotCandidate) {
      void (async () => {
        const { id } = await hotRadarRepo.getOrCreateCandidate({
          chain: candidate.chain,
          tokenId: 0, // V2 has no V1-style `tokens` row of its own yet — see B3 report's known-gaps section.
          tokenAddress: candidate.tokenAddress,
          source: candidate.source,
          discoveredAt: candidate.discoveredAt,
          launchedAt: candidate.launchedAt,
          launchBlockNumber: candidate.launchBlockNumber,
          launchBlockHash: candidate.launchBlockHash,
          expiresAt: candidate.expiresAt,
        }).catch((err: unknown) => {
          dbWriteFailures++;
          logger.error({ err, token: candidate.tokenAddress }, "V2 shadow: failed to persist new candidate");
          return { id: -1 };
        });
        if (id === -1) return;
        bookkeeping.set(candidate.tokenAddress.toLowerCase(), {
          hotCandidateId: id,
          lastLoggedGateStatus: null,
          lastAlertTier: "NONE",
          outcomeScheduled: false,
        });
        await safeDbWrite("lifecycle:DISCOVERED", () =>
          hotRadarRepo.insertLifecycleEvent({
            hotCandidateId: id,
            eventAt: candidate.discoveredAt,
            ageMs: 0,
            field: "radarState",
            fromValue: null,
            toValue: "DISCOVERED",
            reason: null,
          }),
        );
      })();
    },

    onRadarStateChanged(candidate, from, to, ageMs) {
      const bk = bookkeeping.get(candidate.tokenAddress.toLowerCase());
      if (!bk) return;
      const mappedTo = to === "EXPIRED_30M" ? "EXPIRED" : to === "REJECTED" ? "REJECT" : to;
      void safeDbWrite("lifecycle:radarState", () =>
        hotRadarRepo.insertLifecycleEvent({
          hotCandidateId: bk.hotCandidateId,
          eventAt: new Date(),
          ageMs,
          field: "radarState",
          fromValue: from,
          toValue: mappedTo,
          reason: null,
          gateReasons: to === "REJECTED" ? candidate.gateReasons : null,
        }),
      );
      // §4 trigger: HOT is one of the three states (HOT/PASS/ALERT) that
      // starts outcome tracking.
      if (to === "HOT" && !bk.outcomeScheduled) {
        bk.outcomeScheduled = true;
        void safeDbWrite("outcome:schedule", () => outcomePointsRepo.scheduleAll(bk.hotCandidateId, new Date(), null));
      }
    },

    onScoreEvaluated(candidate, score, confidence, context: ScoreEvalContext) {
      const bk = bookkeeping.get(candidate.tokenAddress.toLowerCase());
      if (!bk) return;
      const dataStatus = buildDataStatus(context.gate.reasons, context.features["volume1m"] !== null || context.features["volume3m"] !== null);
      const now = new Date();

      void safeDbWrite("scoreSnapshot", () =>
        hotRadarRepo.insertScoreSnapshot({
          hotCandidateId: bk.hotCandidateId,
          scoreAt: now,
          ageMs: context.ageMs,
          breakoutScore: score.breakoutScore,
          organicScore: score.organicScore,
          kolScore: score.kol.score,
          risk: context.risk.level,
          confidence: confidence.level,
          breakdown: score,
          ruleVersion: score.ruleVersion,
          gateStatus: context.gate.status,
          gateReasons: context.gate.reasons,
          radarState: candidate.radarState,
          protocolState: candidate.protocolState,
          tier: context.tier,
          tierUncapped: context.tierUncapped,
          features: context.features,
          dataStatus,
        }),
      );

      void safeDbWrite("candidateLatest", () =>
        hotRadarRepo.updateCandidateLatest(bk.hotCandidateId, {
          radarState: candidate.radarState,
          protocolState: candidate.protocolState,
          gateStatus: context.gate.status,
          gateReasons: context.gate.reasons,
          latestBreakoutScore: score.breakoutScore,
          latestOrganicScore: score.organicScore,
          latestKolScore: score.kol.score,
          latestRisk: context.risk.level,
          latestConfidence: confidence.level,
          lastEvaluatedAt: now,
        }),
      );

      if (context.gate.status !== bk.lastLoggedGateStatus) {
        const from = bk.lastLoggedGateStatus;
        bk.lastLoggedGateStatus = context.gate.status;
        void safeDbWrite("lifecycle:gateStatus", () =>
          hotRadarRepo.insertLifecycleEvent({
            hotCandidateId: bk.hotCandidateId,
            eventAt: now,
            ageMs: context.ageMs,
            field: "gateStatus",
            fromValue: from,
            toValue: context.gate.status,
            reason: context.gate.reasons.join(","),
            gateReasons: context.gate.status === "PASS" ? null : context.gate.reasons,
          }),
        );
        // §4 trigger: PASS also starts outcome tracking, if HOT hasn't already.
        if (context.gate.status === "PASS" && !bk.outcomeScheduled) {
          bk.outcomeScheduled = true;
          const price = typeof context.features["price"] === "number" ? (context.features["price"] as number) : null;
          void safeDbWrite("outcome:schedule", () => outcomePointsRepo.scheduleAll(bk.hotCandidateId, now, price));
        }
      }
    },

    onAlert(candidate, decision, score) {
      const bk = bookkeeping.get(candidate.tokenAddress.toLowerCase());
      if (!bk) return;
      bk.lastAlertTier = decision.tier;
      const ageMs = Date.now() - candidate.launchedAt.getTime();

      void safeDbWrite("lifecycle:alert", () =>
        hotRadarRepo.insertLifecycleEvent({
          hotCandidateId: bk.hotCandidateId,
          eventAt: new Date(),
          ageMs,
          field: "alert",
          fromValue: null,
          toValue: "ALERT",
          reason: decision.reasons.join(","),
          reasonDetail: { tier: decision.tier, breakoutScore: score.breakoutScore },
        }),
      );

      // §4 trigger: ALERT also starts outcome tracking, if not already.
      if (!bk.outcomeScheduled && OUTCOME_TRIGGER_TIERS.has(decision.tier)) {
        bk.outcomeScheduled = true;
        void safeDbWrite("outcome:schedule", () => outcomePointsRepo.scheduleAll(bk.hotCandidateId, new Date(), null));
      }

      if (!OUTCOME_TRIGGER_TIERS.has(decision.tier)) return;
      const message = formatShadowAlertMessage({
        tier: decision.tier,
        chain: candidate.chain,
        tokenSymbol: null,
        tokenAddress: candidate.tokenAddress,
        ageSeconds: ageMs / 1000,
        breakoutScore: score.breakoutScore,
        organicScore: score.organicScore,
        kolScore: score.kol.score,
        risk: "LOW", // formatShadowAlertMessage's risk/confidence are display-only here; alertEngine already applied both to the tier decision itself.
        confidence: "LOW",
        marketCapUsd: null,
        liquidityUsd: null,
        volume1mUsd: null,
        volume3mUsd: null,
        volume5mUsd: null,
        accelerationPct: null,
        uniqueBuyers: [null, null, null],
        holders: [null, null, null],
        top10HolderPct: null,
        devHoldingPct: null,
        sellability: "UNKNOWN",
        independentKolCount: score.kol.distinctActors,
        scoreHistory: [score.breakoutScore],
      });
      void sendShadowAlert(decision.tier === "WATCH" ? "HOT" : "SHADOW_ALERT", message);
    },
  });

  await manager.start();
  logger.info("V2 shadow radar: HotCandidateManager started");

  // ------------------------------------------------------------------
  // Outcome sweep — §4.1 hot-pipeline fill (DB read only) + §4.2 cold
  // sample (adapter.getLiquiditySnapshot, best-effort, see comment above
  // rpcMetricsOutcome's declaration for the RPC-attribution caveat).
  // ------------------------------------------------------------------
  async function runOutcomeSweep(): Promise<void> {
    const now = new Date();

    const hotDue = await outcomePointsRepo.listDue(now, 200, true).catch(() => []);
    for (const point of hotDue) {
      const nearest = await hotRadarRepo
        .getNearestSnapshotPrice(point.hotCandidateId, point.scheduledAt, HOT_PIPELINE_TOLERANCE_MS)
        .catch(() => null);
      const price = nearest?.price ?? null;
      const returnPct = computeReturnPct(point.baselinePrice, price);
      const series = await hotRadarRepo.listSnapshotPricesUpTo(point.hotCandidateId, point.scheduledAt).catch(() => []);
      const { maxReturnPct, maxDrawdownPct } = computeMaxReturnAndDrawdown(point.baselinePrice, series, point.scheduledAt);
      await safeDbWrite("outcome:hotFill", () =>
        outcomePointsRepo.markSampled(point.id, now, {
          price,
          returnPct,
          maxReturnPct,
          maxDrawdownPct,
          liquidityUsd: null,
          volumeUsd: null,
          holders: null,
          dataSource: nearest ? "hot_pipeline" : null,
          dataStatus: nearest ? "OK" : "UNKNOWN",
          dataStatusReason: nearest ? null : "no score-history snapshot within tolerance of the scheduled time",
        }),
      );
    }

    // §4.2 cold sample (1h/2h/6h/24h) — KNOWN GAP, reported rather than
    // faked (spec §6): the adapter's getLiquiditySnapshot only resolves a
    // token via the routing table startLaunchDiscovery builds, and even
    // then always returns liquidityUsd: null (B1.3 — USD conversion isn't
    // wired up; liquidityUsd is itself one of the 4 unresolved inputs).
    // Calling it here would cost a real RPC round trip per candidate for a
    // result that's null either way, so these points are marked DONE with
    // an honest UNKNOWN rather than spending RPC budget on a call with no
    // possible OK outcome. See the B3 deployment report §K for the
    // low-cost fix (wire liquidityUsd, then this sweep can call it for
    // real and rpcMetricsOutcome starts recording actual requests).
    const coldDue = await outcomePointsRepo.listDue(now, 50, false).catch(() => []);
    for (const point of coldDue) {
      await safeDbWrite("outcome:coldFill", () =>
        outcomePointsRepo.markSampled(point.id, now, {
          price: null,
          returnPct: null,
          maxReturnPct: null,
          maxDrawdownPct: null,
          liquidityUsd: null,
          volumeUsd: null,
          holders: null,
          dataSource: null,
          dataStatus: "UNKNOWN",
          dataStatusReason:
            "cold post-expiry price/liquidity sampling not implemented this phase — adapter has no USD liquidity conversion (liquidityUsd unresolved per spec §0) and no price/volume oracle beyond the live trade feed",
        }),
      );
    }
  }
  const outcomeSweepTimer = setInterval(() => {
    runOutcomeSweep().catch((err: unknown) => logger.error({ err }, "V2 shadow: outcome sweep failed"));
  }, env.OUTCOME_SWEEP_INTERVAL_MS ?? OUTCOME_SWEEP_DEFAULT_MS);
  outcomeSweepTimer.unref();

  // ------------------------------------------------------------------
  // HTTP server — /health only (spec §5). All B3-specific fields are
  // computed here (async DB reads), then merged into buildV2Health's pure
  // output via its `b3` input bag.
  // ------------------------------------------------------------------
  const app = Fastify({ loggerInstance: logger });
  app.get("/health", async () => {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60_000);
    const counters = manager.getCounters();
    const adapterStatus = adapter.getStatus();
    const holderHealth = holderBalanceMap.health();

    const [
      launches24h,
      hotCount24h,
      passCount24h,
      rejectCount24h,
      unknownCount24h,
      alertCount24h,
      earlyObs24h,
      unknownByReason,
      tierUncappedDistribution,
      scoreHistoryRowsToday,
      outcomePointsByOffset,
      pendingOutcomePoints,
      oldestHotAgeMs,
    ] = await Promise.all([
      hotRadarRepo.countCandidatesDiscovered(since24h),
      hotRadarRepo.countLifecycleEventsByToValue("radarState", "HOT", since24h),
      hotRadarRepo.countLifecycleEventsByToValue("gateStatus", "PASS", since24h),
      hotRadarRepo.countLifecycleEventsByToValue("radarState", "REJECT", since24h),
      hotRadarRepo.countLifecycleEventsByToValue("gateStatus", "UNKNOWN_REVIEW", since24h),
      hotRadarRepo.countLifecycleEventsByToValue("alert", "ALERT", since24h),
      hotRadarRepo.countLifecycleEventsByToValue("radarState", "EARLY_OBSERVATION", since24h),
      hotRadarRepo.unknownByReason(null),
      hotRadarRepo.tierUncappedDistribution(since24h),
      hotRadarRepo.scoreHistoryRowsToday(),
      outcomePointsRepo.countByStatusAndOffset(),
      outcomePointsRepo.countPending(),
      hotRadarRepo.oldestHotCandidateAgeMs(now),
    ]).catch((err: unknown) => {
      logger.error({ err }, "V2 shadow: /health aggregate queries failed");
      throw err;
    });

    const hotSnapshot = rpcMetricsHot.snapshot();
    const outcomeSnapshot = rpcMetricsOutcome.snapshot();
    const rpcBudget = computeRpcBudgetSnapshot(hotSnapshot, rpcWeights, rpcBudget24h);
    const dbStatus = await checkShadowDatabase(db);

    return buildV2Health({
      chainId: 4663,
      wsConnected: adapterStatus.connected,
      counters,
      rpcMetrics: hotSnapshot,
      rpcBudget,
      holderBalanceMapHealth: holderHealth,
      b3: {
        uptime: (Date.now() - bootedAt) / 1000,
        serviceMode: "shadow",
        instanceId,
        dbStatus,
        wssStatus: adapterStatus.connected ? "connected" : "disconnected",
        latestBlock: adapterStatus.lastKnownBlock?.toString() ?? null,
        wssReconnectCount: adapterStatus.reconnectCount,
        launchesSeen: { sinceBoot: counters.launchesTotal, last24h: launches24h },
        earlyObservationCount: { sinceBoot: earlyObs24h, last24h: earlyObs24h },
        hotCount: { sinceBoot: hotCount24h, last24h: hotCount24h },
        passCount: { sinceBoot: passCount24h, last24h: passCount24h },
        rejectCount: { sinceBoot: counters.hardRejected, last24h: rejectCount24h },
        unknownCount: { sinceBoot: counters.unknownReview, last24h: unknownCount24h },
        alertCount: { sinceBoot: Object.values(counters.alertsByTier).reduce((a, b) => a + b, 0), last24h: alertCount24h },
        rpcRequestsPerMin: hotSnapshot.rpcRequests1m + outcomeSnapshot.rpcRequests1m,
        rpcRequestsHotPerMin: hotSnapshot.rpcRequests1m,
        rpcRequestsOutcomePerMin: outcomeSnapshot.rpcRequests1m,
        estimatedRpcPerDay: rpcBudget.estimatedRpcCredits24h,
        dbWriteFailures,
        duplicateEventCount: counters.duplicateTransfers,
        missedEventCount: null,
        scoreHistoryRowsToday,
        balanceTableSize: holderHealth.balanceTableAddresses,
        pendingOutcomePoints,
        unknownByReason,
        tierUncappedDistribution,
        outcomePointsByOffset,
      },
    });
  });

  try {
    await app.listen({ port: env.PORT, host: "::" });
  } catch (err) {
    logger.error(err, "V2 shadow: failed to start HTTP server");
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Graceful shutdown — same order/reasoning as V1's index.ts.
  // ------------------------------------------------------------------
  const SHUTDOWN_TIMEOUT_MS = 15_000;
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "V2 shadow: shutdown requested");
    const timeout = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "V2 shadow: graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    try {
      logger.info("V2 shadow: stopping http server");
      await app.close();
      logger.info("V2 shadow: stopping manager");
      await manager.stop();
      clearInterval(outcomeSweepTimer);
      logger.info("V2 shadow: closing database");
      await db.$client.end();
      clearTimeout(timeout);
      logger.info("V2 shadow: shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(timeout);
      logger.error({ err }, "V2 shadow: error during shutdown");
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
