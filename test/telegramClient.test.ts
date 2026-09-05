import { describe, expect, it, vi } from "vitest";
import { createTelegramClient } from "../src/alerts/telegramClient.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function jsonResponse(status: number, body: string = "{}"): Response {
  return new Response(body, { status });
}

describe("createTelegramClient", () => {
  it("posts to the real Telegram sendMessage endpoint shape and returns ok", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const client = createTelegramClient("BOTTOKEN", "12345", fakeLogger(), { fetchImpl, sleep: async () => {} });

    const result = await client.sendMessage("hello");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botBOTTOKEN/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: "12345", text: "hello", parse_mode: "HTML", disable_web_page_preview: true });
  });

  it("retries on 429 and eventually succeeds", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      return attempt < 2 ? jsonResponse(429, "rate limited") : jsonResponse(200);
    });
    const client = createTelegramClient("t", "c", fakeLogger(), { fetchImpl, sleep: async () => {} });

    const result = await client.sendMessage("hi");
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails cleanly (no throw) after exhausting retries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, "down"));
    const client = createTelegramClient("t", "c", fakeLogger(), { fetchImpl, sleep: async () => {}, maxAttempts: 2 });

    const result = await client.sendMessage("hi");
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
