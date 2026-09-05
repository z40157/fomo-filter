# Robinhood Alpha Radar V1 — Progress

Read-only on-chain monitoring system for Robinhood Chain (chainId **4663**, an
Arbitrum Orbit L2 settling on Ethereum). Purpose: detect new token launches
and their BUY/SELL trading activity as a data source for a future
FOMO-detection/alerting system. This file exists so a new session (or a
human) can get oriented without re-deriving everything from the code.

## Status: Phase 6 complete (2026-09-05)

- ✅ Phase 0 — Skeleton
- ✅ Phase 1 — Chain watcher (WS + reconnect + restart recovery)
- ✅ Phase 2 — New-token discovery (Doppler + Pons V1)
- ✅ Phase 3 — BUY/SELL trade detection (Doppler + Pons V1)
- ✅ Phase 4 — Wallet watchlist (manually curated, admin API + import + trade-time matching)
- ✅ Wallet-mining tool (one-off, not a phase) — `scripts/mineWallets.ts` /
  `scripts/verifyWallets.ts`, see its own section below
- ✅ Phase 5 — DexScreener integration + real-time candidate tracking
- ✅ Phase 6 — KOL resonance detection (trigger + persist only — no scoring or alerting yet)
- ⬜ Phase 7 — Scoring (not started; explicitly deferred by the project owner)
- ⬜ Phase 8 — Alerting (not started)
- ⬜ Everything else — `alerts`, `signalOutcomes`, `narrativeFlags` tables
  are still placeholder-only (just `id`/`createdAt`).

Tests: 129/129 passing (`npm test`). Typecheck clean (`npm run typecheck` and
`npm run typecheck:test`). `npm run build` clean.

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

### Phase 4 — Wallet watchlist (`src/db/walletWatchlist.ts`, `src/watchlist/`, `src/wallets/`, `src/api/routes/wallets.ts`)
V1 is entirely manually curated — no auto-classification of who's a KOL.
This phase only stores, dedups, and compares against a human-maintained
list at trade-recording time.

