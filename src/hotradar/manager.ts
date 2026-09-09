// Glue layer wiring a ChainAdapter's normalized events into the
// lifecycle/gate/scoring/alert pieces built earlier in Phase A/B. This is
// intentionally the thinnest layer that can produce a real, observable
// Hot Radar — DB persistence (hot_candidates / candidate_score_history /
// token_lifecycle_events) is a natural next step once schemaV2's repos
// exist, but is not required to run the B1.11 short live test or exercise
// the decision logic end-to-end, so it's left as an explicit extension
// point (see `onScoreEvaluated`/`onAlert` callbacks) rather than baked in.
import type { Logger } from "../logger.js";
import type { ChainAdapter, TradeEvent } from "../chains/types.js";
import { agePhase, ageMs as computeAgeMs, isExpired, nextRadarState, refreshCadenceMsForAge } from "./lifecycle.js";
import { evaluateHardGate, type HardGateInputs } from "./hardGate.js";
import { nextCheckTier, type CheckTier } from "./checkTiers.js";
import { HolderBalanceMap } from "./holderBalanceMap.js";
import { TokenMarketState } from "./marketState.js";
import {
  aggregateScore,
  computeConfidence,
  computeRisk,
  scoreCreator,
  scoreDistribution,
  scoreEarlyness,
  scoreKol,
  scoreLifecycle,
  scoreLiquidity,
  scoreNarrative,
  scoreOrganicMomentum,
  type KolWalletBuy,
  type ScoreBreakdown,
} from "./scoring.js";
import { decideAlertTier, tierForScore, type AlertDecision, type AlertTier } from "./alertEngine.js";
import type { GateResult, HotCandidate, RadarState } from "./types.js";

export interface WatchlistLookup {
  (wallet: string): { ownerGroup: string; tier: "A" | "B" | "C" } | undefined;
}

/** Everything B3 shadow-run persistence (spec §2.2) needs beyond the
 * score/confidence this callback already carried — kept as one additive
 * 4th parameter rather than widening the existing (candidate, score,
 * confidence) shape, so pre-existing callers/tests that only destructure
 * the first two/three positional args are unaffected. Nothing here changes
 * what score/gate/confidence *are* — it only surfaces values already
 * computed inside evaluateCandidate for a caller that wants to persist
 * them (spec §6 rule freeze: plumbing, not scoring/gate changes). */
export interface ScoreEvalContext {
  ageMs: number;
  risk: ReturnType<typeof computeRisk>;
  gate: GateResult;
  /** Actual alert tier for this evaluation, after the full override ladder
   * (confidence cap, risk downgrade, age rules) — same value onAlert would
   * receive as decision.tier. */
  tier: AlertTier;
  /** §5.3 — tierForScore(breakoutScore) alone, with neither the confidence
   * cap nor the risk override applied. Persisted/counted only, never sent
   * as an alert. */
  tierUncapped: AlertTier;
  /** Raw feature values (not scores) feeding this evaluation — spec §2.2:
   * "features 必须存原始值...不是归一化后的分数". */
  features: Record<string, unknown>;
}

export interface HotCandidateManagerDeps {
  adapter: ChainAdapter;
  logger: Logger;
  watchlistLookup?: WatchlistLookup;
  tickIntervalMs?: number;
  hardGateConfig?: Partial<HardGateInputs>;
  onScoreEvaluated?: (
    candidate: HotCandidate,
    score: ScoreBreakdown,
    confidence: ReturnType<typeof computeConfidence>,
    context: ScoreEvalContext,
  ) => void;
  onAlert?: (candidate: HotCandidate, decision: AlertDecision, score: ScoreBreakdown) => void;
  /** Fired once, synchronously, the moment a new candidate is created —
   * before the first tick ever evaluates it. Lets a persistence layer
   * insert the hot_candidates row and a DISCOVERED lifecycle event without
   * waiting for (or inferring it from) the first score evaluation. */
  onLaunch?: (candidate: HotCandidate) => void;
  /** Fired whenever radarState actually changes value during a tick (never
   * once per tick regardless of change — see spec §2.1: "每次转换一行", not
   * every evaluation). Covers DISCOVERED->EARLY_OBSERVATION->HOT and the
   * two terminal transitions (->REJECTED, ->EXPIRED_30M), which onScoreEvaluated
   * alone can't see since evaluateCandidate is skipped once a candidate is
   * terminal (see tick()'s early `continue`). */
  onRadarStateChanged?: (candidate: HotCandidate, from: RadarState, to: RadarState, ageMs: number) => void;
  holderBalanceMap?: HolderBalanceMap;
}

