import { describe, expect, it, vi } from "vitest";
import { createResendClient } from "../src/alerts/resendClient.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function jsonResponse(status: number, body: string = "{}"): Response {
  return new Response(body, { status });
}

describe("createResendClient", () => {
  it("returns ok on a successful send, calling the real Resend endpoint shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const client = createResendClient("key", fakeLogger(), { fetchImpl, sleep: async () => {} });

    const result = await client.sendEmail({ from: "a@b.com", to: "c@d.com", subject: "s", html: "<p>hi</p>" });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer key" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ from: "a@b.com", to: ["c@d.com"], subject: "s", html: "<p>hi</p>" });
  });

  it("retries on a 5xx and succeeds on a later attempt", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      return attempt < 3 ? jsonResponse(500, "server error") : jsonResponse(200);
    });
    const client = createResendClient("key", fakeLogger(), { fetchImpl, sleep: async () => {}, maxAttempts: 4 });

    const result = await client.sendEmail({ from: "a", to: "b", subject: "s", html: "h" });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up and reports failure after exhausting retries, without throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, "still broken"));
    const client = createResendClient("key", fakeLogger(), { fetchImpl, sleep: async () => {}, maxAttempts: 3 });

    const result = await client.sendEmail({ from: "a", to: "b", subject: "s", html: "h" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable 4xx (e.g. bad request) and fails immediately", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, "invalid from address"));
    const client = createResendClient("key", fakeLogger(), { fetchImpl, sleep: async () => {}, maxAttempts: 4 });

    const result = await client.sendEmail({ from: "a", to: "b", subject: "s", html: "h" });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown network error as retryable and eventually fails cleanly", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createResendClient("key", fakeLogger(), { fetchImpl, sleep: async () => {}, maxAttempts: 2 });

    const result = await expect(client.sendEmail({ from: "a", to: "b", subject: "s", html: "h" })).resolves.toMatchObject({
      ok: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    void result;
  });
});
