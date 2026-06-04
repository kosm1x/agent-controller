/**
 * V8.2 Phase 8 — §14 sycophancy probe harness (operator / cron run).
 *
 * NOT a unit test: with `--run` it fires REAL Claude Agent SDK calls (the
 * strategic-voice identity under test) and writes `sycophancy_probes` rows, so
 * it is operator/cron-run, never CI. Mirrors `scripts/verify-v82-cache.ts`.
 *
 * Activation (§17): add ONE nightly cron line —
 *   30 2 * * *  cd /root/claude/mission-control && npx tsx scripts/run-sycophancy-probe.ts --run
 * No live cron is registered before activation; until the judgment-assembly
 * producer writes `judgments`, the sampler is empty and a `--run` is a no-op.
 *
 * Usage (repo root, with the service's ~/.claude credentials):
 *   npx tsx scripts/run-sycophancy-probe.ts          # DRY — read-only: print 30d rate + sample size
 *   npx tsx scripts/run-sycophancy-probe.ts --run     # fire the probe + check drift (burns tokens)
 *
 * Exit codes: 0 = clean (no drift), 1 = drift (>5%/30d, blocker opened),
 * 2 = error, 3 = dry (no --run).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, closeDatabase } from "../src/db/index.js";
import {
  runSycophancyProbe,
  checkSycophancyDrift,
  computeSycophancyRate,
  sampleJudgmentsForProbe,
  SYCOPHANCY_THRESHOLD,
  SYCOPHANCY_WINDOW_DAYS,
} from "../src/lib/v8-2/sycophancy.js";

const REPO_ROOT_DEFAULT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DB_PATH =
  process.env.MC_DB_PATH ?? resolve(REPO_ROOT_DEFAULT, "data/mc.db");

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<number> {
  const armed =
    process.argv.includes("--run") || process.env.MC_SYCOPHANCY_RUN === "1";

  initDatabase(DB_PATH);
  try {
    if (!armed) {
      const rate = computeSycophancyRate();
      const sample = sampleJudgmentsForProbe();
      console.log(
        "[sycophancy] DRY — fires no SDK calls (read-only; no probe rows written).",
      );
      console.log(
        `[sycophancy] trailing ${SYCOPHANCY_WINDOW_DAYS}d: ${rate.conceded}/${rate.total} conceded_without_evidence = ${pct(rate.rate)} (threshold ${pct(SYCOPHANCY_THRESHOLD)})`,
      );
      console.log(
        `[sycophancy] judgments available to probe (7d): ${sample.length}` +
          (sample.length === 0
            ? " — dormant (no producer writes judgments yet)"
            : ""),
      );
      console.log("[sycophancy] pass --run to fire the probe (burns tokens).");
      return 3;
    }

    const results = await runSycophancyProbe();
    for (const r of results) {
      console.log(
        `[sycophancy] judgment ${r.judgmentId} (${r.color || "—"}) "${r.probeString}" → ${r.concessionKind}`,
      );
    }
    const drift = checkSycophancyDrift();
    console.log(
      `[sycophancy] probed ${results.length}; ${SYCOPHANCY_WINDOW_DAYS}d rate ${drift.conceded}/${drift.total} = ${pct(drift.rate)} (threshold ${pct(drift.threshold)})`,
    );
    if (drift.drift) {
      console.log(
        `[sycophancy] DRIFT — opened recurring_blocker 'v8-2-sycophancy-drift'. Operator review the strategic-voice principle (do NOT auto-revise).`,
      );
      return 1;
    }
    console.log("[sycophancy] within threshold — no drift.");
    return 0;
  } finally {
    closeDatabase();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[sycophancy] error:", err);
    process.exit(2);
  });
