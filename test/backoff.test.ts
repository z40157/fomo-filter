import { describe, expect, it } from "vitest";
import { ExponentialBackoff } from "../src/chain/backoff.js";

describe("ExponentialBackoff", () => {
  it("doubles the delay each attempt, capped at maxMs", () => {
    const backoff = new ExponentialBackoff({ initialMs: 1000, maxMs: 60000, factor: 2 });

    expect(backoff.next()).toBe(1000);
    expect(backoff.next()).toBe(2000);
    expect(backoff.next()).toBe(4000);
    expect(backoff.next()).toBe(8000);
    expect(backoff.next()).toBe(16000);
    expect(backoff.next()).toBe(32000);
    expect(backoff.next()).toBe(60000); // would be 64000, capped at maxMs
    expect(backoff.next()).toBe(60000); // stays capped
  });

  it("resets back to the initial delay after reset()", () => {
    const backoff = new ExponentialBackoff({ initialMs: 1000, maxMs: 60000, factor: 2 });

    backoff.next();
    backoff.next();
    backoff.next();
    backoff.reset();

    expect(backoff.next()).toBe(1000);
    expect(backoff.next()).toBe(2000);
  });

  it("uses sane defaults when no options are given", () => {
    const backoff = new ExponentialBackoff();

    expect(backoff.next()).toBe(1000);
    expect(backoff.next()).toBe(2000);
  });

  it("respects a custom factor", () => {
    const backoff = new ExponentialBackoff({ initialMs: 500, maxMs: 10000, factor: 3 });

    expect(backoff.next()).toBe(500);
    expect(backoff.next()).toBe(1500);
    expect(backoff.next()).toBe(4500);
    expect(backoff.next()).toBe(10000); // 13500 capped
  });
});
