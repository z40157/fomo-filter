import { aliasedTable, and, count, countDistinct, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { signalOutcomePoints, signalOutcomes, tokens } from "./schema.js";
import type { RiskLevel } from "../signals/risk.js";
import type { ConfidenceLevel, ScoreBreakdown } from "../signals/scoring.js";
import type { OutcomeAnalysisRow } from "../outcomes/analyzeOutcomesLogic.js";
import type { OutcomeOffsetLabel } from "../outcomes/outcomeTrackerLogic.js";

export interface NewSignalOutcome {
  signalId: number;
  tokenId: number;
  baselineAt: Date;
  baselinePrice: number | null;
  baselineMarketCap: number | null;
  baselineLiquidity: number | null;
  importanceScore: number;
  riskLevel: RiskLevel | null;
  confidence: ConfidenceLevel | null;
  scoreBreakdown: ScoreBreakdown;
  scoringRuleVersion: number;
  points: { offsetLabel: OutcomeOffsetLabel; dueAt: Date }[];
}

/** A still-pending point whose `due_at` has passed, joined to its outcome's
 * baseline — everything the sweeper needs to record it in one query. */
export interface DuePoint {
  pointId: number;
  signalOutcomeId: number;
  offsetLabel: OutcomeOffsetLabel;
  dueAt: Date;
  tokenId: number;
  tokenAddress: string;
  baselinePrice: number | null;
  baselineMarketCap: number | null;
  baselineAvailable: boolean;
}

export interface RecordPointInput {
  dataAvailable: boolean;
  price: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume5m: number | null;
  returnPct: number | null;
  marketCapChangePct: number | null;
  recordedAt: Date;
  actualDelaySeconds: number;
  delayed: boolean;
}

export interface OutcomeSummaryUpdate {
  maxPrice: number | null;
  minPrice: number | null;
  maxReturnPct: number | null;
  maxDrawdownPct: number | null;
}

export interface RecordedPricePoint {
  dueAt: Date;
  price: number | null;
}

export interface SignalOutcomesRepo {
  /** Creates the outcome row plus its unrecorded points. No-op (returns the
   * existing id) if an outcome for this signal already exists — safe to call
   * again after a crash between signal insert and outcome insert. */
  createOutcome(input: NewSignalOutcome): Promise<{ outcomeId: number; created: boolean }>;
  /** Pending points (recorded_at IS NULL) whose due_at <= `now`, oldest-due first. */
  listDuePendingPoints(now: Date, limit: number): Promise<DuePoint[]>;
  recordPoint(pointId: number, input: RecordPointInput): Promise<void>;
  /** Every point of an outcome that has a recorded_at, for summary recompute. */
  listRecordedPoints(signalOutcomeId: number): Promise<RecordedPricePoint[]>;
  updateSummary(signalOutcomeId: number, summary: OutcomeSummaryUpdate): Promise<void>;
  /** Outcomes that still have >= 1 unrecorded point. */
  countTracked(): Promise<number>;
  /** All not-yet-recorded points, regardless of whether they're due. */
  countPendingPoints(): Promise<number>;
  /** Every outcome with its +1h / +24h returns attached — for scripts/analyzeOutcomes.ts. */
  listForAnalysis(): Promise<OutcomeAnalysisRow[]>;
}

function numOrNull(v: number | null): string | null {
  return v === null ? null : v.toString();
}

export function createSignalOutcomesRepo(db: Database): SignalOutcomesRepo {
  return {
    async createOutcome(input) {
      const existing = await db
        .select({ id: signalOutcomes.id })
        .from(signalOutcomes)
        .where(eq(signalOutcomes.signalId, input.signalId))
        .limit(1);
      if (existing[0]) return { outcomeId: existing[0].id, created: false };

      const inserted = await db
        .insert(signalOutcomes)
        .values({
          signalId: input.signalId,
          tokenId: input.tokenId,
          baselineAt: input.baselineAt,
          baselinePrice: numOrNull(input.baselinePrice),
          baselineMarketCap: numOrNull(input.baselineMarketCap),
          baselineLiquidity: numOrNull(input.baselineLiquidity),
          baselineAvailable: input.baselinePrice !== null,
          importanceScore: input.importanceScore.toString(),
          riskLevel: input.riskLevel,
          confidence: input.confidence,
          scoreBreakdown: input.scoreBreakdown,
          scoringRuleVersion: input.scoringRuleVersion,
        })
        .onConflictDoNothing({ target: signalOutcomes.signalId })
        .returning({ id: signalOutcomes.id });

      if (!inserted[0]) {
        // Lost a race with a concurrent insert — read the winner's id.
        const row = await db
          .select({ id: signalOutcomes.id })
          .from(signalOutcomes)
          .where(eq(signalOutcomes.signalId, input.signalId))
          .limit(1);
        return { outcomeId: row[0]!.id, created: false };
      }

      const outcomeId = inserted[0].id;
      if (input.points.length > 0) {
        await db
          .insert(signalOutcomePoints)
          .values(
            input.points.map((p) => ({
              signalOutcomeId: outcomeId,
              offsetLabel: p.offsetLabel,
              dueAt: p.dueAt,
            })),
          )
          .onConflictDoNothing({
            target: [signalOutcomePoints.signalOutcomeId, signalOutcomePoints.offsetLabel],
          });
      }
      return { outcomeId, created: true };
    },

    async listDuePendingPoints(now, limit) {
      const rows = await db
        .select({
          pointId: signalOutcomePoints.id,
          signalOutcomeId: signalOutcomePoints.signalOutcomeId,
          offsetLabel: signalOutcomePoints.offsetLabel,
          dueAt: signalOutcomePoints.dueAt,
          tokenId: signalOutcomes.tokenId,
          tokenAddress: tokens.address,
          baselinePrice: signalOutcomes.baselinePrice,
          baselineMarketCap: signalOutcomes.baselineMarketCap,
          baselineAvailable: signalOutcomes.baselineAvailable,
        })
        .from(signalOutcomePoints)
        .innerJoin(signalOutcomes, eq(signalOutcomes.id, signalOutcomePoints.signalOutcomeId))
        .innerJoin(tokens, eq(tokens.id, signalOutcomes.tokenId))
        .where(and(isNull(signalOutcomePoints.recordedAt), lte(signalOutcomePoints.dueAt, now)))
        .orderBy(signalOutcomePoints.dueAt)
        .limit(limit);

      return rows.map((r) => ({
        pointId: r.pointId,
        signalOutcomeId: r.signalOutcomeId,
        offsetLabel: r.offsetLabel as OutcomeOffsetLabel,
        dueAt: r.dueAt,
        tokenId: r.tokenId,
        tokenAddress: r.tokenAddress,
        baselinePrice: r.baselinePrice === null ? null : Number(r.baselinePrice),
        baselineMarketCap: r.baselineMarketCap === null ? null : Number(r.baselineMarketCap),
        baselineAvailable: r.baselineAvailable,
      }));
    },

    async recordPoint(pointId, input) {
      await db
        .update(signalOutcomePoints)
        .set({
          recordedAt: input.recordedAt,
          dataAvailable: input.dataAvailable,
          price: numOrNull(input.price),
          marketCap: numOrNull(input.marketCap),
          liquidity: numOrNull(input.liquidity),
          volume5m: numOrNull(input.volume5m),
          returnPct: numOrNull(input.returnPct),
          marketCapChangePct: numOrNull(input.marketCapChangePct),
          actualDelaySeconds: input.actualDelaySeconds,
          delayed: input.delayed,
        })
        .where(eq(signalOutcomePoints.id, pointId));
    },

    async listRecordedPoints(signalOutcomeId) {
      const rows = await db
        .select({ dueAt: signalOutcomePoints.dueAt, price: signalOutcomePoints.price })
        .from(signalOutcomePoints)
        .where(
          and(
            eq(signalOutcomePoints.signalOutcomeId, signalOutcomeId),
            isNotNull(signalOutcomePoints.recordedAt),
          ),
        );
      return rows.map((r) => ({ dueAt: r.dueAt, price: r.price === null ? null : Number(r.price) }));
    },

    async updateSummary(signalOutcomeId, summary) {
      await db
        .update(signalOutcomes)
        .set({
          maxPrice: numOrNull(summary.maxPrice),
          minPrice: numOrNull(summary.minPrice),
          maxReturnPct: numOrNull(summary.maxReturnPct),
          maxDrawdownPct: numOrNull(summary.maxDrawdownPct),
          updatedAt: new Date(),
        })
        .where(eq(signalOutcomes.id, signalOutcomeId));
    },

    async countTracked() {
      const rows = await db
        .select({ n: countDistinct(signalOutcomePoints.signalOutcomeId) })
        .from(signalOutcomePoints)
        .where(isNull(signalOutcomePoints.recordedAt));
      return Number(rows[0]?.n ?? 0);
    },

    async countPendingPoints() {
      const rows = await db
        .select({ n: count() })
        .from(signalOutcomePoints)
        .where(isNull(signalOutcomePoints.recordedAt));
      return rows[0]?.n ?? 0;
    },

    async listForAnalysis() {
      const p1h = aliasedTable(signalOutcomePoints, "p1h");
      const p24h = aliasedTable(signalOutcomePoints, "p24h");
      const rows = await db
        .select({
          importanceScore: signalOutcomes.importanceScore,
          riskLevel: signalOutcomes.riskLevel,
          confidence: signalOutcomes.confidence,
          baselineAvailable: signalOutcomes.baselineAvailable,
          maxReturnPct: signalOutcomes.maxReturnPct,
          maxDrawdownPct: signalOutcomes.maxDrawdownPct,
          return1hPct: p1h.returnPct,
          return24hPct: p24h.returnPct,
        })
        .from(signalOutcomes)
        .leftJoin(p1h, and(eq(p1h.signalOutcomeId, signalOutcomes.id), eq(p1h.offsetLabel, "1h")))
        .leftJoin(p24h, and(eq(p24h.signalOutcomeId, signalOutcomes.id), eq(p24h.offsetLabel, "24h")));

      return rows.map((r) => ({
        importanceScore: Number(r.importanceScore),
        riskLevel: r.riskLevel,
        confidence: r.confidence,
        baselineAvailable: r.baselineAvailable,
        maxReturnPct: r.maxReturnPct === null ? null : Number(r.maxReturnPct),
        maxDrawdownPct: r.maxDrawdownPct === null ? null : Number(r.maxDrawdownPct),
        return1hPct: r.return1hPct === null ? null : Number(r.return1hPct),
        return24hPct: r.return24hPct === null ? null : Number(r.return24hPct),
      }));
    },
  };
}
