// B3 §2 — persistence for HotCandidateManager's lifecycle/score events.
// Wired from indexV2.ts's onScoreEvaluated/onAlert callbacks; manager.ts
// itself stays DB-free (spec's own "explicit extension point" design —
// see manager.ts's file header comment).
import { and, asc, count, eq, gte, sql } from "drizzle-orm";
import type { ShadowDatabase } from "./shadowClient.js";
import {
  candidateScoreHistory,
  hotCandidates,
  tokenLifecycleEvents,
  type protocolStateEnum,
} from "./schemaV2.js";
import type { ChainKey } from "../chains/types.js";
import type { GateStatus, HotCandidate, ProtocolState, RadarState } from "../hotradar/types.js";

export interface NewCandidateInput {
  chain: ChainKey;
  tokenId: number;
  tokenAddress: string;
  source: string;
  discoveredAt: Date;
  launchedAt: Date;
  launchBlockNumber: bigint | null;
  launchBlockHash: string | null;
  expiresAt: Date;
}

export interface ScoreSnapshotInput {
  hotCandidateId: number;
  scoreAt: Date;
  ageMs: number;
  breakoutScore: number;
  organicScore: number;
  kolScore: number;
  risk: string;
  confidence: string;
  breakdown: unknown;
  ruleVersion: number;
  gateStatus: GateStatus;
  gateReasons: string[];
  radarState: RadarState;
  protocolState: ProtocolState;
  tier: string;
  tierUncapped: string;
  features: Record<string, unknown>;
  dataStatus: unknown;
}

export interface LifecycleEventInput {
  hotCandidateId: number;
  eventAt: Date;
  ageMs: number;
  field: string;
  fromValue: string | null;
  toValue: string;
  reason: string | null;
  reasonDetail?: unknown;
  gateReasons?: string[] | null;
}

export interface UnknownReasonCounts {
  sellability: number;
  liquidity: number;
  creatorHistory: number;
  holderConcentration: number;
  multiple: number;
}

export interface TierUncappedDistribution {
  none: number;
  watch: number;
  earlyRadar: number;
  strong: number;
  urgent: number;
}

export interface HotRadarRepo {
  /** Gets the existing hot_candidates row id for (chain, tokenAddress), or
   * inserts a new one. Returns { id, isNew } so the caller only fires a
   * DISCOVERED lifecycle event once. */
  getOrCreateCandidate(input: NewCandidateInput): Promise<{ id: number; isNew: boolean }>;
  updateCandidateLatest(
    hotCandidateId: number,
    fields: {
      radarState: RadarState;
      protocolState: ProtocolState;
      gateStatus: GateStatus;
      gateReasons: string[];
      latestBreakoutScore: number;
      latestOrganicScore: number;
      latestKolScore: number;
      latestRisk: string;
      latestConfidence: string;
      lastEvaluatedAt: Date;
    },
  ): Promise<void>;
  insertScoreSnapshot(input: ScoreSnapshotInput): Promise<void>;
  insertLifecycleEvent(input: LifecycleEventInput): Promise<void>;

  /** §5.1 windowed counts. `since` null means all-time (sinceBoot proxy). */
  countCandidatesDiscovered(since: Date | null): Promise<number>;
  countByRadarState(state: RadarState, since: Date | null): Promise<number>;
  countByGateStatus(status: GateStatus, since: Date | null): Promise<number>;
  /** §5.2 — dimension breakdown of UNKNOWN_REVIEW candidates' latest snapshot per candidate. */
  unknownByReason(since: Date | null): Promise<UnknownReasonCounts>;
  /** §5.3 */
  tierUncappedDistribution(since: Date | null): Promise<TierUncappedDistribution>;
  scoreHistoryRowsToday(): Promise<number>;
  countLifecycleEventsByToValue(field: string, toValue: string, since: Date | null): Promise<number>;
  /** For expiry-bug detection (§9 point 3): candidates still HOT older than maxAgeMs. */
  countStuckHot(maxAgeMs: number, now: Date): Promise<number>;
  oldestHotCandidateAgeMs(now: Date): Promise<number | null>;

  /** §4.1 — fills a 5m/15m/30m outcome point from the hot pipeline's own
   * score-history snapshots (features.price), never an extra RPC/API call.
   * Returns null if no snapshot within `toleranceMs` of `target` exists. */
  getNearestSnapshotPrice(hotCandidateId: number, target: Date, toleranceMs: number): Promise<{ price: number | null; at: Date } | null>;

  /** All priced score-history snapshots up to (and including) `upTo`,
   * oldest-first — feeds outcomeScheduler.ts's computeMaxReturnAndDrawdown
   * so §4's maxReturn/maxDrawdown are real running extrema, not a
   * single-point stand-in. */
  listSnapshotPricesUpTo(hotCandidateId: number, upTo: Date): Promise<{ at: Date; price: number | null }[]>;
}

