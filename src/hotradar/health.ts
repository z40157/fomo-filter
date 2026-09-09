// Spec B5 — V2 health snapshot. Pure assembly function (no I/O) so it's
// testable without a running server; a V2 process wires this into its own
// /health route the same way V1's api/routes/health.ts does, but as a
// fully separate file/route — V1's health endpoint and AppContext are
// never touched.
import type { RpcMetricsSnapshot } from "../chain/rpcMetrics.js";
import type { RpcBudgetSnapshot } from "./rpcBudget.js";
import type { HolderBalanceMapHealth } from "./holderBalanceMap.js";
import type { ManagerCounters } from "./manager.js";
import type { UnknownReasonCounts, TierUncappedDistribution } from "../db/hotRadarRepo.js";
import type { OutcomeOffsetLabel } from "./outcomeScheduler.js";

/** A count with both an all-time-since-boot figure and a DB-backed
 * (restart-durable) last-24h figure — spec §5.1: "重启后数字归零，24h报告没法
 * 解读" — never expose a bare count without saying which window it is. */
export interface WindowedCount {
  sinceBoot: number;
  last24h: number;
}

export interface V2HealthSnapshot {
  // Carried over from V1 (spec B5: "保留全部V1 fields") — a real V2
  // process fills these from its own watcher/DB/candidate-tracker
  // equivalents; kept optional here since this module has no I/O of its
  // own to source them from.
  status: "ok";
  chainId: number;
  wsConnected: boolean;

  // New V2 fields
  hotCandidates: number;
  launchesLast30m: number;
  hardRejectedLast30m: number;
  unknownReviewLast30m: number;
  watchCandidates: number;
  earlyRadarToday: number;
  strongToday: number;
  urgentToday: number;
  watchlistBuyHits24h: number;
  activeWatchlistWallets24h: number;

  rpcRequests1m: number;
  rpcRequests24h: number;
  ethGetLogs1m: number;
  ethGetLogs24h: number;
  ethCall1m: number;
  ethGetTransaction1m: number;
  ethGetReceipt1m: number;
  ethGetBlock1m: number;
  wsEvents1m: number;

  estimatedRpcCredits24h: number;
  rpcBudget24h: number | null;
  rpcBudgetUsagePct: number | null;

  balanceTableTokens: number;
  balanceTableAddresses: number;
  balanceTableEvictions: number;

  // ------------------------------------------------------------------
  // B3 §5 — shadow-run-specific fields. Optional so the B5 pure-function
  // tests (and any future non-shadow caller of buildV2Health) don't need
  // to supply them; indexV2.ts's real /health route always does.
  // ------------------------------------------------------------------
  uptime?: number;
  serviceMode?: "shadow";
  instanceId?: string;
  dbStatus?: "ok" | "error";
  wssStatus?: "connected" | "disconnected" | "reconnecting";
  latestBlock?: string | null;
  wssReconnectCount?: number;

  launchesSeen?: WindowedCount;
  earlyObservationCount?: WindowedCount;
  hotCount?: WindowedCount;
  passCount?: WindowedCount;
  rejectCount?: WindowedCount;
  unknownCount?: WindowedCount;
  alertCount?: WindowedCount;

  rpcRequestsPerMin?: number;
  rpcRequestsHotPerMin?: number;
  rpcRequestsOutcomePerMin?: number;
  estimatedRpcPerDay?: number;

  dbWriteFailures?: number;
  duplicateEventCount?: number;
  missedEventCount?: number | null;

  scoreHistoryRowsToday?: number;
  balanceTableSize?: number;
  pendingOutcomePoints?: number;

  unknownByReason?: UnknownReasonCounts;
  tierUncappedDistribution?: TierUncappedDistribution;
  outcomePointsByOffset?: Record<OutcomeOffsetLabel, { done: number; pending: number }>;
}

