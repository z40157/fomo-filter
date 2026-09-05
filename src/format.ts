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

// Raw on-chain quote-currency base units → human amount, optionally suffixed
// with the currency symbol. A trade magnitude is never negative, so a signed
// on-chain delta (Doppler's Swap reports the *swapper's* balance change,
// which goes negative when they pay in the quote currency) is taken as its
// absolute value here — a BUY/SELL amount must never render with a minus
// sign. Assumes an 18-decimal quote currency (WETH / native ETH on this
// chain); same display caveat as signal_wallets.buy_amount — comparable
// across wallets within one alert, not an exact figure.
export function formatQuoteAmount(raw: bigint, symbol?: string | null): string {
  const magnitude = raw < 0n ? -raw : raw;
  const unit = symbol ? ` ${symbol}` : "";
  if (magnitude === 0n) return `0${unit}`;
  const asNumber = Number(magnitude) / 1e18;
  if (!Number.isFinite(asNumber)) return `${magnitude.toString()}${unit}`;
  const maximumFractionDigits = asNumber < 1 ? 6 : 4;
  return `${asNumber.toLocaleString(undefined, { maximumFractionDigits })}${unit}`;
}
