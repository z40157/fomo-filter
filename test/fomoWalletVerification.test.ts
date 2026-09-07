import { describe, expect, it } from "vitest";
import {
  CONTRACT_DIRECT_ACTIVITY,
  HistoricalCapabilityError,
  HistoricalTransientError,
  assembleWalletVerification,
  buildActivityRankings,
  buildCollisionsFile,
  buildLast5Tokens,
  buildRunSummary,
  classifyRpcErrorMessage,
  computeDirectActivityForEOA,
  computeRecommendedEnabled,
  computeUsdCoveragePct,
  decideNameUpdate,
  determineHistoricalRpcSupport,
  findBlock30dAgo,
  groupCandidatesByAddress,
  looksLikePossibleLostProvenance,
  normalizeAddress,
  parseFomoVerifyMetadata,
  planApplyForWallet,
  renderOrReplaceFomoVerifyMetadata,
  toWatchlistImportFormat,
  validateAddressFormat,
  type DirectActivityResult,
  type WalletScannerAggregateLike,
  type WalletVerificationInputs,
} from "../scripts/lib/fomoWalletVerification.js";

// ---------------------------------------------------------------------------
// Section 4 — address validation + collision
// ---------------------------------------------------------------------------

describe("validateAddressFormat", () => {
  it("accepts a well-formed 0x + 40 hex address", () => {
    expect(validateAddressFormat("0x1234567890123456789012345678901234567890")).toBe(true);
  });

  it("rejects addresses missing the 0x prefix, too short, or with bad chars", () => {
    expect(validateAddressFormat("1234567890123456789012345678901234567890")).toBe(false);
    expect(validateAddressFormat("0x123")).toBe(false);
    expect(validateAddressFormat("0xZZZZ567890123456789012345678901234567890")).toBe(false);
    expect(validateAddressFormat("")).toBe(false);
  });
});

