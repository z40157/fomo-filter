// Alert email rendering (Phase 8) — pure function, no I/O, no Resend
// client here. Deliberately plain HTML (tables + a couple of inline-styled
// boxes) — readable in any mail client, nothing that depends on external
// CSS or JS (email clients strip both anyway).
//
// This is a monitoring/detection tool, not a trading signal service:
// nowhere in this template — subject, body, or footer — should any
// wording read as "you should buy this."

import {
  formatUsd,
  formatAge,
  formatQuoteAmount,
  formatUsdOrUnknown as fmtUsdOrUnknown,
  formatCountOrUnknown as fmtCountOrUnknown,
} from "../format.js";
import { dexscreenerUrl, blockscoutUrl } from "./links.js";
import { buildWhyTriggeredText, type AlertContext } from "./alertTypes.js";
import type { AlertLevel } from "./alertLogic.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DIMENSION_LABELS = {
  resonance: "Wallet resonance",
  flow: "Smart flow",
  acceleration: "Acceleration",
  marketQuality: "Market quality",
  narrative: "Narrative",
  earlyness: "Earlyness",
} as const;

const RISK_FACTOR_LABELS: Record<string, string> = {
  liquidity: "Liquidity",
  marketCapEntry: "Market cap / entry timing",
  buySellImbalance: "Buy/sell imbalance (5m)",
  suddenLargeSell: "Sudden large sell",
  watchlistExiting: "Watchlist exiting",
  deployerSelling: "Deployer selling",
};

function levelTag(level: AlertLevel): string {
  if (level === "URGENT") return "URGENT ";
  if (level === "STRONG") return "STRONG ";
  return "";
}

export function buildSubject(ctx: AlertContext): string {
  const symbol = ctx.tokenSymbol ?? ctx.tokenAddress.slice(0, 8);
  const mc = ctx.marketCap === null ? "N/A" : formatUsd(ctx.marketCap);
  return `[RH ${levelTag(ctx.level)}${ctx.importanceScore.toFixed(1)}/10] ${symbol} | MC ${mc} | ${ctx.distinctOwnerGroups} Smart Wallet${ctx.distinctOwnerGroups === 1 ? "" : "s"}`;
}

const CARD = "border:1px solid #ddd; border-radius:6px; padding:12px 16px; margin-bottom:16px;";
const H2 = "font-size:13px; letter-spacing:0.05em; color:#555; margin:0 0 8px 0; text-transform:uppercase;";
const ROW = "display:flex; justify-content:space-between; padding:2px 0;";

