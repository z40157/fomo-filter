import type { WalletWatchlistRepo } from "../db/walletWatchlist.js";
import { createWalletSchema, zodErrorMessage } from "./validation.js";

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: { index: number; error: string }[];
}

/**
 * Core upsert-import logic, kept independent of file I/O and process
 * wiring so it can be unit-tested against a fake repo. Existing addresses
 * are updated in place; new ones are inserted. Invalid entries are skipped
 * (not thrown), so one bad row in a large file doesn't abort the rest.
 */
export async function importWallets(entries: unknown[], repo: WalletWatchlistRepo): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, skipped: [] };

  for (let index = 0; index < entries.length; index++) {
    const parsed = createWalletSchema.safeParse(entries[index]);
    if (!parsed.success) {
      result.skipped.push({ index, error: zodErrorMessage(parsed.error) });
      continue;
    }

    const { inserted } = await repo.upsert(parsed.data);
    if (inserted) {
      result.inserted++;
    } else {
      result.updated++;
    }
  }

  return result;
}
