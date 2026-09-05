// Importance scoring (Phase 7) — pure functions, no ML/AI/embeddings/
// historical-similarity matching, no black boxes. Every point is a
// documented rule; the returned breakdown must always be able to account
// for the full score by itself.
//
// "Importance" means "how urgently this is worth a human look" — it is
// NOT a buy probability, and nothing here (or in its logs) should ever be
// read as "you should buy this."

export const IMPORTANCE_MIN = 1.0;
export const IMPORTANCE_MAX = 10.0;

// Version of the scoring ruleset below. Phase 9's Outcome Tracker snapshots
// this alongside every tracked signal's score_breakdown, so an outcome
// analysis months from now can always say which ruleset produced a given
// score. **Bump this by 1 whenever any threshold, weight, or dimension
// formula in this file changes** — old signals keep their recorded version,
// so their breakdowns stay interpretable under the rules that actually
// scored them, and analysis can segment by ruleset instead of silently
// mixing incompatible scores.
export const SCORING_RULE_VERSION = 1;

const RESONANCE_MAX = 3.0;
const FLOW_MAX = 2.0;
const ACCELERATION_MAX = 2.0;
const MARKET_QUALITY_MAX = 1.0;
const NARRATIVE_MAX = 1.0;
const EARLYNESS_MAX = 1.0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface DimensionResult {
  score: number;
  max: number;
  reasons: string[];
}

export interface ScoreBreakdown {
  resonance: DimensionResult;
  flow: DimensionResult;
  acceleration: DimensionResult;
  marketQuality: DimensionResult;
  narrative: DimensionResult;
  earlyness: DimensionResult;
  total: number;
}

// ---------------------------------------------------------------------
// A. Wallet Resonance — max 3.0
// ---------------------------------------------------------------------
// Fixed tiers by distinct ownerGroup count (given directly by the spec),
// plus a per-Tier-A-ownerGroup bonus, clamped to the dimension max so a
// large window can never blow past 3.0.

export function scoreResonance(distinctOwnerGroups: number, tierAOwnerGroups: number): DimensionResult {
  let base: number;
  let baseLabel: string;
  if (distinctOwnerGroups <= 0) {
    base = 0;
    baseLabel = "0 ownerGroups";
  } else if (distinctOwnerGroups === 1) {
    base = 0.5;
    baseLabel = "1 ownerGroup";
  } else if (distinctOwnerGroups === 2) {
    base = 1.5;
    baseLabel = "2 ownerGroups";
  } else if (distinctOwnerGroups === 3) {
    base = 2.2;
    baseLabel = "3 ownerGroups";
  } else {
    base = 3.0;
    baseLabel = `${distinctOwnerGroups} ownerGroups (4+ tier)`;
  }

  const tierABonus = tierAOwnerGroups * 0.3;
  const raw = base + tierABonus;
  const score = clamp(raw, 0, RESONANCE_MAX);

  const reasons = [`${baseLabel}: ${base.toFixed(2)}`];
  if (tierAOwnerGroups > 0) {
    reasons.push(`+${tierABonus.toFixed(2)} for ${tierAOwnerGroups} Tier-A ownerGroup(s) (0.3 each)`);
  }
  if (raw > RESONANCE_MAX) {
    reasons.push(`clamped from ${raw.toFixed(2)} to dimension max ${RESONANCE_MAX.toFixed(1)}`);
  }

  return { score, max: RESONANCE_MAX, reasons };
}