interface CandidateState {
  candidate: HotCandidate;
  market: TokenMarketState;
  kolBuys: KolWalletBuy[];
  lastAlertedScore: number | null;
  lastCheckTier: CheckTier;
}

export interface ManagerCounters {
  launchesTotal: number;
  hardRejected: number;
  unknownReview: number;
  passedGate: number;
  alertsByTier: Record<string, number>;
  /** B3 §5 — count of Transfer events HolderBalanceMap.applyTransfer()
   * reported as already-seen (dedup by txHash+logIndex), the closest
   * available proxy for spec's `duplicateEventCount` health field. */
  duplicateTransfers: number;
}

export class HotCandidateManager {
  private readonly candidates = new Map<string, CandidateState>();
  private readonly holderMap: HolderBalanceMap;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly counters: ManagerCounters = {
    launchesTotal: 0,
    hardRejected: 0,
    unknownReview: 0,
    passedGate: 0,
    alertsByTier: {},
    duplicateTransfers: 0,
  };

  constructor(private readonly deps: HotCandidateManagerDeps) {
    this.holderMap = deps.holderBalanceMap ?? new HolderBalanceMap();
  }

  getCounters(): ManagerCounters {
    return { ...this.counters, alertsByTier: { ...this.counters.alertsByTier } };
  }

  getActiveTokenAddresses(): string[] {
    return [...this.candidates.values()]
      .filter((c) => c.candidate.radarState !== "REJECTED" && c.candidate.radarState !== "EXPIRED_30M")
      .map((c) => c.candidate.tokenAddress);
  }

  getCandidate(tokenAddress: string): HotCandidate | undefined {
    return this.candidates.get(tokenAddress.toLowerCase())?.candidate;
  }

  /** Read-only passthrough to the holder balance map, for callers building
   * a raw-feature snapshot to persist (spec §2.2) — never used by scoring
   * itself, which still gets holderCount as null (B2.5: real holder growth
   * isn't wired into scoring in this phase). */
  getHolderCount(tokenAddress: string): number {
    return this.holderMap.getHolderCount(tokenAddress);
  }

  async start(): Promise<void> {
    await this.deps.adapter.startLaunchDiscovery((launch) => {
      const key = launch.tokenAddress.toLowerCase();
      if (this.candidates.has(key)) return;
      this.counters.launchesTotal++;
      const now = launch.launchedAt;
      const candidate: HotCandidate = {
        chain: launch.chain,
        tokenAddress: launch.tokenAddress,
        source: launch.source,
        discoveredAt: now,
        launchedAt: launch.launchedAt,
        launchBlockNumber: launch.launchBlockNumber,
        launchBlockHash: launch.launchBlockHash,
        expiresAt: new Date(launch.launchedAt.getTime() + 30 * 60_000),
        radarState: "DISCOVERED",
        protocolState: "UNKNOWN",
        gateStatus: "UNKNOWN_REVIEW",
        gateReasons: [],
        invalidated: false,
        invalidatedReason: null,
      };
      this.candidates.set(key, {
        candidate,
        market: new TokenMarketState(),
        kolBuys: [],
        lastAlertedScore: null,
        lastCheckTier: "CHEAP",
      });
      this.deps.logger.info({ chain: launch.chain, source: launch.source, token: launch.tokenAddress }, "hot radar: new candidate discovered");
      this.deps.onLaunch?.(candidate);
    });

    await this.deps.adapter.startHotTradeFeed(
      () => this.getActiveTokenAddresses(),
      (trade) => this.onTrade(trade),
    );

    if (this.deps.adapter.startHolderFeed) {
      await this.deps.adapter.startHolderFeed(
        () => this.getActiveTokenAddresses(),
        (transfer) => {
          const result = this.holderMap.applyTransfer(transfer.tokenAddress, {
            from: transfer.from,
            to: transfer.to,
            amount: transfer.amount,
            txHash: transfer.txHash,
            logIndex: transfer.logIndex,
          });
          if (result === "duplicate") this.counters.duplicateTransfers++;
        },
      );
    }

    const interval = this.deps.tickIntervalMs ?? 10_000;
    this.tickTimer = setInterval(() => this.tick(new Date()), interval);
    this.tickTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.deps.adapter.stopHotTradeFeed();
    if (this.deps.adapter.stopHolderFeed) await this.deps.adapter.stopHolderFeed();
    await this.deps.adapter.stopLaunchDiscovery();
  }

