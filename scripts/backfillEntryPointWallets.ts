// One-off backfill: corrects `trades.wallet` for historical rows recorded
// before src/chain/tradeDetector.ts's EIP-7702/ERC-4337 EntryPoint wallet
// resolution fix. Before that fix, any trade whose transaction routed
// through handleOps was recorded with tx.from — the bundler/relayer's
// address, e.g. 0x43370371e0bb085d04d02a815230aaf67b35ef25 — instead of the
// real UserOperation sender (see PROGRESS.md's EIP-7702 investigation).
//
// Re-resolves every trade row's wallet using the exact same
// resolveTradeWallet logic tradeDetector.ts now uses live (imported, not
// reimplemented — no risk of the two ever drifting apart), and only writes
// a correction with --apply. Read-only by default.
//
// Does NOT touch signals/signal_wallets/alerts/outcome tables — those
// already fired based on whatever wallet attribution existed at the time;
// this only corrects `trades.wallet` for anything that reads the trades
// table directly going forward (watchlist matching, resonance replay,
// wallet-activity queries, etc.).
//
// Run: npm run trades:backfill-entrypoint-wallets [-- --apply] [-- --limit=500]

import { eq } from "drizzle-orm";
import { loadEnv } from "../src/config/index.js";
import { createHttpClient, type HttpClient } from "../src/chain/client.js";
import { createTradeDetectorHttpClient } from "../src/chain/tradeDetector.js";
import { ExponentialBackoff } from "../src/chain/backoff.js";
import { createDb } from "../src/db/client.js";
import { trades } from "../src/db/schema.js";

const RPC_CONCURRENCY = 5;
const MAX_RETRY_ATTEMPTS = 4;

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

/** Memoizes getTransaction/getTransactionReceipt by hash so N trade rows
 * that share one tx (common — a multi-hop swap emits several Swap logs in
 * a single tx) cost exactly one of each RPC call, not N. Purely a caching
 * wrapper — resolveTradeWallet's own matching logic is untouched. */
function withReceiptCache(client: HttpClient): HttpClient {
  const txCache = new Map<string, ReturnType<HttpClient["getTransaction"]>>();
  const receiptCache = new Map<string, ReturnType<HttpClient["getTransactionReceipt"]>>();
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "getTransaction") {
        return (args: { hash: `0x${string}` }) => {
          const key = args.hash;
          if (!txCache.has(key)) txCache.set(key, target.getTransaction(args));
          return txCache.get(key)!;
        };
      }
      if (prop === "getTransactionReceipt") {
        return (args: { hash: `0x${string}` }) => {
          const key = args.hash;
          if (!receiptCache.has(key)) receiptCache.set(key, target.getTransactionReceipt(args));
          return receiptCache.get(key)!;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as HttpClient;
}

interface TradeRow {
  id: number;
  wallet: string;
  txHash: string;
  logIndex: number;
}

interface Correction {
  id: number;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
}

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  const env = loadEnv();
  const httpClient = withReceiptCache(createHttpClient(env.RH_RPC_HTTP));
  const tradeDetectorHttpClient = createTradeDetectorHttpClient(httpClient);
  const db = createDb(env.DATABASE_URL);

  const allRows = await db
    .select({ id: trades.id, wallet: trades.wallet, txHash: trades.txHash, logIndex: trades.logIndex })
    .from(trades);
  const rows: TradeRow[] = limit ? allRows.slice(0, limit) : allRows;

  console.log(`Scanning ${rows.length} trade row(s) (of ${allRows.length} total) for EntryPoint-routed wallet misattribution...`);
  console.log(applyMode ? "Mode: --apply (WILL write UPDATE trades.wallet)" : "Mode: dry-run (read-only, no DB writes)");

  let checked = 0;
  let viaEntryPointCount = 0;
  let failed = 0;
  const corrections: Correction[] = [];
  const unresolvedRows: { id: number; txHash: string; logIndex: number }[] = [];

  await mapWithConcurrency(rows, RPC_CONCURRENCY, async (row) => {
    checked++;
    if (checked % 500 === 0) console.log(`  ...${checked}/${rows.length}`);
    try {
      const result = await withBackoffRetry(
        () =>
          tradeDetectorHttpClient.resolveTradeWallet({
            transactionHash: row.txHash as `0x${string}`,
            logIndex: row.logIndex,
          }),
        `resolveTradeWallet(${row.txHash}#${row.logIndex})`,
      );
      if (!result.viaEntryPoint) return;
      viaEntryPointCount++;
      if (!result.resolvedViaUserOp) {
        unresolvedRows.push({ id: row.id, txHash: row.txHash, logIndex: row.logIndex });
        return;
      }
      if (result.wallet.toLowerCase() !== row.wallet.toLowerCase()) {
        corrections.push({ id: row.id, txHash: row.txHash, logIndex: row.logIndex, from: row.wallet, to: result.wallet });
      }
    } catch (err) {
      failed++;
      console.warn(`  resolveTradeWallet failed for ${row.txHash}#${row.logIndex}: ${String(err)}`);
    }
  });

  console.log("\n" + "=".repeat(78));
  console.log("SUMMARY");
  console.log("=".repeat(78));
  console.log(`Rows checked: ${checked}`);
  console.log(`Routed through a known EntryPoint: ${viaEntryPointCount}`);
  console.log(`Needing correction: ${corrections.length}`);
  console.log(`Unresolved (viaEntryPoint but no matching UserOperationEvent found — left untouched): ${unresolvedRows.length}`);
  console.log(`RPC failures (left untouched, safe to re-run): ${failed}`);

  if (corrections.length > 0) {
    console.log(applyMode ? "\nCorrections (applying):" : "\nCorrections (dry-run, NOT applied):");
    for (const c of corrections) {
      console.log(`  id=${c.id} tx=${c.txHash}#${c.logIndex}: ${c.from} -> ${c.to}`);
    }
  }
  if (unresolvedRows.length > 0) {
    console.log("\nUnresolved rows requiring manual review (left as-is):");
    for (const u of unresolvedRows) {
      console.log(`  id=${u.id} tx=${u.txHash}#${u.logIndex}`);
    }
  }

  if (applyMode) {
    let applied = 0;
    for (const c of corrections) {
      await db.update(trades).set({ wallet: c.to }).where(eq(trades.id, c.id));
      applied++;
    }
    console.log(`\nApplied ${applied} correction(s).`);
  } else {
    console.log(`\nDry run — no DB writes. Re-run with \`-- --apply\` to write ${corrections.length} correction(s).`);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