// ---------------------------------------------------------------------
// B. Smart Flow / Accumulation — max 2.0
// ---------------------------------------------------------------------
// Three parts:
//  1. Accumulation magnitude (0-1.2): how much watchlist money is in.
//     aggregateWatchedBuyUsd is exactly 0 both when nothing was bought
//     (impossible here — a signal always has >=1 watchlist BUY) and when
//     Phase 5's usd_value enrichment simply hasn't caught up yet. We can't
//     tell those apart from this number alone, so an exact 0 gets a small
//     baseline credit (0.3) rather than 0 — the resonance condition
//     already proves real buying happened. usdDataAvailable further
//     distinguishes this for Confidence, not for this score.
//  2. Net flow direction (-1.0 to +0.5): buying is credited, selling is
//     punished harder than buying is rewarded — a group net-selling into
//     its own resonance is a materially worse signal than one still net
//     buying, which the spec explicitly calls out ("净流出为负时这一项应
//     显著扣分").
//  3. Repeat-buyer bonus (0-0.3): rewards conviction (adding to a
//     position), same "reentry" concept already used by
//     scripts/mineWallets.ts and Phase 5's repeatBuyerCount.

export interface FlowInput {
  aggregateWatchedBuyUsd: number;
  aggregateWatchedSellUsd: number;
  repeatBuyerCount: number;
}

export function scoreFlow(input: FlowInput): DimensionResult {
  const reasons: string[] = [];
  const usdDataAvailable = input.aggregateWatchedBuyUsd > 0 || input.aggregateWatchedSellUsd > 0;

  let magnitude: number;
  if (!usdDataAvailable) {
    magnitude = 0.3;
    reasons.push("usd value not backfilled yet for this window — baseline 0.3 credit (buying is known to have happened)");
  } else if (input.aggregateWatchedBuyUsd < 1_000) {
    magnitude = 0.5;
    reasons.push(`accumulation magnitude 0.5 (buy volume < $1,000: $${input.aggregateWatchedBuyUsd.toFixed(0)})`);
  } else if (input.aggregateWatchedBuyUsd < 5_000) {
    magnitude = 0.8;
    reasons.push(`accumulation magnitude 0.8 ($1,000-$5,000: $${input.aggregateWatchedBuyUsd.toFixed(0)})`);
  } else if (input.aggregateWatchedBuyUsd < 20_000) {
    magnitude = 1.0;
    reasons.push(`accumulation magnitude 1.0 ($5,000-$20,000: $${input.aggregateWatchedBuyUsd.toFixed(0)})`);
  } else {
    magnitude = 1.2;
    reasons.push(`accumulation magnitude 1.2 (>= $20,000: $${input.aggregateWatchedBuyUsd.toFixed(0)})`);
  }

  const netInflow = input.aggregateWatchedBuyUsd - input.aggregateWatchedSellUsd;
  let direction: number;
  if (!usdDataAvailable) {
    direction = 0;
    reasons.push("net flow direction: 0 (unknown — no usd data yet)");
  } else if (netInflow > 0) {
    direction = 0.5;
    reasons.push(`net flow direction: +0.5 (net buying, +$${netInflow.toFixed(0)})`);
  } else if (netInflow === 0) {
    direction = 0;
    reasons.push("net flow direction: 0 (exactly balanced)");
  } else {
    const sellRatio = input.aggregateWatchedBuyUsd > 0 ? Math.abs(netInflow) / input.aggregateWatchedBuyUsd : 1;
    if (sellRatio > 0.5) {
      direction = -1.0;
      reasons.push(`net flow direction: -1.0 (severe net selling, -$${Math.abs(netInflow).toFixed(0)} — watchlist appears to be exiting)`);
    } else if (sellRatio > 0.2) {
      direction = -0.6;
      reasons.push(`net flow direction: -0.6 (moderate net selling, -$${Math.abs(netInflow).toFixed(0)})`);
    } else {
      direction = -0.3;
      reasons.push(`net flow direction: -0.3 (mild net selling, -$${Math.abs(netInflow).toFixed(0)})`);
    }
  }

  let repeat: number;
  if (input.repeatBuyerCount <= 0) {
    repeat = 0;
  } else if (input.repeatBuyerCount === 1) {
    repeat = 0.15;
    reasons.push("repeat-buyer bonus: +0.15 (1 wallet added to its position)");
  } else {
    repeat = 0.3;
    reasons.push(`repeat-buyer bonus: +0.3 (${input.repeatBuyerCount} wallets added to their positions)`);
  }

  const raw = magnitude + direction + repeat;
  const score = clamp(raw, 0, FLOW_MAX);
  if (raw !== score) reasons.push(`clamped from ${raw.toFixed(2)} to [0, ${FLOW_MAX.toFixed(1)}]`);

  return { score, max: FLOW_MAX, reasons };
}

