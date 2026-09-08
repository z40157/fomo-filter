// Chain-agnostic contract for V2's Hot Radar (spec A.2). Scoring,
// HotCandidate lifecycle, and the alert engine must only ever import from
// this file for chain data — never viem, never a Solana/BSC/BCH-specific
// type. All chain differences (WSS vs Geyser vs gRPC, EVM reorgs vs
// Solana slots, etc.) live inside each chain's adapter implementation.

export type ChainKey = "robinhood" | "solana" | "bsc" | "bch";

export type TradeSide = "BUY" | "SELL";

/** A newly discovered token launch, normalized across launchpads/chains.
 * `launchedAt` is t0 (spec A.5) — every adapter must define it explicitly
 * and document, in its own code, which underlying event it came from. EVM
 * adapters must also populate the block number/hash pair so a later reorg
 * can invalidate this launch (see A.5's reorg guard). */
export interface LaunchEvent {
  chain: ChainKey;
  /** Adapter-defined launchpad identifier, e.g. "doppler" | "pons_v1". */
  source: string;
  tokenAddress: string;
  creator: string | null;
  pairToken: string | null;
  pool: string | null;
  launchedAt: Date;
  launchBlockNumber: bigint | null;
  launchBlockHash: string | null;
  launchTxHash: string | null;
}

/** A single BUY/SELL, from the protocol's actual swap/curve event — never
 * inferred from an ERC20 Transfer (spec A.12: Trade Feed and Holder Feed
 * are different event streams on EVM chains). */
export interface TradeEvent {
  chain: ChainKey;
  tokenAddress: string;
  wallet: string;
  side: TradeSide;
  /** Raw base-unit amounts (e.g. wei) — not divided by decimals. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  /** USD value if the adapter could price it on the spot, else null —
   * never guessed (see B1.2). */
  usdValue: number | null;
  blockNumber: bigint | null;
  txHash: string;
  logIndex: number | null;
  timestamp: Date;
}

/** A single ERC20-style Transfer (or chain-native equivalent), used only
 * to maintain the holder balance map — never for BUY/SELL classification
 * (spec A.12). */
export interface TokenTransferEvent {
  chain: ChainKey;
  tokenAddress: string;
  from: string;
  to: string;
  amount: bigint;
  blockNumber: bigint | null;
  txHash: string;
  logIndex: number | null;
  timestamp: Date;
}

export interface TokenMetadata {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
}

/** B1.3: if a chain/launchpad can't reliably compute liquidity on-chain
 * right now, `liquidityUsd`/`liquidityNative` must be null (UNKNOWN) — this
 * type has no "estimated" field on purpose, so a caller can't accidentally
 * treat a guess as real. */
export interface LiquiditySnapshot {
  tokenAddress: string;
  /** Pool/curve balance of the quote token, in its own base units. Null
   * when not computable on-chain at all. */
  liquidityNative: bigint | null;
  quoteToken: string | null;
  /** USD conversion of liquidityNative. Per B1.4, DexScreener may be used
   * here ONLY as a secondary cross-check/fallback for unit conversion —
   * never as the source of whether liquidity exists at all. */
  liquidityUsd: number | null;
  source: "onchain" | "onchain+dexscreener_usd" | "unknown";
  asOf: Date;
}

export type SellabilityStatus = "PASS" | "FAIL" | "UNKNOWN";

/** Read-only simulation result only — see B2.6: never signs or sends a
 * transaction. `estimatedExitSlippagePctByUsd` keys are the USD amounts
 * the caller asked to simulate (spec calls out 100/500/1000 as examples). */
export interface SellabilityResult {
  status: SellabilityStatus;
  estimatedExitSlippagePctByUsd: Record<number, number | null>;
  reasons: string[];
}

/** A launchpad/protocol contract this adapter is (or was) subscribed to —
 * mirrors db/schemaV2.ts's chainSources table, returned by adapters so
 * their actual live subscription state can be persisted/audited (A.17). */
export interface ChainSourceDescriptor {
  source: string;
  role: "factory" | "airlock" | "initializer" | "pool" | "hook";
  address: string;
  eventName: string | null;
}

export interface ChainAdapter {
  readonly chainKey: ChainKey;

  /** Subscribes to this chain's known launch sources (spec A.3: fixed,
   * small set of protocol contracts — never a full-chain firehose). */
  startLaunchDiscovery(onLaunch: (event: LaunchEvent) => void): Promise<void>;
  stopLaunchDiscovery(): Promise<void>;

  /** Subscribes trades for the CURRENT hot address set only. Both this and
   * startHolderFeed's `getHotAddresses` return TOKEN contract addresses,
   * not the underlying pool/hook/initializer contracts trades actually
   * emit from — resolving that mapping is exactly the kind of
   * launchpad-specific detail this interface exists to hide from the
   * scoring/engine layer (spec A.2). `getHotAddresses` is polled by the
   * adapter (spec A.3: re-check every 10-15s) to refresh its subscription
   * as candidates enter/leave the <=30m window. */
  startHotTradeFeed(getHotAddresses: () => string[], onTrade: (trade: TradeEvent) => void): Promise<void>;
  stopHotTradeFeed(): Promise<void>;

  /** Optional — not every chain/launchpad needs a separate Transfer feed.
   * Same dynamic-address-set contract as startHotTradeFeed (token
   * addresses; ERC20-style Transfer is emitted by the token contract
   * itself, so no pool/hook mapping is needed here). */
  startHolderFeed?(
    getHotAddresses: () => string[],
    onTransfer: (event: TokenTransferEvent) => void,
  ): Promise<void>;
  stopHolderFeed?(): Promise<void>;

  getTokenMetadata(address: string): Promise<TokenMetadata | null>;
  getCreator(address: string): Promise<string | null>;
  getLiquiditySnapshot(address: string): Promise<LiquiditySnapshot | null>;

  /** READ-ONLY. Never signs, never sends a transaction — see B1 hard
   * boundary and B2.6. */
  simulateSellability(address: string, amountsUsd: number[]): Promise<SellabilityResult>;

  /** One-time initial backfill of Transfer events from a token's launch
   * block to the current block (spec A.13 step 2) — separate from the live
   * startHolderFeed subscription, called once per new Hot Candidate. */
  backfillHolderTransfers?(
    address: string,
    fromBlock: bigint,
    onTransfer: (event: TokenTransferEvent) => void,
  ): Promise<void>;

  describeSources(): ChainSourceDescriptor[];
}