  private onTrade(trade: TradeEvent): void {
    const state = this.candidates.get(trade.tokenAddress.toLowerCase());
    if (!state) return;
    state.market.recordTrade(trade, null);

    const watched = this.deps.watchlistLookup?.(trade.wallet);
    if (watched && trade.side === "BUY") {
      state.kolBuys.push({ wallet: trade.wallet, ownerGroup: watched.ownerGroup, tier: watched.tier });
    }
  }

  /** Runs one evaluation pass over every tracked candidate — radarState
   * transition, gate, scoring, alert decision. Exposed for tests; also
   * invoked by the internal timer. */
  tick(now: Date): void {
    for (const [key, state] of this.candidates) {
      const ms = computeAgeMs(now, state.candidate.launchedAt);
      const wasExpired = state.candidate.radarState === "EXPIRED_30M" || state.candidate.radarState === "REJECTED";
      const previousRadarState = state.candidate.radarState;

      state.candidate.radarState = nextRadarState({
        ageMs: ms,
        currentState: state.candidate.radarState,
        gateStatus: state.candidate.gateStatus,
      });
      if (state.candidate.radarState !== previousRadarState) {
        this.deps.onRadarStateChanged?.(state.candidate, previousRadarState, state.candidate.radarState, ms);
      }

      if (isExpired(ms) && !wasExpired) {
        this.holderMap.release(key);
        this.deps.logger.info({ token: state.candidate.tokenAddress }, "hot radar: candidate expired (30m) — releasing holder map, stopping high-frequency refresh");
        continue;
      }
      if (state.candidate.radarState === "EXPIRED_30M" || state.candidate.radarState === "REJECTED") {
        continue; // spec A.6/A.7: no further high-frequency evaluation once terminal
      }

      const cadence = refreshCadenceMsForAge(ms);
      if (cadence === null) continue;

      this.evaluateCandidate(state, ms, now);
    }
  }