// ---------------------------------------------------------------------
// C. Acceleration — max 2.0
// ---------------------------------------------------------------------
// Deliberately trend-first, not magnitude-first: the spec is explicit
// that raw volume alone must not drive this score ("$500K成交量配$50K市值
// 不应该自动高分") — that "high turnover, low cap" shape is a flash-pump
// risk signal, handled in risk.ts, not rewarded here as importance.
//  1. Volume momentum (0-1.0): % change in volume5m between the two most
//     recent snapshots. With fewer than 2 snapshots there is no trend to
//     measure at all — explicitly degraded to a flat 0.4 and flagged
//     insufficientData, never silently treated as "no momentum" (0) or
//     "strong momentum" (1.0).
//  2. Recent activity floor (0-0.6): a small, capped credit for buys5m
//     existing at all — modest on purpose, so this doesn't become a
//     second volume-magnitude reward in disguise.
//  3. Buy/sell ratio (0-0.4): recent (5m) buy pressure vs sell pressure.

export interface SnapshotPoint {
  snapshotAt: Date;
  volume5m: number | null;
}

export interface AccelerationInput {
  volume5m: number | null;
  buys5m: number | null;
  sells5m: number | null;
  /** Oldest first. Only the two most recent entries are used for the momentum trend. */
  recentSnapshots: SnapshotPoint[];
}

export function scoreAcceleration(input: AccelerationInput): DimensionResult {
  const reasons: string[] = [];
  const usableSnapshots = input.recentSnapshots.filter((s) => s.volume5m !== null);

  let momentum: number;
  if (usableSnapshots.length < 2) {
    momentum = 0.4;
    reasons.push(
      `volume momentum: 0.4 (insufficient snapshot history — only ${usableSnapshots.length} usable snapshot(s), need >= 2 for a trend)`,
    );
  } else {
    const prev = usableSnapshots[usableSnapshots.length - 2]!.volume5m!;
    const latest = usableSnapshots[usableSnapshots.length - 1]!.volume5m!;
    const changeRatio = prev > 0 ? (latest - prev) / prev : latest > 0 ? 1 : 0;
    if (changeRatio <= -0.2) {
      momentum = 0.1;
      reasons.push(`volume momentum: 0.1 (declining ${(changeRatio * 100).toFixed(0)}% vs prior snapshot)`);
    } else if (changeRatio <= 0.2) {
      momentum = 0.4;
      reasons.push(`volume momentum: 0.4 (flat, ${(changeRatio * 100).toFixed(0)}% vs prior snapshot)`);
    } else if (changeRatio <= 1.0) {
      momentum = 0.7;
      reasons.push(`volume momentum: 0.7 (accelerating +${(changeRatio * 100).toFixed(0)}% vs prior snapshot)`);
    } else {
      momentum = 1.0;
      reasons.push(`volume momentum: 1.0 (rapidly accelerating +${(changeRatio * 100).toFixed(0)}% vs prior snapshot)`);
    }
  }

  const buys5m = input.buys5m ?? 0;
  let activity: number;
  if (input.buys5m === null) {
    activity = 0;
    reasons.push("recent activity: 0 (no DexScreener buys5m data)");
  } else if (buys5m === 0) {
    activity = 0;
  } else if (buys5m <= 2) {
    activity = 0.2;
    reasons.push(`recent activity: 0.2 (${buys5m} buys in the last 5m)`);
  } else if (buys5m <= 5) {
    activity = 0.4;
    reasons.push(`recent activity: 0.4 (${buys5m} buys in the last 5m)`);
  } else {
    activity = 0.6;
    reasons.push(`recent activity: 0.6 (${buys5m} buys in the last 5m)`);
  }

  const sells5m = input.sells5m ?? 0;
  let ratio: number;
  if (input.buys5m === null || input.sells5m === null) {
    ratio = 0;
  } else if (buys5m === 0 && sells5m === 0) {
    ratio = 0;
  } else if (sells5m === 0) {
    ratio = 0.4;
    reasons.push("buy/sell ratio (5m): 0.4 (all buys, no recent sells)");
  } else {
    const r = buys5m / sells5m;
    if (r >= 2) {
      ratio = 0.4;
      reasons.push(`buy/sell ratio (5m): 0.4 (${r.toFixed(1)}:1)`);
    } else if (r >= 1) {
      ratio = 0.25;
      reasons.push(`buy/sell ratio (5m): 0.25 (${r.toFixed(1)}:1)`);
    } else {
      ratio = 0.1;
      reasons.push(`buy/sell ratio (5m): 0.1 (${r.toFixed(1)}:1 — more sells than buys recently)`);
    }
  }

  const raw = momentum + activity + ratio;
  const score = clamp(raw, 0, ACCELERATION_MAX);
  if (raw !== score) reasons.push(`clamped from ${raw.toFixed(2)} to [0, ${ACCELERATION_MAX.toFixed(1)}]`);

  return { score, max: ACCELERATION_MAX, reasons };
}

