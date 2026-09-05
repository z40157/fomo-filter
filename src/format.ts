// Shared human-readable formatting helpers — used by log lines (resonanceDetector.ts)
// and alert content (alerts/telegramTemplate.ts, alerts/emailTemplate.ts) so all
// present numbers the same way.

export function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatUsdOrUnknown(n: number | null): string {
  return n === null ? "unknown" : formatUsd(n);
}

export function formatCountOrUnknown(n: number | null): string {
  return n === null ? "unknown" : n.toString();
}

export function formatAge(ageMs: number): string {
  const minutes = ageMs / 60_000;
  if (minutes < 60) return `${minutes.toFixed(0)}min`;
  if (minutes < 1_440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1_440).toFixed(1)}d`;
}

// Raw on-chain quote-currency base units → approximate human amount. Assumes
// 18 decimals (same display caveat as signal_wallets.buy_amount) — comparable
// across wallets within one alert, not an exact figure.
export function formatQuoteAmount(raw: bigint): string {
  if (raw === 0n) return "0";
  const asNumber = Number(raw) / 1e18;
  if (!Number.isFinite(asNumber)) return raw.toString();
  return `~${asNumber.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}
