// Human-facing (not API) links for a token — for emails/Telegram messages,
// never used for data fetching.
//
// dexscreenerUrl: DexScreener's documented web URL shape is
// https://dexscreener.com/{chainId}/{address}, and Phase 5 already
// confirmed "robinhood" as the real chain slug against DexScreener's own
// API (see market/dexscreener.ts). The web page itself couldn't be
// live-fetched to double-check (dexscreener.com returns HTTP 403 to
// automated fetches) — this follows their standard, consistently observed
// URL convention rather than a fetched confirmation.
//
// blockscoutUrl: robinhoodchain.blockscout.com confirmed live 2026-09-05
// as Robinhood Chain's (chainId 4663) official Blockscout instance; the
// /token/{address} path was confirmed to resolve to a real per-token page
// (title "Robinhood Chain token details | Blockscout") using a real
// on-chain MOLLIE token address.

export function dexscreenerUrl(tokenAddress: string): string {
  return `https://dexscreener.com/robinhood/${tokenAddress}`;
}

export function blockscoutUrl(tokenAddress: string): string {
  return `https://robinhoodchain.blockscout.com/token/${tokenAddress}`;
}