// ---------------------------------------------------------------------
// D. Market Quality — max 1.0
// ---------------------------------------------------------------------
// V1 explicitly does NOT estimate Insider%/Sniper%/Bundler% — we don't
// have the data to compute those honestly, and approximating them with
// other metrics would be presenting a guess as a measurement.
//  1. Liquidity floor (0-0.5): deeper pools are structurally safer.
//  2. marketCap/liquidity ratio (0-0.3): a LOW ratio (liquidity can
//     actually support the cap) earns credit; a high ratio earns none
//     here (risk.ts flags it as dangerous separately — not double
//     counted as a bonus here, only withheld).
//  3. Buy/sell count structure (0-0.2): a token that's mostly been
//     bought (not dumped) since launch, across ALL traders (not just the
//     watchlist), gets a small structural credit.

export interface MarketQualityInput {
  liquidity: number | null;
  marketCap: number | null;
  totalBuys: number;
  totalSells: number;
}

export function scoreMarketQuality(input: MarketQualityInput): DimensionResult {
  const reasons: string[] = [];

  let liquidityScore: number;
  if (input.liquidity === null) {
    liquidityScore = 0;
    reasons.push("liquidity floor: 0 (no DexScreener liquidity data)");
  } else if (input.liquidity < 5_000) {
    liquidityScore = 0.1;
    reasons.push(`liquidity floor: 0.1 (< $5,000: $${input.liquidity.toFixed(0)})`);
  } else if (input.liquidity < 15_000) {
    liquidityScore = 0.3;
    reasons.push(`liquidity floor: 0.3 ($5,000-$15,000: $${input.liquidity.toFixed(0)})`);
  } else if (input.liquidity < 50_000) {
    liquidityScore = 0.45;
    reasons.push(`liquidity floor: 0.45 ($15,000-$50,000: $${input.liquidity.toFixed(0)})`);
  } else {
    liquidityScore = 0.5;
    reasons.push(`liquidity floor: 0.5 (>= $50,000: $${input.liquidity.toFixed(0)})`);
  }

  let ratioScore: number;
  if (input.marketCap === null || input.liquidity === null || input.liquidity === 0) {
    ratioScore = 0;
    reasons.push("mc/liquidity ratio: 0 (unknown)");
  } else {
    const ratio = input.marketCap / input.liquidity;
    if (ratio <= 1) {
      ratioScore = 0.3;
      reasons.push(`mc/liquidity ratio: 0.3 (${ratio.toFixed(2)} — liquidity comfortably backs market cap)`);
    } else if (ratio <= 3) {
      ratioScore = 0.2;
      reasons.push(`mc/liquidity ratio: 0.2 (${ratio.toFixed(2)})`);
    } else if (ratio <= 8) {
      ratioScore = 0.1;
      reasons.push(`mc/liquidity ratio: 0.1 (${ratio.toFixed(2)})`);
    } else {
      ratioScore = 0;
      reasons.push(`mc/liquidity ratio: 0 (${ratio.toFixed(2)} — thin liquidity relative to cap; see risk breakdown)`);
    }
  }

  let structureScore: number;
  if (input.totalSells === 0 && input.totalBuys === 0) {
    structureScore = 0;
    reasons.push("buy/sell structure: 0 (no trade data)");
  } else if (input.totalSells === 0) {
    structureScore = 0.2;
    reasons.push("buy/sell structure: 0.2 (pure accumulation so far, zero sells)");
  } else {
    const r = input.totalBuys / input.totalSells;
    if (r >= 1.5) {
      structureScore = 0.2;
      reasons.push(`buy/sell structure: 0.2 (${r.toFixed(2)}:1 overall)`);
    } else if (r >= 1) {
      structureScore = 0.1;
      reasons.push(`buy/sell structure: 0.1 (${r.toFixed(2)}:1 overall)`);
    } else {
      structureScore = 0;
      reasons.push(`buy/sell structure: 0 (${r.toFixed(2)}:1 overall — more sells than buys)`);
    }
  }

  const raw = liquidityScore + ratioScore + structureScore;
  const score = clamp(raw, 0, MARKET_QUALITY_MAX);
  if (raw !== score) reasons.push(`clamped from ${raw.toFixed(2)} to [0, ${MARKET_QUALITY_MAX.toFixed(1)}]`);

  return { score, max: MARKET_QUALITY_MAX, reasons };
}

