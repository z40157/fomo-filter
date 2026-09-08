// Continuous wallet discovery: daily, runs the same early-buyer-of-a-
// performing-token analysis that scripts/mineWallets.ts + verifyWallets.ts
// did as a one-off manual pass, but automatically against live production
// data, ranking tokens by REAL price performance (token_snapshots, Phase 5)
// instead of the old trade-count proxy score (no price data existed when
// that proxy was written).
//
// New candidates are written straight into `wallet_watchlist` but always
// `enabled: false` — this NEVER auto-activates a wallet into live signal
// triggering/Telegram alerting on its own. A human reviews the daily
// Telegram summary and flips promising ones on via the admin API. This was
// an explicit product decision (2026-09-08): auto-enabling unvetted mined
// addresses risks flooding real alerts with noise from a bad mining pass.
import type { Logger } from "../logger.js";
import type { WalletWatchlistRepo } from "../db/walletWatchlist.js";
import type { WatchlistCache } from "../watchlist/watchlistCache.js";
import type { DiscoveryRepo } from "../db/discovery.js";
import type { TelegramClient } from "../alerts/telegramClient.js";
import { classifyAddressType } from "../chain/addressType.js";
import {
  aggregateCandidates,
  findEarlyBuyersByCount,
  findEarlyBuyersByTime,
  rankTokensByRealPerformance,
  type CandidateWallet,
  type PerTokenEarlyBuyers,
  type TokenForRanking,
} from "./miningLogic.js";

export interface DiscoveryConfig {
  lookbackDays: number;
  minTradesPerToken: number;
  minSnapshotsPerToken: number;
  topTokensCount: number;
  earlyBuyerTopN: number;
  earlyBuyerWindowMinutes: number;
  maxNewCandidatesPerRun: number;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  lookbackDays: 7,
  minTradesPerToken: 10,
  minSnapshotsPerToken: 5,
  topTokensCount: 15,
  earlyBuyerTopN: 20,
  earlyBuyerWindowMinutes: 30,
  maxNewCandidatesPerRun: 20,
};

/** Minimal shape of the RPC client this job needs — matches viem's PublicClient.getCode. */
export interface AddressCodeClient {
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>;
}

export interface WalletDiscoveryJobDeps {
  discoveryRepo: DiscoveryRepo;
  walletsRepo: WalletWatchlistRepo;
  watchlistCache: WatchlistCache;
  httpClient: AddressCodeClient;
  telegramClient?: TelegramClient;
  logger: Logger;
  extraExclusions?: readonly string[];
  config?: Partial<DiscoveryConfig>;
  now?: () => Date;
}

export interface WalletDiscoveryJob {
  runOnce(): Promise<DiscoveryRunResult>;
  start(intervalMs: number): void;
  stop(): void;
}

export interface DiscoveryRunResult {
  tokensConsidered: number;
  tokensRanked: number;
  candidatesFound: number;
  candidatesAdded: number;
  added: { address: string; tier: string; hitCount: number }[];
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function tierFor(hitCount: number): "A" | "B" | "C" {
  return hitCount >= 5 ? "A" : hitCount >= 3 ? "B" : "C";
}

async function classifyWithRetry(
  httpClient: AddressCodeClient,
  address: string,
  logger: Logger,
): Promise<"EOA" | "EIP7702_DELEGATED_EOA" | "CONTRACT_OR_SMART_ACCOUNT" | "UNKNOWN"> {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const code = await httpClient.getCode({ address: address as `0x${string}` });
      return classifyAddressType(code ?? "0x");
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        logger.warn({ err, address }, "eth_getCode failed for discovery candidate — skipping this run, will retry next run");
        return "UNKNOWN";
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return "UNKNOWN";
}

export function createWalletDiscoveryJob(deps: WalletDiscoveryJobDeps): WalletDiscoveryJob {
  const config: DiscoveryConfig = { ...DEFAULT_DISCOVERY_CONFIG, ...deps.config };
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<DiscoveryRunResult> {
    const since = new Date(now().getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);
    const candidateTokens = await deps.discoveryRepo.listCandidateTokens(since, config.minTradesPerToken);

    const tokensForRanking: TokenForRanking[] = [];
    for (const token of candidateTokens) {
      const snapshots = await deps.discoveryRepo.listTokenSnapshotPrices(token.tokenId);
      tokensForRanking.push({ tokenId: token.tokenId, address: token.address, symbol: token.symbol, snapshots });
    }
    const ranked = rankTokensByRealPerformance(tokensForRanking, config.minSnapshotsPerToken);
    const topTokens = ranked.slice(0, config.topTokensCount);

    const perTokenEarlyBuyers: PerTokenEarlyBuyers[] = [];
    for (const token of topTokens) {
      const tokenTrades = await deps.discoveryRepo.listTradesForToken(token.tokenId);
      const tradesForMining = tokenTrades.map((t) => ({ wallet: t.wallet.toLowerCase(), side: t.side, timestamp: t.timestamp }));
      perTokenEarlyBuyers.push({
        tokenAddress: token.address,
        symbol: token.symbol,
        byCount: findEarlyBuyersByCount(tradesForMining, config.earlyBuyerTopN),
        byTime: findEarlyBuyersByTime(tradesForMining, config.earlyBuyerWindowMinutes),
      });
    }

    let candidates = aggregateCandidates(perTokenEarlyBuyers);
    const candidatesFound = candidates.length;

    const infra = await deps.discoveryRepo.listInfrastructureAddresses();
    for (const extra of deps.extraExclusions ?? []) infra.add(extra.toLowerCase());
    candidates = candidates.filter((c) => !infra.has(c.address));

    const existing = await deps.walletsRepo.list();
    const existingAddresses = new Set(existing.map((w) => w.address.toLowerCase()));
    candidates = candidates.filter((c) => !existingAddresses.has(c.address));

    candidates.sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      if (b.hitCountTopN !== a.hitCountTopN) return b.hitCountTopN - a.hitCountTopN;
      const rankA = a.avgEntryRank ?? Number.POSITIVE_INFINITY;
      const rankB = b.avgEntryRank ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      return a.address.localeCompare(b.address);
    });
    const shortlist = candidates.slice(0, config.maxNewCandidatesPerRun);

