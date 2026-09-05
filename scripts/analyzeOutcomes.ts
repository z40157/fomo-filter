// Phase 9 — outcome analysis report. Reads signal_outcomes /
// signal_outcome_points and prints, per importance bucket (and crossed by
// risk level and confidence), how signals actually did afterwards.
//
// This ONLY presents data. It contains no "buy above X" logic or wording —
// its whole point is to let a human decide, later, whether the scoring
// rules were any good. Small samples are called out loudly rather than
// dressed up as conclusions.
//
// Run: npm run outcomes:analyze

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnv } from "../src/config/index.js";
import { createSignalOutcomesRepo } from "../src/db/signalOutcomes.js";
import * as schema from "../src/db/schema.js";
import {
  MIN_RELIABLE_SAMPLE,
  buildOutcomeReport,
  type GroupStats,
  type OutcomeReport,
} from "../src/outcomes/analyzeOutcomesLogic.js";

function pct(n: number | null): string {
  if (n === null) return "  —  ";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function ratio(n: number | null): string {
  return n === null ? "  —  " : `${(n * 100).toFixed(0)}%`;
}

function renderGroupTable(title: string, groups: GroupStats[]): void {
  console.log(`\n${title}`);
  console.log(
    [
      "group".padEnd(10),
      "n".padStart(5),
      "ok".padStart(5),
      "excl".padStart(5),
      "+1h mean".padStart(10),
      "+1h med".padStart(9),
      "+24h mean".padStart(10),
      "+24h med".padStart(9),
      "win%(24h)".padStart(10),
      "avgMaxUp".padStart(10),
      "avgMaxDD".padStart(10),
    ].join(" "),
  );
  for (const g of groups) {
    const warn = g.insufficient && g.dataComplete > 0 ? "  ⚠ n<10" : "";
    console.log(
      [
        g.label.padEnd(10),
        String(g.count).padStart(5),
        String(g.dataComplete).padStart(5),
        String(g.excluded).padStart(5),
        pct(g.return1h.mean).padStart(10),
        pct(g.return1h.median).padStart(9),
        pct(g.return24h.mean).padStart(10),
        pct(g.return24h.median).padStart(9),
        ratio(g.positiveRatio24h).padStart(10),
        pct(g.avgMaxReturnPct).padStart(10),
        pct(g.avgMaxDrawdownPct).padStart(10),
      ].join(" ") + warn,
    );
  }
}

function renderReport(report: OutcomeReport): void {
  console.log("=".repeat(78));
  console.log("SIGNAL OUTCOME ANALYSIS — descriptive data only, not advice");
  console.log("=".repeat(78));
  console.log(
    `\nTotal tracked outcomes: ${report.overall.total}` +
      `  |  data-complete (baseline available): ${report.overall.dataComplete}` +
      `  |  excluded (no baseline): ${report.overall.excluded}`,
  );
  console.log(
    "Returns are % vs the signal's baseline price. avgMaxUp / avgMaxDD are the mean of each",
  );
  console.log(
    `outcome's best / worst point — measured across only the 5 discrete samples (+5m/+15m/+1h/`,
  );
  console.log("+6h/+24h), NOT a continuous price feed, so true intra-sample highs/lows are unseen.");

  if (report.overall.dataComplete === 0) {
    console.log(
      `\n⚠️  NO data-complete outcomes yet — nothing to analyse. (Outcomes need a baseline price` +
        ` at signal time and at least their +1h/+24h points recorded.)`,
    );
    return;
  }
  if (report.overall.insufficient) {
    console.log("\n" + "!".repeat(78));
    console.log(
      `⚠️  ONLY ${report.overall.dataComplete} data-complete outcome(s) — far below the ${MIN_RELIABLE_SAMPLE} needed`,
    );
    console.log(
      "⚠️  for any statistic below to mean anything. Treat every number here as a smoke test",
    );
    console.log("⚠️  of the pipeline, NOT a finding about the scoring rules.");
    console.log("!".repeat(78));
  }

  renderGroupTable("BY IMPORTANCE BUCKET", report.byImportanceBucket);
  renderGroupTable("BY RISK LEVEL", report.byRisk);
  renderGroupTable("BY CONFIDENCE", report.byConfidence);

  console.log(
    "\nLegend: n=all outcomes in group, ok=data-complete, excl=excluded (no baseline).",
  );
  console.log("        win%(24h) = share of data-complete +24h returns that are positive.");
  console.log(
    "\nThis report describes what happened after past signals. It is not a recommendation to",
  );
  console.log("buy anything, and score thresholds here carry no 'therefore buy' meaning.");
}

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  try {
    const repo = createSignalOutcomesRepo(db);
    const rows = await repo.listForAnalysis();
    renderReport(buildOutcomeReport(rows));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
