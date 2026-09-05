// Resend (https://resend.com) email delivery — the only outbound email
// channel. Retries transient failures (429 / 5xx / network errors) with
// the same exponential backoff used elsewhere (chain/backoff.ts), then
// gives up and reports failure — never throws, so a send failure can
// never crash or block the caller.

import { ExponentialBackoff } from "../chain/backoff.js";
import type { Logger } from "../logger.js";

const API_URL = "https://api.resend.com/emails";
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type SendResult = { ok: true } | { ok: false; error: string };

export interface EmailClient {
  sendEmail(params: { from: string; to: string; subject: string; html: string }): Promise<SendResult>;
}

export interface ResendClientOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createResendClient(apiKey: string, logger: Logger, options: ResendClientOptions = {}): EmailClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async sendEmail({ from, to, subject, html }) {
      const backoff = new ExponentialBackoff({ initialMs: 1_000, maxMs: 15_000, factor: 2 });

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetchImpl(API_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ from, to: [to], subject, html }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) return { ok: true };

          const bodyText = await response.text().catch(() => "");
          if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
            logger.warn({ status: response.status, attempt }, "Resend request failed — retrying");
            await sleep(backoff.next());
            continue;
          }
          return { ok: false, error: `Resend HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
        } catch (err) {
          clearTimeout(timeoutId);
          if (attempt < maxAttempts) {
            logger.warn({ err, attempt }, "Resend request errored — retrying");
            await sleep(backoff.next());
            continue;
          }
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { ok: false, error: "Resend request failed after all retries" };
    },
  };
}
