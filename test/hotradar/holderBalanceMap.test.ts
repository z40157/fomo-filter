import { describe, expect, it } from "vitest";
import { HolderBalanceMap } from "../../src/hotradar/holderBalanceMap.js";

const TOKEN = "0xtoken0000000000000000000000000000000001";
const ZERO = `0x${"0".repeat(40)}`;
const ALICE = "0xalice000000000000000000000000000000001a";
const BOB = "0xbob0000000000000000000000000000000001b";
const LP = "0xlp00000000000000000000000000000000001c";

describe("HolderBalanceMap — mint / transfer / sell(burn) / zero balance", () => {
  it("mint: no from-side deduction, only credits the recipient", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 });
    expect(map.getHolders(TOKEN).get(ALICE)).toBe(1000n);
    expect(map.getHolderCount(TOKEN)).toBe(1);
  });

  it("transfer: moves balance from one holder to another", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ALICE, to: BOB, amount: 400n, txHash: "0x2", logIndex: 0 });
    expect(map.getHolders(TOKEN).get(ALICE)).toBe(600n);
    expect(map.getHolders(TOKEN).get(BOB)).toBe(400n);
  });

  it("burn (sell to zero address): debits the sender, no recipient credited", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ALICE, to: ZERO, amount: 1000n, txHash: "0x2", logIndex: 0 });
    expect(map.getHolders(TOKEN).has(ALICE)).toBe(false); // zero balance dropped
  });

  it("a holder who sold everything (zero balance) is excluded from getHolders/getHolderCount", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ALICE, to: BOB, amount: 1000n, txHash: "0x2", logIndex: 0 });
    expect(map.getHolderCount(TOKEN)).toBe(1);
    expect(map.getHolders(TOKEN).has(ALICE)).toBe(false);
  });
});

describe("HolderBalanceMap — exclusion is read-time only", () => {
  it("excluded addresses (LP/router/etc) are omitted from getHolders but the raw balance survives internally", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: LP, amount: 5000n, txHash: "0x1", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x2", logIndex: 0 });

    expect(map.getHolderCount(TOKEN)).toBe(2); // no exclusion supplied
    expect(map.getHolderCount(TOKEN, [LP])).toBe(1); // excluded at read time
    // Re-querying without exclusion again still sees LP — proves the raw
    // map was never mutated by the excluding read.
    expect(map.getHolderCount(TOKEN)).toBe(2);
  });

  it("getTopHolderSharePct respects exclusions and returns a percentage 0-100", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: LP, amount: 9000n, txHash: "0x1", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 500n, txHash: "0x2", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ZERO, to: BOB, amount: 500n, txHash: "0x3", logIndex: 0 });

    expect(map.getTopHolderSharePct(TOKEN, 1)).toBeCloseTo(90, 0); // LP dominates without exclusion
    expect(map.getTopHolderSharePct(TOKEN, 1, [LP])).toBeCloseTo(50, 0); // Alice/Bob split evenly once LP excluded
  });

  it("returns null (never 0) when there is nothing to compute a share from", () => {
    const map = new HolderBalanceMap();
    expect(map.getTopHolderSharePct(TOKEN, 10)).toBeNull();
  });
});

describe("HolderBalanceMap — dedup (backfill + live subscription race)", () => {
  it("the same (txHash, logIndex) applied twice is only counted once", () => {
    const map = new HolderBalanceMap();
    const transfer = { from: ZERO, to: ALICE, amount: 1000n, txHash: "0xdup", logIndex: 2 };
    expect(map.applyTransfer(TOKEN, transfer)).toBe("applied");
    expect(map.applyTransfer(TOKEN, transfer)).toBe("duplicate");
    expect(map.getHolders(TOKEN).get(ALICE)).toBe(1000n);
  });

  it("different logIndex within the same tx are distinct events", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 100n, txHash: "0xsame", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 100n, txHash: "0xsame", logIndex: 1 });
    expect(map.getHolders(TOKEN).get(ALICE)).toBe(200n);
  });
});

describe("HolderBalanceMap — EXPIRED_30M eviction", () => {
  it("release() drops the token's entire balance map and frees its address-count contribution", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 });
    expect(map.health().balanceTableTokens).toBe(1);
    expect(map.health().balanceTableAddresses).toBe(1);

    map.release(TOKEN);
    expect(map.health().balanceTableTokens).toBe(0);
    expect(map.health().balanceTableAddresses).toBe(0);
    expect(map.getHolderCount(TOKEN)).toBe(0);
  });

  it("re-applying a transfer for a released token starts a fresh map (no stale dedup state)", () => {
    const map = new HolderBalanceMap();
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 });
    map.release(TOKEN);
    expect(map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1000n, txHash: "0x1", logIndex: 0 })).toBe("applied");
  });
});

describe("HolderBalanceMap — capacity guard (A.15)", () => {
  it("degrades gracefully instead of growing without bound once the per-token cap is hit", () => {
    const map = new HolderBalanceMap({ maxAddressesPerToken: 2 });
    expect(map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1n, txHash: "0x1", logIndex: 0 })).toBe("applied");
    expect(map.applyTransfer(TOKEN, { from: ZERO, to: BOB, amount: 1n, txHash: "0x2", logIndex: 0 })).toBe("applied");
    const third = "0xthird00000000000000000000000000000001d";
    expect(map.applyTransfer(TOKEN, { from: ZERO, to: third, amount: 1n, txHash: "0x3", logIndex: 0 })).toBe(
      "capacity_exceeded",
    );
    expect(map.isCapacityExceeded(TOKEN)).toBe(true);
    expect(map.health().balanceTableEvictions).toBe(1);
    // Existing holders are untouched by the rejected write.
    expect(map.getHolderCount(TOKEN)).toBe(2);
  });

  it("a transfer that only moves balance between already-tracked addresses is never blocked by the cap", () => {
    const map = new HolderBalanceMap({ maxAddressesPerToken: 2 });
    map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 100n, txHash: "0x1", logIndex: 0 });
    map.applyTransfer(TOKEN, { from: ZERO, to: BOB, amount: 100n, txHash: "0x2", logIndex: 0 });
    expect(map.applyTransfer(TOKEN, { from: ALICE, to: BOB, amount: 50n, txHash: "0x3", logIndex: 0 })).toBe("applied");
  });

  it("respects the cross-token total cap even when each individual token is under its own per-token cap", () => {
    const map = new HolderBalanceMap({ maxAddressesPerToken: 10, maxTotalAddresses: 1 });
    expect(map.applyTransfer(TOKEN, { from: ZERO, to: ALICE, amount: 1n, txHash: "0x1", logIndex: 0 })).toBe("applied");
    const otherToken = "0xtoken0000000000000000000000000000000002";
    expect(map.applyTransfer(otherToken, { from: ZERO, to: BOB, amount: 1n, txHash: "0x2", logIndex: 0 })).toBe(
      "capacity_exceeded",
    );
  });

  it("never throws even when hammered past capacity repeatedly", () => {
    const map = new HolderBalanceMap({ maxAddressesPerToken: 1 });
    expect(() => {
      for (let i = 0; i < 50; i++) {
        map.applyTransfer(TOKEN, {
          from: ZERO,
          to: `0x${i.toString().padStart(40, "0")}`,
          amount: 1n,
          txHash: `0xtx${i}`,
          logIndex: 0,
        });
      }
    }).not.toThrow();
  });
});