- `wallet_watchlist` table: `address` (PK, always lowercased before
  writing — an `0xABC…`/`0xabc…` case difference must never create a
  second row), `name`, `type` (`KOL`/`FOMO_TRADER`/`SMART_MONEY` enum),
  `tier` (`A`/`B`/`C` enum), `owner_group` (free-text — groups multiple
  addresses controlled by the same real person, see decision #6 below),
  `enabled` (default `true`, so an address can be paused without
  deleting its history), `notes`, `created_at`/`updated_at`.
- Admin API (`src/api/routes/wallets.ts`): `GET/POST/PATCH/DELETE
  /api/wallets`. Write routes are guarded by `src/api/adminAuth.ts`
  (constant-time compare of the `x-admin-key` header against
  `ADMIN_API_KEY`; an unset `ADMIN_API_KEY` locks writes down rather than
  leaving them open). `GET` is intentionally unauthenticated — watchlist
  membership isn't sensitive for this internal read-only tool, and
  something needs to list it for a future dashboard. Request bodies are
  validated with zod (`src/wallets/validation.ts`, shared with the import
  script below); invalid input is a 400 with a field-level message,
  duplicate addresses on `POST` are a 409.
- Bulk import: `data/wallets.json` (gitignored — real curated addresses
  are operational data, not something to commit, same reasoning as
  `.env`) plus a tracked `data/wallets.example.json` template. `npm run
  wallets:import` (`src/scripts/importWallets.ts`) reads the file and
  upserts every entry by lowercased address via the same core logic
  (`src/wallets/importWallets.ts`) that's unit-tested against a fake
  repo — invalid rows are skipped and reported, not fatal to the batch.
- Trade-time matching: `src/watchlist/watchlistCache.ts` keeps an
  in-memory `Map<address, WalletEntry>` of currently-enabled wallets so
  every recorded trade can be checked with zero extra DB round-trips.
  `tradeDetector.ts`'s `recordTrade` looks up the trade's wallet after a
  successful (non-duplicate) insert and logs a `"watchlist wallet trade"`
  info line with `name`/`tier`/`ownerGroup`/`token`/`side`/amounts on a
  hit. The cache is refreshed immediately after every API write, and
  also on a 60s timer in `index.ts` — the timer exists specifically to
  pick up `wallets:import` runs (a separate process the live server has
  no other way to hear about).
- `countDistinctOwnerGroups` (`watchlistCache.ts`) was written and tested
  in Phase 4 with no consumer yet; Phase 5's `candidateAggregates.ts` is
  its first real user (`independentOwnerCount`). Phase 6's resonance/co-buy
  detection will lean on it more directly.
- `GET /health` gains `watchedWallets` (`watchlistCache.size()` — no DB
  query).

### Wallet-mining tool (`scripts/mineWallets.ts`, `scripts/verifyWallets.ts`) — one-off, not a phase
Robinhood Chain is too new for any existing smart-money leaderboard (GMGN
etc.) to cover it, so candidate KOL/smart-money addresses have to be mined
from our own data instead of looked up. This is a standalone analysis tool,
not part of the phase pipeline — it never writes to the live
`wallet_watchlist` table.

- `npm run wallets:mine`: scores tokens from existing trade data (trade
  count, unique buyers, buy ratio, activity duration, net quote-currency
  inflow) via rank-normalization across the token set (`scripts/lib/
  mining.ts`, unit-tested) — explicitly a proxy for "looks active," not a
  real gain/market-cap ranking, since no pricing existed yet when this was
  built. Mines early-buyer wallets from the top-scoring tokens (both a
  "first N trades" and a "first X minutes" criterion, tracked separately),
  excludes known deployer/protocol/pool/contract addresses (`eth_getCode`,
  with retry — a burst of concurrent calls got 429'd at first, fixed by
  lowering concurrency and retrying with backoff, excluding on persistent
  failure rather than assuming EOA), and writes `data/mined_wallets.json` —
  same shape `wallets:import` expects, but every entry starts
  `enabled: false` pending human review.
- `npm run wallets:verify`: enriches those candidates with real Mobula
  "Wallet Trading Analysis" data for chainId `evm:4663` (`scripts/lib/
  mobula.ts`) — chain id and the `Authorization: <key>` header format were
  confirmed against Mobula's own docs/live API, not assumed. Falls back to
  Mobula's public demo API (no key needed) when `MOBULA_API_KEY` isn't set.
  Rate-limited to Mobula's documented 5/min, with retry/backoff and a
  `data/mobula_cache.json` cache so repeat runs don't re-spend quota.
  Missing data is marked `"unknown"`, never 0.
- Real run: 50 candidates mined, all 50 Mobula-verified successfully.
  **Anomaly worth knowing about**: Mobula's demo API's `period` parameter
  (7d/30d/90d) returned byte-identical results in testing — it did not
  appear to actually filter by time window. Also, `periodActiveTokensCount`
  for the top candidate came back as 692, far exceeding our own tracked
  universe of 165 tokens, suggesting either broader chain-wide coverage by
  Mobula (plausible — plenty of activity happens outside Doppler/Pons) or
  demo-tier data that isn't fully reliable. Get a real `MOBULA_API_KEY`
  and re-verify before trusting these PnL numbers for anything real.
- `data/mined_wallets.json` and `data/mobula_cache.json` are gitignored —
  same treatment as `data/wallets.json`: real derived data, not source.

### Phase 5 — DexScreener integration + real-time candidate tracking (`src/market/`)
The only external market-data source in V1. Goal: know every tracked
token's market cap, liquidity, and volume, and start closing the loop on
Phase 3's `trades.usd_value` (left null since there was no price source).

- `src/market/dexscreener.ts`: chain id `"robinhood"` — confirmed live
  (DexScreener's own docs never show Robinhood Chain's identifier) by
  querying `/latest/dex/search` with a real BUNEE address and getting back
  `"chainId":"robinhood"` with a pair address matching what Phase 3 already
  found independently on-chain. Uses `GET /tokens/v1/{chainId}/
  {tokenAddress}`, which docs.dexscreener.com/api/reference.md documents
  (along with every other listed endpoint) at a flat 60 requests/minute,
  no API key needed. The client self-limits to 50/min for headroom, caches
  both hits and misses in memory (15s TTL), retries with
  `chain/backoff.ts`'s `ExponentialBackoff` (reused, not reimplemented) on
  429/5xx/network errors, times out via `AbortController`, and tracks a
  rolling ok/degraded/down status from real call outcomes (a "not found"
  response doesn't count as a failure — it's a valid answer). A token with
  no indexed pair yet returns `null`, never a fabricated `0`.
- `src/market/candidateTrackerLogic.ts`: pure, timer-free scheduling
  decisions (unit-tested directly, no mocked clock/timers needed beyond an
  injected `now`) — `isActive`, `refreshIntervalMs`, `isDueForRefresh`,
  `shouldExitTracking`. Defaults: every Phase 2 token tracked at least 24h
  regardless of activity; active (traded within 15min) refreshes every
  20s; inactive refreshes every 5min; exits only after the 24h floor once
  it's had no trade for 4h. All four numbers are overridable via
  `CANDIDATE_ACTIVE_REFRESH_MS` / `CANDIDATE_INACTIVE_REFRESH_MS` /
  `CANDIDATE_MIN_TRACKING_HOURS` / `CANDIDATE_EXIT_INACTIVITY_HOURS`.
- `src/market/candidateTracker.ts`: wires the above to real DexScreener
  calls, `token_snapshots` writes, and per-candidate in-memory aggregate
  state (`src/market/candidateAggregates.ts`): `ageMs`,
  `watchedWalletBuyCount`, `independentOwnerCount` (via Phase 4's
  `countDistinctOwnerGroups`, scoped to BUY-side watchlist wallets),
  `aggregateWatchedBuyUsd`/`SellUsd` (sums `trades.usd_value` — see the
  enrichment caveat below), and `repeatBuyerCount` (wallets with 2+ buys
  on the token — deliberately **not** scoped to the watchlist; it's a
  general momentum signal, same "reentry" concept `mineWallets.ts` already
  used).
- `src/market/usdEnrichment.ts`: see "USD enrichment design" below.
- `token_snapshots` schema completed: `token_id → tokens`, `price`
  (numeric(38,18) — meme-coin prices go well below $0.0001), `market_cap`,
  `liquidity`, `volume_5m`, `volume_1h`, `buys_5m`, `sells_5m`,
  `snapshot_at`, with a `(token_id, snapshot_at)` index for time-series
  reads. See "token_snapshots growth" below for volume/cleanup notes.
- `GET /health` gains `activeCandidates` (`candidateTracker
  .getActiveCandidateCount()`) and `dexscreenerStatus`
  (`dexscreener.getStatus()`).
- Real verification: pulled live data for SEXCOIN ($24,602 mcap, $24,787.76
  liquidity), MOLLIE ($25,731 mcap, $25,658.25 liquidity), and BUNEE
  ($21,052 mcap, $13,464.02 liquidity) — all real, sane numbers. A live 90s
  `CandidateTracker` run discovered all 165 real tracked tokens immediately
  on start, held steady at 165 the whole run, kept `dexscreenerStatus:
  "ok"` throughout, and wrote 51 real snapshot rows across 25+ distinct
  tokens with sane price/liquidity values.

### Phase 6 — KOL resonance detection (`src/signals/`)
The system's first move from *recording* data to *flagging* it. This
phase is detection-and-persistence only — no scoring (Phase 7) and no
alerting (Phase 8). Every log line and code comment is deliberately
worded as a detection trigger for review, never a buy recommendation.

- **Detection is event-driven, not polled.** `resonanceDetector.ts`'s
  `onWatchlistBuy()` is called directly from `chain/tradeDetector.ts`'s
  `recordTrade()` on every watchlist wallet's BUY (right next to the
  existing "watchlist wallet trade" hit log) — never a periodic full-table
  scan, so a signal can't be missed by a scan interval landing outside the
  window.
