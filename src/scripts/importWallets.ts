import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "../config/index.js";
import { createDb } from "../db/client.js";
import { createWalletWatchlistRepo } from "../db/walletWatchlist.js";
import { importWallets } from "../wallets/importWallets.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const repo = createWalletWatchlistRepo(db);

  const filePath = resolve(process.cwd(), "data/wallets.json");
  const raw = readFileSync(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("data/wallets.json must contain a JSON array of wallet entries");
  }

  const result = await importWallets(parsed, repo);

  console.log(`Import complete: ${result.inserted} inserted, ${result.updated} updated.`);
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} invalid entr${result.skipped.length === 1 ? "y" : "ies"}:`);
    for (const { index, error } of result.skipped) {
      console.log(`  [${index}] ${error}`);
    }
  }

  process.exit(result.skipped.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
