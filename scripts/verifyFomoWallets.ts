// FOMO Top100 EVM Wallet -> Robinhood Chain Activity Verification.
//
// Independent, read-only wallet verification tool. Reads
// data/fomo_top100_watchlist_candidates.json, checks each address's
// Robinhood Chain (chainId 4663) activity via RPC + our own scanner DB, and
// writes report files under outputs/. Never touches `wallet_watchlist`
// unless run with --apply, and even then only via the existing
// walletWatchlist repo (create/update), never a second upsert path, and
// never overwriting a manually-curated row (see scripts/lib's
// planApplyForWallet for the full provenance-preserving decision tree).
//
// Does NOT modify: scanner, Doppler/Pons parsers, tradeDetector, resonance,
// scoring/risk/alert, Telegram, Outcome Tracker.
//
// Run: npm run wallets:fomo-verify [-- --apply]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../src/config/index.js";
import { CHAIN_ID, createHttpClient, type HttpClient } from "../src/chain/client.js";
import { createDb } from "../src/db/client.js";
import { createTradesRepo } from "../src/db/trades.js";
import { createWalletWatchlistRepo, type WalletWatchlistRepo } from "../src/db/walletWatchlist.js";
import { ExponentialBackoff } from "../src/chain/backoff.js";
import * as lib from "./lib/fomoWalletVerification.js";

const INPUT_PATH = "data/fomo_top100_watchlist_candidates.json";
const OUTPUT_DIR = "outputs";
const RPC_CONCURRENCY = 5;
const THIRTY_DAYS_SECONDS = 30n * 24n * 60n * 60n;
const MAX_RETRY_ATTEMPTS = 4;
const WALLET_SOURCE = "FOMO_WALLET_FINDER";

interface RawCandidate {
  rank: number;
  handle: string;
  address: string;
  name: string;
  type: string;
  tier: string;
  ownerGroup: string;
  enabled: boolean;
  notes: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Generic retry wrapper reusing the project's ExponentialBackoff for
 * delays — for calls where every failure is just "retry, then give up
 * loudly" (eth_getCode, eth_getBlockByNumber, plain nonce reads). The
 * historical-nonce probe has its own wrapper below since it must
 * distinguish capability errors (never retry) from transient ones. */
async function withBackoffRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const backoff = new ExponentialBackoff({ initialMs: 500, maxMs: 8_000, factor: 2 });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRY_ATTEMPTS) break;
      await sleep(backoff.next());
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRY_ATTEMPTS} attempts: ${String(lastErr)}`);
}

/** Wraps eth_getTransactionCount(address, block30dAgo) for the ONE
 * capability probe call: capability errors are classified and thrown
 * immediately (never retried — retrying a pruning error just wastes RPC
 * quota), transient errors get backoff/retry then surface as
 * HistoricalTransientError once exhausted. */
async function probeHistoricalNonce(httpClient: HttpClient, address: string, block: bigint): Promise<bigint> {
  const backoff = new ExponentialBackoff({ initialMs: 500, maxMs: 8_000, factor: 2 });
  let lastMessage = "";
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const count = await httpClient.getTransactionCount({ address: address as `0x${string}`, blockNumber: block });
      return BigInt(count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastMessage = message;
      if (lib.classifyRpcErrorMessage(message) === "capability") {
        throw new lib.HistoricalCapabilityError(message);
      }
      if (attempt === MAX_RETRY_ATTEMPTS) break;
      await sleep(backoff.next());
    }
  }
  throw new lib.HistoricalTransientError(lastMessage);
}

function historicalStateLabel(state: lib.HistoricalRpcSupported): string {
  if (state === true) return "SUPPORTED";
  if (state === false) return "UNSUPPORTED";
  return "UNKNOWN";
}

function printSummary(summary: lib.RunSummary): void {
  console.log("\n" + "=".repeat(78));
  console.log("SUMMARY");
  console.log("=".repeat(78));
  console.log(`Input wallets: ${summary.inputWallets}`);
  console.log(`Valid: ${summary.valid}`);
  console.log(`Invalid: ${summary.invalid}`);
  console.log(`Collisions: ${summary.collisions}`);
  console.log();
  console.log(`EOA: ${summary.eoa}`);
  console.log(`Contract / Smart Account: ${summary.contractOrSmartAccount}`);
  console.log();
  console.log(`Historical state: ${historicalStateLabel(summary.historicalState)}`);
  if (summary.historicalState !== true && summary.historicalStateReason) {
    console.log(`  Reason: ${summary.historicalStateReason}`);
  }
  console.log();
  console.log(`Direct ever-active: ${summary.directEverActive}`);
  console.log(`Direct 30d-active: ${summary.direct30dActive}`);
  console.log(`Direct 30d-inactive: ${summary.direct30dInactive}`);
  console.log(`Direct activity unknown: ${summary.directActivityUnknown}`);
  console.log();
  console.log(`Scanner data ever observed: ${summary.scannerDataEverObserved}`);
  console.log(`Scanner trades in last 30d: ${summary.scannerTrades30d}`);
  console.log(`Scanner BUY wallets in last 30d: ${summary.scannerBuyWallets30d}`);
  console.log();
  console.log(`Recommended enabled: ${summary.recommendedEnabled}`);
  console.log(`Recommended disabled: ${summary.recommendedDisabled}`);
  console.log(`Excluded due collision: ${summary.excludedDueCollision}`);
  console.log();
  console.log(`Unresolved collisions requiring manual review: ${summary.unresolvedCollisions.length}`);
  for (const c of summary.unresolvedCollisions) {
    console.log(`  ${c.address} — handles: ${c.handles.join(", ")} — ranks: ${c.ranks.join(", ")}`);
  }
}

function printRankings(rankings: lib.ActivityRankings): void {
  console.log("\n" + "=".repeat(78));
  console.log("ACTIVITY RANKINGS");
  console.log("=".repeat(78));

  console.log("\nTop tracked BUY activity (trackedBuys30d):");
  for (const r of rankings.topTrackedBuyActivity) {
    console.log(`  #${r.rank} ${r.handle} (${r.address}) — ${r.metric}`);
  }

  console.log("\nTop scanner token breadth (distinctTokens30d):");
  for (const r of rankings.topScannerTokenBreadth) {
    console.log(`  #${r.rank} ${r.handle} (${r.address}) — ${r.metric}`);
  }

  console.log("\nTop direct sender activity (directTxCount30d):");
  for (const r of rankings.topDirectSenderActivity) {
    console.log(`  #${r.rank} ${r.handle} (${r.address}) — ${r.metric}`);
  }
}

