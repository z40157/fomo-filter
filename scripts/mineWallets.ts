// One-off analysis tool: mine candidate KOL/smart-money wallets from our
// own on-chain data. Robinhood Chain is new enough that no existing
// smart-money leaderboard (GMGN etc.) covers it, so candidates have to be
// derived from what we've already recorded ourselves (Phase 2/3's real
// tokens + trades), not looked up.
//
// This is NOT part of the V1 phase pipeline — it never touches the live
// `wallet_watchlist` table. It only reads tokens/trades and writes
// data/mined_wallets.json for a human to review (and optionally promote via
// `npm run wallets:import` after copying/trimming it into data/wallets.json).
//
// Run: npm run wallets:mine

import { writeFileSync } from "node:fs";
import pg from "pg";
import { loadEnv } from "../src/config/index.js";
import { createHttpClient } from "../src/chain/client.js";
import {
  aggregateCandidates,
  findEarlyBuyersByCount,
  findEarlyBuyersByTime,
  scoreTokens,
  type PerTokenEarlyBuyers,
  type TokenTradeStats,
  type TradeForMining,
} from "./lib/mining.js";

// ---- tunables ----
const MIN_TRADES_FOR_SCORING = 10; // ignore near-dead tokens — too few trades to say anything about "performance"
const TOP_TOKENS_COUNT = 25; // how many top-scoring tokens to mine early buyers from
const EARLY_BUYER_TOP_N = 20; // "first N trades" criterion
const EARLY_BUYER_WINDOW_MINUTES = 30; // "first X minutes" criterion
const OUTPUT_CANDIDATES = 50;
const CONTRACT_CHECK_CONCURRENCY = 6; // conservative — QuickNode 429'd a handful of eth_getCode calls at concurrency 10