describe("groupCandidatesByAddress / buildCollisionsFile", () => {
  it("finds no collisions when every address is unique", () => {
    const grouped = groupCandidatesByAddress([
      { rank: 1, handle: "a", address: "0xaaa0000000000000000000000000000000aaaa" },
      { rank: 2, handle: "b", address: "0xbbb0000000000000000000000000000000bbbb" },
    ]);
    expect(buildCollisionsFile(grouped)).toEqual([]);
  });

  it("detects a duplicate address (case-insensitively) and lists both users", () => {
    const grouped = groupCandidatesByAddress([
      { rank: 3, handle: "aaa", address: "0xAAA0000000000000000000000000000000aaaa" },
      { rank: 18, handle: "bbb", address: "0xaaa0000000000000000000000000000000AAAA" },
    ]);
    const collisions = buildCollisionsFile(grouped);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.manualReviewRequired).toBe(true);
    expect(collisions[0]!.users).toEqual([
      { rank: 3, handle: "aaa" },
      { rank: 18, handle: "bbb" },
    ]);
  });

  it("still runs the collision-detection machinery even with a single, non-colliding candidate", () => {
    const grouped = groupCandidatesByAddress([{ rank: 1, handle: "solo", address: "0x1111111111111111111111111111111111111" + "1" }]);
    expect(buildCollisionsFile(grouped)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Section 6 — block30dAgo binary search
// ---------------------------------------------------------------------------

describe("findBlock30dAgo", () => {
  it("finds the largest block with timestamp <= target, caching repeated fetches", async () => {
    // block N has timestamp N * 10 (monotonic, deterministic fake chain)
    const calls: bigint[] = [];
    const getBlockTimestamp = async (b: bigint) => {
      calls.push(b);
      return b * 10n;
    };
    const result = await findBlock30dAgo(1000n, 505n, getBlockTimestamp);
    expect(result.block30dAgo).toBe(50n); // 50*10=500 <= 505, 51*10=510 > 505
    expect(result.block30dAgoTimestamp).toBe(500n);
    // every fetched block number should be distinct (cache prevents duplicate RPC calls)
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("clamps to the low bound when the target predates the entire searchable range", async () => {
    const getBlockTimestamp = async (b: bigint) => b * 10n;
    const result = await findBlock30dAgo(1000n, -5n, getBlockTimestamp, 0n);
    expect(result.block30dAgo).toBe(0n);
    expect(result.block30dAgoTimestamp).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Section 8 — historicalRpcSupported state machine
// ---------------------------------------------------------------------------

describe("classifyRpcErrorMessage", () => {
  it("classifies known pruning/capability phrases as capability errors", () => {
    expect(classifyRpcErrorMessage("archive state unavailable for this block")).toBe("capability");
    expect(classifyRpcErrorMessage("missing trie node abc123")).toBe("capability");
    expect(classifyRpcErrorMessage("historical block unsupported on this plan")).toBe("capability");
  });

  it("classifies everything else as transient", () => {
    expect(classifyRpcErrorMessage("connection reset by peer")).toBe("transient");
    expect(classifyRpcErrorMessage("HTTP 429 Too Many Requests")).toBe("transient");
    expect(classifyRpcErrorMessage("timeout")).toBe("transient");
  });
});

describe("determineHistoricalRpcSupport", () => {
  it("returns UNKNOWN with a reason, and never probes, when there is no EOA candidate", async () => {
    let probed = false;
    const result = await determineHistoricalRpcSupport({
      candidates: [{ address: "0xcontract", addressType: "CONTRACT_OR_SMART_ACCOUNT" }],
      block30dAgo: 100n,
      probeNonce: async () => {
        probed = true;
        return 0n;
      },
    });
    expect(result.historicalRpcSupported).toBe("UNKNOWN");
    expect(result.reason).toBe("no EOA candidate available for historical nonce probe");
    expect(probed).toBe(false);
  });

  it("sets true on a successful probe, including a probe result of exactly 0", async () => {
    const result = await determineHistoricalRpcSupport({
      candidates: [{ address: "0xeoa", addressType: "EOA" }],
      block30dAgo: 100n,
      probeNonce: async () => 0n,
    });
    expect(result.historicalRpcSupported).toBe(true);
    expect(result.historicalRpcProbeAddress).toBe("0xeoa");
  });

  it("sets false only on a HistoricalCapabilityError, never on other errors", async () => {
    const result = await determineHistoricalRpcSupport({
      candidates: [{ address: "0xeoa", addressType: "EOA" }],
      block30dAgo: 100n,
      probeNonce: async () => {
        throw new HistoricalCapabilityError("archive state unavailable");
      },
    });
    expect(result.historicalRpcSupported).toBe(false);
  });

  it("sets UNKNOWN (never false) on a HistoricalTransientError after retries are exhausted", async () => {
    const result = await determineHistoricalRpcSupport({
      candidates: [{ address: "0xeoa", addressType: "EOA" }],
      block30dAgo: 100n,
      probeNonce: async () => {
        throw new HistoricalTransientError("connection reset");
      },
    });
    expect(result.historicalRpcSupported).toBe("UNKNOWN");
    expect(result.reason).toBe(
      "Historical-state capability could not be determined because the probe failed with a transient/non-capability RPC error.",
    );
  });

  it("only ever probes the FIRST EOA in candidate order, skipping leading contracts", async () => {
    const probed: string[] = [];
    await determineHistoricalRpcSupport({
      candidates: [
        { address: "0xcontract1", addressType: "CONTRACT_OR_SMART_ACCOUNT" },
        { address: "0xeoa1", addressType: "EOA" },
        { address: "0xeoa2", addressType: "EOA" },
      ],
      block30dAgo: 100n,
      probeNonce: async (address) => {
        probed.push(address);
        return 5n;
      },
    });
    expect(probed).toEqual(["0xeoa1"]);
  });
});

// ---------------------------------------------------------------------------
// Section 7 — direct sender activity
// ---------------------------------------------------------------------------

describe("computeDirectActivityForEOA", () => {
  it("directNonceLatest > 0 => directEverActive = true", () => {
    const result = computeDirectActivityForEOA({ nonceLatest: 5, historicalRpcSupported: "UNKNOWN", nonce30dAgo: null });
    expect(result.directEverActive).toBe(true);
    expect(result.directNonceLatest).toBe(5);
  });

  it("directNonceLatest === 0 => directEverActive = false", () => {
    const result = computeDirectActivityForEOA({ nonceLatest: 0, historicalRpcSupported: "UNKNOWN", nonce30dAgo: null });
    expect(result.directEverActive).toBe(false);
  });

  it("computes directTxCount30d as the nonce delta when historicalRpcSupported=true", () => {
    const result = computeDirectActivityForEOA({ nonceLatest: 14, historicalRpcSupported: true, nonce30dAgo: 3 });
    expect(result.directTxCount30d).toBe(11);
    expect(result.directRecentActive).toBe(true);
  });

  it("directRecentActive=false when the 30d delta is exactly 0", () => {
    const result = computeDirectActivityForEOA({ nonceLatest: 3, historicalRpcSupported: true, nonce30dAgo: 3 });
    expect(result.directTxCount30d).toBe(0);
    expect(result.directRecentActive).toBe(false);
  });

  it("leaves directTxCount30d/directRecentActive as null/UNKNOWN when historicalRpcSupported is not true", () => {
    const unsupported = computeDirectActivityForEOA({ nonceLatest: 5, historicalRpcSupported: false, nonce30dAgo: null });
    expect(unsupported.directTxCount30d).toBeNull();
    expect(unsupported.directRecentActive).toBe("UNKNOWN");

    const unknown = computeDirectActivityForEOA({ nonceLatest: 5, historicalRpcSupported: "UNKNOWN", nonce30dAgo: null });
    expect(unknown.directTxCount30d).toBeNull();
    expect(unknown.directRecentActive).toBe("UNKNOWN");
  });

  it("never guesses/clamps a negative delta — reports UNKNOWN plus an error reason instead of Math.max(0, delta)", () => {
    const result = computeDirectActivityForEOA({ nonceLatest: 3, historicalRpcSupported: true, nonce30dAgo: 10 });
    expect(result.directTxCount30d).toBeNull();
    expect(result.directRecentActive).toBe("UNKNOWN");
    expect(result.errorReason).toBeDefined();
    expect(result.errorReason).not.toMatch(/^0$/);
  });
});

describe("CONTRACT_DIRECT_ACTIVITY", () => {
  it("is all null/UNKNOWN — never derives activity from a nonce for contract/smart-account addresses", () => {
    expect(CONTRACT_DIRECT_ACTIVITY).toEqual<DirectActivityResult>({
      directNonceLatest: null,
      directNonce30dAgo: null,
      directTxCount30d: null,
      directEverActive: "UNKNOWN",
      directRecentActive: "UNKNOWN",
    });
  });
});

// ---------------------------------------------------------------------------
// Section 9.5 — USD coverage
// ---------------------------------------------------------------------------

describe("computeUsdCoveragePct", () => {
  it("is null when there are zero trades in the window — not 0%", () => {
    expect(computeUsdCoveragePct(0, 0)).toBeNull();
  });

  it("is 0 (a real number, not null) when there are trades but none are priced", () => {
    expect(computeUsdCoveragePct(10, 0)).toBe(0);
  });

  it("computes the percentage normally otherwise", () => {
    expect(computeUsdCoveragePct(19, 9)).toBeCloseTo((9 / 19) * 100);
  });
});

// ---------------------------------------------------------------------------
// Section 11 — recommendedEnabled
// ---------------------------------------------------------------------------

describe("computeRecommendedEnabled", () => {
  it("is true when trackedBuys30d > 0", () => {
    const r = computeRecommendedEnabled({ trackedBuys30d: 1, directRecentActive: "UNKNOWN" });
    expect(r.recommendedEnabled).toBe(true);
    expect(r.reasons).toContain("recommended_enabled=true because trackedBuys30d > 0");
  });

  it("is true when directRecentActive === true, strictly (UNKNOWN never triggers it)", () => {
    const active = computeRecommendedEnabled({ trackedBuys30d: 0, directRecentActive: true });
    expect(active.recommendedEnabled).toBe(true);

    const unknown = computeRecommendedEnabled({ trackedBuys30d: 0, directRecentActive: "UNKNOWN" });
    expect(unknown.recommendedEnabled).toBe(false);
  });

  it("is false with the exact mandated reason string when neither condition holds", () => {
    const r = computeRecommendedEnabled({ trackedBuys30d: 0, directRecentActive: false });
    expect(r.recommendedEnabled).toBe(false);
    expect(r.reasons).toEqual([
      "recommended_enabled=false because no recent scanner-covered BUY and no confirmed recent direct-sender activity were observed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Section 9.4 — last5Tokens (no per-wallet query, sorted+sliced in app code)
// ---------------------------------------------------------------------------

describe("buildLast5Tokens", () => {
  it("sorts by lastTradeAt DESC and takes the top 5", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      tokenAddress: `0xtoken${i}`,
      symbol: `T${i}`,
      buyCount: 1,
      sellCount: 0,
      lastTradeAt: new Date(2026, 0, i + 1),
    }));
    const top5 = buildLast5Tokens(rows);
    expect(top5).toHaveLength(5);
    expect(top5[0]!.symbol).toBe("T7");
    expect(top5[4]!.symbol).toBe("T3");
  });
});

// ---------------------------------------------------------------------------
// Section 10/14 — full per-wallet assembly (helper + core tests)
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<WalletVerificationInputs> = {}): WalletVerificationInputs {
  return {
    rank: 1,
    handle: "someone",
    address: "0x1234567890123456789012345678901234567890",
    validAddress: true,
    addressCollision: false,
    collisionHandles: [],
    addressType: "EOA",
    historicalRpcSupported: true,
    directActivity: {
      directNonceLatest: 5,
      directNonce30dAgo: 2,
      directTxCount30d: 3,
      directEverActive: true,
      directRecentActive: true,
    },
    scannerAgg: null,
    tokenRows: [],
    ...overrides,
  };
}

describe("assembleWalletVerification — invalid address", () => {
  it("short-circuits to a fully null/UNKNOWN record, flagged INVALID_ADDRESS, never excluded-for-collision", () => {
    const result = assembleWalletVerification(
      baseInputs({ validAddress: false, addressType: null, directActivity: CONTRACT_DIRECT_ACTIVITY }),
    );
    expect(result.validAddress).toBe(false);
    expect(result.statusFlags).toEqual(["INVALID_ADDRESS"]);
    expect(result.summaryStatus).toBe("INVALID_ADDRESS");
    expect(result.recommendedEnabled).toBe(false);
    expect(result.directEverActive).toBe("UNKNOWN");
    expect(result.usdCoveragePct).toBeNull();
  });
});

describe("assembleWalletVerification — CONTRACT_OR_SMART_ACCOUNT wording", () => {
  it("never uses forbidden 'inactive'/'no activity' wording, uses the mandated sentence instead", () => {
    const result = assembleWalletVerification(
      baseInputs({
        addressType: "CONTRACT_OR_SMART_ACCOUNT",
        directActivity: CONTRACT_DIRECT_ACTIVITY,
        scannerAgg: null,
      }),
    );
    expect(result.directEverActive).toBe("UNKNOWN");
    expect(result.directRecentActive).toBe("UNKNOWN");
    expect(result.recommendedEnabled).toBe(false);
    for (const r of result.reasons) {
      expect(r.toLowerCase()).not.toMatch(/\binactive\b/);
      expect(r.toLowerCase()).not.toMatch(/did not trade/);
    }
    expect(result.reasons.join(" ")).toContain(
      "Direct sender nonce analysis is not applicable to this contract/smart-account address type",
    );
  });

  it("says 'No recent BUY was observed...' (never 'no recent trading') when trackedBuys30d=0 but scanner data exists", () => {
    const scannerAgg: WalletScannerAggregateLike = {
      totalHistoricalTrades: 3,
      firstTrackedTradeAt: new Date("2026-01-01"),
      lastTrackedTradeAt: new Date("2026-01-01"),
      trackedTrades30d: 0,
      trackedBuys30d: 0,
      trackedSells30d: 0,
      distinctTokens30d: 0,
      pricedTradeCount30d: 0,
      trackedBuyUsd30d: null,
      trackedSellUsd30d: null,
    };
    const result = assembleWalletVerification(
      baseInputs({ addressType: "CONTRACT_OR_SMART_ACCOUNT", directActivity: CONTRACT_DIRECT_ACTIVITY, scannerAgg }),
    );
    expect(result.reasons).toContain("No recent BUY was observed in the scanner-covered markets.");
    for (const r of result.reasons) {
      expect(r).not.toMatch(/no recent trading/i);
    }
  });
});

describe("assembleWalletVerification — EOA no-recent-activity wording", () => {
  it("never says 'wallet inactive', uses the exact mandated AA/delegated-execution caveat instead", () => {
    const result = assembleWalletVerification(
      baseInputs({
        directActivity: {
          directNonceLatest: 5,
          directNonce30dAgo: 5,
          directTxCount30d: 0,
          directEverActive: true,
          directRecentActive: false,
        },
      }),
    );
    for (const r of result.reasons) {
      expect(r.toLowerCase()).not.toMatch(/wallet inactive/);
    }
    expect(result.reasons).toContain(
      "No direct transactions were sent by this EOA in the measured 30-day window. This does not rule out activity through account abstraction, smart accounts, relayers, or other delegated execution paths.",
    );
  });
});

describe("assembleWalletVerification — collision handling", () => {
  it("still runs the full pipeline (address type, direct activity, scanner data) but forces recommendedEnabled=false and excludedFromFinalWatchlist=true", () => {
    const scannerAgg: WalletScannerAggregateLike = {
      totalHistoricalTrades: 5,
      firstTrackedTradeAt: new Date("2026-01-01"),
      lastTrackedTradeAt: new Date("2026-02-01"),
      trackedTrades30d: 5,
      trackedBuys30d: 3,
      trackedSells30d: 2,
      distinctTokens30d: 2,
      pricedTradeCount30d: 5,
      trackedBuyUsd30d: 100,
      trackedSellUsd30d: 50,
    };
    const result = assembleWalletVerification(
      baseInputs({ addressCollision: true, collisionHandles: ["otherHandle"], scannerAgg }),
    );
    // full pipeline still ran:
    expect(result.trackedBuys30d).toBe(3);
    expect(result.scannerDataObserved).toBe(true);
    expect(result.directEverActive).toBe(true);
    // but forced:
    expect(result.recommendedEnabled).toBe(false);
    expect(result.excludedFromFinalWatchlist).toBe(true);
    expect(result.statusFlags).toContain("ADDRESS_COLLISION");
    expect(result.reasons.join(" ")).toContain("ADDRESS_COLLISION_REQUIRES_MANUAL_REVIEW");
  });
});

describe("assembleWalletVerification — recommendation examples", () => {
  it("recommends enabled with a scanner-covered BUY, disabled without any qualifying signal", () => {
    const enabledAgg: WalletScannerAggregateLike = {
      totalHistoricalTrades: 2,
      firstTrackedTradeAt: new Date(),
      lastTrackedTradeAt: new Date(),
      trackedTrades30d: 2,
      trackedBuys30d: 1,
      trackedSells30d: 1,
      distinctTokens30d: 1,
      pricedTradeCount30d: 0,
      trackedBuyUsd30d: null,
      trackedSellUsd30d: null,
    };
    const enabled = assembleWalletVerification(
      baseInputs({
        scannerAgg: enabledAgg,
        directActivity: { ...baseInputs().directActivity, directRecentActive: false },
      }),
    );
    expect(enabled.recommendedEnabled).toBe(true);

    const disabled = assembleWalletVerification(
      baseInputs({
        scannerAgg: null,
        directActivity: {
          directNonceLatest: 5,
          directNonce30dAgo: 5,
          directTxCount30d: 0,
          directEverActive: true,
          directRecentActive: false,
        },
      }),
    );
    expect(disabled.recommendedEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 20.2 — CRITICAL TEST 1: historical vs 30d separation
// ---------------------------------------------------------------------------

describe("CRITICAL TEST 1 — historical vs 30d separation", () => {
  it("a wallet with 1 BUY 40 days ago and nothing in the last 30d is scannerDataObserved=true, trackedMarketActive30d=false, and NEVER flagged NO_MATCH_IN_SCANNER_DATA", () => {
    const scannerAgg: WalletScannerAggregateLike = {
      totalHistoricalTrades: 1,
      firstTrackedTradeAt: new Date("2025-11-01"),
      lastTrackedTradeAt: new Date("2025-11-01"),
      trackedTrades30d: 0,
      trackedBuys30d: 0,
      trackedSells30d: 0,
      distinctTokens30d: 0,
      pricedTradeCount30d: 0,
      trackedBuyUsd30d: null,
      trackedSellUsd30d: null,
    };
    const result = assembleWalletVerification(baseInputs({ scannerAgg }));

    expect(result.scannerDataObserved).toBe(true);
    expect(result.totalHistoricalTrades).toBe(1);
    expect(result.trackedTrades30d).toBe(0);
    expect(result.trackedBuys30d).toBe(0);
    expect(result.trackedMarketActive30d).toBe(false);

    expect(result.statusFlags).not.toContain("NO_MATCH_IN_SCANNER_DATA");
    expect(result.summaryStatus).not.toBe("NO_MATCH_IN_SCANNER_DATA");
  });
});

// ---------------------------------------------------------------------------
// Metadata parser / renderer (Section 16, 20.4)
// ---------------------------------------------------------------------------

describe("parseFomoVerifyMetadata", () => {
  it("parses a well-formed block", () => {
    const notes = [
      "[source:fomo-verify-v1]",
      "fomo_rank=6",
      "fomo_handle=DumbCrayonEater",
      "wallet_source=FOMO_WALLET_FINDER",
      "verification=SCANNER_TRACKED_ACTIVE",
      "verified_at=2026-09-07T00:00:00.000Z",
      "[/source:fomo-verify-v1]",
    ].join("\n");
    const meta = parseFomoVerifyMetadata(notes);
    expect(meta).toEqual({
      isToolManaged: true,
      fomoRank: 6,
      fomoHandle: "DumbCrayonEater",
      walletSource: "FOMO_WALLET_FINDER",
      verification: "SCANNER_TRACKED_ACTIVE",
      verifiedAt: "2026-09-07T00:00:00.000Z",
    });
  });

  it("treats a missing start marker as not tool-managed (fail-safe)", () => {
    const notes = "fomo_rank=6\nfomo_handle=X\n[/source:fomo-verify-v1]";
    expect(parseFomoVerifyMetadata(notes).isToolManaged).toBe(false);
  });

  it("treats a missing end marker as not tool-managed (fail-safe)", () => {
    const notes = "[source:fomo-verify-v1]\nfomo_rank=6\nfomo_handle=X";
    expect(parseFomoVerifyMetadata(notes).isToolManaged).toBe(false);
  });

  it("treats a corrupted/misspelled marker as not tool-managed", () => {
    const notes = "[source:fomo-verify-v2]\nfomo_rank=6\n[/source:fomo-verify-v1]";
    expect(parseFomoVerifyMetadata(notes).isToolManaged).toBe(false);
  });

  it("treats an incomplete block (end appears before start) as not tool-managed", () => {
    const notes = "[/source:fomo-verify-v1] some text [source:fomo-verify-v1]";
    expect(parseFomoVerifyMetadata(notes).isToolManaged).toBe(false);
  });

  it("returns not-tool-managed for null notes", () => {
    expect(parseFomoVerifyMetadata(null).isToolManaged).toBe(false);
  });

  it("does not choke on a handle containing special characters (=, unicode, punctuation)", () => {
    const notes = [
      "[source:fomo-verify-v1]",
      "fomo_rank=1",
      "fomo_handle=weird=handle_🔥#1",
      "wallet_source=FOMO_WALLET_FINDER",
      "verification=SCANNER_TRACKED_ACTIVE",
      "verified_at=2026-09-07T00:00:00.000Z",
      "[/source:fomo-verify-v1]",
    ].join("\n");
    const meta = parseFomoVerifyMetadata(notes);
    expect(meta.isToolManaged).toBe(true);
    expect(meta.fomoHandle).toBe("weird=handle_🔥#1");
  });
});

describe("renderOrReplaceFomoVerifyMetadata", () => {
  const newMeta = {
    fomoRank: 6,
    fomoHandle: "NewHandle",
    walletSource: "FOMO_WALLET_FINDER",
    verification: "SCANNER_TRACKED_ACTIVE",
    verifiedAt: "2026-09-07T00:00:00.000Z",
  };

  it("creates a fresh block when there are no existing notes", () => {
    const rendered = renderOrReplaceFomoVerifyMetadata(null, newMeta);
    expect(rendered).toContain("[source:fomo-verify-v1]");
    expect(rendered).toContain("fomo_handle=NewHandle");
    expect(rendered).toContain("[/source:fomo-verify-v1]");
    expect(parseFomoVerifyMetadata(rendered).isToolManaged).toBe(true);
  });

  it("preserves manual notes written BEFORE the block, replacing only the block itself", () => {
    const existing = "Manual note A\n\n[source:fomo-verify-v1]\nfomo_handle=OldHandle\n[/source:fomo-verify-v1]";
    const rendered = renderOrReplaceFomoVerifyMetadata(existing, newMeta);
    expect(rendered).toContain("Manual note A");
    expect(rendered).toContain("fomo_handle=NewHandle");
    expect(rendered).not.toContain("OldHandle");
  });

  it("preserves manual notes written AFTER the block", () => {
    const existing = "[source:fomo-verify-v1]\nfomo_handle=OldHandle\n[/source:fomo-verify-v1]\n\nManual note B";
    const rendered = renderOrReplaceFomoVerifyMetadata(existing, newMeta);
    expect(rendered).toContain("Manual note B");
    expect(rendered).toContain("fomo_handle=NewHandle");
  });

  it("preserves manual notes on BOTH sides of the block simultaneously", () => {
    const existing = "Manual note A\n\n[source:fomo-verify-v1]\nfomo_handle=OldHandle\n[/source:fomo-verify-v1]\n\nManual note B";
    const rendered = renderOrReplaceFomoVerifyMetadata(existing, newMeta);
    expect(rendered).toContain("Manual note A");
    expect(rendered).toContain("Manual note B");
    expect(rendered).toContain("fomo_handle=NewHandle");
    expect(rendered).not.toContain("OldHandle");
  });

  it("replaces the block on rerun instead of appending a second one", () => {
    const first = renderOrReplaceFomoVerifyMetadata(null, newMeta);
    const second = renderOrReplaceFomoVerifyMetadata(first, { ...newMeta, fomoRank: 7 });
    const occurrences = second.split("[source:fomo-verify-v1]").length - 1;
    expect(occurrences).toBe(1);
    expect(second).toContain("fomo_rank=7");
  });
});

describe("looksLikePossibleLostProvenance", () => {
  it("flags notes with leftover tool-shaped fields but no valid marker block", () => {
    expect(looksLikePossibleLostProvenance("fomo_rank=6; fomo_handle=X; verification=SOMETHING")).toBe(true);
    expect(looksLikePossibleLostProvenance("wallet_source=FOMO_WALLET_FINDER")).toBe(true);
  });

  it("does not flag a fresh, never-tool-managed candidate note", () => {
    expect(looksLikePossibleLostProvenance("FOMO 7D rank #1; source=FOMO_WALLET_FINDER")).toBe(false);
  });

  it("does not flag null notes", () => {
    expect(looksLikePossibleLostProvenance(null)).toBe(false);
  });
});

describe("decideNameUpdate", () => {
  it("updates the name when existingName still equals the previously-imported handle", () => {
    const result = decideNameUpdate({
      existingName: "OldHandle",
      existingMetadata: { isToolManaged: true, fomoRank: 1, fomoHandle: "OldHandle", walletSource: null, verification: null, verifiedAt: null },
      currentHandle: "NewHandle",
    });
    expect(result.nameUpdated).toBe(true);
    expect(result.newName).toBe("NewHandle");
  });

  it("preserves a manually-customized name (existingName != previousHandle)", () => {
    const result = decideNameUpdate({
      existingName: "My Custom Name",
      existingMetadata: { isToolManaged: true, fomoRank: 1, fomoHandle: "OldHandle", walletSource: null, verification: null, verifiedAt: null },
      currentHandle: "NewHandle",
    });
    expect(result.nameUpdated).toBe(false);
    expect(result.newName).toBe("My Custom Name");
    expect(result.skipReason).toBe("manually_customized");
  });

  it("refuses to guess and preserves the name when previousHandle can't be recovered, with the mandated log message", () => {
    const result = decideNameUpdate({
      existingName: "Whatever",
      existingMetadata: { isToolManaged: false, fomoRank: null, fomoHandle: null, walletSource: null, verification: null, verifiedAt: null },
      currentHandle: "NewHandle",
    });
    expect(result.nameUpdated).toBe(false);
    expect(result.newName).toBe("Whatever");
    expect(result.skippedLogMessage).toBe(
      "Skipped name update because previous tool-managed handle could not be reliably recovered from notes.",
    );
  });
});

// ---------------------------------------------------------------------------
// Section 20.3 — CRITICAL TEST 2: manually-renamed tool-managed wallet not downgraded
// ---------------------------------------------------------------------------

describe("CRITICAL TEST 2 — manually-renamed / re-tiered tool-managed wallet survives a rerun untouched", () => {
  it("preserves name, tier, and ownerGroup; only rotates the metadata's fomo_handle and (per rules) enabled", () => {
    const existing = {
      name: "My Custom Name",
      type: "FOMO_TRADER",
      tier: "A",
      ownerGroup: "custom-owner-group",
      notes: "[source:fomo-verify-v1]\nfomo_rank=6\nfomo_handle=OldHandle\nwallet_source=FOMO_WALLET_FINDER\nverification=SCANNER_TRACKED_ACTIVE\nverified_at=2026-09-01T00:00:00.000Z\n[/source:fomo-verify-v1]",
    };

    const action = planApplyForWallet({
      existing,
      verified: {
        address: "0xabc",
        handle: "NewHandle",
        rank: 6,
        ownerGroup: "NewHandle",
        enabled: true,
        walletSource: "FOMO_WALLET_FINDER",
        verification: "SCANNER_TRACKED_ACTIVE",
      },
      verifiedAtIso: "2026-09-07T00:00:00.000Z",
    });

    expect(action.kind).toBe("update");
    if (action.kind !== "update") throw new Error("expected update");

    // name must NOT be overwritten to NewHandle:
    expect(action.patch.name).toBeUndefined();
    // tier/type/ownerGroup are never even part of the patch — repo.update()
    // only touches provided keys, so they're structurally preserved:
    expect(action.patch).not.toHaveProperty("tier");
    expect(action.patch).not.toHaveProperty("ownerGroup");
    expect(action.patch).not.toHaveProperty("type");
    // enabled can still update per the recommendation rules:
    expect(action.patch.enabled).toBe(true);
    // metadata block rotates to the new handle even though name itself didn't move:
    expect(action.patch.notes).toContain("fomo_handle=NewHandle");
    expect(action.nameDecision.skipReason).toBe("manually_customized");
  });
});

describe("planApplyForWallet — other branches", () => {
  it("creates a brand-new tool-managed row when no existing row exists", () => {
    const action = planApplyForWallet({
      existing: null,
      verified: {
        address: "0xabc",
        handle: "freshHandle",
        rank: 10,
        ownerGroup: "freshHandle",
        enabled: false,
        walletSource: "FOMO_WALLET_FINDER",
        verification: "NO_MATCH_IN_SCANNER_DATA",
      },
      verifiedAtIso: "2026-09-07T00:00:00.000Z",
    });
    expect(action.kind).toBe("create");
    if (action.kind !== "create") throw new Error("expected create");
    expect(action.entry.tier).toBe("C");
    expect(action.entry.type).toBe("FOMO_TRADER");
    expect(action.entry.notes).toContain("fomo_handle=freshHandle");
  });

  it("skips a non-tool-managed existing row entirely (fail-safe), regardless of type mismatch or missing marker", () => {
    const action = planApplyForWallet({
      existing: { name: "Hand Curated KOL", type: "KOL", tier: "A", ownerGroup: "someone", notes: "manually added, no tool marker" },
      verified: {
        address: "0xabc",
        handle: "someHandle",
        rank: 1,
        ownerGroup: "someHandle",
        enabled: true,
        walletSource: "FOMO_WALLET_FINDER",
        verification: "SCANNER_TRACKED_ACTIVE",
      },
      verifiedAtIso: "2026-09-07T00:00:00.000Z",
    });
    expect(action).toEqual({ kind: "skip", reason: "APPLY_SKIPPED_EXISTING_MANUAL_ROW", possibleLostProvenance: false });
  });

  it("flags possibleLostProvenance when type=FOMO_TRADER but the marker is missing/corrupted with leftover tool-shaped fields", () => {
    const action = planApplyForWallet({
      existing: {
        name: "Someone",
        type: "FOMO_TRADER",
        tier: "C",
        ownerGroup: "someone",
        notes: "fomo_rank=3; fomo_handle=Someone; verification=OLD_FORMAT (no proper marker block)",
      },
      verified: {
        address: "0xabc",
        handle: "someone",
        rank: 3,
        ownerGroup: "someone",
        enabled: true,
        walletSource: "FOMO_WALLET_FINDER",
        verification: "SCANNER_TRACKED_ACTIVE",
      },
      verifiedAtIso: "2026-09-07T00:00:00.000Z",
    });
    expect(action.kind).toBe("skip");
    if (action.kind !== "skip") throw new Error("expected skip");
    expect(action.possibleLostProvenance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 14.4 — verified watchlist JSON excludes invalid/collision addresses
// ---------------------------------------------------------------------------

describe("toWatchlistImportFormat", () => {
  it("excludes invalid addresses and collision-excluded addresses from the final watchlist", () => {
    const valid = assembleWalletVerification(baseInputs({ rank: 1, handle: "good", address: "0xaaa0000000000000000000000000000000aaaa" }));
    const invalid = assembleWalletVerification(
      baseInputs({ rank: 2, handle: "bad", address: "not-an-address", validAddress: false, addressType: null }),
    );
    const collided = assembleWalletVerification(
      baseInputs({
        rank: 3,
        handle: "collided",
        address: "0xccc0000000000000000000000000000000cccc",
        addressCollision: true,
        collisionHandles: ["other"],
      }),
    );

    const candidatesByAddress = new Map([
      ["0xaaa0000000000000000000000000000000aaaa", { rank: 1, handle: "good", ownerGroup: "good" }],
      ["0xccc0000000000000000000000000000000cccc", { rank: 3, handle: "collided", ownerGroup: "collided" }],
    ]);

    const out = toWatchlistImportFormat([valid, invalid, collided], candidatesByAddress, "2026-09-07T00:00:00.000Z");
    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe("0xaaa0000000000000000000000000000000aaaa");
    expect(out[0]!.tier).toBe("C");
    expect(out[0]!.type).toBe("FOMO_TRADER");
  });
});

// ---------------------------------------------------------------------------
// Section 18/19 — run summary + activity rankings
// ---------------------------------------------------------------------------

describe("buildRunSummary / buildActivityRankings", () => {
  it("tallies counts and builds three independent, never-conflated activity rankings", () => {
    const walletA = assembleWalletVerification(
      baseInputs({
        rank: 1,
        handle: "a",
        address: "0xaaa0000000000000000000000000000000aaaa",
        scannerAgg: {
          totalHistoricalTrades: 5,
          firstTrackedTradeAt: new Date(),
          lastTrackedTradeAt: new Date(),
          trackedTrades30d: 5,
          trackedBuys30d: 4,
          trackedSells30d: 1,
          distinctTokens30d: 3,
          pricedTradeCount30d: 5,
          trackedBuyUsd30d: 400,
          trackedSellUsd30d: 100,
        },
        directActivity: { directNonceLatest: 20, directNonce30dAgo: 5, directTxCount30d: 15, directEverActive: true, directRecentActive: true },
      }),
    );
    const walletB = assembleWalletVerification(
      baseInputs({
        rank: 2,
        handle: "b",
        address: "0xbbb0000000000000000000000000000000bbbb",
        addressType: "CONTRACT_OR_SMART_ACCOUNT",
        directActivity: CONTRACT_DIRECT_ACTIVITY,
        scannerAgg: null,
      }),
    );

    const summary = buildRunSummary([walletA, walletB], true, null, []);
    expect(summary.inputWallets).toBe(2);
    expect(summary.valid).toBe(2);
    expect(summary.eoa).toBe(1);
    expect(summary.contractOrSmartAccount).toBe(1);
    expect(summary.recommendedEnabled).toBe(1); // A qualifies, B doesn't
    expect(summary.scannerBuyWallets30d).toBe(1);

    const rankings = buildActivityRankings([walletA, walletB]);
    expect(rankings.topTrackedBuyActivity[0]!.handle).toBe("a");
    expect(rankings.topDirectSenderActivity).toHaveLength(1); // B's directTxCount30d is null, excluded
    expect(rankings.topDirectSenderActivity[0]!.handle).toBe("a");
  });
});

describe("normalizeAddress", () => {
  it("lowercases", () => {
    expect(normalizeAddress("0xABCDEF0000000000000000000000000000000A")).toBe("0xabcdef0000000000000000000000000000000a");
  });
});