interface LostProvenanceDetail {
  address: string;
  name: string;
  type: string;
  notesExcerpt: string;
}

async function runApply(params: {
  walletRepo: WalletWatchlistRepo;
  wallets: lib.WalletVerification[];
  candidatesByAddress: Map<string, { rank: number; handle: string; ownerGroup: string }>;
  verifiedAtIso: string;
}): Promise<void> {
  const { walletRepo, wallets, candidatesByAddress, verifiedAtIso } = params;
  console.log("\n" + "=".repeat(78));
  console.log("--apply: writing to wallet_watchlist");
  console.log("=".repeat(78));

  const existingRows = await walletRepo.list();
  const existingByAddress = new Map(existingRows.map((r) => [r.address.toLowerCase(), r]));

  let created = 0;
  let updated = 0;
  let skippedManual = 0;
  let skippedCollision = 0;
  let skippedInvalid = 0;
  let possibleLostProvenance = 0;
  let preservedNames = 0;
  let preservedTiers = 0;
  let preservedOwnerGroups = 0;
  const lostProvenanceDetails: LostProvenanceDetail[] = [];

  for (const w of wallets) {
    if (!w.validAddress) {
      skippedInvalid++;
      continue;
    }
    if (w.excludedFromFinalWatchlist) {
      skippedCollision++;
      continue;
    }
    const candidate = candidatesByAddress.get(w.address);
    if (!candidate) continue;

    const existing = existingByAddress.get(w.address) ?? null;
    const verifiedEntry: lib.VerifiedWatchlistEntry = {
      address: w.address,
      handle: candidate.handle,
      rank: candidate.rank,
      ownerGroup: candidate.ownerGroup,
      enabled: w.recommendedEnabled,
      walletSource: WALLET_SOURCE,
      verification: w.summaryStatus,
    };
    const existingLike: lib.ExistingWalletRowLike | null = existing
      ? { name: existing.name, type: existing.type, tier: existing.tier, ownerGroup: existing.ownerGroup, notes: existing.notes }
      : null;

    const action = lib.planApplyForWallet({ existing: existingLike, verified: verifiedEntry, verifiedAtIso });

    if (action.kind === "create") {
      await walletRepo.create(action.entry);
      created++;
      console.log(`  CREATE ${w.address} (${candidate.handle})`);
    } else if (action.kind === "update") {
      await walletRepo.update(w.address, action.patch);
      updated++;
      if (action.nameDecision.skipReason === "manually_customized") preservedNames++;
      if (existing && existing.tier !== "C") preservedTiers++;
      if (existing && existing.ownerGroup !== candidate.ownerGroup) preservedOwnerGroups++;
      const note = action.nameDecision.skippedLogMessage ? ` — ${action.nameDecision.skippedLogMessage}` : "";
      console.log(`  UPDATE ${w.address} (${candidate.handle})${note}`);
    } else {
      skippedManual++;
      if (action.possibleLostProvenance) {
        possibleLostProvenance++;
        lostProvenanceDetails.push({
          address: w.address,
          name: existing?.name ?? "",
          type: existing?.type ?? "",
          notesExcerpt: (existing?.notes ?? "").slice(0, 120),
        });
      }
      console.log(`  SKIP (${action.reason}) ${w.address}` + (action.possibleLostProvenance ? " — POSSIBLE_LOST_PROVENANCE_MARKER" : ""));
    }
  }

  console.log("\n--apply summary:");
  console.log(`Created tool-managed: ${created}`);
  console.log(`Updated tool-managed: ${updated}`);
  console.log(`Skipped manual rows: ${skippedManual}`);
  console.log(`Skipped due collision: ${skippedCollision}`);
  console.log(`Skipped invalid: ${skippedInvalid}`);
  console.log(`Possible lost provenance marker: ${possibleLostProvenance}`);
  console.log(`Preserved manually customized names: ${preservedNames}`);
  console.log(`Preserved non-C tiers: ${preservedTiers}`);
  console.log(`Preserved customized ownerGroups: ${preservedOwnerGroups}`);

  if (lostProvenanceDetails.length > 0) {
    console.log("\nPossible tool-managed rows with missing/corrupted marker:");
    for (const d of lostProvenanceDetails) {
      console.log(`  ${d.address} / ${d.name} / ${d.type} / "${d.notesExcerpt}"`);
    }
  }
}

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");

  if (!existsSync(INPUT_PATH)) {
    console.error(`Input file not found: ${INPUT_PATH}`);
    console.error("Place the FOMO Top100 wallet candidate file at that exact path (see task spec §1) and rerun.");
    console.error("This tool does not re-fetch FOMO data or query the Wallet Finder itself.");
    process.exit(1);
  }

  const raw: RawCandidate[] = JSON.parse(readFileSync(INPUT_PATH, "utf8"));
  console.log(`Loaded ${raw.length} candidates from ${INPUT_PATH}.`);

  const duplicateHandles = raw.length - new Set(raw.map((c) => c.handle)).size;
  if (duplicateHandles > 0) {
    console.warn(`Warning: ${duplicateHandles} duplicate handle(s) in input (not an address collision by itself).`);
  }

  const env = loadEnv();
  const httpClient = createHttpClient(env.RH_RPC_HTTP);
  const db = createDb(env.DATABASE_URL);
  const tradesRepo = createTradesRepo(db);
  const walletRepo = createWalletWatchlistRepo(db);

  // ---- Section 4: address validation + collision ----
  const byAddress = lib.groupCandidatesByAddress(raw);
  const collisions = lib.buildCollisionsFile(byAddress);

  const candidateMeta = raw.map((c) => {
    const validAddress = lib.validateAddressFormat(c.address);
    const key = lib.normalizeAddress(c.address);
    const group = byAddress.get(key) ?? [];
    const addressCollision = group.length > 1;
    const collisionHandles = group.filter((u) => u.handle !== c.handle).map((u) => u.handle);
    return { ...c, validAddress, addressCollision, collisionHandles };
  });
  const validCandidates = candidateMeta.filter((c) => c.validAddress);
  console.log(
    `Address validation: ${validCandidates.length}/${candidateMeta.length} valid, ${collisions.length} address(es) with collisions.`,
  );

  // ---- Section 5: address type (eth_getCode), concurrency <= 5 ----
  console.log(`\nDetermining address type via eth_getCode (concurrency ${RPC_CONCURRENCY})...`);
  const addressTypeByAddr = new Map<string, lib.AddressType>();
  await mapWithConcurrency(validCandidates, RPC_CONCURRENCY, async (c) => {
    const addr = lib.normalizeAddress(c.address);
    try {
      const type = await withBackoffRetry(async () => {
        const code = await httpClient.getCode({ address: addr as `0x${string}` });
        const isEoa = !code || code === "0x";
        return isEoa ? ("EOA" as const) : ("CONTRACT_OR_SMART_ACCOUNT" as const);
      }, `eth_getCode(${addr})`);
      addressTypeByAddr.set(addr, type);
    } catch (err) {
      console.warn(`  eth_getCode failed for ${addr}: ${String(err)}`);
    }
  });

  // ---- Section 6: global block30dAgo (computed exactly once) ----
  const latestBlockNumber = await withBackoffRetry(() => httpClient.getBlockNumber(), "eth_blockNumber");
  const latestBlock = await withBackoffRetry(
    () => httpClient.getBlock({ blockNumber: latestBlockNumber }),
    "eth_getBlockByNumber(latest)",
  );
  const latestTimestamp = latestBlock.timestamp;
  const targetTimestamp = latestTimestamp - THIRTY_DAYS_SECONDS;

  const { block30dAgo, block30dAgoTimestamp, binarySearchRpcCalls } = await lib.findBlock30dAgo(
    latestBlockNumber,
    targetTimestamp,
    (b) =>
      withBackoffRetry(async () => (await httpClient.getBlock({ blockNumber: b })).timestamp, `eth_getBlockByNumber(${b})`),
  );

  console.log("\nlatestBlock:", latestBlockNumber.toString());
  console.log("latestTimestamp:", latestTimestamp.toString());
  console.log("targetTimestamp:", targetTimestamp.toString());
  console.log("block30dAgo:", block30dAgo.toString());
  console.log("block30dAgoTimestamp:", block30dAgoTimestamp.toString());
  console.log("binarySearchRpcCalls:", binarySearchRpcCalls);

  const cutoff30dDate = new Date(Number(targetTimestamp) * 1000);

  // ---- Section 8: historicalRpcSupported (one probe for the whole run) ----
  const probeCandidates = validCandidates
    .map((c) => {
      const addr = lib.normalizeAddress(c.address);
      const addressType = addressTypeByAddr.get(addr);
      return addressType ? { address: addr, addressType } : null;
    })
    .filter((c): c is { address: string; addressType: lib.AddressType } => c !== null);

  const historicalResult = await lib.determineHistoricalRpcSupport({
    candidates: probeCandidates,
    block30dAgo,
    probeNonce: (address, block) => probeHistoricalNonce(httpClient, address, block),
  });
  console.log(
    `\nHistorical state: ${historicalStateLabel(historicalResult.historicalRpcSupported)}` +
      (historicalResult.reason ? ` (${historicalResult.reason})` : ""),
  );

  // ---- Section 7: per-EOA direct sender nonces ----
  const eoaCandidates = validCandidates.filter((c) => addressTypeByAddr.get(lib.normalizeAddress(c.address)) === "EOA");
  const nonceLatestByAddr = new Map<string, number>();
  const nonce30dAgoByAddr = new Map<string, number>();

  console.log(`\nFetching direct-sender nonces for ${eoaCandidates.length} EOA candidates...`);
  await mapWithConcurrency(eoaCandidates, RPC_CONCURRENCY, async (c) => {
    const addr = lib.normalizeAddress(c.address);
    try {
      const latest = await withBackoffRetry(
        () => httpClient.getTransactionCount({ address: addr as `0x${string}` }),
        `eth_getTransactionCount(latest, ${addr})`,
      );
      nonceLatestByAddr.set(addr, latest);
    } catch (err) {
      console.warn(`  eth_getTransactionCount(latest) failed for ${addr}: ${String(err)}`);
    }

    if (historicalResult.historicalRpcSupported === true) {
      try {
        const past = await withBackoffRetry(
          () => httpClient.getTransactionCount({ address: addr as `0x${string}`, blockNumber: block30dAgo }),
          `eth_getTransactionCount(30dAgo, ${addr})`,
        );
        nonce30dAgoByAddr.set(addr, past);
      } catch (err) {
        console.warn(`  eth_getTransactionCount(30dAgo) failed for ${addr}: ${String(err)}`);
      }
    }
  });

  // ---- Section 9: scanner DB aggregates (two bulk queries, no N+1) ----
  const validAddresses = validCandidates.map((c) => lib.normalizeAddress(c.address));
  console.log(`\nQuerying scanner DB for ${validAddresses.length} wallet(s)...`);
  const scannerAggByAddr = await tradesRepo.listWalletActivityAggregates(validAddresses, cutoff30dDate);
  const tokenRows = await tradesRepo.listWalletTokenActivity30d(validAddresses, cutoff30dDate);
  const tokenRowsByAddr = new Map<string, lib.WalletTokenActivityLike[]>();
  for (const r of tokenRows) {
    const list = tokenRowsByAddr.get(r.wallet) ?? [];
    list.push(r);
    tokenRowsByAddr.set(r.wallet, list);
  }

  // ---- Section 10/14: assemble per-wallet verification ----
  console.log();
  const wallets: lib.WalletVerification[] = [];
  for (let i = 0; i < candidateMeta.length; i++) {
    const c = candidateMeta[i]!;
    const addr = lib.normalizeAddress(c.address);
    const addressType = c.validAddress ? (addressTypeByAddr.get(addr) ?? null) : null;

    let directActivity: lib.DirectActivityResult;
    if (!c.validAddress || addressType === null || addressType === "CONTRACT_OR_SMART_ACCOUNT") {
      directActivity = lib.CONTRACT_DIRECT_ACTIVITY;
    } else {
      const nonceLatest = nonceLatestByAddr.get(addr);
      if (nonceLatest === undefined) {
        directActivity = {
          directNonceLatest: null,
          directNonce30dAgo: null,
          directTxCount30d: null,
          directEverActive: "UNKNOWN",
          directRecentActive: "UNKNOWN",
          errorReason: "eth_getTransactionCount(latest) failed after retries — direct-sender activity unknown for this wallet.",
        };
      } else {
        directActivity = lib.computeDirectActivityForEOA({
          nonceLatest,
          historicalRpcSupported: historicalResult.historicalRpcSupported,
          nonce30dAgo: nonce30dAgoByAddr.get(addr) ?? null,
        });
      }
    }

    const wv = lib.assembleWalletVerification({
      rank: c.rank,
      handle: c.handle,
      address: c.address,
      validAddress: c.validAddress,
      addressCollision: c.addressCollision,
      collisionHandles: c.collisionHandles,
      addressType,
      historicalRpcSupported: historicalResult.historicalRpcSupported,
      directActivity,
      scannerAgg: scannerAggByAddr.get(addr) ?? null,
      tokenRows: tokenRowsByAddr.get(addr) ?? [],
    });
    wallets.push(wv);

    console.log(`[${i + 1}/${candidateMeta.length}] ${c.handle}`);
    console.log(`  address type: ${wv.addressType ?? "n/a (invalid address)"}`);
    console.log(`  direct ever active: ${wv.directEverActive}`);
    console.log(`  direct 30d sender tx: ${wv.directTxCount30d ?? "unknown"}`);
    console.log(`  tracked buys 30d: ${wv.trackedBuys30d}`);
    console.log(`  status: ${wv.summaryStatus}`);
  }

  // ---- Section 14: write output files ----
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const runMetadata = {
    generatedAt,
    chainId: CHAIN_ID,
    latestBlock: latestBlockNumber.toString(),
    latestBlockTimestamp: new Date(Number(latestTimestamp) * 1000).toISOString(),
    cutoff30d: cutoff30dDate.toISOString(),
    block30dAgo: block30dAgo.toString(),
    block30dAgoTimestamp: new Date(Number(block30dAgoTimestamp) * 1000).toISOString(),
    historicalRpcSupported: historicalResult.historicalRpcSupported,
    inputWalletCount: raw.length,
  };

  writeFileSync(`${OUTPUT_DIR}/fomo_robinhood_verification.json`, JSON.stringify({ runMetadata, wallets }, null, 2));
  writeFileSync(`${OUTPUT_DIR}/fomo_robinhood_verification.csv`, lib.toVerificationCsv(wallets));
  writeFileSync(`${OUTPUT_DIR}/fomo_wallet_collisions.json`, JSON.stringify(collisions, null, 2));

  const candidatesByAddress = new Map(
    raw.map((c) => [lib.normalizeAddress(c.address), { rank: c.rank, handle: c.handle, ownerGroup: c.ownerGroup }]),
  );
  const verifiedWatchlist = lib.toWatchlistImportFormat(wallets, candidatesByAddress, generatedAt);
  writeFileSync(`${OUTPUT_DIR}/fomo_robinhood_watchlist_verified.json`, JSON.stringify(verifiedWatchlist, null, 2));

  console.log(`\nWrote outputs/fomo_robinhood_verification.json (${wallets.length} wallets)`);
  console.log(`Wrote outputs/fomo_robinhood_verification.csv`);
  console.log(`Wrote outputs/fomo_wallet_collisions.json (${collisions.length} collision(s))`);
  console.log(`Wrote outputs/fomo_robinhood_watchlist_verified.json (${verifiedWatchlist.length} entries)`);

  // ---- Section 18/19: summary + rankings ----
  const summary = lib.buildRunSummary(wallets, historicalResult.historicalRpcSupported, historicalResult.reason ?? null, collisions);
  printSummary(summary);
  const rankings = lib.buildActivityRankings(wallets);
  printRankings(rankings);

  // ---- Section 16: optional --apply ----
  if (applyMode) {
    await runApply({ walletRepo, wallets, candidatesByAddress, verifiedAtIso: generatedAt });
  } else {
    console.log("\nDefault run — read-only, no DB writes. Re-run with `-- --apply` to import into wallet_watchlist.");
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