  private evaluateCandidate(state: CandidateState, ageMs: number, now: Date): void {
    const gateInputs: HardGateInputs = {
      ageMs,
      sellability: "UNKNOWN", // Expensive-tier only (A.11) — cheap/medium ticks never claim to know this
      creatorLaunches24h: null,
      contractRedFlags: [],
      contractRedFlagsCheckable: false,
      liquidityThinness: "UNKNOWN",
      creatorDumpSeverity: null,
      topTraderConcentration: { top3SharePct: null, uniqueTraders: null },
      holderConcentrationTrend: null,
      ...this.deps.hardGateConfig,
    };
    const gate = evaluateHardGate(gateInputs);
    const previousGateStatus = state.candidate.gateStatus;
    state.candidate.gateStatus = gate.status;
    state.candidate.gateReasons = gate.reasons;
    if (previousGateStatus !== "REJECT" && gate.status === "REJECT") this.counters.hardRejected++;
    if (gate.status === "UNKNOWN_REVIEW") this.counters.unknownReview++;
    if (gate.status === "PASS") this.counters.passedGate++;

    const cheapGatePassed = gate.status !== "REJECT";
    const tier = nextCheckTier({ cheapGatePassed, organicScore: null });
    state.lastCheckTier = tier;

    const snapshot = state.market.snapshot(now.getTime());
    const w1m = snapshot.windows["1m"];

    const organicMomentum = scoreOrganicMomentum({
      volumeVelocity: snapshot.volumeVelocity,
      volumeAcceleration: snapshot.volumeAcceleration,
      uniqueBuyerVelocity: snapshot.uniqueBuyerVelocity,
      netBuyFlowUsd: w1m.netBuyFlow,
    });
    const distribution = scoreDistribution({
      uniqueBuyerVelocity: snapshot.uniqueBuyerVelocity,
      holderGrowth: null,
      top10HolderPct: null,
      sameWalletBuyRatio: null,
    });
    const liquidity = scoreLiquidity({ liquidityUsd: null, liquidityGrowth: null, liquidityToMcRatio: null, sellabilityStatus: "UNKNOWN" });
    const creator = scoreCreator({ launchesTotal: null, earlySellCount: null, survived24hRatio: null });
    const lifecycle = scoreLifecycle({ protocolState: state.candidate.protocolState });
    const narrative = scoreNarrative({ manualBoost: null });
    const earlyness = scoreEarlyness(ageMs);
    const kol = scoreKol(state.kolBuys);

    const score = aggregateScore({ organicMomentum, distribution, liquidity, creator, lifecycle, narrative, earlyness, kol });
    const confidence = computeConfidence({
      marketDataComplete: w1m.volume !== null,
      holderDataComplete: false,
      creatorDataComplete: false,
      sellabilityKnown: false,
      walletAttributionReliable: kol.clusteringAvailable,
      windowCompleteness: w1m.volume !== null ? 1 : 0,
    });
    const risk = computeRisk({ gateStatus: gate.status, creatorDumpSeverity: null, washTradeShaped: false });

    const decision = decideAlertTier({ breakoutScore: score.breakoutScore, risk: risk.level, confidence: confidence.level, ageMs });

    this.deps.onScoreEvaluated?.(state.candidate, score, confidence, {
      ageMs,
      risk,
      gate,
      tier: decision.tier,
      tierUncapped: tierForScore(score.breakoutScore),
      features: {
        volume1m: w1m.volume,
        buys1m: w1m.buys,
        sells1m: w1m.sells,
        uniqueBuyers1m: w1m.uniqueBuyers,
        uniqueTraders1m: w1m.uniqueTraders,
        netBuyFlow1m: w1m.netBuyFlow,
        volume3m: snapshot.windows["3m"].volume,
        uniqueBuyers3m: snapshot.windows["3m"].uniqueBuyers,
        volume5m: snapshot.windows["5m"].volume,
        uniqueBuyers5m: snapshot.windows["5m"].uniqueBuyers,
        volumeVelocity: snapshot.volumeVelocity,
        volumeAcceleration: snapshot.volumeAcceleration,
        uniqueBuyerVelocity: snapshot.uniqueBuyerVelocity,
        tradeIntervalSeconds: snapshot.tradeIntervalSeconds,
        price: snapshot.price,
        holderCount: this.holderMap.getHolderCount(state.candidate.tokenAddress),
        kolBuysCount: state.kolBuys.length,
        sellability: gateInputs.sellability,
        creatorLaunches24h: gateInputs.creatorLaunches24h,
        liquidityThinness: gateInputs.liquidityThinness,
        topTraderConcentration: gateInputs.topTraderConcentration,
        holderConcentrationTrend: gateInputs.holderConcentrationTrend,
      },
    });

    const isFirstAlert = state.lastAlertedScore === null;
    if (decision.tier !== "NONE" && (isFirstAlert || score.breakoutScore - state.lastAlertedScore! >= 0.01)) {
      this.counters.alertsByTier[decision.tier] = (this.counters.alertsByTier[decision.tier] ?? 0) + 1;
      state.lastAlertedScore = score.breakoutScore;
      this.deps.onAlert?.(state.candidate, decision, score);
    }
  }
}

export function ageBucket(ms: number): "0-3m" | "3-10m" | "10-20m" | "20-30m" {
  const phase = agePhase(ms);
  if (phase === "DISCOVERED" || phase === "EARLY_OBSERVATION") return "0-3m";
  if (phase === "HOT_FIRST") return "3-10m";
  if (phase === "HOT_SECOND") return "10-20m";
  return "20-30m";
}
