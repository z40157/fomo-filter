// Telegram alert message (Phase 8, revised) — Telegram is now the primary
// and default alert channel, carrying the full layered-threshold logic
// that previously lived on email:
//   < 7.0    not sent
//   7.0-7.9  normal message
//   8.0-8.9  message tagged STRONG
//   >= 9.0   message tagged URGENT
//
// Rendered as Telegram HTML (parse_mode "HTML") so it stays readable on a
// phone. The CA is wrapped in <code> for one-tap copy. Risk=UNKNOWN or
// Confidence=LOW is called out at the very top, never buried lower down.
// No wording anywhere reads as "you should buy this".

import { formatUsd, formatUsdOrUnknown, formatCountOrUnknown, formatAge, formatQuoteAmount } from "../format.js";
import { dexscreenerUrl, blockscoutUrl } from "./links.js";
import { buildWhyTriggeredText, type AlertContext } from "./alertTypes.js";

/** Telegram HTML parse_mode only requires these three escaped inside text nodes. */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DIMENSION_LABELS = {
  resonance: "Wallet resonance",
  flow: "Smart flow",
  acceleration: "Acceleration",
  marketQuality: "Market quality",
  narrative: "Narrative",
  earlyness: "Earlyness",
} as const;

function headerLine(ctx: AlertContext): string {
  const symbol = escapeTelegramHtml(ctx.tokenSymbol ?? ctx.tokenAddress.slice(0, 10));
  const score = `${ctx.importanceScore.toFixed(1)}/10`;
  if (ctx.level === "URGENT") return `🚨 <b>URGENT</b> · <b>${score}</b> · <b>${symbol}</b>`;
  if (ctx.level === "STRONG") return `⚡ <b>STRONG</b> · <b>${score}</b> · <b>${symbol}</b>`;
  return `📡 <b>${score}</b> · <b>${symbol}</b>`;
}

export function renderTelegramMessage(ctx: AlertContext): string {
  const warnings: string[] = [];
  if (ctx.riskLevel === "UNKNOWN") {
    warnings.push("⚠️ <b>RISK UNKNOWN</b> — key market data is missing; this is NOT a safe / LOW rating.");
  }
  if (ctx.confidence === "LOW") {
    warnings.push("⚠️ <b>LOW CONFIDENCE</b> — this score is based on incomplete data (see notes below).");
  }

  const symbol = escapeTelegramHtml(ctx.tokenSymbol ?? "(unknown symbol)");
  const name = escapeTelegramHtml(ctx.tokenName ?? "(unknown name)");
  const netFlow = ctx.aggregateWatchedBuyUsd - ctx.aggregateWatchedSellUsd;
  const netFlowStr = `${netFlow >= 0 ? "+" : "-"}${formatUsd(Math.abs(netFlow))}`;

  const scoreBlock = (Object.keys(DIMENSION_LABELS) as (keyof typeof DIMENSION_LABELS)[])
    .map((key) => {
      const dim = ctx.scoreBreakdown[key];
      return `${DIMENSION_LABELS[key].padEnd(17)} ${dim.score.toFixed(1)}/${dim.max}`;
    })
    .join("\n");

  const whyTriggered = escapeTelegramHtml(
    buildWhyTriggeredText({
      distinctOwnerGroups: ctx.distinctOwnerGroups,
      tierACount: ctx.tierACount,
      hasRepeatAccumulation: ctx.hasRepeatAccumulation,
      windowMinutes: ctx.windowMinutes,
      triggerConditions: ctx.triggerConditions,
    }),
  );

  const unit = ctx.quoteTokenSymbol ?? "quote units";
  const walletLines =
    ctx.wallets.length > 0
      ? ctx.wallets
          .map((w) => {
            const sold = w.sellAmount > 0n ? `, sold ${formatQuoteAmount(w.sellAmount, unit)}` : "";
            return `• ${escapeTelegramHtml(w.name)} (${w.tier}) — bought ${formatQuoteAmount(w.buyAmount, unit)}${sold}`;
          })
          .join("\n")
      : "• (no per-wallet breakdown available)";

  const confidenceBlock =
    ctx.confidenceReasons.length > 0
      ? `\n\n<b>Confidence notes</b>\n${ctx.confidenceReasons.map((r) => `• ${escapeTelegramHtml(r)}`).join("\n")}`
      : "";

  const sections = [
    warnings.join("\n"),
    headerLine(ctx),
    `Risk: <b>${ctx.riskLevel}</b> · Confidence: <b>${ctx.confidence}</b>`,
    [
      `<b>Token</b>`,
      `${symbol} — ${name}`,
      `CA: <code>${escapeTelegramHtml(ctx.tokenAddress)}</code>`,
      `MC ${formatUsdOrUnknown(ctx.marketCap)} · Liq ${formatUsdOrUnknown(ctx.liquidity)} · Age ${formatAge(ctx.ageMs)}`,
    ].join("\n"),
    [
      `<b>Smart flow (${ctx.windowMinutes}m window)</b>`,
      `${ctx.distinctOwnerGroups} ownerGroup${ctx.distinctOwnerGroups === 1 ? "" : "s"} · ${ctx.tierACount} Tier-A · net ${netFlowStr} · ${ctx.repeatBuyerCount} repeat buyer${ctx.repeatBuyerCount === 1 ? "" : "s"}`,
      `5m vol ${formatUsdOrUnknown(ctx.volume5m)} · buys ${formatCountOrUnknown(ctx.buys5m)} · sells ${formatCountOrUnknown(ctx.sells5m)}`,
    ].join("\n"),
    `<b>Score breakdown</b>\n<pre>${scoreBlock}</pre>`,
    `<b>Why triggered</b>\n${whyTriggered}`,
    `<b>Watched wallets</b>\n${walletLines}${confidenceBlock}`,
    `<a href="${dexscreenerUrl(ctx.tokenAddress)}">DexScreener</a> · <a href="${blockscoutUrl(ctx.tokenAddress)}">Blockscout</a>`,
    `<i>This is a monitoring signal, NOT a buy recommendation.</i>`,
  ].filter((s) => s.length > 0);

  return sections.join("\n\n");
}
