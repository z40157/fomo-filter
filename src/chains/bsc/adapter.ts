// Scaffold only (Phase A) — see src/chains/solana/adapter.ts's header for
// why this throws instead of implementing anything. BSC is EVM-shaped so
// its real implementation will likely share more code with robinhood/ than
// solana/ or bch/ will, but that reuse is a later-phase decision.
import type { ChainAdapter, ChainKey } from "../types.js";

export const BSC_CHAIN_KEY: ChainKey = "bsc";

export function createBscAdapter(): ChainAdapter {
  throw new Error(
    "BSC adapter is not implemented (Phase A scaffold only) — see V2 Master Spec: do not implement BSC in Phase A/B",
  );
}