interface TokenStatsRow {
  token_id: number;
  address: string;
  symbol: string | null;
  launch_source: string;
  total_trades: string;
  unique_buyers: string;
  buys: string;
  sells: string;
  first_trade_at: Date;
  last_trade_at: Date;
  buy_quote_sum: string;
  sell_quote_sum: string;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function main(): Promise<void> {
  const env = loadEnv();
  // Raw pg for these ad-hoc aggregate queries — this is a one-off analysis
  // script, not core app code, so it isn't worth routing through Drizzle's
  // schema-typed query builder for SQL this shape-specific.
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const httpClient = createHttpClient(env.RH_RPC_HTTP);

  console.log("=== Phase A: scoring tokens from existing trade data ===");
  console.log(
    "NOTE: no price data exists yet (Phase 5). 'Score' is a PROXY built only\n" +
      "from trade count / unique buyers / buy-sell ratio / activity duration /\n" +
      "net quote-currency inflow (rank-normalized, since different tokens use\n" +
      "different quote currencies we can't convert to a common unit without\n" +
      "pricing). This is NOT a real gain/market-cap ranking.\n",
  );

  const statsRes = await pool.query<TokenStatsRow>(
    `select
       t.id as token_id, t.address, t.symbol, t.launch_source,
       count(*)::text as total_trades,
       count(distinct case when tr.side = 'BUY' then tr.wallet end)::text as unique_buyers,
       count(*) filter (where tr.side = 'BUY')::text as buys,
       count(*) filter (where tr.side = 'SELL')::text as sells,
       min(tr.timestamp) as first_trade_at,
       max(tr.timestamp) as last_trade_at,
       coalesce(sum(case when tr.side = 'BUY' then tr.quote_amount::numeric else 0 end), 0)::text as buy_quote_sum,
       coalesce(sum(case when tr.side = 'SELL' then tr.quote_amount::numeric else 0 end), 0)::text as sell_quote_sum
     from trades tr
     join tokens t on t.id = tr.token_id
     group by t.id, t.address, t.symbol, t.launch_source
     having count(*) >= $1`,
    [MIN_TRADES_FOR_SCORING],
  );

  const tokenStats: TokenTradeStats[] = statsRes.rows.map((row) => ({
    tokenId: row.token_id,
    address: row.address,
    symbol: row.symbol,
    totalTrades: Number(row.total_trades),
    uniqueBuyers: Number(row.unique_buyers),
    buys: Number(row.buys),
    sells: Number(row.sells),
    firstTradeAt: new Date(row.first_trade_at),
    lastTradeAt: new Date(row.last_trade_at),
    netInflowRaw: Number(BigInt(row.buy_quote_sum) - BigInt(row.sell_quote_sum)),
  }));

  console.log(`${tokenStats.length} tokens have >= ${MIN_TRADES_FOR_SCORING} trades and are eligible for scoring.`);

  const scored = scoreTokens(tokenStats).sort((a, b) => b.score - a.score);
  const topTokens = scored.slice(0, TOP_TOKENS_COUNT);

  console.log(`\nTop ${topTokens.length} tokens by proxy performance score:`);
  console.table(
    topTokens.map((t, i) => ({
      rank: i + 1,
      symbol: t.symbol ?? "(no symbol)",
      address: shortAddr(t.address),
      score: t.score.toFixed(3),
      totalTrades: t.totalTrades,
      uniqueBuyers: t.uniqueBuyers,
      buyRatio: t.buyRatio.toFixed(2),
      durationHrs: (t.durationSeconds / 3600).toFixed(1),
    })),
  );

  console.log(`\n=== Phase B: finding early buyers in top ${topTokens.length} tokens ===`);
  console.log(
    `Criteria (both computed, labeled separately): first ${EARLY_BUYER_TOP_N} trades ("topN"), ` +
      `and first ${EARLY_BUYER_WINDOW_MINUTES} minutes after the token's first trade ("timeWindow").\n`,
  );

  const perTokenEarlyBuyers: PerTokenEarlyBuyers[] = [];
  for (const token of topTokens) {
    const tradesRes = await pool.query<{ wallet: string; side: "BUY" | "SELL"; timestamp: Date }>(
      `select wallet, side, timestamp from trades where token_id = $1 order by block_number asc, log_index asc`,
      [token.tokenId],
    );
    const tradesForMining: TradeForMining[] = tradesRes.rows.map((r) => ({
      wallet: r.wallet.toLowerCase(),
      side: r.side,
      timestamp: new Date(r.timestamp),
    }));

    perTokenEarlyBuyers.push({
      tokenAddress: token.address,
      symbol: token.symbol,
      byCount: findEarlyBuyersByCount(tradesForMining, EARLY_BUYER_TOP_N),
      byTime: findEarlyBuyersByTime(tradesForMining, EARLY_BUYER_WINDOW_MINUTES),
    });
  }

  let candidates = aggregateCandidates(perTokenEarlyBuyers);
  console.log(`${candidates.length} distinct wallets appeared as an early buyer in at least one top token.`);

  console.log("\n=== Phase C: excluding infrastructure addresses ===");
  const exclusionSet = new Set<string>();
  exclusionSet.add(env.DOPPLER_AIRLOCK_ADDRESS.toLowerCase());
  exclusionSet.add(env.PONS_V1_FACTORY_ADDRESS.toLowerCase());

  const infraRes = await pool.query<{ addr: string | null }>(
    `select lower(deployer) as addr from tokens
     union select lower(initializer) as addr from tokens where initializer is not null
     union select lower(pool) as addr from tokens`,
  );
  for (const row of infraRes.rows) {
    if (row.addr) exclusionSet.add(row.addr);
  }
  console.log(`Excluding ${exclusionSet.size} known deployer/protocol/pool addresses (from tokens table + env).`);

  const beforeInfraFilter = candidates.length;
  candidates = candidates.filter((c) => !exclusionSet.has(c.address));
  console.log(`Removed ${beforeInfraFilter - candidates.length} candidates matching known infrastructure addresses.`);

  console.log(`Checking remaining ${candidates.length} candidates for contract bytecode (eth_getCode)...`);
  const codeChecks = await mapWithConcurrency(candidates, CONTRACT_CHECK_CONCURRENCY, async (c) => {
    const MAX_ATTEMPTS = 4;
    let backoffMs = 500;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const code = await httpClient.getCode({ address: c.address as `0x${string}` });
        return { address: c.address, isContract: !!code && code !== "0x", checked: true };
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          // Fail safe: if we genuinely can't tell, exclude rather than risk
          // a contract slipping into the "smart money" candidate list.
          console.warn(
            `  eth_getCode failed for ${c.address} after ${MAX_ATTEMPTS} attempts — excluding it to be safe: ${String(err)}`,
          );
          return { address: c.address, isContract: true, checked: false };
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs *= 2;
      }
    }
    // unreachable, but keeps TypeScript happy about the loop always returning
    return { address: c.address, isContract: true, checked: false };
  });
  const contractAddresses = new Set(codeChecks.filter((r) => r.isContract).map((r) => r.address));
  const uncheckedCount = codeChecks.filter((r) => !r.checked).length;
  const beforeContractFilter = candidates.length;
  candidates = candidates.filter((c) => !contractAddresses.has(c.address));
  console.log(
    `Removed ${beforeContractFilter - candidates.length} addresses (contracts, plus ${uncheckedCount} that ` +
      `couldn't be checked and were excluded defensively).`,
  );

  candidates.sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    if (b.hitCountTopN !== a.hitCountTopN) return b.hitCountTopN - a.hitCountTopN;
    const rankA = a.avgEntryRank ?? Number.POSITIVE_INFINITY;
    const rankB = b.avgEntryRank ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return a.address.localeCompare(b.address);
  });
  const topCandidates = candidates.slice(0, OUTPUT_CANDIDATES);

  console.log(`\n=== Phase D: enriching top ${topCandidates.length} candidates with global trade stats ===`);
  const addresses = topCandidates.map((c) => c.address);
  const globalStatsRes =
    addresses.length > 0
      ? await pool.query<{ wallet: string; side: "BUY" | "SELL"; cnt: string }>(
          `select wallet, side, count(*)::text as cnt from trades where wallet = ANY($1) group by wallet, side`,
          [addresses],
        )
      : { rows: [] as { wallet: string; side: "BUY" | "SELL"; cnt: string }[] };

  const globalBuys = new Map<string, number>();
  const globalSells = new Map<string, number>();
  for (const row of globalStatsRes.rows) {
    const target = row.side === "BUY" ? globalBuys : globalSells;
    target.set(row.wallet.toLowerCase(), Number(row.cnt));
  }

  const reentryRes =
    addresses.length > 0
      ? await pool.query<{ wallet: string; buy_count: string }>(
          `select wallet, count(*)::text as buy_count from trades
           where wallet = ANY($1) and side = 'BUY'
           group by wallet, token_id`,
          [addresses],
        )
      : { rows: [] as { wallet: string; buy_count: string }[] };
  const reentryWallets = new Set(
    reentryRes.rows.filter((r) => Number(r.buy_count) >= 2).map((r) => r.wallet.toLowerCase()),
  );

  console.log(`\nTop ${topCandidates.length} candidate wallets (by repeat-hit count):`);
  console.table(
    topCandidates.map((c, i) => ({
      rank: i + 1,
      address: shortAddr(c.address),
      hitCount: c.hitCount,
      hitCountTopN: c.hitCountTopN,
      hitCountTimeWindow: c.hitCountTimeWindow,
      avgEntryRank: c.avgEntryRank !== null ? c.avgEntryRank.toFixed(1) : "-",
      avgEntryMin: c.avgEntryMinutes !== null ? c.avgEntryMinutes.toFixed(1) : "-",
      totalBuys: globalBuys.get(c.address) ?? 0,
      totalSells: globalSells.get(c.address) ?? 0,
      reentry: reentryWallets.has(c.address) ? "yes" : "no",
    })),
  );

  const minedAt = new Date().toISOString();
  const output = topCandidates.map((c, i) => {
    const hitsDescription = c.hits
      .map((h) => {
        const parts: string[] = [];
        if (h.rankAmongFirstN !== undefined) parts.push(`topN rank #${h.rankAmongFirstN}`);
        if (h.minutesAfterFirstTrade !== undefined) parts.push(`+${h.minutesAfterFirstTrade.toFixed(1)}min`);
        return `${h.symbol ?? shortAddr(h.tokenAddress)}(${parts.join(", ")})`;
      })
      .join("; ");

    const tier = c.hitCount >= 5 ? "A" : c.hitCount >= 3 ? "B" : "C";

    return {
      address: c.address,
      name: `Candidate_${i + 1}_${shortAddr(c.address)}`,
      type: "SMART_MONEY",
      tier,
      // Unknown real-world grouping — one group per address until a human
      // confirms which candidates are actually the same person.
      ownerGroup: c.address,
      // NOT auto-activated: this is an unvetted mining result, not a
      // reviewed watchlist entry. A human must flip this on (or promote
      // via the admin API/wallets.json) after review.
      enabled: false,
      notes:
        `[MINED CANDIDATE — PENDING REVIEW, not yet Mobula-verified] ` +
        `Hit ${c.hitCount} performing token(s): ${hitsDescription}. ` +
        `avgEntryRank=${c.avgEntryRank?.toFixed(1) ?? "n/a"}, avgEntryMinutes=${c.avgEntryMinutes?.toFixed(1) ?? "n/a"}, ` +
        `totalBuys=${globalBuys.get(c.address) ?? 0}, totalSells=${globalSells.get(c.address) ?? 0}, ` +
        `reentry=${reentryWallets.has(c.address) ? "yes" : "no"}. ` +
        `Mined ${minedAt} via scripts/mineWallets.ts using a proxy performance score (trade count/participation/timing shape) — NOT real price/gain data.`,
      _analysis: {
        hitCount: c.hitCount,
        hitCountTopN: c.hitCountTopN,
        hitCountTimeWindow: c.hitCountTimeWindow,
        avgEntryRank: c.avgEntryRank,
        avgEntryMinutes: c.avgEntryMinutes,
        totalBuys: globalBuys.get(c.address) ?? 0,
        totalSells: globalSells.get(c.address) ?? 0,
        hasReentry: reentryWallets.has(c.address),
        hits: c.hits,
        minedAt,
      },
    };
  });

  writeFileSync("data/mined_wallets.json", JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.length} candidates to data/mined_wallets.json`);
  console.log("Next: review, then optionally `npm run wallets:verify` to enrich with Mobula PnL/win-rate data.");

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
