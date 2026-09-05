# Robinhood Alpha Radar V1 — Progress

Read-only on-chain monitoring system for Robinhood Chain (chainId **4663**, an
Arbitrum Orbit L2 settling on Ethereum). Purpose: detect new token launches
and their BUY/SELL trading activity as a data source for a future
FOMO-detection/alerting system. This file exists so a new session (or a
human) can get oriented without re-deriving everything from the code.

## Status: Phase 3 complete (2026-09-05)

- ✅ Phase 0 — Skeleton
- ✅ Phase 1 — Chain watcher (WS + reconnect + restart recovery)
- ✅ Phase 2 — New-token discovery (Doppler + Pons V1)
- ✅ Phase 3 — BUY/SELL trade detection (Doppler + Pons V1)
- ⬜ Phase 4 — Wallet watchlist (not started)
- ⬜ Everything else — `walletWatchlist`, `tokenSnapshots`, `signals`,
  `signalWallets`, `alerts`, `signalOutcomes`, `narrativeFlags` tables are
  still placeholder-only (just `id`/`createdAt`).

Tests: 31/31 passing (`npm test`). Typecheck clean (`npm run typecheck` and
`npm run typecheck:test`).

---

## What each phase actually built

### Phase 0 — Skeleton
- Fastify API server (`src/api/server.ts`) with a `/health` route
  (`src/api/routes/health.ts`) reporting watcher status, DB connectivity,
  and tracked-token count.
- Drizzle ORM + Postgres (`src/db/client.ts`, `src/db/schema.ts`).
- Zod-validated env loading (`src/config/env.ts`).
- Pino logging (`src/logger.ts`), Dockerfile.

### Phase 1 — Chain watcher (`src/chain/watcher.ts`)
- `ChainWatcher`: WS block subscription (`viem`), exponential backoff
  reconnect (`src/chain/backoff.ts`), restart-recovery backfill against a
  `scanner_state` table (one row per chainId, tracks
  `last_processed_block`) — see `src/chain/recovery.ts`.
- Exposes an `onBlockRange(fromBlock, toBlock)` hook so downstream
  detectors piggyback the same block pipeline instead of running their own
  WS subscription. Awaited before the range is marked processed.
- This RPC's WSS edge doesn't handle WebSocket ping frames — viem's
  keepalive ping was closing an otherwise-healthy connection every ~20s.
  `keepAlive: false` on the WS transport fixes it (see `src/chain/client.ts`
  comment).

### Phase 2 — New-token discovery (`src/chain/newTokenDetector.ts`)
- Watches the Doppler Airlock's `Create` event and the Pons V1 Factory's
  `TokenLaunched` event, resolves deployer (Doppler only — Pons already
  carries it) and ERC-20 `name()`/`symbol()`, writes into `tokens` with
  dedup on `address`.
- For Doppler, also captures the Create event's `initializer` field (the
  pool-initializer/hook contract address) onto the token row — needed by
  Phase 3, see below.

### Phase 3 — BUY/SELL trade detection (`src/chain/tradeDetector.ts`)
- New `trades` table: `chain_id, token_id → tokens, wallet, side (BUY/SELL
  enum), quote_amount, token_amount (both numeric(78,0) — raw base-unit
  integers, NOT decimal-adjusted), usd_value (nullable, never blocks
  recording), block_number, tx_hash, log_index, timestamp`, with
  `unique(chain_id, tx_hash, log_index)` for dedup (a single tx can contain
  multiple separate Swap logs — confirmed on real data, e.g. bonding-curve
  multi-hop execution within one Multicurve/Bundler tx).
- `tokens` gains two Doppler-only nullable columns: `initializer` (the
  hook/pool-initializer contract to watch for Swap logs) and `pool_id`
  (the resolved Uniswap v4 PoolId used to filter Swap logs to this token).
- Plain ERC20 Transfer events (including airdrops, which are just
  Transfers with no curve/pool interaction) are excluded **by
  construction**: the http client only ever calls `eth_getLogs` topic-
  filtered to the Swap event selector, so Transfer logs never reach the
  detector at all — there's no explicit "ignore Transfer" branch to get
  wrong.

---

## Key technical decisions (read this before touching trade detection)

### 1. Doppler trades are NOT "CurveBuy"/"CurveSell" — they're a Uniswap v4 hook `Swap` event
There is no `CurveBuy`/`CurveSell` event anywhere in
`github.com/whetstoneresearch/doppler`. That was a wrong assumption in the
original spec. What's actually true, verified against the real deployed
contracts on chainId 4663:

- The Airlock `Create` event's `poolOrHook` field equals the launched
  **asset address itself** (verified across 32 real launches). The
  launched token contract only ever emits standard ERC20
  `Transfer`/`Approval`/`OwnershipTransferred` — confirmed by pulling every
  raw log ever emitted by several real launched tokens and diffing topic0
  against independently-computed selectors.