- **Three independent trigger conditions** (`resonanceLogic.ts`'s
  `evaluateConditions`), all counted by distinct `ownerGroup` — reusing
  Phase 4's `countDistinctOwnerGroups`, never raw address count, for the
  same reason Phase 4 introduced `ownerGroup` in the first place (one
  person's 5 wallets must not look like 5 independent signals):
  - **A**: >= 3 distinct ownerGroups bought the token within the window.
  - **B**: >= 2 distinct **Tier-A** ownerGroups bought within the window.
  - **C**: >= 2 distinct ownerGroups bought, **and** at least one of them
    bought 2+ times within the window (checked at the ownerGroup level —
    two different addresses from the same owner both buying counts as a
    repeat).
  - A window can satisfy more than one condition at once; `signals
    .trigger_conditions` is an array, not a single value.
  - A watchlist wallet with a blank `ownerGroup` becomes its own
    independent group (not silently dropped) — logged as a `warn` so it
    can be fixed later: `"watchlist wallet has no ownerGroup set..."`.
- **Sliding window**: default 20 minutes (`RESONANCE_WINDOW_MINUTES`),
  pruned lazily on every `onWatchlistBuy` call for the token in question,
  plus a periodic sweep (`cleanupIntervalMs`, default 60s) that prunes —
  and fully removes the map entry for — every tracked token, so a token
  that stops getting watchlist buys doesn't leak its stale window forever.
- **Cooldown + escalation** (`decideTrigger`): once a signal fires for a
  token, no new signal for that token for `RESONANCE_COOLDOWN_MINUTES`
  (default 10) — *unless* the window gets strictly stronger than it was at
  the last signal: distinct ownerGroups up by 2+, or a Tier-A ownerGroup
  appearing for the first time. Either one breaks through the cooldown and
  fires immediately, marked `escalation: true`; the cooldown timer then
  restarts from that escalation. A subtlety confirmed by the real replay
  below: since every buy is checked immediately (not batched), an
  escalation fires the instant the threshold is first crossed — e.g. going
  from baseline 3 to 5 ownerGroups escalates the moment the 5th one buys,
  not "whenever you next check."
- `signals`/`signal_wallets` schema completed. `signals` carries
  `trigger_conditions` (enum array), `distinct_owner_groups`,
  `tier_a_count`, `has_repeat_accumulation`, the `window_minutes` actually
  used (so an old signal can always be re-interpreted correctly even after
  the config changes), `escalation`, and a market snapshot
  (`market_cap`/`liquidity`/`volume_5m`) pulled from a new
  `candidateTracker.getLatestMarketSnapshot()` — null if none was
  available yet, never guessed. `signal_wallets` has one row per
  participating wallet: name/tier/ownerGroup plus that wallet's
  window-scoped `buy_count`/`buy_amount` (raw quote-currency units, same
  convention as `trades.quote_amount` — comparable across wallets within
  one signal, not across signals with different quote currencies).
- `GET /health` gains `signalsToday` and `lastSignalAt`.
- **Real verification — MOLLIE historical replay**: since the watchlist
  only had Phase 4's 3 test wallets (unlikely to organically resonate),
  verified against real data instead: temporarily added 5 real early
  MOLLIE buyers (from Phase 3's actual trade data) to the watchlist with
  distinct `ownerGroup`s (2 marked Tier A), then replayed their 30 real
  historical BUY trades through the real detector in their actual
  on-chain chronological order. It fired 4 real signals:

  | # | triggered at (real) | conditions | ownerGroups | Tier-A | repeat | escalation |
  |---|---|---|---|---|---|---|
  | 1 | 07:32:49 | B | 2 | 2 | false | false |
  | 2 | 07:32:56 | A, B | 4 | 2 | false | **true** (broke a 10-min cooldown: +2 ownerGroups) |
  | 3 | 07:47:00 | A, B, C | 5 | 2 | true | false (cooldown from #2 had elapsed) |
  | 4 | 08:02:13 | A, B, C | 3 | 2 | true | false (cooldown from #3 had elapsed) |

  All 4 rows and their `signal_wallets` breakdowns are real rows in the
  dev database. The 5 temporary wallets (`ReplayTest_1..5`,
  `replay_owner_1..5`) are left in `wallet_watchlist` with
  **`enabled: false`** (not deleted) and a `notes` field stating they were
  only for this verification — **they are not a real curated list**;
  don't mistake them for genuine KOLs if you're browsing the table.

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

### 6. `ownerGroup`, not address, is the unit that will ever get counted
The watchlist's whole reason for existing beyond a simple address list is
`ownerGroup`: a real person can (and does) run several wallets, and any
future "N KOLs bought within M minutes" resonance logic (Phase 5+) must
count distinct **owners**, not distinct **addresses** — otherwise one
person self-trading across 5 wallets looks identical to 5 independent
KOLs agreeing, which would be a false signal. `ownerGroup` is a free-text
string (not its own table/FK) deliberately — V1 has no auto-clustering of
wallets into owners, a human decides via the `notes`/`ownerGroup` fields
when adding entries. `countDistinctOwnerGroups` in `watchlistCache.ts` is
the one place this grouping is actually consumed (so far, by nothing —
it's there for Phase 5).

### 7. The watchlist cache has two refresh triggers, not one, on purpose
Refreshing only on API writes (the obvious choice) misses a case that
actually happens on this project: `npm run wallets:import` runs as a
**separate process** from the live server (see `src/scripts/
importWallets.ts`), so a bulk import while the server is already running
would otherwise go unnoticed until restart. `index.ts` therefore also
refreshes the cache on a 60s timer (`.unref()`'d so it doesn't keep the
process alive), on top of the immediate refresh after every `POST`/
`PATCH`/`DELETE`. If a wallet is added via import while the server is up,
expect up to ~60s of lag before its trades start producing hit logs —
this is a known, accepted trade-off, not a bug.

### 8. USD enrichment design: never a future price for a past trade, and it needs the tracker to have run for a while first
`trades.usd_value` has been null since Phase 3 (no price source existed
yet). `src/market/usdEnrichment.ts` backfills it, but under one hard rule:
**it only ever uses a `token_snapshots` row whose `snapshot_at` is at or
before the trade's own `timestamp`**, within a bounded staleness window
(`maxSnapshotAgeMs`, default 10 minutes). Never the current/latest price,
never a snapshot from after the trade. Using a later price to value an
earlier trade wouldn't be recovering history, it'd be fabricating it —
meme-coin prices can move 10x+ within a single 10-minute window on this
chain, so the two are not close enough to treat as interchangeable.

**Consequence verified directly**: right after Phase 5 shipped, running
the enrichment job found real, already-recorded historical trades but
**enriched zero of them** — every snapshot in the table at that point had
just been written (`snapshot_at` = now), which is *after* every historical
trade, so none qualified. This is correct, not broken. `usd_value` only
starts filling in once `candidateTracker.ts` has been running continuously
long enough to have a snapshot within `maxSnapshotAgeMs` of a trade's
actual time — i.e., enrichment coverage grows gradually from whenever the
tracker was first started, not retroactively. A large gap between "Phase 3
trades exist" and "the tracker has been live" means a permanent gap in
`usd_value` coverage for that period; there's no way to backfill it after
the fact since DexScreener doesn't expose historical prices through this
endpoint. If dense historical `usd_value` coverage is ever needed for
old trades, that requires a different data source (DexScreener's OHLCV/
candle endpoints, if they cover this chain) — out of scope for V1.

Decimals for the human-unit conversion come from a live `decimals()`
call (`chain/erc20.ts`'s `resolveTokenDecimals`), cached per-process —
never assumed as 18, since that would silently corrupt `usd_value` by
whatever power-of-10 the real token's decimals differ by, with no error
to catch it.

### 9. `token_snapshots` growth rate and cleanup strategy (not implemented in V1)
Every tracked candidate gets a row on every refresh: ~20s cadence while
active (15min after its last trade), ~5min once inactive, for a minimum
of 24h per token before it can exit tracking at all.

**Rough estimate**, worst case (a token stays "active" — i.e. keeps
trading — for its whole first 24h, which real tokens on this chain
regularly do): 24h × 3,600s / 20s ≈ **~4,320 rows per active-for-a-full-day
token**. A quieter token that goes inactive quickly costs far less: e.g.
active for 1h then inactive for the remaining 23h ≈ 180 + 23×12 ≈ **~456
rows**. With Doppler/Pons launch volume observed so far (roughly
tens-to-a-few-hundred new tokens per day during a busy period — see
Phase 2/3 real-verification numbers, 165 tokens accumulated so far), a
busy day could plausibly add **tens of thousands of `token_snapshots`
rows per day**, growing roughly linearly with (new tokens/day ×
average rows/token) — i.e. this table is the fastest-growing one in the
schema by a wide margin, and will keep growing indefinitely since V1
implements no retention policy.

**Not implemented, deliberately deferred** (per the project owner's
instruction to only document the plan, not build it):
- **Downsample old data**: once a token exits tracking (or after some
  age, e.g. 7 days), collapse its snapshot history to a coarser
  resolution (e.g. one row per hour instead of per 20s) rather than
  deleting it outright — preserves the shape of a token's price history
  for later analysis at a fraction of the storage.
- **Hard retention window**: delete snapshot rows older than N days
  (e.g. 30/90) for tokens that are no longer being tracked, on a
  scheduled job — simplest option, loses fine-grained history entirely
  past the window.
- **Partition by time** (e.g. Postgres native partitioning on
  `snapshot_at`) if the table gets large enough that even indexed
  queries or the eventual cleanup job itself become slow — makes bulk
  drops of old partitions cheap regardless of which retention policy is
  chosen above.
- Whichever is chosen, the existing `(token_id, snapshot_at)` index
  already supports the query shapes a cleanup job would need (per-token
  time-range scans), so no schema rework is required to add this later.

---

## Confirmed contract addresses (chainId 4663) and their source

| Address | What | Source of truth |
|---|---|---|
| `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` | Doppler Airlock | `.env` `DOPPLER_AIRLOCK_ADDRESS`; confirmed live via real `Create` events |
| `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | Pons V1 Launch Factory | `.env` `PONS_V1_FACTORY_ADDRESS`; also literally documented in a comment at the top of `PonsLaunchFactory.sol` in `github.com/ponsdotdev/ponsfamily` |
| `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` | Doppler pool-initializer/hook (shared singleton, so far) | Read per-token from the real `Create` event's `initializer` field — **not hardcoded anywhere in the code**, this is just what's been observed on every real launch to date |
| Per-token `pool` address | Pons V1's dedicated Uniswap V3 pool per launch | Real `TokenLaunched` event's `pool` field |
| `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Common Pons V1 pair token (looks like WETH) | Observed as `pairToken` on many real Pons launches (e.g. BUNEE) — not independently confirmed as canonical WETH, just the token every sampled Pons pool paired against |
| `"robinhood"` | Robinhood Chain's identifier in DexScreener's API (`{chainId}` path segment) | Not shown anywhere in docs.dexscreener.com — found by querying `/latest/dex/search?q=<real BUNEE address>` and reading `chainId` back off the real response, which also returned the exact pair address Phase 3 already knew independently |
| `"evm:4663"` | Robinhood Chain's identifier in Mobula's API (`chainIds` param) | Not shown in Mobula's docs either — found the same way, via a real `/wallet/analysis` call, confirmed by the response's `nativeBalance.chainId` field |

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

- **`drizzle-kit generate` prompts interactively** (not a `--yes`-able flag)
  whenever a table's shape changes enough that it can't tell a dropped+added
  column apart from a rename — this happened converting `wallet_watchlist`
  from its `id`/`createdAt` placeholder to real columns (one prompt per new
  column, asking "create column" vs "rename from `id`"). Always "create
  column" was correct here. It also generated `DROP COLUMN "id"` positioned
  *after* `ADD COLUMN "address" ... PRIMARY KEY`, which fails at migrate
  time ("multiple primary keys") since the old PK on `id` is still there —
  had to hand-edit the generated SQL to move the `DROP COLUMN "id"` line
  first. Check the generated SQL by eye before running `drizzle-kit
  migrate` any time a placeholder table gets its real columns for the
  first time.

- **`usd_value` fills in gradually, not retroactively** — Phase 5's
  enrichment job only uses a snapshot at-or-before a trade's own timestamp
  (see decision #8 above), so trades from before the candidate tracker was
  first running will likely never get a `usd_value` — there's no
  historical-price endpoint being used to backfill that gap.
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
  real Pons trades on BUNEE, 3 real watchlist wallets) is sitting in
  whatever Postgres instance `DATABASE_URL` in `.env` points to (a local
  Docker container named `alpha-radar-pg` in the dev environment this was
  verified in) — this is real production-shaped data, not fixtures, left
  in place as evidence and because later phases will likely build on it.
- **The watchlist has no notion of "who added this or when, beyond
  `created_at`/`updated_at`"** — no audit log of admin API calls. Fine for
  V1's single-operator manual curation; would need revisiting if multiple
  people administer the list.
- **`data/wallets.json` is real local operational data and is
  gitignored** — same treatment as `.env`. Only `data/wallets.example.json`
  is tracked. Anyone picking up this repo fresh needs to create their own
  `data/wallets.json` (or use the admin API) before `wallets:import` has
  anything to do. Same treatment for `data/mined_wallets.json` and
  `data/mobula_cache.json` from the wallet-mining tool.
- **`token_snapshots` has no retention/cleanup implemented** — see
  decision #9 above for the growth estimate and the options considered
  (downsampling, hard retention window, time partitioning). Deliberately
  left as documentation-only for V1.
- **Mobula's demo-tier `period` parameter didn't appear to filter by time
  window** in testing (7d/30d/90d gave identical results) — see the
  wallet-mining tool section above. Don't trust demo-tier Mobula PnL
  figures without re-verifying against a real `MOBULA_API_KEY`.
- **`candidateTracker.ts` re-fetches `ModifyLiquidity`-style "is this
  candidate still active" checks and DexScreener snapshots for every
  tracked token on every tick where it's due** — at 165 tokens this is
  fine (verified: stable, `dexscreenerStatus: "ok"` throughout a live 90s
  run), but the discovery query (`tokensRepo.listAll()`) and the
  last-trade-time query both scale linearly with total tracked token
  count, checked every `tickIntervalMs` (default 5s) regardless of how
  many are actually due. Worth revisiting if the tracked-token count grows
  by an order of magnitude.

## Next planned phase
Phase 7 — Importance scoring + risk grading (in progress as of
2026-09-05). Phase 9's planned Outcome Tracker will need Phase 7's exact
scoring rules to be traceable after the fact — see Phase 7's section
above once it lands for the full rule definitions, kept versioned there
for that reason.
