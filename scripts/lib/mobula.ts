// Mobula "Get Wallet Trading Analysis" client — see docs.mobula.io.
//
// Verified live (not just from docs) on 2026-09-05 against
// https://demo-api.mobula.io/api/2/wallet/analysis?wallet=<real address>&chainIds=evm:4663:
// returned HTTP 200 with `nativeBalance.chainId: "evm:4663"` and a
// Robinhood-chain-specific asset logo URL, confirming `evm:4663` is the
// correct chain identifier for this endpoint's `chainIds` param (docs.mobula.io
// only showed generic examples like `evm:1`, never Robinhood Chain's own id).
//
// Auth: docs.mobula.io/rest-api-reference/authentification's own curl
// example uses a raw `Authorization: YOUR_API_KEY` header (no "Bearer"
// prefix). Without a key, requests fall back to the public demo API
// (https://demo-api.mobula.io) — works with no signup, but Mobula's own
// docs call it "for testing only" with "increased latency", so this is a
// deliberate fallback for exploratory use, not a substitute for a real key
// in anything meant to run repeatedly.
//
// Rate limit: Mobula's docs state "5 requests per minute per API key" for
// this endpoint. We honor that pace (one request per ~12s) regardless of
// whether a key is configured, since the demo API's own docs ask for
// restraint too ("for testing only").

const PRODUCTION_BASE_URL = "https://api.mobula.io/api/2/wallet/analysis";
const DEMO_BASE_URL = "https://demo-api.mobula.io/api/2/wallet/analysis";

export const MOBULA_MIN_INTERVAL_MS = 12_000;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 2_000;

export type MobulaStatus = "ok" | "unknown" | "error";

export interface MobulaWalletResult {
  status: MobulaStatus;
  pnl: number | "unknown";
  totalPnl: number | "unknown";
  winRate: number | "unknown";
  txCount: number | "unknown";
  labels: string[];
  note: string | undefined;
  fetchedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unknownResult(status: MobulaStatus, note: string): MobulaWalletResult {
  return {
    status,
    pnl: "unknown",
    totalPnl: "unknown",
    winRate: "unknown",
    txCount: "unknown",
    labels: [],
    note,
    fetchedAt: new Date().toISOString(),
  };
}

export interface FetchWalletAnalysisOptions {
  apiKey?: string;
  /** e.g. "evm:4663" for Robinhood Chain. */
  chainId: string;
  /** "1d" | "7d" | "30d" | "90d" per Mobula's docs. */
  period: string;
}

export async function fetchWalletAnalysis(
  address: string,
  opts: FetchWalletAnalysisOptions,
): Promise<MobulaWalletResult> {
  const baseUrl = opts.apiKey ? PRODUCTION_BASE_URL : DEMO_BASE_URL;
  const url = `${baseUrl}?wallet=${encodeURIComponent(address)}&chainIds=${encodeURIComponent(opts.chainId)}&period=${encodeURIComponent(opts.period)}`;
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["Authorization"] = opts.apiKey;

  let attempt = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  while (true) {
    attempt++;
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        return unknownResult("error", `network error after ${attempt} attempts: ${String(err)}`);
      }
      await sleep(backoffMs);
      backoffMs *= 2;
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) {
        return unknownResult("error", `HTTP ${response.status} after ${attempt} attempts`);
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : backoffMs;
      await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : backoffMs);
      backoffMs *= 2;
      continue;
    }

    if (!response.ok) {
      return unknownResult("error", `HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    const stat = (body as { data?: { stat?: unknown } } | null)?.data?.stat as Record<string, unknown> | undefined;
    if (!stat) {
      return unknownResult("unknown", "Mobula response missing expected data.stat field");
    }

    const periodBuys = typeof stat["periodBuys"] === "number" ? stat["periodBuys"] : 0;
    const periodSells = typeof stat["periodSells"] === "number" ? stat["periodSells"] : 0;
    const txCount = periodBuys + periodSells;
    const labelsRaw = (body as { data?: { labels?: unknown } } | null)?.data?.labels;

    return {
      status: "ok",
      pnl: typeof stat["periodRealizedPnlUSD"] === "number" ? (stat["periodRealizedPnlUSD"] as number) : "unknown",
      totalPnl: typeof stat["periodTotalPnlUSD"] === "number" ? (stat["periodTotalPnlUSD"] as number) : "unknown",
      winRate: typeof stat["winRealizedPnlRate"] === "number" ? (stat["winRealizedPnlRate"] as number) : "unknown",
      txCount,
      labels: Array.isArray(labelsRaw) ? (labelsRaw as string[]) : [],
      note:
        txCount === 0
          ? "Mobula reported zero trading activity for this chain/period — could mean no data indexed for this address/chain, or genuinely no qualifying trades; the API doesn't distinguish these, so this is NOT the same as a confirmed-zero PnL."
          : undefined,
      fetchedAt: new Date().toISOString(),
    };
  }
}