// ---------------------------------------------------------------------
// E. Narrative / Stock Pair — max 1.0
// ---------------------------------------------------------------------
// V1 does no AI narrative analysis. Two manually-sourced inputs only:
//  - officialStockPair: pairToken matches a known Robinhood stock-token
//    address from config/stockTokens.json (empty by default — handled
//    with zero special-casing beyond "not found").
//  - narrativeBoost: a human-set 0-1 value from the narrative_flags
//    table, scaled into the remaining budget.

export interface NarrativeInput {
  pairTokenAddress: string;
  officialStockTokens: ReadonlySet<string>;
  /** 0-1, or null if no narrative_flags row exists for this token. */
  narrativeBoost: number | null;
}

const OFFICIAL_STOCK_PAIR_BONUS = 0.6;
const NARRATIVE_BOOST_MAX = 0.4;

export function scoreNarrative(input: NarrativeInput): DimensionResult {
  const reasons: string[] = [];
  const isOfficialStockPair = input.officialStockTokens.has(input.pairTokenAddress.toLowerCase());

  const stockPairScore = isOfficialStockPair ? OFFICIAL_STOCK_PAIR_BONUS : 0;
  if (isOfficialStockPair) {
    reasons.push(`+${OFFICIAL_STOCK_PAIR_BONUS.toFixed(1)}: paired against a known official Robinhood stock token`);
  } else {
    reasons.push("+0: pair token is not in config/stockTokens.json");
  }

  const boost = input.narrativeBoost === null ? 0 : clamp(input.narrativeBoost, 0, 1);
  const narrativeScore = boost * NARRATIVE_BOOST_MAX;
  if (input.narrativeBoost === null) {
    reasons.push("+0: no manual narrative_flags entry for this token");
  } else {
    reasons.push(`+${narrativeScore.toFixed(2)}: manual narrative boost ${boost.toFixed(2)} x ${NARRATIVE_BOOST_MAX}`);
  }

  const raw = stockPairScore + narrativeScore;
  const score = clamp(raw, 0, NARRATIVE_MAX);
  if (raw !== score) reasons.push(`clamped from ${raw.toFixed(2)} to [0, ${NARRATIVE_MAX.toFixed(1)}]`);

  return { score, max: NARRATIVE_MAX, reasons };
}