export interface BuildV2HealthInputs {
  chainId: number;
  wsConnected: boolean;
  counters: ManagerCounters;
  rpcMetrics: RpcMetricsSnapshot;
  rpcBudget: RpcBudgetSnapshot;
  holderBalanceMapHealth: HolderBalanceMapHealth;
  /** Fields the manager's rolling counters don't currently distinguish
   * ("last30m" / "today" windows) — a real process would compute these
   * from persisted hot_candidates/candidate_score_history rows; this
   * builder accepts them as already-computed so it stays pure. Defaults
   * to the manager's all-time counters where a windowed figure isn't
   * available yet, clearly documented as an approximation. */
  windowedOverrides?: Partial<
    Pick<
      V2HealthSnapshot,
      | "hotCandidates"
      | "launchesLast30m"
      | "hardRejectedLast30m"
      | "unknownReviewLast30m"
      | "watchCandidates"
      | "earlyRadarToday"
      | "strongToday"
      | "urgentToday"
      | "watchlistBuyHits24h"
      | "activeWatchlistWallets24h"
    >
  >;
  /** B3 §5 fields — see V2HealthSnapshot's own comment for why these are
   * grouped separately (all optional, only the real shadow process supplies
   * them). Passed through to the output as-is, no defaulting/derivation —
   * this function stays pure/I/O-free either way. */
  b3?: Pick<
    V2HealthSnapshot,
    | "uptime"
    | "serviceMode"
    | "instanceId"
    | "dbStatus"
    | "wssStatus"
    | "latestBlock"
    | "wssReconnectCount"
    | "launchesSeen"
    | "earlyObservationCount"
    | "hotCount"
    | "passCount"
    | "rejectCount"
    | "unknownCount"
    | "alertCount"
    | "rpcRequestsPerMin"
    | "rpcRequestsHotPerMin"
    | "rpcRequestsOutcomePerMin"
    | "estimatedRpcPerDay"
    | "dbWriteFailures"
    | "duplicateEventCount"
    | "missedEventCount"
    | "scoreHistoryRowsToday"
    | "balanceTableSize"
    | "pendingOutcomePoints"
    | "unknownByReason"
    | "tierUncappedDistribution"
    | "outcomePointsByOffset"
  >;
}

export function buildV2Health(inputs: BuildV2HealthInputs): V2HealthSnapshot {
  const alertsByTier = inputs.counters.alertsByTier;
  return {
    status: "ok",
    chainId: inputs.chainId,
    wsConnected: inputs.wsConnected,

    hotCandidates: inputs.windowedOverrides?.hotCandidates ?? 0,
    launchesLast30m: inputs.windowedOverrides?.launchesLast30m ?? inputs.counters.launchesTotal,
    hardRejectedLast30m: inputs.windowedOverrides?.hardRejectedLast30m ?? inputs.counters.hardRejected,
    unknownReviewLast30m: inputs.windowedOverrides?.unknownReviewLast30m ?? inputs.counters.unknownReview,
    watchCandidates: inputs.windowedOverrides?.watchCandidates ?? (alertsByTier["WATCH"] ?? 0),
    earlyRadarToday: inputs.windowedOverrides?.earlyRadarToday ?? (alertsByTier["EARLY_RADAR"] ?? 0),
    strongToday: inputs.windowedOverrides?.strongToday ?? (alertsByTier["STRONG"] ?? 0),
    urgentToday: inputs.windowedOverrides?.urgentToday ?? (alertsByTier["URGENT"] ?? 0),
    watchlistBuyHits24h: inputs.windowedOverrides?.watchlistBuyHits24h ?? 0,
    activeWatchlistWallets24h: inputs.windowedOverrides?.activeWatchlistWallets24h ?? 0,

    rpcRequests1m: inputs.rpcMetrics.rpcRequests1m,
    rpcRequests24h: inputs.rpcMetrics.rpcRequests24h,
    ethGetLogs1m: inputs.rpcMetrics.ethGetLogs1m,
    ethGetLogs24h: inputs.rpcMetrics.ethGetLogs24h,
    ethCall1m: inputs.rpcMetrics.ethCall1m,
    ethGetTransaction1m: inputs.rpcMetrics.ethGetTransaction1m,
    ethGetReceipt1m: inputs.rpcMetrics.ethGetReceipt1m,
    ethGetBlock1m: inputs.rpcMetrics.ethGetBlock1m,
    wsEvents1m: inputs.rpcMetrics.wsEvents1m,

    estimatedRpcCredits24h: inputs.rpcBudget.estimatedRpcCredits24h,
    rpcBudget24h: inputs.rpcBudget.rpcBudget24h,
    rpcBudgetUsagePct: inputs.rpcBudget.rpcBudgetUsagePct,

    balanceTableTokens: inputs.holderBalanceMapHealth.balanceTableTokens,
    balanceTableAddresses: inputs.holderBalanceMapHealth.balanceTableAddresses,
    balanceTableEvictions: inputs.holderBalanceMapHealth.balanceTableEvictions,

    ...inputs.b3,
  };
}
