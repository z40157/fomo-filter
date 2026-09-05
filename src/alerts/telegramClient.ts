// Telegram Bot API delivery. Same retry shape as resendClient.ts — never
// throws, reports { ok: false, error } on final failure instead.

import { ExponentialBackoff } from "../chain/backoff.js";
import type { Logger } from "../logger.js";

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type SendResult = { ok: true } | { ok: false; error: string };

export interface TelegramClient {
  sendMessage(text: string): Promise<SendResult>;
}

export interface TelegramClientOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createTelegramClient(
  botToken: string,
  chatId: string,
  logger: Logger,
  options: TelegramClientOptions = {},
): TelegramClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return {
    async sendMessage(text) {
      const backoff = new ExponentialBackoff({ initialMs: 1_000, maxMs: 15_000, factor: 2 });

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetchImpl(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) return { ok: true };

          const bodyText = await response.text().catch(() => "");
          if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
            logger.warn({ status: response.status, attempt }, "Telegram request failed — retrying");
            await sleep(backoff.next());
            continue;
          }
          return { ok: false, error: `Telegram HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
        } catch (err) {
          clearTimeout(timeoutId);
          if (attempt < maxAttempts) {
            logger.warn({ err, attempt }, "Telegram request errored — retrying");
            await sleep(backoff.next());
            continue;
          }
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { ok: false, error: "Telegram request failed after all retries" };
    },
  };
}