- Real trading happens on a **shared, singleton pool-initializer/hook
  contract** named by the Create event's `initializer` field (on this
  chain, observed as `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` for
  every launch so far — but the code reads it per-token from the Create
  event rather than hardcoding it, in case Airlock ever registers a
  different initializer module).
- That contract's `Swap` event (source:
  `src/initializers/DopplerHookInitializer.sol`) is what gets recorded.
  Full signature used for topic0/decoding:
  `Swap(address indexed sender, PoolKey indexed poolKey, PoolId indexed poolId, IPoolManager.SwapParams params, int128 amount0, int128 amount1, bytes hookData)`
  — verified: independently computed topic0
  (`0x1d9f7b5e406d8c887155e1a78e070d2d41c5d0444dab8b21612f846835c27183`)
  exactly matched 3,477 real logs at that contract on-chain.

### 2. Amount sign conventions differ between Doppler and Pons V1 — and are opposite
- **Doppler's Swap event reports the *swapper's* balance delta**: positive
  = swapper received that currency, negative = swapper paid it. Verified
  against a real native-ETH trade where `amount0` exactly matched
  `-tx.value`.
- **Pons V1 (standard Uniswap V3 pool) Swap event reports the *pool's*
  balance delta** (the well-known V3 convention): positive = pool received
  (swapper paid in), negative = pool paid out (swapper received). Verified
  against real BUNEE/WETH trades with sane WETH amounts.
- Getting this backwards silently flips every BUY/SELL label — there's no
  runtime error to catch it, only wrong labels. If touching this code,
  re-verify against a real trade's `tx.value` (for a native-currency pair)
  before trusting a sign change.
- `wallet` = `tx.from` (the actual transaction sender) in both cases, never
  the event's `sender`/`recipient` param — those are frequently an
  intermediate router/Bundler contract, not the EOA. Same pattern Phase 2
  already used for Doppler's deployer resolution.

