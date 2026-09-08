// Spec A.12-A.15. A pure, chain-agnostic in-memory holder balance map —
// built ONLY from ERC20-style Transfer events (never Swap/Curve trade
// events, which V1 already proved is a different classification problem —
// see A.12). Exclusion of LP/burn/router/locker/system addresses happens
// at READ time only (A.13 step 6) — the raw balance map keeps every
// address, so a later query with a different exclusion set (or none) is
// still correct without re-processing history.

export interface TransferInput {
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  logIndex: number | null;
}

export type ApplyTransferResult = "applied" | "duplicate" | "capacity_exceeded";

export interface HolderBalanceMapConfig {
  /** Per-token address cap (spec A.15: hard limit against a pathological
   * candidate with millions of addresses). Default 200,000. */
  maxAddressesPerToken?: number;
  /** Cross-token total cap, protecting overall process memory regardless
   * of how many tokens are being tracked at once. Default 2,000,000. */
  maxTotalAddresses?: number;
}

export interface HolderBalanceMapHealth {
  balanceTableTokens: number;
  balanceTableAddresses: number;
  balanceTableEvictions: number;
}

const ZERO_ADDRESS = /^0x0+$/;

function isNewBalance(balances: Map<string, bigint>, address: string): boolean {
  return !balances.has(address);
}

export class HolderBalanceMap {
  private readonly tokens = new Map<string, Map<string, bigint>>();
  private readonly seenTransfers = new Map<string, Set<string>>();
  private readonly capExceededTokens = new Set<string>();
  private readonly maxAddressesPerToken: number;
  private readonly maxTotalAddresses: number;
  private totalAddresses = 0;
  private evictions = 0;

  constructor(config: HolderBalanceMapConfig = {}) {
    this.maxAddressesPerToken = config.maxAddressesPerToken ?? 200_000;
    this.maxTotalAddresses = config.maxTotalAddresses ?? 2_000_000;
  }

  /** Applies one Transfer, deduped by (txHash, logIndex) per token (spec
   * A.13 step 3) — safe to call for the same event twice, e.g. once from
   * the one-time launchBlock backfill and once from the live subscription
   * racing it (A.13 steps 2/4). Never throws — a capacity breach degrades
   * gracefully (A.15: "不能无限增长造成OOM... 超过：degrade gracefully").*/
  applyTransfer(tokenAddress: string, transfer: TransferInput): ApplyTransferResult {
    const token = tokenAddress.toLowerCase();
    const dedupKey = `${transfer.txHash.toLowerCase()}:${transfer.logIndex ?? -1}`;
    let seen = this.seenTransfers.get(token);
    if (!seen) {
      seen = new Set();
      this.seenTransfers.set(token, seen);
    }
    if (seen.has(dedupKey)) return "duplicate";

    let balances = this.tokens.get(token);
    if (!balances) {
      balances = new Map();
      this.tokens.set(token, balances);
    }

    const from = transfer.from.toLowerCase();
    const to = transfer.to.toLowerCase();
    const isMint = ZERO_ADDRESS.test(from);
    const isBurn = ZERO_ADDRESS.test(to);

    const newAddressCount =
      (isMint ? 0 : isNewBalance(balances, from) ? 1 : 0) + (isBurn ? 0 : isNewBalance(balances, to) ? 1 : 0);

    if (
      newAddressCount > 0 &&
      (balances.size + newAddressCount > this.maxAddressesPerToken ||
        this.totalAddresses + newAddressCount > this.maxTotalAddresses)
    ) {
      this.evictions++;
      this.capExceededTokens.add(token);
      // Still mark seen — a retried/duplicate delivery of this same event
      // must not be charged against the cap twice.
      seen.add(dedupKey);
      return "capacity_exceeded";
    }

    if (!isMint) {
      const isNew = isNewBalance(balances, from);
      balances.set(from, (balances.get(from) ?? 0n) - transfer.amount);
      if (isNew) this.totalAddresses++;
    }
    if (!isBurn) {
      const isNew = isNewBalance(balances, to);
      balances.set(to, (balances.get(to) ?? 0n) + transfer.amount);
      if (isNew) this.totalAddresses++;
    }
    seen.add(dedupKey);
    return "applied";
  }

  /** True once this token has hit BALANCE_TABLE_CAP_EXCEEDED at least once
   * — callers should lower confidence on holder metrics for it (A.15). */
  isCapacityExceeded(tokenAddress: string): boolean {
    return this.capExceededTokens.has(tokenAddress.toLowerCase());
  }

  /** Read-time exclusion only (A.13 step 6) — the underlying map is never
   * mutated by this. Zero/negative balances are dropped (not "holders"). */
  getHolders(tokenAddress: string, excludeAddresses: Iterable<string> = []): Map<string, bigint> {
    const balances = this.tokens.get(tokenAddress.toLowerCase());
    if (!balances) return new Map();
    const exclude = new Set(Array.from(excludeAddresses, (a) => a.toLowerCase()));
    const result = new Map<string, bigint>();
    for (const [address, balance] of balances) {
      if (exclude.has(address)) continue;
      if (balance <= 0n) continue;
      result.set(address, balance);
    }
    return result;
  }

  getHolderCount(tokenAddress: string, excludeAddresses?: Iterable<string>): number {
    return this.getHolders(tokenAddress, excludeAddresses).size;
  }

  /** Percentage (0-100) of total held-balance concentrated in the top N
   * holders, after exclusions. Null when there's nothing to compute from
   * yet — never 0, which would misleadingly read as "well distributed". */
  getTopHolderSharePct(tokenAddress: string, topN: number, excludeAddresses?: Iterable<string>): number | null {
    const balances = [...this.getHolders(tokenAddress, excludeAddresses).values()].sort((a, b) =>
      b > a ? 1 : b < a ? -1 : 0,
    );
    if (balances.length === 0) return null;
    const total = balances.reduce((sum, b) => sum + b, 0n);
    if (total <= 0n) return null;
    const top = balances.slice(0, topN).reduce((sum, b) => sum + b, 0n);
    return Number((top * 10_000n) / total) / 100;
  }

  /** EXPIRED_30M must immediately release this token's balance map (A.13
   * step 7) — nothing after this call should keep tracking it in memory. */
  release(tokenAddress: string): void {
    const token = tokenAddress.toLowerCase();
    const balances = this.tokens.get(token);
    if (balances) this.totalAddresses -= balances.size;
    this.tokens.delete(token);
    this.seenTransfers.delete(token);
    this.capExceededTokens.delete(token);
  }

  health(): HolderBalanceMapHealth {
    return {
      balanceTableTokens: this.tokens.size,
      balanceTableAddresses: this.totalAddresses,
      balanceTableEvictions: this.evictions,
    };
  }
}