export function buildHtmlBody(ctx: AlertContext): string {
  const symbol = ctx.tokenSymbol ? escapeHtml(ctx.tokenSymbol) : "(unknown symbol)";
  const name = ctx.tokenName ? escapeHtml(ctx.tokenName) : "(unknown name)";
  const netFlow = ctx.aggregateWatchedBuyUsd - ctx.aggregateWatchedSellUsd;

  const dataWarnings: string[] = [];
  if (ctx.riskLevel === "UNKNOWN") {
    dataWarnings.push("RISK COULD NOT BE DETERMINED (UNKNOWN) — key market data is missing, this is NOT the same as a safe/LOW rating.");
  }
  if (ctx.confidence === "LOW") {
    dataWarnings.push("LOW CONFIDENCE — this score is based on incomplete data (see the Confidence section below for exactly what's missing).");
  }
  const warningBanner =
    dataWarnings.length > 0
      ? `<div style="background:#fff3cd; border:1px solid #f0ad4e; border-radius:6px; padding:10px 16px; margin-bottom:16px; font-weight:bold; color:#8a6300;">
          ${dataWarnings.map((w) => `⚠ ${escapeHtml(w)}`).join("<br/>")}
        </div>`
      : "";

  const scoreRows = (Object.keys(DIMENSION_LABELS) as (keyof typeof DIMENSION_LABELS)[])
    .map((key) => {
      const dim = ctx.scoreBreakdown[key];
      return `<div style="${ROW}"><span>${DIMENSION_LABELS[key]}</span><span>${dim.score.toFixed(1)} / ${dim.max}</span></div>`;
    })
    .join("\n");

  const whyTriggered = buildWhyTriggeredText({
    distinctOwnerGroups: ctx.distinctOwnerGroups,
    tierACount: ctx.tierACount,
    hasRepeatAccumulation: ctx.hasRepeatAccumulation,
    windowMinutes: ctx.windowMinutes,
    triggerConditions: ctx.triggerConditions,
  });

  const walletRows = ctx.wallets
    .map(
      (w) => `<tr>
        <td style="padding:4px 8px; border-bottom:1px solid #eee;">${escapeHtml(w.name)}</td>
        <td style="padding:4px 8px; border-bottom:1px solid #eee;">${w.tier}</td>
        <td style="padding:4px 8px; border-bottom:1px solid #eee;">${formatQuoteAmount(w.buyAmount)}</td>
        <td style="padding:4px 8px; border-bottom:1px solid #eee;">${w.buyCount}</td>
        <td style="padding:4px 8px; border-bottom:1px solid #eee;">${formatQuoteAmount(w.sellAmount)}</td>
      </tr>`,
    )
    .join("\n");

  const riskRows = Object.entries(ctx.riskBreakdown)
    .filter(([key]) => key !== "overall")
    .map(([key, factor]) => {
      const f = factor as { level: string; reason: string };
      return `<div style="${ROW}"><span>${RISK_FACTOR_LABELS[key] ?? key}</span><span>${f.level} — ${escapeHtml(f.reason)}</span></div>`;
    })
    .join("\n");

  const confidenceReasons = ctx.confidenceReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("\n");

  return `
<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width:640px; margin:0 auto; color:#222;">
  <h1 style="font-size:18px; margin:0 0 16px 0;">Robinhood Alpha Radar</h1>

  ${warningBanner}

  <div style="${CARD}">
    <div style="font-size:22px; font-weight:bold;">IMPORTANCE: ${ctx.importanceScore.toFixed(1)} / 10</div>
    <div>RISK: <strong>${ctx.riskLevel}</strong></div>
    <div>CONFIDENCE: <strong>${ctx.confidence}</strong></div>
  </div>

  <div style="${CARD}">
    <div style="${H2}">Token</div>
    <div style="${ROW}"><span>Symbol / Name</span><span>${symbol} / ${name}</span></div>
    <div style="${ROW}"><span>CA</span><span><code style="font-size:12px;">${ctx.tokenAddress}</code></span></div>
    <div style="${ROW}"><span>Age</span><span>${formatAge(ctx.ageMs)}</span></div>
    <div style="${ROW}"><span>Market cap</span><span>${fmtUsdOrUnknown(ctx.marketCap)}</span></div>
    <div style="${ROW}"><span>Liquidity</span><span>${fmtUsdOrUnknown(ctx.liquidity)}</span></div>
  </div>

  <div style="${CARD}">
    <div style="${H2}">${ctx.windowMinutes}M Smart Flow</div>
    <div style="${ROW}"><span>Independent watched wallets (ownerGroups)</span><span>${ctx.distinctOwnerGroups}</span></div>
    <div style="${ROW}"><span>Tier A wallets</span><span>${ctx.tierACount}</span></div>
    <div style="${ROW}"><span>Aggregate buy</span><span>${formatUsd(ctx.aggregateWatchedBuyUsd)}</span></div>
    <div style="${ROW}"><span>Aggregate sell</span><span>${formatUsd(ctx.aggregateWatchedSellUsd)}</span></div>
    <div style="${ROW}"><span>Net flow</span><span>${netFlow >= 0 ? "+" : "-"}${formatUsd(Math.abs(netFlow))}</span></div>
    <div style="${ROW}"><span>Repeat buyers</span><span>${ctx.repeatBuyerCount}</span></div>
  </div>

  <div style="${CARD}">
    <div style="${H2}">Market</div>
    <div style="${ROW}"><span>5m volume</span><span>${fmtUsdOrUnknown(ctx.volume5m)}</span></div>
    <div style="${ROW}"><span>5m buys</span><span>${fmtCountOrUnknown(ctx.buys5m)}</span></div>
    <div style="${ROW}"><span>5m sells</span><span>${fmtCountOrUnknown(ctx.sells5m)}</span></div>
  </div>

  <div style="${CARD}">
    <div style="${H2}">Score breakdown</div>
    ${scoreRows}
  </div>

  <div style="${CARD}">
    <div style="${H2}">Why triggered</div>
    <div>${escapeHtml(whyTriggered)}</div>
  </div>

  <div style="${CARD}">
    <div style="${H2}">Watched wallets</div>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr>
          <th style="text-align:left; padding:4px 8px; border-bottom:2px solid #ccc;">Name</th>
          <th style="text-align:left; padding:4px 8px; border-bottom:2px solid #ccc;">Tier</th>
          <th style="text-align:left; padding:4px 8px; border-bottom:2px solid #ccc;">Buy amt (quote)</th>
          <th style="text-align:left; padding:4px 8px; border-bottom:2px solid #ccc;">Buy count</th>
          <th style="text-align:left; padding:4px 8px; border-bottom:2px solid #ccc;">Sell amt (quote)</th>
        </tr>
      </thead>
      <tbody>
        ${walletRows}
      </tbody>
    </table>
  </div>

  <div style="${CARD}">
    <div style="${H2}">Risk</div>
    ${riskRows}
  </div>

  <div style="${CARD}">
    <div style="${H2}">Confidence</div>
    <ul style="margin:0; padding-left:20px;">
      ${confidenceReasons}
    </ul>
  </div>

  <div style="${CARD}">
    <div style="${H2}">Links</div>
    <div><a href="${dexscreenerUrl(ctx.tokenAddress)}">DexScreener</a></div>
    <div><a href="${blockscoutUrl(ctx.tokenAddress)}">Blockscout</a></div>
  </div>

  <p style="font-size:12px; color:#888; margin-top:24px;">
    This is a monitoring signal, NOT an automatic buy recommendation.
  </p>
</div>
`.trim();
}

export function renderAlertEmail(ctx: AlertContext): { subject: string; html: string } {
  return { subject: buildSubject(ctx), html: buildHtmlBody(ctx) };
}
