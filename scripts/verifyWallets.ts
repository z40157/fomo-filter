// One-off analysis tool: enrich data/mined_wallets.json with real Mobula
// wallet-analysis data (PnL, win rate, trade count, labels) for Robinhood
// Chain. See scripts/lib/mobula.ts for API details/verification notes.
//
// This never writes to the live `wallet_watchlist` table — it only
// annotates the JSON file for a human to review before promoting any
// candidate via the admin API or `npm run wallets:import`.
//
// Run: npm run wallets:verify

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../src/config/index.js";
import { fetchWalletAnalysis, MOBULA_MIN_INTERVAL_MS, type MobulaWalletResult } from "./lib/mobula.js";

const MINED_WALLETS_FILE = "data/mined_wallets.json";
const CACHE_FILE = "data/mobula_cache.json";
const CHAIN_ID = "evm:4663";
const PERIOD = "90d"; // widest period Mobula's docs offer — this chain is new, so max coverage matters more than recency

interface MinedWallet {
  address: string;
  [key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.MOBULA_API_KEY) {
    console.warn(
      "MOBULA_API_KEY not set — falling back to Mobula's public demo API.\n" +
        "That's rate-limited and described by Mobula as 'for testing only', so\n" +
        "treat these results as exploratory. Set MOBULA_API_KEY for real use.\n",
    );
  }

  const wallets = loadJson<MinedWallet[]>(MINED_WALLETS_FILE, []);
  if (wallets.length === 0) {
    console.error(`${MINED_WALLETS_FILE} is empty or missing — run \`npm run wallets:mine\` first.`);
    process.exit(1);
  }

  const cache = loadJson<Record<string, MobulaWalletResult>>(CACHE_FILE, {});
  console.log(`Loaded ${wallets.length} candidates, ${Object.keys(cache).length} already cached.`);

  let queried = 0;
  for (let i = 0; i < wallets.length; i++) {
    const address = wallets[i]!.address.toLowerCase();
    if (cache[address]) {
      console.log(`[${i + 1}/${wallets.length}] ${address}: cached (status=${cache[address]!.status})`);
      continue;
    }

    if (queried > 0) {
      await sleep(MOBULA_MIN_INTERVAL_MS);
    }
    console.log(`[${i + 1}/${wallets.length}] querying Mobula for ${address}...`);
    const result = await fetchWalletAnalysis(address, {
      apiKey: env.MOBULA_API_KEY,
      chainId: CHAIN_ID,
      period: PERIOD,
    });
    cache[address] = result;
    queried++;
    // Persist after every call, not just at the end — a 50-wallet run at
    // ~12s/call takes ~10 minutes; a crash partway through shouldn't lose
    // the quota already spent.
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(
      `  -> status=${result.status} pnl=${result.pnl} winRate=${result.winRate} txCount=${result.txCount}` +
        (result.note ? ` note="${result.note}"` : ""),
    );
  }

  const merged = wallets.map((w) => {
    const result = cache[w.address.toLowerCase()];
    return {
      ...w,
      mobulaPnl: result?.pnl ?? "unknown",
      mobulaTotalPnl: result?.totalPnl ?? "unknown",
      mobulaWinRate: result?.winRate ?? "unknown",
      mobulaTxCount: result?.txCount ?? "unknown",
      mobulaLabels: result?.labels ?? [],
      mobulaStatus: result?.status ?? "unknown",
      mobulaNote: result?.note,
      mobulaFetchedAt: result?.fetchedAt,
    };
  });

  writeFileSync(MINED_WALLETS_FILE, JSON.stringify(merged, null, 2));
  console.log(`\nQueried ${queried} new wallet(s) this run. Merged Mobula data into ${MINED_WALLETS_FILE}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
