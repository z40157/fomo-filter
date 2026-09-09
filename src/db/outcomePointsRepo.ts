// B3 §4 — persisted Outcome Tracking schedule (see hotradar/outcomeScheduler.ts
// for the pure offset/return math). Persistence-first by design (spec
// §4.2: "采样调度必须能在restart后恢复") — every pending point is a DB row
// from the moment a candidate crosses into HOT/PASS/ALERT, never held only
// in process memory.
import { and, asc, count, eq, lte } from "drizzle-orm";
import type { ShadowDatabase } from "./shadowClient.js";
import { candidateOutcomePoints } from "./schemaV2.js";
import { OUTCOME_OFFSETS, type OutcomeOffsetLabel } from "../hotradar/outcomeScheduler.js";

export interface DuePoint {
  id: number;
  hotCandidateId: number;
  offsetLabel: OutcomeOffsetLabel;
  baselineAt: Date;
  baselinePrice: number | null;
  scheduledAt: Date;
}

export interface SampleResult {
  price: number | null;
  returnPct: number | null;
  maxReturnPct: number | null;
  maxDrawdownPct: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  holders: number | null;
  dataSource: string | null;
  dataStatus: "OK" | "UNKNOWN" | "ERROR";
  dataStatusReason: string | null;
}

export interface OutcomePointsRepo {
  /** Idempotent — a candidate can only cross into outcome tracking once
   * (spec §4: HOT/PASS/ALERT trigger), enforced by the (hotCandidateId,
   * offsetLabel) unique constraint; a second call is a silent no-op. */
  scheduleAll(hotCandidateId: number, baselineAt: Date, baselinePrice: number | null): Promise<void>;
  listDue(now: Date, limit: number, hotPipeline: boolean): Promise<DuePoint[]>;
  markSampled(id: number, sampledAt: Date, result: SampleResult): Promise<void>;
  countByStatusAndOffset(): Promise<Record<OutcomeOffsetLabel, { done: number; pending: number }>>;
  countPending(): Promise<number>;
}

const HOT_PIPELINE_LABELS: OutcomeOffsetLabel[] = ["5m", "15m", "30m"];
const COLD_LABELS: OutcomeOffsetLabel[] = ["1h", "2h", "6h", "24h"];

export function createOutcomePointsRepo(db: ShadowDatabase): OutcomePointsRepo {
  return {
    async scheduleAll(hotCandidateId, baselineAt, baselinePrice) {
      const rows = OUTCOME_OFFSETS.map((offset) => ({
        hotCandidateId,
        offsetLabel: offset.label,
        baselineAt,
        baselinePrice: baselinePrice === null ? null : baselinePrice.toFixed(18),
        scheduledAt: new Date(baselineAt.getTime() + offset.ms),
        status: "PENDING" as const,
      }));
      await db
        .insert(candidateOutcomePoints)
        .values(rows)
        .onConflictDoNothing({ target: [candidateOutcomePoints.hotCandidateId, candidateOutcomePoints.offsetLabel] });
    },

    async listDue(now, limit, hotPipeline) {
      const labels = hotPipeline ? HOT_PIPELINE_LABELS : COLD_LABELS;
      const rows = await db
        .select({
          id: candidateOutcomePoints.id,
          hotCandidateId: candidateOutcomePoints.hotCandidateId,
          offsetLabel: candidateOutcomePoints.offsetLabel,
          baselineAt: candidateOutcomePoints.baselineAt,
          baselinePrice: candidateOutcomePoints.baselinePrice,
          scheduledAt: candidateOutcomePoints.scheduledAt,
        })
        .from(candidateOutcomePoints)
        .where(and(eq(candidateOutcomePoints.status, "PENDING"), lte(candidateOutcomePoints.scheduledAt, now)))
        .orderBy(asc(candidateOutcomePoints.scheduledAt))
        .limit(limit * 2); // over-fetch since we filter by label client-side (label isn't part of the sargable index)
      return rows
        .filter((r) => labels.includes(r.offsetLabel as OutcomeOffsetLabel))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          hotCandidateId: r.hotCandidateId,
          offsetLabel: r.offsetLabel as OutcomeOffsetLabel,
          baselineAt: r.baselineAt,
          baselinePrice: r.baselinePrice === null ? null : Number(r.baselinePrice),
          scheduledAt: r.scheduledAt,
        }));
    },

    async markSampled(id, sampledAt, result) {
      await db
        .update(candidateOutcomePoints)
        .set({
          status: "DONE",
          sampledAt,
          price: result.price === null ? null : result.price.toFixed(18),
          returnPct: result.returnPct === null ? null : result.returnPct.toFixed(4),
          maxReturnPct: result.maxReturnPct === null ? null : result.maxReturnPct.toFixed(4),
          maxDrawdownPct: result.maxDrawdownPct === null ? null : result.maxDrawdownPct.toFixed(4),
          liquidityUsd: result.liquidityUsd === null ? null : result.liquidityUsd.toFixed(2),
          volumeUsd: result.volumeUsd === null ? null : result.volumeUsd.toFixed(2),
          holders: result.holders,
          dataSource: result.dataSource,
          dataStatus: result.dataStatus,
          dataStatusReason: result.dataStatusReason,
        })
        .where(eq(candidateOutcomePoints.id, id));
    },

    async countByStatusAndOffset() {
      const rows = await db
        .select({ offsetLabel: candidateOutcomePoints.offsetLabel, status: candidateOutcomePoints.status, c: count() })
        .from(candidateOutcomePoints)
        .groupBy(candidateOutcomePoints.offsetLabel, candidateOutcomePoints.status);
      const result: Record<OutcomeOffsetLabel, { done: number; pending: number }> = {
        "5m": { done: 0, pending: 0 },
        "15m": { done: 0, pending: 0 },
        "30m": { done: 0, pending: 0 },
        "1h": { done: 0, pending: 0 },
        "2h": { done: 0, pending: 0 },
        "6h": { done: 0, pending: 0 },
        "24h": { done: 0, pending: 0 },
      };
      for (const row of rows) {
        const label = row.offsetLabel as OutcomeOffsetLabel;
        if (row.status === "DONE") result[label].done = row.c;
        else if (row.status === "PENDING") result[label].pending = row.c;
      }
      return result;
    },

    async countPending() {
      const rows = await db.select({ c: count() }).from(candidateOutcomePoints).where(eq(candidateOutcomePoints.status, "PENDING"));
      return rows[0]?.c ?? 0;
    },
  };
}
