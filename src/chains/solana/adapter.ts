// Scaffold only (Phase A). Real Solana ingestion (logsSubscribe / Geyser /
// gRPC / a third-party stream — see spec A.3) is out of scope until a
// later phase explicitly turns it on. This file exists so ChainAdapter's
// shape gets exercised by TypeScript against a second chain now, catching
// any accidental Robinhood/EVM assumption baked into the interface early.
import type { ChainAdapter, ChainKey } from "../types.js";

export const SOLANA_CHAIN_KEY: ChainKey = "solana";

export function createSolanaAdapter(): ChainAdapter {
  throw new Error(
    "Solana adapter is not implemented (Phase A scaffold only) — see V2 Master Spec: do not implement Solana in Phase A/B",
  );
}
