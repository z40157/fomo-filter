// Phase 9 — Outcome Tracker runtime. Two responsibilities:
//
//  1. onSignalCreated(): at signal time, for any signal scoring >= 6.0,
//     capture a baseline (a fresh DexScreener fetch) and write the outcome
//     row + its five unrecorded points (+5m/+15m/+1h/+6h/+24h).
//
//  2. a restart-tolerant sweeper: on a timer, read still-pending points
//     whose due_at has passed straight from the DB, fetch current market
//     data, and fill each one in — recording the ACTUAL delay, never
//     pretending a late sample was on time. No per-signal setTimeout: those
//     are lost on restart and don't scale to thousands of signals.
//
// Every failure is caught and logged; nothing here can block or throw back
// into the resonance/signal pipeline. Missing data is written as null.

import type { Logger } from "../logger.js";
import type { RiskLevel } from "../signals/risk.js";
import type { ConfidenceLevel, ScoreBreakdown } from "../signals/scoring.js";
import type { SignalOutcomesRepo } from "../db/signalOutcomes.js";
import {
  DEFAULT_OUTCOME_OFFSETS,
  buildPointSchedule,
  computeActualDelaySeconds,
  computeChangePct,
  computeOutcomeSummary,
  isDelayed,
  shouldTrackOutcome,
  type OutcomeOffset,
} from "./outcomeTrackerLogic.js";

const DEFAULT_SWEEP_BATCH_SIZE = 25;

/** Narrow view of the DexScreener client — only what the tracker reads. */
export interface OutcomeMarketSource {
  getTokenSnapshot(tokenAddress: string): Promise<{
    priceUsd: number | null;
    marketCap: number | null;
    liquidityUsd: number | null;
    volume5m: number | null;
  } | null>;
}

export interface SignalCreatedInput {
  signalId: number;
  tokenId: number;
  tokenAddress: string;
  importanceScore: number;
  riskLevel: RiskLevel | null;
  confidence: ConfidenceLevel | null;
  scoreBreakdown: ScoreBreakdown;
  triggeredAt: Date;
}

export interface OutcomeTrackerDeps {
  outcomesRepo: SignalOutcomesRepo;
  marketSource: OutcomeMarketSource;
  scoringRuleVersion: number;
  logger: Logger;
  now?: () => Date;
  offsets?: readonly OutcomeOffset[];
  sweepBatchSize?: number;
}

export interface OutcomeSweepResult {
  recorded: number;
  withData: number;
  withoutData: number;
  delayed: number;
}

export interface OutcomeTracker {
  /** Best-effort; never throws. Creates the baseline + schedule for a >=6.0 signal. */
  onSignalCreated(input: SignalCreatedInput): Promise<void>;
  /** One sweeper pass over due-and-pending points. */
  runOnce(): Promise<OutcomeSweepResult>;
  start(intervalMs: number): void;
  stop(): void;
}