    const added: DiscoveryRunResult["added"] = [];
    const minedAt = now().toISOString();
    for (const candidate of shortlist) {
      const addressType = await classifyWithRetry(deps.httpClient, candidate.address, deps.logger);
      if (addressType === "CONTRACT_OR_SMART_ACCOUNT" || addressType === "UNKNOWN") continue;

      const tier = tierFor(candidate.hitCount);
      const hitsDescription = describeHits(candidate);
      const created = await deps.walletsRepo.create({
        address: candidate.address,
        name: `AutoDiscovered_${shortAddr(candidate.address)}`,
        type: "SMART_MONEY",
        tier,
        ownerGroup: candidate.address,
        enabled: false,
        notes:
          `[AUTO-DISCOVERED ${minedAt} — PENDING REVIEW] Early buyer (addressType=${addressType}) in ` +
          `${candidate.hitCount} real-performing token(s): ${hitsDescription}. ` +
          `avgEntryRank=${candidate.avgEntryRank?.toFixed(1) ?? "n/a"}, avgEntryMinutes=${candidate.avgEntryMinutes?.toFixed(1) ?? "n/a"}. ` +
          `Found by the daily wallet discovery job (src/discovery/walletDiscoveryJob.ts) — ranked from ` +
          `real token_snapshots price data, not a trade-count proxy.`,
      });
      if (created) added.push({ address: candidate.address, tier, hitCount: candidate.hitCount });
    }

    if (added.length > 0) {
      await deps.watchlistCache.refresh();
      await sendSummary(deps.telegramClient, added, topTokens.length, deps.logger);
    }

    deps.logger.info(
      {
        tokensConsidered: candidateTokens.length,
        tokensRanked: topTokens.length,
        candidatesFound,
        candidatesAdded: added.length,
      },
      "wallet discovery run complete",
    );

    return { tokensConsidered: candidateTokens.length, tokensRanked: topTokens.length, candidatesFound, candidatesAdded: added.length, added };
  }

  return {
    runOnce,
    start(intervalMs) {
      if (timer) return;
      // Unlike the other background jobs (usdEnrichment, outcomeTracker),
      // this one also fires once immediately: it's a daily batch, not a
      // continuous sweep, so waiting a full intervalMs for the first run
      // would mean the first candidates surface a day after deploy.
      runOnce().catch((err: unknown) => {
        deps.logger.error({ err }, "wallet discovery run failed");
      });
      timer = setInterval(() => {
        runOnce().catch((err: unknown) => {
          deps.logger.error({ err }, "wallet discovery run failed");
        });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function describeHits(candidate: CandidateWallet): string {
  return candidate.hits
    .map((h) => {
      const parts: string[] = [];
      if (h.rankAmongFirstN !== undefined) parts.push(`topN rank #${h.rankAmongFirstN}`);
      if (h.minutesAfterFirstTrade !== undefined) parts.push(`+${h.minutesAfterFirstTrade.toFixed(1)}min`);
      return `${h.symbol ?? shortAddr(h.tokenAddress)}(${parts.join(", ")})`;
    })
    .join("; ");
}

async function sendSummary(
  telegramClient: TelegramClient | undefined,
  added: DiscoveryRunResult["added"],
  tokensRanked: number,
  logger: Logger,
): Promise<void> {
  if (!telegramClient) return;
  const top = added.slice(0, 10);
  const lines = top.map((a) => `• <code>${a.address}</code> tier ${a.tier}, ${a.hitCount} hit(s)`);
  const more = added.length > top.length ? `\n...and ${added.length - top.length} more` : "";
  const text =
    `🔍 <b>Wallet discovery</b> (daily, auto)\n` +
    `Scanned top ${tokensRanked} real-performing token(s), found ${added.length} new candidate(s) — ` +
    `added <b>disabled</b>, pending your review.\n\n${lines.join("\n")}${more}`;
  const result = await telegramClient.sendMessage(text);
  if (!result.ok) {
    logger.warn({ error: result.error }, "wallet discovery summary Telegram send failed");
  }
}
