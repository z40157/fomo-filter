import { describe, expect, it } from "vitest";
import { computeBackfillRange } from "../src/chain/recovery.js";

describe("computeBackfillRange", () => {
  it("returns null on first-ever startup (no prior scanner_state)", () => {
    expect(computeBackfillRange(null, 1_000_000n)).toBeNull();
  });

  it("returns null when already caught up to the chain head", () => {
    expect(computeBackfillRange(500n, 500n)).toBeNull();
  });

  it("returns null defensively if the stored block is somehow ahead", () => {
    expect(computeBackfillRange(505n, 500n)).toBeNull();
  });

  it("computes the inclusive missing range", () => {
    expect(computeBackfillRange(500n, 505n)).toEqual({ fromBlock: 501n, toBlock: 505n });
  });

  it("handles a gap of exactly one block", () => {
    expect(computeBackfillRange(500n, 501n)).toEqual({ fromBlock: 501n, toBlock: 501n });
  });
});
