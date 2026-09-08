// Pure, RPC/DB-free logic for scripts/verifyFomoWallets.ts. Every function
// here takes already-fetched data (or an injected fetch/probe function) so
// the whole pipeline is unit-testable without a live chain or database.
//
// Two principles run through this entire module (see the task spec):
//   1. "not found" != "no activity" — our scanner only covers Doppler +
//      Pons V1, never the whole chain. NO_MATCH_IN_SCANNER_DATA and
//      NO_ROBINHOOD_ACTIVITY are never the same claim.
//   2. Never guess — missing data is `null` / `"UNKNOWN"`, never silently
//      downgraded to `0` / `false`.

import type { AddressType } from "../../src/chain/addressType.js";
import { parseEip7702Delegate, classifyAddressType } from "../../src/chain/addressType.js";
export type { AddressType };
export { parseEip7702Delegate, classifyAddressType };
export type TriState = true | false | "UNKNOWN";
export type HistoricalRpcSupported = true | false | "UNKNOWN";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function validateAddressFormat(address: string): boolean {
  return EVM_ADDRESS_RE.test(address);
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

// EIP-7702 delegation designator detection now lives in
// src/chain/addressType.ts (re-exported above) so it ships in the
// production build and src/discovery/walletDiscoveryJob.ts can reuse it —
// scripts/ is dev-tooling only, not part of the compiled dist/ image.

// ---------------------------------------------------------------------------
// Section 4 — address collision detection
// ---------------------------------------------------------------------------

export interface CollisionUser {
  rank: number;
  handle: string;
}

/** Groups candidates by lowercased address. Always computed, even when the
 * current input has zero collisions — this logic must exist for future runs. */
export function groupCandidatesByAddress(
  candidates: { rank: number; handle: string; address: string }[],
): Map<string, CollisionUser[]> {
  const byAddress = new Map<string, CollisionUser[]>();
  for (const c of candidates) {
    const key = normalizeAddress(c.address);
    const list = byAddress.get(key) ?? [];
    list.push({ rank: c.rank, handle: c.handle });
    byAddress.set(key, list);
  }
  return byAddress;
}

export interface FomoWalletCollision {
  address: string;
  users: CollisionUser[];
  manualReviewRequired: true;
}

export function buildCollisionsFile(byAddress: Map<string, CollisionUser[]>): FomoWalletCollision[] {
  const collisions: FomoWalletCollision[] = [];
  for (const [address, users] of byAddress) {
    if (users.length > 1) {
      collisions.push({ address, users, manualReviewRequired: true });
    }
  }
  return collisions;
}

// ---------------------------------------------------------------------------
// Section 6 — global block30dAgo binary search (run once, not per-wallet)
// ---------------------------------------------------------------------------

export interface Block30dAgoResult {
  block30dAgo: bigint;
  block30dAgoTimestamp: bigint;
  binarySearchRpcCalls: number;
}

/** Finds the largest block whose timestamp is <= targetTimestamp, via binary
 * search over [low, latestBlock]. `getBlockTimestamp` is injected so this is
 * fully testable with a fake in-memory chain. Caches every timestamp fetched
 * during the search in a local Map so no block is ever fetched twice. */
export async function findBlock30dAgo(
  latestBlock: bigint,
  targetTimestamp: bigint,
  getBlockTimestamp: (blockNumber: bigint) => Promise<bigint>,
  low = 0n,
): Promise<Block30dAgoResult> {
  const cache = new Map<bigint, bigint>();
  let calls = 0;
  const ts = async (b: bigint): Promise<bigint> => {
    const cached = cache.get(b);
    if (cached !== undefined) return cached;
    calls++;
    const t = await getBlockTimestamp(b);
    cache.set(b, t);
    return t;
  };

  let lo = low;
  let hi = latestBlock;
  let result = low;

  while (lo <= hi) {
    const mid = lo + (hi - lo) / 2n;
    const midTs = await ts(mid);
    if (midTs <= targetTimestamp) {
      result = mid;
      lo = mid + 1n;
    } else {
      if (mid === low) break;
      hi = mid - 1n;
    }
  }

  const resultTs = cache.get(result) ?? (await ts(result));
  return { block30dAgo: result, block30dAgoTimestamp: resultTs, binarySearchRpcCalls: calls };
}

// ---------------------------------------------------------------------------
// Section 8 — historicalRpcSupported state machine
// ---------------------------------------------------------------------------

/** Thrown by an injected probe fn to signal a definite provider
 * capability/pruning error (archive state unavailable, pruned state, etc.) —
 * never retried, immediately sets historicalRpcSupported = false. */
export class HistoricalCapabilityError extends Error {}

/** Thrown by an injected probe fn after backoff/retry is exhausted without
 * ever proving a capability problem (429s, timeouts, connection resets) —
 * sets historicalRpcSupported = UNKNOWN, never false. */
export class HistoricalTransientError extends Error {}

const CAPABILITY_ERROR_PATTERNS = [
  /archive state unavailable/i,
  /pruned state/i,
  /missing trie node/i,
  /missing historical state/i,
  /historical block unsupported/i,
  /archive required/i,
  /unsupported historical state/i,
];

/** Pure classifier used by the orchestration script's RPC wrapper to decide
 * whether a given error message proves the provider lacks historical-state
 * support (capability) vs. is just a transient failure worth retrying. */
export function classifyRpcErrorMessage(message: string): "capability" | "transient" {
  return CAPABILITY_ERROR_PATTERNS.some((re) => re.test(message)) ? "capability" : "transient";
}

export interface HistoricalCapabilityResult {
  historicalRpcSupported: HistoricalRpcSupported;
  historicalRpcProbeAddress: string | null;
  historicalRpcProbeResult: string | null;
  historicalRpcProbeBlock: bigint | null;
  reason?: string;
}

/** Runs the capability probe against the first EOA-or-EIP7702-delegated-EOA
 * candidate found (in input order), or returns UNKNOWN immediately if there
 * is none — never probes a genuine CONTRACT_OR_SMART_ACCOUNT address. An
 * EIP7702_DELEGATED_EOA is still a real EOA for `eth_getTransactionCount`
 * purposes (own nonce, own private key) — excluding it here was the actual
 * bug behind an entire 72/72-delegated run always reporting UNKNOWN
 * regardless of the RPC's real historical-state support (see the
 * classifyAddressType doc comment above). `probeNonce` must already
 * encapsulate backoff/retry and throw HistoricalCapabilityError /
 * HistoricalTransientError as appropriate (anything else is treated as a
 * transient/unclassified failure — still UNKNOWN, never false). */
export async function determineHistoricalRpcSupport(params: {
  candidates: { address: string; addressType: AddressType }[];
  block30dAgo: bigint;
  probeNonce: (address: string, block: bigint) => Promise<bigint>;
}): Promise<HistoricalCapabilityResult> {
  const probeCandidate = params.candidates.find(
    (c) => c.addressType === "EOA" || c.addressType === "EIP7702_DELEGATED_EOA",
  );
  if (!probeCandidate) {
    return {
      historicalRpcSupported: "UNKNOWN",
      historicalRpcProbeAddress: null,
      historicalRpcProbeResult: null,
      historicalRpcProbeBlock: null,
      reason: "no EOA or EIP-7702-delegated-EOA candidate available for historical nonce probe",
    };
  }

  try {
    const value = await params.probeNonce(probeCandidate.address, params.block30dAgo);
    return {
      historicalRpcSupported: true,
      historicalRpcProbeAddress: probeCandidate.address,
      historicalRpcProbeResult: value.toString(),
      historicalRpcProbeBlock: params.block30dAgo,
    };
  } catch (err) {
    if (err instanceof HistoricalCapabilityError) {
      return {
        historicalRpcSupported: false,
        historicalRpcProbeAddress: probeCandidate.address,
        historicalRpcProbeResult: `capability_error: ${err.message}`,
        historicalRpcProbeBlock: params.block30dAgo,
        reason: err.message,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      historicalRpcSupported: "UNKNOWN",
      historicalRpcProbeAddress: probeCandidate.address,
      historicalRpcProbeResult: `transient_error: ${message}`,
      historicalRpcProbeBlock: params.block30dAgo,
      reason:
        "Historical-state capability could not be determined because the probe failed with a transient/non-capability RPC error.",
    };
  }
}

// ---------------------------------------------------------------------------
// Section 7 — direct sender activity
// ---------------------------------------------------------------------------

export interface DirectActivityResult {
  directNonceLatest: number | null;
  directNonce30dAgo: number | null;
  directTxCount30d: number | null;
  directEverActive: TriState;
  directRecentActive: TriState;
  /** Set only for the "impossible negative delta" defensive case — never
   * silently clamped with Math.max(0, delta). */
  errorReason?: string;
}

export const CONTRACT_DIRECT_ACTIVITY: DirectActivityResult = {
  directNonceLatest: null,
  directNonce30dAgo: null,
  directTxCount30d: null,
  directEverActive: "UNKNOWN",
  directRecentActive: "UNKNOWN",
};

export function computeDirectActivityForEOA(params: {
  nonceLatest: number;
  historicalRpcSupported: HistoricalRpcSupported;
  /** Null when historicalRpcSupported !== true, or the wallet-specific fetch itself failed. */
  nonce30dAgo: number | null;
}): DirectActivityResult {
  const directEverActive: TriState = params.nonceLatest > 0;

  if (params.historicalRpcSupported !== true || params.nonce30dAgo === null) {
    return {
      directNonceLatest: params.nonceLatest,
      directNonce30dAgo: null,
      directTxCount30d: null,
      directEverActive,
      directRecentActive: "UNKNOWN",
    };
  }

  const delta = params.nonceLatest - params.nonce30dAgo;
  if (delta < 0) {
    return {
      directNonceLatest: params.nonceLatest,
      directNonce30dAgo: params.nonce30dAgo,
      directTxCount30d: null,
      directEverActive,
      directRecentActive: "UNKNOWN",
      errorReason: `directTxCount30d computed as negative (directNonceLatest=${params.nonceLatest}, directNonce30dAgo=${params.nonce30dAgo}) — treated as UNKNOWN rather than guessed; verify RPC/block consistency.`,
    };
  }

  return {
    directNonceLatest: params.nonceLatest,
    directNonce30dAgo: params.nonce30dAgo,
    directTxCount30d: delta,
    directEverActive,
    directRecentActive: delta > 0,
  };
}

// ---------------------------------------------------------------------------
// Section 9.5 — USD coverage
// ---------------------------------------------------------------------------

/** null when there's nothing to compute coverage over (0 trades in the
 * window) — distinct from a real 0% coverage over trades that exist. */
export function computeUsdCoveragePct(trackedTrades30d: number, pricedTradeCount30d: number): number | null {
  if (trackedTrades30d <= 0) return null;
  return (pricedTradeCount30d / trackedTrades30d) * 100;
}

// ---------------------------------------------------------------------------
// Section 11 — recommendedEnabled
// ---------------------------------------------------------------------------

export function computeRecommendedEnabled(params: {
  trackedBuys30d: number;
  directRecentActive: TriState;
}): { recommendedEnabled: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let enabled = false;
  if (params.trackedBuys30d > 0) {
    enabled = true;
    reasons.push("recommended_enabled=true because trackedBuys30d > 0");
  }
  if (params.directRecentActive === true) {
    enabled = true;
    reasons.push("recommended_enabled=true because directRecentActive=true");
  }
  if (!enabled) {
    reasons.push(
      "recommended_enabled=false because no recent scanner-covered BUY and no confirmed recent direct-sender activity were observed",
    );
  }
  return { recommendedEnabled: enabled, reasons };
}

// ---------------------------------------------------------------------------
// Section 9 — scanner DB aggregates, last5Tokens
// ---------------------------------------------------------------------------

export interface WalletScannerAggregateLike {
  totalHistoricalTrades: number;
  firstTrackedTradeAt: Date | null;
  lastTrackedTradeAt: Date | null;
  trackedTrades30d: number;
  trackedBuys30d: number;
  trackedSells30d: number;
  distinctTokens30d: number;
  pricedTradeCount30d: number;
  trackedBuyUsd30d: number | null;
  trackedSellUsd30d: number | null;
}

export interface WalletTokenActivityLike {
  tokenAddress: string;
  symbol: string | null;
  buyCount: number;
  sellCount: number;
  lastTradeAt: Date;
}

export interface Last5Token {
  symbol: string | null;
  address: string;
  buyCount: number;
  sellCount: number;
  lastTradeAt: string;
}

/** Sorts in application code (never a per-wallet SQL query) and takes the
 * top 5 by lastTradeAt — the caller has already grouped rows by wallet. */
export function buildLast5Tokens(tokenRows: WalletTokenActivityLike[]): Last5Token[] {
  return [...tokenRows]
    .sort((a, b) => b.lastTradeAt.getTime() - a.lastTradeAt.getTime())
    .slice(0, 5)
    .map((r) => ({
      symbol: r.symbol,
      address: r.tokenAddress,
      buyCount: r.buyCount,
      sellCount: r.sellCount,
      lastTradeAt: r.lastTradeAt.toISOString(),
    }));
}

// ---------------------------------------------------------------------------
// Section 10/14 — full per-wallet assembly
// ---------------------------------------------------------------------------

export interface WalletVerificationInputs {
  rank: number;
  handle: string;
  address: string;
  validAddress: boolean;
  addressCollision: boolean;
  collisionHandles: string[];
  addressType: AddressType | null;
  historicalRpcSupported: HistoricalRpcSupported;
  directActivity: DirectActivityResult;
  scannerAgg: WalletScannerAggregateLike | null;
  tokenRows: WalletTokenActivityLike[];
}

export interface WalletVerification {
  rank: number;
  handle: string;
  address: string;
  validAddress: boolean;
  addressCollision: boolean;
  collisionHandles: string[];
  addressType: AddressType | null;
  historicalRpcSupported: HistoricalRpcSupported;
  directNonceLatest: number | null;
  directNonce30dAgo: number | null;
  directTxCount30d: number | null;
  directEverActive: TriState;
  directRecentActive: TriState;
  scannerDataObserved: boolean;
  totalHistoricalTrades: number;
  trackedMarketActive30d: boolean;
  trackedTrades30d: number;
  trackedBuys30d: number;
  trackedSells30d: number;
  distinctTokens30d: number;
  trackedBuyUsd30d: number | null;
  trackedSellUsd30d: number | null;
  pricedTradeCount30d: number;
  usdCoveragePct: number | null;
  firstTrackedTradeAt: string | null;
  lastTrackedTradeAt: string | null;
  last5Tokens: Last5Token[];
  statusFlags: string[];
  summaryStatus: string;
  recommendedEnabled: boolean;
  excludedFromFinalWatchlist: boolean;
  reasons: string[];
}

const CONTRACT_RECOMMENDATION_REASON =
  "No qualifying activity was positively observed in the currently scanner-covered markets. Direct sender nonce analysis is not applicable to this contract/smart-account address type, so broader account-abstraction or delegated activity remains unknown.";

const NO_SCANNER_HISTORY_REASON = "No scanner-covered trade history was observed for this address.";
const NO_SCANNER_HISTORY_CAVEAT =
  "This does not prove the address had no Robinhood Chain activity outside the scanner's covered protocols.";
const NO_RECENT_BUY_REASON = "No recent BUY was observed in the scanner-covered markets.";
const EOA_NO_RECENT_ACTIVITY_REASON =
  "No direct transactions were sent by this EOA in the measured 30-day window. This does not rule out activity through account abstraction, smart accounts, relayers, or other delegated execution paths.";
const EIP7702_NONCE_CAVEAT =
  "This address's on-chain code is an EIP-7702 delegation designator (still the user's own EOA, not a deployed contract). Its nonce also increments on EIP-7702 authorization refreshes, not only on sent transactions, so a nonce-based tx count here is not directly comparable to a plain EOA's tx count and should not be read as a precise activity measure. Real trading through this account very likely happens via ERC-4337 UserOperations (sender != tx.from) that the scanner's tx.from-based matching cannot see — see the 2026-09-07 investigation.";

export function assembleWalletVerification(inputs: WalletVerificationInputs): WalletVerification {
  if (!inputs.validAddress) {
    return {
      rank: inputs.rank,
      handle: inputs.handle,
      address: inputs.address,
      validAddress: false,
      addressCollision: inputs.addressCollision,
      collisionHandles: inputs.collisionHandles,
      addressType: null,
      historicalRpcSupported: inputs.historicalRpcSupported,
      directNonceLatest: null,
      directNonce30dAgo: null,
      directTxCount30d: null,
      directEverActive: "UNKNOWN",
      directRecentActive: "UNKNOWN",
      scannerDataObserved: false,
      totalHistoricalTrades: 0,
      trackedMarketActive30d: false,
      trackedTrades30d: 0,
      trackedBuys30d: 0,
      trackedSells30d: 0,
      distinctTokens30d: 0,
      trackedBuyUsd30d: null,
      trackedSellUsd30d: null,
      pricedTradeCount30d: 0,
      usdCoveragePct: null,
      firstTrackedTradeAt: null,
      lastTrackedTradeAt: null,
      last5Tokens: [],
      statusFlags: ["INVALID_ADDRESS"],
      summaryStatus: "INVALID_ADDRESS",
      recommendedEnabled: false,
      excludedFromFinalWatchlist: false,
      reasons: ["Address failed EVM format validation (expected 0x followed by 40 hex characters)."],
    };
  }

  const statusFlags: string[] = [];
  const reasons: string[] = [];
  const da = inputs.directActivity;

  if (inputs.addressType === "EOA") {
    statusFlags.push("EOA");
    if (da.directEverActive === true) statusFlags.push("DIRECT_EVER_ACTIVE");
    if (da.directRecentActive === true) {
      statusFlags.push("DIRECT_RECENT_ACTIVE");
    } else if (da.directRecentActive === false) {
      statusFlags.push("NO_DIRECT_RECENT_ACTIVITY");
      reasons.push(EOA_NO_RECENT_ACTIVITY_REASON);
    } else {
      statusFlags.push("DIRECT_ACTIVITY_UNKNOWN");
      if (inputs.historicalRpcSupported !== true) {
        statusFlags.push("HISTORICAL_RPC_UNAVAILABLE");
      }
    }
    if (da.errorReason) {
      statusFlags.push("ERROR");
      reasons.push(da.errorReason);
    }
  } else if (inputs.addressType === "EIP7702_DELEGATED_EOA") {
    statusFlags.push("EIP7702_DELEGATED_EOA");
    if (da.directEverActive === true) statusFlags.push("DIRECT_EVER_ACTIVE");
    if (da.directRecentActive === true) {
      statusFlags.push("DIRECT_RECENT_ACTIVE");
    } else if (da.directRecentActive === false) {
      statusFlags.push("NO_DIRECT_RECENT_ACTIVITY");
    } else {
      statusFlags.push("DIRECT_ACTIVITY_UNKNOWN");
      if (inputs.historicalRpcSupported !== true) {
        statusFlags.push("HISTORICAL_RPC_UNAVAILABLE");
      }
    }
    reasons.push(EIP7702_NONCE_CAVEAT);
    if (da.errorReason) {
      statusFlags.push("ERROR");
      reasons.push(da.errorReason);
    }
  } else if (inputs.addressType === "CONTRACT_OR_SMART_ACCOUNT") {
    statusFlags.push("CONTRACT_OR_SMART_ACCOUNT");
    statusFlags.push("SMART_ACCOUNT_ACTIVITY_UNKNOWN");
  }

  const scannerDataObserved = !!inputs.scannerAgg && inputs.scannerAgg.totalHistoricalTrades > 0;
  const totalHistoricalTrades = inputs.scannerAgg?.totalHistoricalTrades ?? 0;
  const trackedTrades30d = inputs.scannerAgg?.trackedTrades30d ?? 0;
  const trackedBuys30d = inputs.scannerAgg?.trackedBuys30d ?? 0;
  const trackedSells30d = inputs.scannerAgg?.trackedSells30d ?? 0;
  const distinctTokens30d = inputs.scannerAgg?.distinctTokens30d ?? 0;
  const pricedTradeCount30d = inputs.scannerAgg?.pricedTradeCount30d ?? 0;
  const trackedBuyUsd30d = inputs.scannerAgg?.trackedBuyUsd30d ?? null;
  const trackedSellUsd30d = inputs.scannerAgg?.trackedSellUsd30d ?? null;
  const trackedMarketActive30d = trackedTrades30d > 0;
  const usdCoveragePct = computeUsdCoveragePct(trackedTrades30d, pricedTradeCount30d);

  if (!scannerDataObserved) {
    statusFlags.push("NO_MATCH_IN_SCANNER_DATA");
    reasons.push(NO_SCANNER_HISTORY_REASON, NO_SCANNER_HISTORY_CAVEAT);
  } else if (trackedMarketActive30d) {
    statusFlags.push("SCANNER_TRACKED_ACTIVE");
  }
  // scannerDataObserved=true but trackedMarketActive30d=false ("seen before,
  // quiet last 30d") deliberately gets neither scanner flag — the fields
  // alone communicate that, and neither canonical flag is honest here.

  if (scannerDataObserved && trackedBuys30d === 0) {
    reasons.push(NO_RECENT_BUY_REASON);
  }

  if (trackedTrades30d > 0) {
    reasons.push(
      usdCoveragePct === null
        ? "USD valuation coverage: unavailable (no trades in the 30-day window)."
        : `USD valuation coverage: ${usdCoveragePct.toFixed(0)}% (${pricedTradeCount30d}/${trackedTrades30d} trades).`,
    );
  }

  if (inputs.addressCollision) {
    statusFlags.push("ADDRESS_COLLISION");
    reasons.push(
      `ADDRESS_COLLISION_REQUIRES_MANUAL_REVIEW: this address is also claimed by handle(s) ${inputs.collisionHandles.join(", ")}.`,
    );
  }

  let recommendedEnabled: boolean;
  if (inputs.addressCollision) {
    recommendedEnabled = false;
  } else {
    const rec = computeRecommendedEnabled({ trackedBuys30d, directRecentActive: da.directRecentActive });
    recommendedEnabled = rec.recommendedEnabled;
    reasons.push(...rec.reasons);
  }

  if (!recommendedEnabled && !inputs.addressCollision && inputs.addressType === "CONTRACT_OR_SMART_ACCOUNT") {
    reasons.push(CONTRACT_RECOMMENDATION_REASON);
  }

  const excludedFromFinalWatchlist = inputs.addressCollision;

  const summaryStatus = buildSummaryStatus({
    validAddress: true,
    addressCollision: inputs.addressCollision,
    addressType: inputs.addressType,
    trackedMarketActive30d,
    scannerDataObserved,
    directRecentActive: da.directRecentActive,
  });

  return {
    rank: inputs.rank,
    handle: inputs.handle,
    address: normalizeAddress(inputs.address),
    validAddress: true,
    addressCollision: inputs.addressCollision,
    collisionHandles: inputs.collisionHandles,
    addressType: inputs.addressType,
    historicalRpcSupported: inputs.historicalRpcSupported,
    directNonceLatest: da.directNonceLatest,
    directNonce30dAgo: da.directNonce30dAgo,
    directTxCount30d: da.directTxCount30d,
    directEverActive: da.directEverActive,
    directRecentActive: da.directRecentActive,
    scannerDataObserved,
    totalHistoricalTrades,
    trackedMarketActive30d,
    trackedTrades30d,
    trackedBuys30d,
    trackedSells30d,
    distinctTokens30d,
    trackedBuyUsd30d,
    trackedSellUsd30d,
    pricedTradeCount30d,
    usdCoveragePct,
    firstTrackedTradeAt: inputs.scannerAgg?.firstTrackedTradeAt?.toISOString() ?? null,
    lastTrackedTradeAt: inputs.scannerAgg?.lastTrackedTradeAt?.toISOString() ?? null,
    last5Tokens: buildLast5Tokens(inputs.tokenRows),
    statusFlags,
    summaryStatus,
    recommendedEnabled,
    excludedFromFinalWatchlist,
    reasons,
  };
}

export function buildSummaryStatus(params: {
  validAddress: boolean;
  addressCollision: boolean;
  addressType: AddressType | null;
  trackedMarketActive30d: boolean;
  scannerDataObserved: boolean;
  directRecentActive: TriState;
}): string {
  if (!params.validAddress) return "INVALID_ADDRESS";
  if (params.addressCollision) return "ADDRESS_COLLISION_REQUIRES_MANUAL_REVIEW";
  if (params.trackedMarketActive30d) return "SCANNER_TRACKED_ACTIVE";
  if (params.directRecentActive === true) return "DIRECT_RECENT_ACTIVE";
  if (!params.scannerDataObserved) return "NO_MATCH_IN_SCANNER_DATA";
  if (params.addressType === "CONTRACT_OR_SMART_ACCOUNT") return "SMART_ACCOUNT_ACTIVITY_UNKNOWN";
  if (params.directRecentActive === false) return "NO_DIRECT_RECENT_ACTIVITY";
  return "DIRECT_ACTIVITY_UNKNOWN";
}

// ---------------------------------------------------------------------------
// Section 16 — provenance metadata (parse / render) + --apply planning
// ---------------------------------------------------------------------------

export const FOMO_VERIFY_START_MARKER = "[source:fomo-verify-v1]";
export const FOMO_VERIFY_END_MARKER = "[/source:fomo-verify-v1]";

export interface FomoVerifyMetadata {
  isToolManaged: boolean;
  fomoRank: number | null;
  fomoHandle: string | null;
  walletSource: string | null;
  verification: string | null;
  verifiedAt: string | null;
}

const NOT_TOOL_MANAGED: FomoVerifyMetadata = {
  isToolManaged: false,
  fomoRank: null,
  fomoHandle: null,
  walletSource: null,
  verification: null,
  verifiedAt: null,
};

/** Pure parse of the tool-managed metadata block. Requires BOTH markers,
 * in order, to be present — anything else (missing start, missing end,
 * corrupted spelling, end before start) is treated as "not tool-managed",
 * fail-safe, never guessed into existence. */
export function parseFomoVerifyMetadata(notes: string | null): FomoVerifyMetadata {
  if (!notes) return NOT_TOOL_MANAGED;
  const startIdx = notes.indexOf(FOMO_VERIFY_START_MARKER);
  const endIdx = notes.indexOf(FOMO_VERIFY_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return NOT_TOOL_MANAGED;

  const block = notes.slice(startIdx + FOMO_VERIFY_START_MARKER.length, endIdx);
  const kv: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    kv[key] = value;
  }

  const rankNum = kv.fomo_rank !== undefined ? Number(kv.fomo_rank) : NaN;
  return {
    isToolManaged: true,
    fomoRank: Number.isFinite(rankNum) ? rankNum : null,
    fomoHandle: kv.fomo_handle ?? null,
    walletSource: kv.wallet_source ?? null,
    verification: kv.verification ?? null,
    verifiedAt: kv.verified_at ?? null,
  };
}

export interface NewFomoVerifyMetadata {
  fomoRank: number;
  fomoHandle: string;
  walletSource: string;
  verification: string;
  verifiedAt: string;
}

/** Replaces (never appends to) the tool's own metadata block, preserving
 * everything outside it byte-for-byte — manual notes before AND after the
 * block both survive a rerun untouched. */
export function renderOrReplaceFomoVerifyMetadata(
  existingNotes: string | null,
  newMetadata: NewFomoVerifyMetadata,
): string {
  const block = [
    FOMO_VERIFY_START_MARKER,
    `fomo_rank=${newMetadata.fomoRank}`,
    `fomo_handle=${newMetadata.fomoHandle}`,
    `wallet_source=${newMetadata.walletSource}`,
    `verification=${newMetadata.verification}`,
    `verified_at=${newMetadata.verifiedAt}`,
    FOMO_VERIFY_END_MARKER,
  ].join("\n");

  const notes = existingNotes ?? "";
  const startIdx = notes.indexOf(FOMO_VERIFY_START_MARKER);
  const endIdx = notes.indexOf(FOMO_VERIFY_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    if (notes.trim().length === 0) return block;
    return `${notes}\n\n${block}`;
  }

  const before = notes.slice(0, startIdx);
  const after = notes.slice(endIdx + FOMO_VERIFY_END_MARKER.length);
  return `${before}${block}${after}`;
}

const POSSIBLE_LOST_PROVENANCE_INDICATORS = [
  "wallet_source=FOMO_WALLET_FINDER",
  "fomo_rank=",
  "fomo_handle=",
  "verification=",
];

/** Conservative heuristic for "this row was PROBABLY tool-managed once but
 * the marker block is now missing/corrupted" — used only to surface a
 * manual-review count, never to auto-restore tool-managed status. */
export function looksLikePossibleLostProvenance(notes: string | null): boolean {
  if (!notes) return false;
  return POSSIBLE_LOST_PROVENANCE_INDICATORS.some((indicator) => notes.includes(indicator));
}

export interface NameUpdateDecision {
  newName: string;
  nameUpdated: boolean;
  /** "cannot_resolve_previous_handle": notes didn't carry a recoverable
   * fomo_handle, so we refuse to guess. "manually_customized": the current
   * name differs from what the tool last set, so a human likely renamed it —
   * preserved, not overwritten. Absent when the name was actually updated. */
  skipReason?: "cannot_resolve_previous_handle" | "manually_customized";
  skippedLogMessage?: string;
}

/** Only updates `name` if the existing name still equals the handle that was
 * imported last time (recovered from the metadata block, never compared
 * against the CURRENT input handle, which may have changed independently of
 * whether a human renamed the row). */
export function decideNameUpdate(params: {
  existingName: string;
  existingMetadata: FomoVerifyMetadata;
  currentHandle: string;
}): NameUpdateDecision {
  const previousHandle = params.existingMetadata.fomoHandle;
  if (previousHandle === null) {
    return {
      newName: params.existingName,
      nameUpdated: false,
      skipReason: "cannot_resolve_previous_handle",
      skippedLogMessage:
        "Skipped name update because previous tool-managed handle could not be reliably recovered from notes.",
    };
  }
  if (params.existingName === previousHandle) {
    const updated = params.currentHandle !== params.existingName;
    return { newName: params.currentHandle, nameUpdated: updated };
  }
  return { newName: params.existingName, nameUpdated: false, skipReason: "manually_customized" };
}

export interface VerifiedWatchlistEntry {
  address: string;
  handle: string;
  rank: number;
  ownerGroup: string;
  enabled: boolean;
  walletSource: string;
  verification: string;
}

export interface ExistingWalletRowLike {
  name: string;
  type: string;
  tier: string;
  ownerGroup: string;
  notes: string | null;
}

export type ApplyAction =
  | {
      kind: "create";
      entry: {
        address: string;
        name: string;
        type: "FOMO_TRADER";
        tier: "C";
        ownerGroup: string;
        enabled: boolean;
        notes: string;
      };
    }
  | {
      kind: "update";
      patch: { enabled: boolean; notes: string; name?: string };
      nameDecision: NameUpdateDecision;
    }
  | {
      kind: "skip";
      reason: "APPLY_SKIPPED_EXISTING_MANUAL_ROW";
      possibleLostProvenance: boolean;
    };

/** The full §16 decision tree for one wallet's --apply behavior. Never
 * touches ownerGroup/tier/type on an existing row (they're simply absent
 * from the `update` patch), and never modifies anything for a row that
 * isn't provably tool-managed (fail-safe: missing/corrupted marker =
 * treated as a human row). */
export function planApplyForWallet(params: {
  existing: ExistingWalletRowLike | null;
  verified: VerifiedWatchlistEntry;
  verifiedAtIso: string;
}): ApplyAction {
  const { existing, verified, verifiedAtIso } = params;
  const newMetadata: NewFomoVerifyMetadata = {
    fomoRank: verified.rank,
    fomoHandle: verified.handle,
    walletSource: verified.walletSource,
    verification: verified.verification,
    verifiedAt: verifiedAtIso,
  };

  if (!existing) {
    return {
      kind: "create",
      entry: {
        address: verified.address,
        name: verified.handle,
        type: "FOMO_TRADER",
        tier: "C",
        ownerGroup: verified.ownerGroup,
        enabled: verified.enabled,
        notes: renderOrReplaceFomoVerifyMetadata(null, newMetadata),
      },
    };
  }

  const meta = parseFomoVerifyMetadata(existing.notes);
  const isToolManaged = existing.type === "FOMO_TRADER" && meta.isToolManaged;

  if (!isToolManaged) {
    const possibleLostProvenance = existing.type === "FOMO_TRADER" && looksLikePossibleLostProvenance(existing.notes);
    return { kind: "skip", reason: "APPLY_SKIPPED_EXISTING_MANUAL_ROW", possibleLostProvenance };
  }

  const nameDecision = decideNameUpdate({
    existingName: existing.name,
    existingMetadata: meta,
    currentHandle: verified.handle,
  });

  const patch: { enabled: boolean; notes: string; name?: string } = {
    enabled: verified.enabled,
    notes: renderOrReplaceFomoVerifyMetadata(existing.notes, newMetadata),
  };
  if (nameDecision.nameUpdated) {
    patch.name = nameDecision.newName;
  }

  return { kind: "update", patch, nameDecision };
}

// ---------------------------------------------------------------------------
// Section 14.4 — verified watchlist JSON (npm run wallets:import-compatible)
// ---------------------------------------------------------------------------

export function toWatchlistImportFormat(
  wallets: WalletVerification[],
  candidatesByAddress: Map<string, { rank: number; handle: string; ownerGroup: string }>,
  verifiedAtIso: string,
): {
  address: string;
  name: string;
  type: "FOMO_TRADER";
  tier: "C";
  ownerGroup: string;
  enabled: boolean;
  notes: string;
}[] {
  const out: ReturnType<typeof toWatchlistImportFormat> = [];
  for (const w of wallets) {
    if (!w.validAddress || w.excludedFromFinalWatchlist) continue;
    const candidate = candidatesByAddress.get(w.address);
    if (!candidate) continue;
    out.push({
      address: w.address,
      name: candidate.handle,
      type: "FOMO_TRADER",
      tier: "C",
      ownerGroup: candidate.ownerGroup,
      enabled: w.recommendedEnabled,
      notes: renderOrReplaceFomoVerifyMetadata(null, {
        fomoRank: candidate.rank,
        fomoHandle: candidate.handle,
        walletSource: "FOMO_WALLET_FINDER",
        verification: w.summaryStatus,
        verifiedAt: verifiedAtIso,
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 18/19 — CLI summary + activity rankings
// ---------------------------------------------------------------------------

export interface RunSummary {
  inputWallets: number;
  valid: number;
  invalid: number;
  collisions: number;
  eoa: number;
  eip7702DelegatedEoa: number;
  contractOrSmartAccount: number;
  historicalState: HistoricalRpcSupported;
  historicalStateReason: string | null;
  directEverActive: number;
  direct30dActive: number;
  direct30dInactive: number;
  directActivityUnknown: number;
  scannerDataEverObserved: number;
  scannerTrades30d: number;
  scannerBuyWallets30d: number;
  recommendedEnabled: number;
  recommendedDisabled: number;
  excludedDueCollision: number;
  unresolvedCollisions: { address: string; handles: string[]; ranks: number[] }[];
}

export function buildRunSummary(
  wallets: WalletVerification[],
  historicalState: HistoricalRpcSupported,
  historicalStateReason: string | null,
  collisions: FomoWalletCollision[],
): RunSummary {
  const valid = wallets.filter((w) => w.validAddress);
  const invalid = wallets.filter((w) => !w.validAddress);
  const eoa = valid.filter((w) => w.addressType === "EOA");
  const eip7702DelegatedEoa = valid.filter((w) => w.addressType === "EIP7702_DELEGATED_EOA");
  const contracts = valid.filter((w) => w.addressType === "CONTRACT_OR_SMART_ACCOUNT");

  return {
    inputWallets: wallets.length,
    valid: valid.length,
    invalid: invalid.length,
    collisions: collisions.length,
    eoa: eoa.length,
    eip7702DelegatedEoa: eip7702DelegatedEoa.length,
    contractOrSmartAccount: contracts.length,
    historicalState,
    historicalStateReason,
    directEverActive: valid.filter((w) => w.directEverActive === true).length,
    direct30dActive: valid.filter((w) => w.directRecentActive === true).length,
    direct30dInactive: valid.filter((w) => w.directRecentActive === false).length,
    directActivityUnknown: valid.filter((w) => w.directRecentActive === "UNKNOWN").length,
    scannerDataEverObserved: valid.filter((w) => w.scannerDataObserved).length,
    scannerTrades30d: valid.reduce((sum, w) => sum + w.trackedTrades30d, 0),
    scannerBuyWallets30d: valid.filter((w) => w.trackedBuys30d > 0).length,
    recommendedEnabled: valid.filter((w) => w.recommendedEnabled).length,
    recommendedDisabled: valid.filter((w) => !w.recommendedEnabled).length,
    excludedDueCollision: valid.filter((w) => w.excludedFromFinalWatchlist).length,
    unresolvedCollisions: collisions.map((c) => ({
      address: c.address,
      handles: c.users.map((u) => u.handle),
      ranks: c.users.map((u) => u.rank),
    })),
  };
}

export interface ActivityRankingRow {
  rank: number;
  handle: string;
  address: string;
  metric: number;
}

export interface ActivityRankings {
  topTrackedBuyActivity: ActivityRankingRow[];
  topScannerTokenBreadth: ActivityRankingRow[];
  topDirectSenderActivity: ActivityRankingRow[];
}

export function buildActivityRankings(wallets: WalletVerification[], limit = 10): ActivityRankings {
  const valid = wallets.filter((w) => w.validAddress);

  const topTrackedBuyActivity = [...valid]
    .sort((a, b) => b.trackedBuys30d - a.trackedBuys30d)
    .slice(0, limit)
    .map((w) => ({ rank: w.rank, handle: w.handle, address: w.address, metric: w.trackedBuys30d }));

  const topScannerTokenBreadth = [...valid]
    .sort((a, b) => b.distinctTokens30d - a.distinctTokens30d)
    .slice(0, limit)
    .map((w) => ({ rank: w.rank, handle: w.handle, address: w.address, metric: w.distinctTokens30d }));

  const topDirectSenderActivity = valid
    .filter((w) => w.directTxCount30d !== null)
    .sort((a, b) => (b.directTxCount30d ?? 0) - (a.directTxCount30d ?? 0))
    .slice(0, limit)
    .map((w) => ({ rank: w.rank, handle: w.handle, address: w.address, metric: w.directTxCount30d ?? 0 }));

  return { topTrackedBuyActivity, topScannerTokenBreadth, topDirectSenderActivity };
}

// ---------------------------------------------------------------------------
// CSV serialization (Section 14.2)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toVerificationCsv(wallets: WalletVerification[]): string {
  const header = [
    "rank",
    "handle",
    "address",
    "addressType",
    "directRecentActive",
    "directTxCount30d",
    "scannerDataObserved",
    "totalHistoricalTrades",
    "trackedBuys30d",
    "trackedSells30d",
    "distinctTokens30d",
    "lastTrackedTradeAt",
    "summaryStatus",
    "recommendedEnabled",
  ];
  const lines = [header.join(",")];
  for (const w of wallets) {
    lines.push(
      [
        String(w.rank),
        csvEscape(w.handle),
        w.address,
        w.addressType ?? "",
        String(w.directRecentActive),
        w.directTxCount30d === null ? "" : String(w.directTxCount30d),
        String(w.scannerDataObserved),
        String(w.totalHistoricalTrades),
        String(w.trackedBuys30d),
        String(w.trackedSells30d),
        String(w.distinctTokens30d),
        w.lastTrackedTradeAt ?? "",
        w.summaryStatus,
        String(w.recommendedEnabled),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
