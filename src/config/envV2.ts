import { z } from "zod";

// V2 shadow process's own env schema — deliberately separate from
// config/env.ts (V1's) so nothing V2 reads can accidentally pick up a V1
// var by name collision, and so V1's schema/behavior is untouched by
// anything B3 needs. Spec B3 §3 condition 3/4: Telegram vars use different
// names entirely (V2_TELEGRAM_BOT_TOKEN / V2_TELEGRAM_CHAT_ID — matching
// the names .env.example already reserved for this in Phase A) so even if
// a Railway project accidentally shared variables across services, shadow
// alerting still can't silently activate under V1's names.

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 40 hex char address");

const envV2Schema = z.object({
  SHADOW_DATABASE_URL: z.string().min(1, "SHADOW_DATABASE_URL is required"),
  RH_RPC_HTTP: z.string().min(1, "RH_RPC_HTTP is required"),
  RH_RPC_WS: z.string().min(1, "RH_RPC_WS is required"),
  DOPPLER_AIRLOCK_ADDRESS: evmAddress,
  PONS_V1_FACTORY_ADDRESS: evmAddress,

  // §3 — independent shadow-only Telegram config. Absent by default; both
  // must be set for shadow alerting to activate at all (see indexV2.ts's
  // isolation check, which also requires TELEGRAM_BOT_TOKEN/_CHAT_ID —
  // V1's names — to be entirely absent from this process's env).
  V2_TELEGRAM_BOT_TOKEN: z.string().optional(),
  V2_TELEGRAM_CHAT_ID: z.string().optional(),

  // §4.2 — RPC budget/credit-weight tuning, same shape as V1's rpcBudget.ts
  // consumers, kept independent per-process.
  RPC_CREDIT_BUDGET_24H: z.coerce.number().positive().optional(),
  RPC_CREDIT_WEIGHTS_JSON: z.string().optional(),

  // §5 — identifies this instance in /health during a deploy-overlap window
  // (spec §1.3). Falls back to Railway's own deployment id if unset.
  INSTANCE_ID: z.string().optional(),

  TICK_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  OUTCOME_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type EnvV2 = z.infer<typeof envV2Schema>;

export function loadEnvV2(source: NodeJS.ProcessEnv = process.env): EnvV2 {
  const parsed = envV2Schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid V2 environment configuration: ${issues}`);
  }
  return parsed.data;
}

/** §3 — the full isolation check for enabling shadow Telegram. All four
 * conditions must hold; the caller (indexV2.ts) logs which one failed. */
export interface TelegramIsolationCheck {
  hasOwnBotToken: boolean;
  hasOwnChatId: boolean;
  v1TokenAbsent: boolean;
  v1ChatIdAbsent: boolean;
  eligible: boolean;
  reasons: string[];
}

export function checkTelegramIsolation(source: NodeJS.ProcessEnv = process.env): TelegramIsolationCheck {
  const hasOwnBotToken = !!source["V2_TELEGRAM_BOT_TOKEN"];
  const hasOwnChatId = !!source["V2_TELEGRAM_CHAT_ID"];
  const v1TokenAbsent = !source["TELEGRAM_BOT_TOKEN"];
  const v1ChatIdAbsent = !source["TELEGRAM_CHAT_ID"];
  const reasons: string[] = [];
  if (!hasOwnBotToken) reasons.push("condition 1 (independent bot token) not met: V2_TELEGRAM_BOT_TOKEN is unset");
  if (!hasOwnChatId) reasons.push("condition 2 (independent chat) not met: V2_TELEGRAM_CHAT_ID is unset");
  if (!v1TokenAbsent) reasons.push("condition 3 violated: TELEGRAM_BOT_TOKEN (V1's) is present in this process's env");
  if (!v1ChatIdAbsent) reasons.push("condition 3 violated: TELEGRAM_CHAT_ID (V1's) is present in this process's env");
  return {
    hasOwnBotToken,
    hasOwnChatId,
    v1TokenAbsent,
    v1ChatIdAbsent,
    eligible: hasOwnBotToken && hasOwnChatId && v1TokenAbsent && v1ChatIdAbsent,
    reasons,
  };
}