export function createOutcomeTracker(deps: OutcomeTrackerDeps): OutcomeTracker {
  const now = deps.now ?? (() => new Date());
  const offsets = deps.offsets ?? DEFAULT_OUTCOME_OFFSETS;
  const sweepBatchSize = deps.sweepBatchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function onSignalCreated(input: SignalCreatedInput): Promise<void> {
    try {
      if (!shouldTrackOutcome(input.importanceScore)) return;

      let baselinePrice: number | null = null;
      let baselineMarketCap: number | null = null;
      let baselineLiquidity: number | null = null;
      try {
        const snap = await deps.marketSource.getTokenSnapshot(input.tokenAddress);
        if (snap) {
          baselinePrice = snap.priceUsd;
          baselineMarketCap = snap.marketCap;
          baselineLiquidity = snap.liquidityUsd;
        }
      } catch (err) {
        deps.logger.warn(
          { err, signalId: input.signalId },
          "outcome baseline DexScreener fetch failed — recording an outcome with no baseline",
        );
      }

      const baselineAt = input.triggeredAt;
      const points = buildPointSchedule(baselineAt, offsets);
      const { created } = await deps.outcomesRepo.createOutcome({
        signalId: input.signalId,
        tokenId: input.tokenId,
        baselineAt,
        baselinePrice,
        baselineMarketCap,
        baselineLiquidity,
        importanceScore: input.importanceScore,
        riskLevel: input.riskLevel,
        confidence: input.confidence,
        scoreBreakdown: input.scoreBreakdown,
        scoringRuleVersion: deps.scoringRuleVersion,
        points: points.map((p) => ({ offsetLabel: p.label, dueAt: p.dueAt })),
      });

      deps.logger.info(
        {
          signalId: input.signalId,
          tokenId: input.tokenId,
          importanceScore: input.importanceScore,
          baselineAvailable: baselinePrice !== null,
          alreadyExisted: !created,
        },
        "outcome tracking started for signal (this records what happened next, not a recommendation)",
      );
    } catch (err) {
      deps.logger.error({ err, signalId: input.signalId }, "failed to start outcome tracking — signal itself is unaffected");
    }
  }

  async function recordOnePoint(point: Awaited<ReturnType<SignalOutcomesRepo["listDuePendingPoints"]>>[number]): Promise<{
    withData: boolean;
    delayed: boolean;
  }> {
    const recordedAt = now();
    const actualDelaySeconds = computeActualDelaySeconds(point.dueAt, recordedAt);
    const delayed = isDelayed(point.offsetLabel, actualDelaySeconds, offsets);

    let snap: Awaited<ReturnType<OutcomeMarketSource["getTokenSnapshot"]>> = null;
    try {
      snap = await deps.marketSource.getTokenSnapshot(point.tokenAddress);
    } catch (err) {
      deps.logger.warn({ err, pointId: point.pointId }, "outcome point DexScreener fetch failed — recording dataAvailable=false");
    }

    const dataAvailable = snap !== null;
    const price = snap?.priceUsd ?? null;
    const marketCap = snap?.marketCap ?? null;

    await deps.outcomesRepo.recordPoint(point.pointId, {
      dataAvailable,
      price,
      marketCap,
      liquidity: snap?.liquidityUsd ?? null,
      volume5m: snap?.volume5m ?? null,
      // Null unless BOTH the baseline and this point have real numbers — never 0.
      returnPct: point.baselineAvailable ? computeChangePct(point.baselinePrice, price) : null,
      marketCapChangePct: point.baselineAvailable ? computeChangePct(point.baselineMarketCap, marketCap) : null,
      recordedAt,
      actualDelaySeconds,
      delayed,
    });

    // Recompute the outcome's rolled-up summary from scratch off all its
    // recorded points — restart-safe, never drifts.
    const recorded = await deps.outcomesRepo.listRecordedPoints(point.signalOutcomeId);
    const summary = computeOutcomeSummary(point.baselineAvailable ? point.baselinePrice : null, recorded);
    await deps.outcomesRepo.updateSummary(point.signalOutcomeId, summary);

    return { withData: dataAvailable, delayed };
  }

  async function runOnce(): Promise<OutcomeSweepResult> {
    const due = await deps.outcomesRepo.listDuePendingPoints(now(), sweepBatchSize);
    const result: OutcomeSweepResult = { recorded: 0, withData: 0, withoutData: 0, delayed: 0 };

    for (const point of due) {
      try {
        const { withData, delayed } = await recordOnePoint(point);
        result.recorded++;
        if (withData) result.withData++;
        else result.withoutData++;
        if (delayed) result.delayed++;
      } catch (err) {
        deps.logger.error({ err, pointId: point.pointId }, "failed to record an outcome point — will retry next sweep");
      }
    }

    if (result.recorded > 0) {
      deps.logger.info(result, "outcome sweep recorded points");
    }
    return result;
  }

  return {
    onSignalCreated,
    runOnce,
    start(intervalMs) {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err: unknown) => {
          deps.logger.error({ err }, "outcome sweep pass failed");
        });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