### 3. Doppler's PoolId cannot be assumed — it's resolved lazily from a real ModifyLiquidity event
- Uniswap v4 `PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`.
  `currency0`/`currency1` = the asset/pairToken sorted ascending by
  numeric address value (the standard, protocol-enforced sort — same rule
  Uniswap V3's factory uses for `token0`/`token1`).
- `fee` is always the dynamic-fee flag `8388608` (`0x800000`) — structurally
  forced by the hook's dynamic-fee design, confirmed constant across 1,644
  real `ModifyLiquidity` logs.
- **`tickSpacing` genuinely varies per launch** — confirmed both `8` and
  `200` among those same 1,644 real logs. It must never be assumed.
- **A Doppler bonding-curve pool's liquidity is NOT seeded at launch.** It's
  modified lazily, in the same transaction as whichever swap first trades
  it. Verified on a real token: its first `ModifyLiquidity` landed 97
  blocks after its `Create` event, in the exact same tx as its first real
  `Swap`. (An earlier version of this code assumed liquidity was seeded
  atomically at launch and looked for `ModifyLiquidity` only in
  `[launchBlock, launchBlock+2]` — that was wrong and silently resolved
  zero PoolIds. Real verification against the live chain is what caught
  this.)
- Correct design (current code): every `processBlockRange` call fetches
  `ModifyLiquidity` logs for the *same* block range being scanned for
  trades (not a fixed window near launch), and resolves/persists any
  still-unknown token's PoolId the moment a matching currency pair shows
  up. An untraded token simply stays unresolved — correct, since it has no
  trades to find yet. This also means restart-recovery is safe: a missed
  gap is replayed through the same `onBlockRange` pipeline in one shot, so
  a token's first-ever trade (and thus its PoolId) is caught in whichever
  call's range actually contains it, regardless of how long ago it
  launched.

### 4. `eth_getLogs` response size can exceed viem's cap even within the RPC's block-range cap
QuickNode's Build-plan range cap (10,000 blocks) is independent from
viem's client-side response-size cap (10MB default). A busy 10,000-block
window on the shared Doppler hook contract returned 10.5MB and threw
`ResponseBodyTooLargeError`. Fix: `getLogsWithSizeBackoff` in
`tradeDetector.ts` catches this specific error and bisects the range,
retrying each half recursively, rather than shrinking the default chunk
size (which would waste requests during the much more common quiet
periods). If this error class ever needs handling elsewhere (e.g. if
`newTokenDetector.ts` starts hitting it), reuse this pattern rather than
guessing a smaller universal chunk size.

### 5. Chunk size bumped for the paid RPC plan
`chunkBlockRange` (shared by both detectors, defined in
`newTokenDetector.ts`) default is now **10,000** blocks per `eth_getLogs`
call (was 5, for the old free-tier plan). Chunking itself is still always
applied — never a single unbounded range — both for the RPC's hard cap and
because of point 4 above.

---

## Confirmed contract addresses (chainId 4663) and their source

| Address | What | Source of truth |
|---|---|---|
| `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` | Doppler Airlock | `.env` `DOPPLER_AIRLOCK_ADDRESS`; confirmed live via real `Create` events |
| `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | Pons V1 Launch Factory | `.env` `PONS_V1_FACTORY_ADDRESS`; also literally documented in a comment at the top of `PonsLaunchFactory.sol` in `github.com/ponsdotdev/ponsfamily` |
| `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` | Doppler pool-initializer/hook (shared singleton, so far) | Read per-token from the real `Create` event's `initializer` field — **not hardcoded anywhere in the code**, this is just what's been observed on every real launch to date |
| Per-token `pool` address | Pons V1's dedicated Uniswap V3 pool per launch | Real `TokenLaunched` event's `pool` field |
| `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Common Pons V1 pair token (looks like WETH) | Observed as `pairToken` on many real Pons launches (e.g. BUNEE) — not independently confirmed as canonical WETH, just the token every sampled Pons pool paired against |

Reference repos cloned and inspected directly during verification (not
guessed from memory):
- `github.com/whetstoneresearch/doppler` (Doppler protocol source)
- `github.com/ponsdotdev/ponsfamily` → `contractsV1/` (Pons V1 source)
- `github.com/Uniswap/v4-core` (for `PoolKey`/`SwapParams` struct layouts,
  needed to hash `PoolId` correctly)

Block explorer note: `robinhoodchain.blockscout.com` is the official
explorer but sits behind a Cloudflare challenge that blocks both `curl`
and the `WebFetch` tool — verification here was done entirely via direct
RPC calls (`eth_getLogs`/`eth_getCode`/`eth_getTransactionReceipt`) plus
independently-computed event selectors, cross-checked against real
transaction data (e.g. `tx.value` matching a decoded native-ETH trade
amount exactly).

---

## Known limitations / follow-ups

- **`usd_value` is always `null` for now** — no pricing pass exists yet.
  This was explicit in the Phase 3 spec ("save raw quote amount, don't
  block on USD conversion").
- **`quote_amount`/`token_amount` are raw on-chain base-unit integers**
  (e.g. wei), not decimal-adjusted by each token's `decimals()`. Any
  future consumer computing human-readable amounts needs to fetch
  decimals itself.
- **Pons V1 launch activity on this chain stopped a long time ago**
  (real launches only found between blocks ~9,019,252 and ~34,777,220;
  chain head is past 54,900,000 as of 2026-09-05) — but old Pons pools
  are still genuinely traded (confirmed real recent swaps on several
  sampled pools). The detector only watches pools for tokens it has
  itself discovered via Phase 2's own block-range scanning, so Pons
  trades will only start showing up once/if Phase 2 processes a block
  range containing one of the ~246k historical `TokenLaunched` events —
  it will not retroactively discover old launches on its own. If a
  backfill of historical Pons launches is ever wanted, that's a
  deliberate one-time scan someone has to trigger (see Phase 2 for the
  pattern — `newTokenDetector.processBlockRange` can be called with any
  historical range).
- **Doppler's PoolId-resolution ModifyLiquidity scan has no lower bound
  per token.** Every `processBlockRange` call re-fetches `ModifyLiquidity`
  for *every currently-unresolved* Doppler token's shared initializer
  address, even for chunks that predate that token's launch entirely. This
  wastes RPC calls when back-scanning old history for freshly-tracked
  tokens (observed directly during verification — a scan over an old
  49,978,000–54,030,000-ish window kept fetching irrelevant historical
  `ModifyLiquidity` volume). Not wrong, just inefficient; fine for normal
  live operation (new tokens have no "before launch" history to
  needlessly scan), but worth optimizing before doing any large historical
  backfill.
- **Trade recording is sequential, not batched**, one `getTransactionSender`
  + `getBlockTimestamp` round-trip pair per trade (matches Phase 2's
  existing per-log pattern). Verified fine for the real activity level
  seen so far (thousands of trades processed in a few minutes), but could
  become a bottleneck if per-token trade volume grows substantially.
- **`/health` was intentionally not extended** in Phase 3 (per spec) — it
  still only reports watcher/DB/token-count status, nothing trades-related
  yet.
- Real verification data (165 real Doppler tokens, 7,337+ real trades, 9
  real Pons trades on BUNEE) is sitting in whatever Postgres instance
  `DATABASE_URL` in `.env` points to (a local Docker container named
  `alpha-radar-pg` in the dev environment this was verified in) — this is
  real production-shaped data, not fixtures, left in place as evidence and
  because Phase 4 (wallet watchlist) will likely want to build on it.

## Next planned phase
Phase 4 — Wallet watchlist (not yet started as of 2026-09-05; requirements
to be provided by the project owner).
