import { and, desc, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { alerts, signals } from "./schema.js";
import type { RiskLevel } from "../signals/risk.js";
import type { ConfidenceLevel } from "../signals/scoring.js";
import type { AlertTriggerReason } from "../alerts/alertLogic.js";

export type AlertChannel = "email" | "telegram";
export type DeliveryStatus = "sent" | "failed";

export interface NewAlert {
  signalId: number;
  tokenId: number;
  channel: AlertChannel;
  sentAt: Date;
  importanceAtSend: number;
  riskAtSend: RiskLevel | null;
  confidenceAtSend: ConfidenceLevel | null;
  triggerReason: AlertTriggerReason;
  deliveryStatus: DeliveryStatus;
  errorMessage?: string | null;
}

export interface PriorAlert {
  sentAt: Date;
  importanceAtSend: number;
  /** From the signal this alert was sent for — the resonance state at send time. */
  distinctOwnerGroups: number;
  tierACount: number;
}

export interface AlertsRepo {
  /** Returns the new alert row's id. */
  create(alert: NewAlert): Promise<number>;
  /** The most recent successfully-sent alert for this (token, channel), or null if none yet. */
  getLastSentAlert(tokenId: number, channel: AlertChannel): Promise<PriorAlert | null>;
  /** Has any past successfully-sent alert for this (token, channel) had importanceAtSend >= threshold? */
  hasSentAtOrAbove(tokenId: number, channel: AlertChannel, threshold: number): Promise<boolean>;
}

export function createAlertsRepo(db: Database): AlertsRepo {
  return {
    async create(alert) {
      const rows = await db
        .insert(alerts)
        .values({
          ...alert,
          importanceAtSend: alert.importanceAtSend.toString(),
          errorMessage: alert.errorMessage ?? null,
        })
        .returning({ id: alerts.id });
      return rows[0]!.id;
    },

    async getLastSentAlert(tokenId, channel) {
      const rows = await db
        .select({
          sentAt: alerts.sentAt,
          importanceAtSend: alerts.importanceAtSend,
          distinctOwnerGroups: signals.distinctOwnerGroups,
          tierACount: signals.tierACount,
        })
        .from(alerts)
        .innerJoin(signals, eq(signals.id, alerts.signalId))
        .where(and(eq(alerts.tokenId, tokenId), eq(alerts.channel, channel), eq(alerts.deliveryStatus, "sent")))
        .orderBy(desc(alerts.sentAt))
        .limit(1);

      const row = rows[0];
      if (!row) return null;
      return {
        sentAt: row.sentAt,
        importanceAtSend: Number(row.importanceAtSend),
        distinctOwnerGroups: row.distinctOwnerGroups,
        tierACount: row.tierACount,
      };
    },

    async hasSentAtOrAbove(tokenId, channel, threshold) {
      const rows = await db
        .select({ importanceAtSend: alerts.importanceAtSend })
        .from(alerts)
        .where(
          and(
            eq(alerts.tokenId, tokenId),
            eq(alerts.channel, channel),
            eq(alerts.deliveryStatus, "sent"),
            gte(alerts.importanceAtSend, threshold.toString()),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}
