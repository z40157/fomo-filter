import { z } from "zod";

const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 40 hex char address");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RH_RPC_HTTP: z.string().min(1, "RH_RPC_HTTP is required"),
  RH_RPC_WS: z.string().min(1, "RH_RPC_WS is required"),
  DOPPLER_AIRLOCK_ADDRESS: evmAddress,
  PONS_V1_FACTORY_ADDRESS: evmAddress,
  RESEND_API_KEY: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_EMAIL_TO: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  // Optional: without it, scripts/verifyWallets.ts falls back to Mobula's
  // public demo API (rate-limited, "for testing only" per their docs).
  MOBULA_API_KEY: z.string().optional(),
  // Candidate tracker tuning — all optional, defaults live in
  // market/candidateTrackerLogic.ts's DEFAULT_TRACKER_CONFIG.
  CANDIDATE_ACTIVE_REFRESH_MS: z.coerce.number().int().positive().optional(),
  CANDIDATE_INACTIVE_REFRESH_MS: z.coerce.number().int().positive().optional(),
  CANDIDATE_MIN_TRACKING_HOURS: z.coerce.number().positive().optional(),
  CANDIDATE_EXIT_INACTIVITY_HOURS: z.coerce.number().positive().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
