// Stateful wrapper (Phase 8, revised) tying alertLogic.ts's pure
// dedup/cooldown decision to real delivery and the `alerts` table.
//
// Telegram is now the primary + default channel and carries the full
// layered-threshold behaviour on its own:
//   < 7.0    nothing sent
//   7.0-7.9  normal message
//   8.0-8.9  message tagged STRONG
//   >= 9.0   message tagged URGENT
//
// Email (Resend) is retained but OFF by default: it only sends when
// RESEND_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO are all set, and its
// absence is silent (no warning, no error). When enabled, an email goes
// out alongside every Telegram alert, with its own `alerts` row.
//
// Called once per persisted signal from signals/resonanceDetector.ts —
// never blocks or throws back into the caller: every failure is caught,
// logged, and recorded as a `failed` alerts row instead.

import type { Logger } from "../logger.js";
import type { AlertsRepo } from "../db/alerts.js";
import { decideAlert, URGENT_THRESHOLD, DEFAULT_ALERT_COOLDOWN_MINUTES, type PriorAlertState } from "./alertLogic.js";
import { renderTelegramMessage } from "./telegramTemplate.js";
import { renderAlertEmail } from "./emailTemplate.js";
import type { TelegramClient } from "./telegramClient.js";
import type { EmailClient } from "./resendClient.js";
import type { AlertContext, AlertWalletBreakdown } from "./alertTypes.js";

export type AlertDispatchInput = Omit<AlertContext, "level" | "wallets"> & {
  wallets: Omit<AlertWalletBreakdown, "sellAmount" | "sellCount">[];
};

export interface WalletSellSummary {
  sellAmount: bigint;
  sellCount: number;
}

export interface AlertDispatcherDeps {
  alertsRepo: AlertsRepo;
  logger: Logger;
  /** Primary channel. Undefined when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID aren't configured — dispatch then no-ops (logged once per call, nothing persisted since nothing was attempted). */
  telegramClient?: TelegramClient;
  /** Retained but disabled by default. Undefined unless RESEND_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO are all set — its absence is silent (no warn, no error). When present, an email is sent alongside every Telegram alert. */
  emailClient?: EmailClient;
  emailFrom?: string;
  emailTo?: string;
  /** Real SELL totals per watched wallet for this token, as of `before` — defaults to "no sells known" (0/0) for every wallet if omitted. */
  getWalletSells?: (tokenId: number, wallets: string[], before: Date) => Promise<Map<string, WalletSellSummary>>;
  now?: () => Date;
  cooldownMinutes?: number;
}

export interface AlertDispatcher {
  dispatch(input: AlertDispatchInput): Promise<void>;
}

export function createAlertDispatcher(deps: AlertDispatcherDeps): AlertDispatcher {
  const now = deps.now ?? (() => new Date());
  const cooldownMinutes = deps.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES;

  return {
    async dispatch(input) {
      try {
        if (!deps.telegramClient) {
          deps.logger.warn(
            { tokenId: input.tokenId },
            "Telegram alerting is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — skipping alert dispatch entirely",
          );
          return;
        }

        const nowDate = now();
        // Dedup/cooldown state is keyed on the (token, telegram) channel now
        // that Telegram is primary — same rules as before, different channel.
        const [lastSent, hasCrossedNine] = await Promise.all([
          deps.alertsRepo.getLastSentAlert(input.tokenId, "telegram"),
          deps.alertsRepo.hasSentAtOrAbove(input.tokenId, "telegram", URGENT_THRESHOLD),
        ]);
        const prior: PriorAlertState | null = lastSent
          ? {
              sentAt: lastSent.sentAt,
              importanceAtSend: lastSent.importanceAtSend,
              distinctOwnerGroups: lastSent.distinctOwnerGroups,
              tierACount: lastSent.tierACount,
              hasCrossedNine,
            }
          : null;

        const decision = decideAlert(
          {
            importanceScore: input.importanceScore,
            distinctOwnerGroups: input.distinctOwnerGroups,
            tierACount: input.tierACount,
          },
          prior,
          nowDate,
          cooldownMinutes,
        );
        if (!decision.shouldSend || !decision.reason) return;

        const sellSummaries =
          (await deps.getWalletSells?.(
            input.tokenId,
            input.wallets.map((w) => w.address),
            nowDate,
          )) ?? new Map<string, WalletSellSummary>();

        const context: AlertContext = {
          ...input,
          level: decision.level,
          wallets: input.wallets.map((w) => {
            const sells = sellSummaries.get(w.address.toLowerCase());
            return { ...w, sellAmount: sells?.sellAmount ?? 0n, sellCount: sells?.sellCount ?? 0 };
          }),
        };

        // --- Primary channel: Telegram ---
        const text = renderTelegramMessage(context);
        const tgResult = await deps.telegramClient.sendMessage(text);
        await deps.alertsRepo.create({
          signalId: input.signalId,
          tokenId: input.tokenId,
          channel: "telegram",
          sentAt: nowDate,
          importanceAtSend: input.importanceScore,
          riskAtSend: input.riskLevel,
          confidenceAtSend: input.confidence,
          triggerReason: decision.reason,
          deliveryStatus: tgResult.ok ? "sent" : "failed",
          errorMessage: tgResult.ok ? null : tgResult.error,
        });
        if (tgResult.ok) {
          deps.logger.info(
            { tokenId: input.tokenId, symbol: input.tokenSymbol, level: decision.level, reason: decision.reason },
            "alert telegram sent",
          );
        } else {
          deps.logger.error({ tokenId: input.tokenId, error: tgResult.error }, "alert telegram failed after retries");
        }

        // --- Optional channel: email (Resend), off unless fully configured ---
        if (deps.emailClient && deps.emailFrom && deps.emailTo) {
          const { subject, html } = renderAlertEmail(context);
          const emailResult = await deps.emailClient.sendEmail({ from: deps.emailFrom, to: deps.emailTo, subject, html });
          await deps.alertsRepo.create({
            signalId: input.signalId,
            tokenId: input.tokenId,
            channel: "email",
            sentAt: now(),
            importanceAtSend: input.importanceScore,
            riskAtSend: input.riskLevel,
            confidenceAtSend: input.confidence,
            triggerReason: decision.reason,
            deliveryStatus: emailResult.ok ? "sent" : "failed",
            errorMessage: emailResult.ok ? null : emailResult.error,
          });
          if (emailResult.ok) {
            deps.logger.info({ tokenId: input.tokenId, symbol: input.tokenSymbol, subject }, "alert email sent");
          } else {
            deps.logger.error({ tokenId: input.tokenId, error: emailResult.error }, "alert email failed after retries");
          }
        }
      } catch (err) {
        deps.logger.error({ err, tokenId: input.tokenId }, "alert dispatch failed unexpectedly — not blocking main flow");
      }
    },
  };
}