export function createHotRadarRepo(db: ShadowDatabase): HotRadarRepo {
  return {
    async getOrCreateCandidate(input) {
      const existing = await db
        .select({ id: hotCandidates.id })
        .from(hotCandidates)
        .where(and(eq(hotCandidates.chain, input.chain), eq(hotCandidates.tokenAddress, input.tokenAddress)))
        .limit(1);
      if (existing[0]) return { id: existing[0].id, isNew: false };

      const inserted = await db
        .insert(hotCandidates)
        .values({
          chain: input.chain,
          tokenId: input.tokenId,
          tokenAddress: input.tokenAddress,
          source: input.source,
          discoveredAt: input.discoveredAt,
          launchedAt: input.launchedAt,
          launchBlockNumber: input.launchBlockNumber,
          launchBlockHash: input.launchBlockHash,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({ target: [hotCandidates.chain, hotCandidates.tokenAddress] })
        .returning({ id: hotCandidates.id });

      if (inserted[0]) return { id: inserted[0].id, isNew: true };
      // Lost a race against a concurrent insert (shouldn't happen with a
      // single-process manager, but the unique constraint makes it safe) —
      // re-read rather than throw.
      const raced = await db
        .select({ id: hotCandidates.id })
        .from(hotCandidates)
        .where(and(eq(hotCandidates.chain, input.chain), eq(hotCandidates.tokenAddress, input.tokenAddress)))
        .limit(1);
      return { id: raced[0]!.id, isNew: false };
    },

    async updateCandidateLatest(hotCandidateId, fields) {
      await db
        .update(hotCandidates)
        .set({
          radarState: fields.radarState,
          protocolState: fields.protocolState as (typeof protocolStateEnum.enumValues)[number],
          gateStatus: fields.gateStatus,
          gateReasons: fields.gateReasons,
          latestBreakoutScore: fields.latestBreakoutScore.toFixed(2),
          latestOrganicScore: fields.latestOrganicScore.toFixed(2),
          latestKolScore: fields.latestKolScore.toFixed(2),
          latestRisk: fields.latestRisk,
          latestConfidence: fields.latestConfidence,
          lastEvaluatedAt: fields.lastEvaluatedAt,
          updatedAt: new Date(),
        })
        .where(eq(hotCandidates.id, hotCandidateId));
    },

    async insertScoreSnapshot(input) {
      await db.insert(candidateScoreHistory).values({
        hotCandidateId: input.hotCandidateId,
        scoreAt: input.scoreAt,
        ageMs: input.ageMs,
        breakoutScore: input.breakoutScore.toFixed(2),
        organicScore: input.organicScore.toFixed(2),
        kolScore: input.kolScore.toFixed(2),
        risk: input.risk,
        confidence: input.confidence,
        breakdown: input.breakdown,
        ruleVersion: input.ruleVersion,
        gateStatus: input.gateStatus,
        gateReasons: input.gateReasons,
        radarState: input.radarState,
        protocolState: input.protocolState,
        tier: input.tier,
        tierUncapped: input.tierUncapped,
        features: input.features,
        dataStatus: input.dataStatus,
      });
    },

    async insertLifecycleEvent(input) {
      await db.insert(tokenLifecycleEvents).values({
        hotCandidateId: input.hotCandidateId,
        eventAt: input.eventAt,
        ageMs: input.ageMs,
        field: input.field,
        fromValue: input.fromValue,
        toValue: input.toValue,
        reason: input.reason,
        reasonDetail: input.reasonDetail ?? null,
        gateReasons: input.gateReasons ?? null,
      });
    },

    async countCandidatesDiscovered(since) {
      const where = since ? gte(hotCandidates.discoveredAt, since) : undefined;
      const rows = await db.select({ c: count() }).from(hotCandidates).where(where);
      return rows[0]?.c ?? 0;
    },

    async countByRadarState(state, since) {
      const where = since
        ? and(eq(hotCandidates.radarState, state), gte(hotCandidates.updatedAt, since))
        : eq(hotCandidates.radarState, state);
      const rows = await db.select({ c: count() }).from(hotCandidates).where(where);
      return rows[0]?.c ?? 0;
    },

    async countByGateStatus(status, since) {
      const where = since
        ? and(eq(hotCandidates.gateStatus, status), gte(hotCandidates.updatedAt, since))
        : eq(hotCandidates.gateStatus, status);
      const rows = await db.select({ c: count() }).from(hotCandidates).where(where);
      return rows[0]?.c ?? 0;
    },

    async unknownByReason(since) {
      // One row per candidate's CURRENT gate_reasons (fast-read column,
      // not full history) — cheap enough to run on every /health call
      // (hot_candidates is one row per token, not per evaluation).
      const where = since
        ? and(eq(hotCandidates.gateStatus, "UNKNOWN_REVIEW"), gte(hotCandidates.updatedAt, since))
        : eq(hotCandidates.gateStatus, "UNKNOWN_REVIEW");
      const rows = await db.select({ gateReasons: hotCandidates.gateReasons }).from(hotCandidates).where(where);

      const counts: UnknownReasonCounts = { sellability: 0, liquidity: 0, creatorHistory: 0, holderConcentration: 0, multiple: 0 };
      for (const row of rows) {
        const reasons = (row.gateReasons as string[] | null) ?? [];
        const flags = {
          sellability: reasons.includes("SELLABILITY_UNKNOWN"),
          liquidity: reasons.includes("LIQUIDITY_UNKNOWN"),
          creatorHistory: reasons.includes("CREATOR_LAUNCHES_24H_UNKNOWN") || reasons.includes("CONTRACT_CAPABILITIES_UNKNOWN"),
          holderConcentration: reasons.includes("HOLDER_CONCENTRATION_TREND_UNKNOWN"),
        };
        const hitCount = Object.values(flags).filter(Boolean).length;
        if (hitCount === 0) continue;
        if (hitCount > 1) {
          counts.multiple++;
          continue;
        }
        if (flags.sellability) counts.sellability++;
        else if (flags.liquidity) counts.liquidity++;
        else if (flags.creatorHistory) counts.creatorHistory++;
        else if (flags.holderConcentration) counts.holderConcentration++;
      }
      return counts;
    },

    async tierUncappedDistribution(since) {
      const where = since ? gte(candidateScoreHistory.scoreAt, since) : undefined;
      const rows = await db
        .select({ tierUncapped: candidateScoreHistory.tierUncapped, c: count() })
        .from(candidateScoreHistory)
        .where(where)
        .groupBy(candidateScoreHistory.tierUncapped);
      const dist: TierUncappedDistribution = { none: 0, watch: 0, earlyRadar: 0, strong: 0, urgent: 0 };
      for (const row of rows) {
        switch (row.tierUncapped) {
          case "NONE":
            dist.none = row.c;
            break;
          case "WATCH":
            dist.watch = row.c;
            break;
          case "EARLY_RADAR":
            dist.earlyRadar = row.c;
            break;
          case "STRONG":
            dist.strong = row.c;
            break;
          case "URGENT":
            dist.urgent = row.c;
            break;
        }
      }
      return dist;
    },

    async scoreHistoryRowsToday() {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const rows = await db
        .select({ c: count() })
        .from(candidateScoreHistory)
        .where(gte(candidateScoreHistory.scoreAt, startOfDay));
      return rows[0]?.c ?? 0;
    },

    async countLifecycleEventsByToValue(field, toValue, since) {
      const where = since
        ? and(eq(tokenLifecycleEvents.field, field), eq(tokenLifecycleEvents.toValue, toValue), gte(tokenLifecycleEvents.eventAt, since))
        : and(eq(tokenLifecycleEvents.field, field), eq(tokenLifecycleEvents.toValue, toValue));
      const rows = await db.select({ c: count() }).from(tokenLifecycleEvents).where(where);
      return rows[0]?.c ?? 0;
    },

    async countStuckHot(maxAgeMs, now) {
      const cutoff = new Date(now.getTime() - maxAgeMs);
      const rows = await db
        .select({ c: count() })
        .from(hotCandidates)
        .where(and(eq(hotCandidates.radarState, "HOT"), sql`${hotCandidates.launchedAt} < ${cutoff}`));
      return rows[0]?.c ?? 0;
    },

    async oldestHotCandidateAgeMs(now) {
      const rows = await db
        .select({ launchedAt: hotCandidates.launchedAt })
        .from(hotCandidates)
        .where(eq(hotCandidates.radarState, "HOT"))
        .orderBy(asc(hotCandidates.launchedAt))
        .limit(1);
      if (!rows[0]) return null;
      return now.getTime() - rows[0].launchedAt.getTime();
    },

    async getNearestSnapshotPrice(hotCandidateId, target, toleranceMs) {
      const rows = await db
        .select({ scoreAt: candidateScoreHistory.scoreAt, features: candidateScoreHistory.features })
        .from(candidateScoreHistory)
        .where(
          and(
            eq(candidateScoreHistory.hotCandidateId, hotCandidateId),
            sql`abs(extract(epoch from (${candidateScoreHistory.scoreAt} - ${target}))) <= ${toleranceMs / 1000}`,
          ),
        )
        .orderBy(sql`abs(extract(epoch from (${candidateScoreHistory.scoreAt} - ${target})))`)
        .limit(1);
      if (!rows[0]) return null;
      const features = rows[0].features as Record<string, unknown>;
      const price = typeof features["price"] === "number" ? (features["price"] as number) : null;
      return { price, at: rows[0].scoreAt };
    },

    async listSnapshotPricesUpTo(hotCandidateId, upTo) {
      const rows = await db
        .select({ scoreAt: candidateScoreHistory.scoreAt, features: candidateScoreHistory.features })
        .from(candidateScoreHistory)
        .where(and(eq(candidateScoreHistory.hotCandidateId, hotCandidateId), sql`${candidateScoreHistory.scoreAt} <= ${upTo}`))
        .orderBy(asc(candidateScoreHistory.scoreAt));
      return rows.map((r) => {
        const features = r.features as Record<string, unknown>;
        const price = typeof features["price"] === "number" ? (features["price"] as number) : null;
        return { at: r.scoreAt, price };
      });
    },
  };
}

// Re-exported for consumers of this repo's types that also need the domain
// HotCandidate shape (currently unused directly here — candidates are held
// in-memory by the manager — but kept for future Phase C consumers).
export type { HotCandidate };
