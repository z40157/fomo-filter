import { describe, expect, it } from "vitest";
import { classifyDopplerSwap, classifyPonsSwap, currencyPairKey, sortCurrencies } from "../../../src/chains/robinhood/tradeClassification.js";

const TOKEN = "0x1000000000000000000000000000000000000a"; // numerically smaller
const PAIR = "0x2000000000000000000000000000000000000b"; // numerically larger

describe("sortCurrencies / currencyPairKey", () => {
  it("orders by numeric address value regardless of input order", () => {
    expect(sortCurrencies(TOKEN, PAIR)).toEqual([TOKEN, PAIR]);
    expect(sortCurrencies(PAIR, TOKEN)).toEqual([TOKEN, PAIR]);
  });

  it("is order-independent", () => {
    expect(currencyPairKey(TOKEN, PAIR)).toBe(currencyPairKey(PAIR, TOKEN));
  });
});

describe("classifyDopplerSwap", () => {
  it("token as currency0: positive amount0 is a BUY of the token", () => {
    const result = classifyDopplerSwap({ amount0: 100n, amount1: -50n }, TOKEN, PAIR);
    expect(result).toEqual({ side: "BUY", tokenAmount: 100n, quoteAmount: -50n });
  });

  it("token as currency0: negative amount0 is a SELL", () => {
    const result = classifyDopplerSwap({ amount0: -100n, amount1: 50n }, TOKEN, PAIR);
    expect(result).toEqual({ side: "SELL", tokenAmount: -100n, quoteAmount: 50n });
  });

  it("token as currency1 (pair token numerically smaller): reads amount1 as the token side", () => {
    // Swap the roles: PAIR is numerically smaller than TOKEN here, so TOKEN is currency1.
    const smallerPair = "0x0000000000000000000000000000000000000c";
    const result = classifyDopplerSwap({ amount0: -20n, amount1: 40n }, TOKEN, smallerPair);
    expect(result).toEqual({ side: "BUY", tokenAmount: 40n, quoteAmount: -20n });
  });
});

describe("classifyPonsSwap", () => {
  it("token as token0: pool paying out the token (negative amount0) is a BUY", () => {
    const result = classifyPonsSwap({ amount0: -100n, amount1: 50n }, TOKEN, PAIR);
    expect(result).toEqual({ side: "BUY", tokenAmount: -100n, quoteAmount: 50n });
  });

  it("token as token0: pool receiving the token (positive amount0) is a SELL", () => {
    const result = classifyPonsSwap({ amount0: 100n, amount1: -50n }, TOKEN, PAIR);
    expect(result).toEqual({ side: "SELL", tokenAmount: 100n, quoteAmount: -50n });
  });
});
