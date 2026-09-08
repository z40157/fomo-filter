// Spec B1.1 — on-chain-first market state, computed from this radar's own
// trade stream (never DexScreener as a precondition — B1.4). One instance
// tracks one token's rolling trade history and derives the windowed
// metrics B2's Organic Momentum dimension needs.

import type { TradeEvent } from "../chains/types.js";

export const WINDOWS_MS = { "1m": 60_000, "3m": 3 * 60_000, "5m": 5 * 60_000 } as const;
export type WindowKey = keyof typeof WINDOWS_MS;

export interface WindowStats {
  volume: number | null;
  buys: number | null;
  sells: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  uniqueTraders: number | null;
  netBuyFlow: number | null;
}

export interface MarketStateSnapshot {
  windows: Record<WindowKey, WindowStats>;
  /** Median seconds between trades over the available history — null with
   * fewer than 2 trades. Smaller = busier. */
  tradeIntervalSeconds: number | null;
  /** (recent 1m volume - prior 1m volume) / prior 1m volume, as a ratio
   * (0.5 = +50%). Null when either side is missing — never 0 (spec B2.4:
   * missing data is null, not a fabricated flat reading). */
  volumeVelocity: number | null;
  /** Second derivative — change in volumeVelocity between two consecutive
   * measurement points the caller supplies (see computeAcceleration). */
  volumeAcceleration: number | null;
  uniqueBuyerVelocity: number | null;
  price: number | null;
  priceVelocity: number | null;
}

interface RecordedTrade {
  side: TradeEvent["side"];
  wallet: string;
  usdValue: number | null;
  quoteAmount: bigint;
  tokenAmount: bigint;
  timestamp: number;
}

/** Per-token rolling trade tracker. Deliberately holds only recent trades
 * (bounded by the largest window, 5m) — a Hot Candidate is evicted
 * entirely at EXPIRED_30M (see EvictablePerTokenState pattern shared with
 * HolderBalanceMap), so unbounded history was never a design goal here. */
export class TokenMarketState {
  private trades: RecordedTrade[] = [];
  private lastVolume1m: number | null = null;
  private lastUniqueBuyers1m: number | null = null;

  recordTrade(trade: TradeEvent, quoteUsdPrice: number | null): void {
    const usdValue =
      trade.usdValue ?? (quoteUsdPrice !== null ? toHumanUnits(trade.quoteAmount) * quoteUsdPrice : null);
    this.trades.push({
      side: trade.side,
      wallet: trade.wallet.toLowerCase(),
      usdValue,
      quoteAmount: trade.quoteAmount,
      tokenAmount: trade.tokenAmount,
      timestamp: trade.timestamp.getTime(),
    });
    const cutoff = trade.timestamp.getTime() - WINDOWS_MS["5m"];
    this.trades = this.trades.filter((t) => t.timestamp >= cutoff);
  }

  private windowStats(nowMs: number, windowMs: number): WindowStats {
    const cutoff = nowMs - windowMs;
    const inWindow = this.trades.filter((t) => t.timestamp >= cutoff);
    if (inWindow.length === 0) {
      return { volume: null, buys: null, sells: null, uniqueBuyers: null, uniqueSellers: null, uniqueTraders: null, netBuyFlow: null };
    }
    let buys = 0;
    let sells = 0;
    let buyVolume = 0;
    let sellVolume = 0;
    let sawUsd = false;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    for (const t of inWindow) {
      if (t.side === "BUY") {
        buys++;
        buyers.add(t.wallet);
        if (t.usdValue !== null) {
          buyVolume += t.usdValue;
          sawUsd = true;
        }
      } else {
        sells++;
        sellers.add(t.wallet);
        if (t.usdValue !== null) {
          sellVolume += t.usdValue;
          sawUsd = true;
        }
      }
    }
    return {
      volume: sawUsd ? buyVolume + sellVolume : null,
      buys,
      sells,
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      uniqueTraders: new Set([...buyers, ...sellers]).size,
      netBuyFlow: sawUsd ? buyVolume - sellVolume : null,
    };
  }

  private tradeIntervalSeconds(): number | null {
    if (this.trades.length < 2) return null;
    const sorted = [...this.trades].sort((a, b) => a.timestamp - b.timestamp);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i]!.timestamp - sorted[i - 1]!.timestamp) / 1000);
    }
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    return gaps.length % 2 === 0 ? (gaps[mid - 1]! + gaps[mid]!) / 2 : gaps[mid]!;
  }

  private latestPrice(): number | null {
    const last = this.trades[this.trades.length - 1];
    if (!last || last.tokenAmount === 0n) return null;
    // Price expressed in quote-token units per token, human-scaled by raw
    // base-unit ratio only (no decimals applied here — callers with real
    // decimals should scale; kept simple/testable at the base-unit level).
    return toHumanUnits(last.quoteAmount) / toHumanUnits(last.tokenAmount);
  }

  snapshot(nowMs: number): MarketStateSnapshot {
    const windows = {
      "1m": this.windowStats(nowMs, WINDOWS_MS["1m"]),
      "3m": this.windowStats(nowMs, WINDOWS_MS["3m"]),
      "5m": this.windowStats(nowMs, WINDOWS_MS["5m"]),
    };

    const currentVolume1m = windows["1m"].volume;
    const volumeVelocity =
      currentVolume1m !== null && this.lastVolume1m !== null && this.lastVolume1m > 0
        ? (currentVolume1m - this.lastVolume1m) / this.lastVolume1m
        : null;

    const currentUniqueBuyers1m = windows["1m"].uniqueBuyers;
    const uniqueBuyerVelocity =
      currentUniqueBuyers1m !== null && this.lastUniqueBuyers1m !== null && this.lastUniqueBuyers1m > 0
        ? (currentUniqueBuyers1m - this.lastUniqueBuyers1m) / this.lastUniqueBuyers1m
        : null;

    this.lastVolume1m = currentVolume1m;
    this.lastUniqueBuyers1m = currentUniqueBuyers1m;

    return {
      windows,
      tradeIntervalSeconds: this.tradeIntervalSeconds(),
      volumeVelocity,
      volumeAcceleration: null, // requires two velocity samples — see computeAcceleration
      uniqueBuyerVelocity,
      price: this.latestPrice(),
      priceVelocity: null, // requires two price samples over time — computed by the caller from score_history
    };
  }
}

function toHumanUnits(raw: bigint): number {
  // Deliberately no decimals division here (base-unit ratios cancel them
  // out for price; volume/flow callers pass a pre-scaled quoteUsdPrice
  // instead) — see recordTrade's usdValue computation.
  return Number(raw);
}

/** B2.4: acceleration from two velocity samples, using whatever the
 * longest available window is — never fabricates a value from a single
 * sample. */
export function computeAcceleration(previousVelocity: number | null, currentVelocity: number | null): number | null {
  if (previousVelocity === null || currentVelocity === null) return null;
  return currentVelocity - previousVelocity;
}
