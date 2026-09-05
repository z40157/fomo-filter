import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { scannerState } from "./schema.js";

export interface ScannerStateRepo {
  getState(chainId: number): Promise<{ lastProcessedBlock: bigint } | null>;
  saveState(chainId: number, lastProcessedBlock: bigint): Promise<void>;
}

export function createScannerStateRepo(db: Database): ScannerStateRepo {
  return {
    async getState(chainId) {
      const rows = await db
        .select({ lastProcessedBlock: scannerState.lastProcessedBlock })
        .from(scannerState)
        .where(eq(scannerState.chainId, chainId))
        .limit(1);
      return rows[0] ?? null;
    },

    async saveState(chainId, lastProcessedBlock) {
      await db
        .insert(scannerState)
        .values({ chainId, lastProcessedBlock, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: scannerState.chainId,
          set: { lastProcessedBlock, updatedAt: new Date() },
        });
    },
  };
}
