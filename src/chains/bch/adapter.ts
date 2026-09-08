// Scaffold only (Phase A) — see src/chains/solana/adapter.ts's header for
// why this throws instead of implementing anything. BCH is neither EVM nor
// Solana-shaped (UTXO chain, no native token-launch/AMM standard the way
// EVM/Solana meme launchpads do), so its adapter will need its own launch
// definition before any real implementation is possible.
import type { ChainAdapter, ChainKey } from "../types.js";

export const BCH_CHAIN_KEY: ChainKey = "bch";

export function createBchAdapter(): ChainAdapter {
  throw new Error(
    "BCH adapter is not implemented (Phase A scaffold only) — see V2 Master Spec: do not implement BCH in Phase A/B",
  );
}
