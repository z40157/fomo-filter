import type { DopplerSwapArgs, PonsSwapArgs } from "../../chain/tradeDetector.js";
import type { TradeSide } from "../types.js";

// Mirrors chain/tradeDetector.ts's handleDopplerSwap/handlePonsSwap exactly
// — see that file's header comments for the on-chain verification behind
// this math (currency ordering, which side reports the swapper's vs the
// pool's balance delta). Deliberately duplicated here rather than imported
// from tradeDetector.ts: V2 development must not require editing any V1
// production file (see V2 Master Spec Git rules) — DOPPLER_SWAP_EVENT /
// PONS_V3_SWAP_EVENT / computeDopplerPoolId are still imported directly,
// since those are already-exported, unmodified constants/pure functions.

export function sortCurrencies(a: string, b: string): [string, string] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

export function currencyPairKey(a: string, b: string): string {
  const [lo, hi] = sortCurrencies(a, b);
  return `${lo.toLowerCase()}_${hi.toLowerCase()}`;
}

export interface ClassifiedSwap {
  side: TradeSide;
  tokenAmount: bigint;
  quoteAmount: bigint;
}

/** Doppler's Swap event reports the *swapper's* balance delta: positive =
 * swapper received that currency (BUY of that currency), negative = paid. */
export function classifyDopplerSwap(
  args: Pick<DopplerSwapArgs, "amount0" | "amount1">,
  tokenAddress: string,
  pairToken: string,
): ClassifiedSwap {
  const [currency0] = sortCurrencies(tokenAddress, pairToken);
  const assetIsCurrency0 = currency0.toLowerCase() === tokenAddress.toLowerCase();
  const tokenAmount = assetIsCurrency0 ? args.amount0 : args.amount1;
  const quoteAmount = assetIsCurrency0 ? args.amount1 : args.amount0;
  return { side: tokenAmount > 0n ? "BUY" : "SELL", tokenAmount, quoteAmount };
}

/** Standard Uniswap V3 Swap event reports the *pool's* balance delta —
 * opposite convention from Doppler's hook: positive = pool received
 * (swapper paid it in), negative = pool paid out (swapper received). */
export function classifyPonsSwap(
  args: Pick<PonsSwapArgs, "amount0" | "amount1">,
  tokenAddress: string,
  pairToken: string,
): ClassifiedSwap {
  const [token0] = sortCurrencies(tokenAddress, pairToken);
  const assetIsToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
  const tokenAmount = assetIsToken0 ? args.amount0 : args.amount1;
  const quoteAmount = assetIsToken0 ? args.amount1 : args.amount0;
  return { side: tokenAmount < 0n ? "BUY" : "SELL", tokenAmount, quoteAmount };
}