// ---------------------------------------------------------------------
// F. Earlyness — max 1.0
// ---------------------------------------------------------------------
// Monotonically decreasing by token age, exactly as specified.

export function scoreEarlyness(ageMs: number): DimensionResult {
  const ageMinutes = ageMs / 60_000;
  let score: number;
  let label: string;
  if (ageMinutes < 15) {
    score = 1.0;
    label = "< 15min";
  } else if (ageMinutes < 30) {
    score = 0.8;
    label = "15-30min";
  } else if (ageMinutes < 60) {
    score = 0.6;
    label = "30-60min";
  } else if (ageMinutes < 180) {
    score = 0.4;
    label = "1-3h";
  } else {
    score = 0.2;
    label = "> 3h";
  }
  return { score, max: EARLYNESS_MAX, reasons: [`age ${ageMinutes.toFixed(0)}min (${label}): ${score.toFixed(1)}`] };
}

// ---------------------------------------------------------------------
// Total
// ---------------------------------------------------------------------

export interface ImportanceScoreInput {
  distinctOwnerGroups: number;
  tierAOwnerGroups: number;
  flow: FlowInput;
  acceleration: AccelerationInput;
  marketQuality: MarketQualityInput;
  narrative: NarrativeInput;
  ageMs: number;
}

export function computeImportanceScore(input: ImportanceScoreInput): { score: number; breakdown: ScoreBreakdown } {
  const resonance = scoreResonance(input.distinctOwnerGroups, input.tierAOwnerGroups);
  const flow = scoreFlow(input.flow);
  const acceleration = scoreAcceleration(input.acceleration);
  const marketQuality = scoreMarketQuality(input.marketQuality);
  const narrative = scoreNarrative(input.narrative);
  const earlyness = scoreEarlyness(input.ageMs);

  const rawTotal = resonance.score + flow.score + acceleration.score + marketQuality.score + narrative.score + earlyness.score;
  const total = clamp(rawTotal, IMPORTANCE_MIN, IMPORTANCE_MAX);

  return {
    score: total,
    breakdown: { resonance, flow, acceleration, marketQuality, narrative, earlyness, total },
  };
}

// ---------------------------------------------------------------------
// Confidence — independent of importance and risk
// ---------------------------------------------------------------------
// "How much should we trust THIS SCORE", not "how good is the token".
// A high-importance signal can be low-confidence at the same time (thin
// data on a very fresh token) — that's expected, not a bug.

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface ConfidenceInput {
  hasMarketData: boolean;
  snapshotCount: number;
  hasUsdFlowData: boolean;
  fallbackOwnerGroupCount: number;
  ageMs: number;
}

export function computeConfidence(input: ConfidenceInput): { level: ConfidenceLevel; reasons: string[] } {
  const reasons: string[] = [];
  let severity = 0;

  if (!input.hasMarketData) {
    reasons.push("no DexScreener market data available yet");
    severity += 2;
  }
  if (input.snapshotCount < 2) {
    reasons.push(`only ${input.snapshotCount} market snapshot(s) so far — trend data is thin`);
    severity += 1;
  }
  if (!input.hasUsdFlowData) {
    reasons.push("usd value not yet backfilled for this window's trades");
    severity += 1;
  }
  if (input.fallbackOwnerGroupCount > 0) {
    reasons.push(`${input.fallbackOwnerGroupCount} participating wallet(s) have no ownerGroup on file`);
    severity += 1;
  }
  if (input.ageMs < 15 * 60_000) {
    reasons.push("token is under 15 minutes old — data is inherently limited this early");
    severity += 1;
  }

  if (reasons.length === 0) {
    reasons.push("market data, snapshot history, usd values, and owner groups are all available");
  }

  const level: ConfidenceLevel = severity >= 3 ? "LOW" : severity >= 1 ? "MEDIUM" : "HIGH";
  return { level, reasons };
}
