/**
 * Self-healing triage monitor harness (operator / cron run).
 *
 * NOT a unit test: with `--run` it fires a REAL Claude Agent SDK call (the triage
 * sub-agent) and writes a `triage_report` row. Read-only otherwise. The monitor
 * NEVER remediates — `--run` writes a diagnosis for the operator to review.
 *
 * Activation: ships dormant. To arm the LIVE cron, set
 * `SELF_HEALING_TRIAGE_ENABLED=true` via a systemd drop-in (NOT .env) + restart.
 * This harness runs one tick on demand WITHOUT arming the cron.
 *
 * Usage (repo root, with the service's ~/.claude credentials):
 *   npx tsx scripts/run-triage-monitor.ts          # DRY — list current anomalies (no SDK, no write)
 *   npx tsx scripts/run-triage-monitor.ts --run     # full tick — triage + write a report (burns tokens)
 *
 * Exit codes: 0 = healthy / throttled, 1 = anomalies (DRY) or report written (--run),
 * 2 = error, 3 = analysis produced no report.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import {
  detectAnomalies,
  queryPrometheus,
  getStuckTaskCount,
  recentTaskErrors,
} from "../src/lib/self-healing/detect.js";
import { runTriageAnalysis } from "../src/lib/self-healing/analyze.js";
import {
  persistTriageReport,
  hasOpenTriageWithin,
} from "../src/lib/self-healing/persist.js";
import { runTriageTick } from "../src/lib/self-healing/tick.js";

const DB_PATH =
  process.env.MC_DB_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "data/mc.db");

const log = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(msg, fields ? JSON.stringify(fields) : ""),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.warn(msg, fields ? JSON.stringify(fields) : ""),
};

async function main(): Promise<number> {
  const armed = process.argv.includes("--run");
  initDatabase(DB_PATH);
  try {
    const db = getDatabase();
    const anomalies = await detectAnomalies({
      queryPrometheus,
      getStuckTaskCount: () => getStuckTaskCount(db),
    });

    if (anomalies.length === 0) {
      console.log("[triage] No anomalies detected — system healthy.");
      return 0;
    }
    console.log(`[triage] ${anomalies.length} anomaly(ies):`);
    for (const a of anomalies) {
      console.log(`  • [${a.severity}] ${a.kind}: ${a.detail}`);
    }

    if (!armed) {
      console.log(
        "[triage] DRY — no SDK call, no report written. Pass --run to triage.",
      );
      return 1;
    }

    const result = await runTriageTick(
      {
        detect: async () => anomalies,
        recentTriageExists: () => hasOpenTriageWithin(db, 6),
        analyze: (a) =>
          runTriageAnalysis(a, { recentErrors: recentTaskErrors(db) }),
        persist: (r, a, m) => persistTriageReport(db, r, a, m),
      },
      log,
    );

    if (result.throttled) {
      console.log(
        "[triage] Skipped — an open report already covers this window.",
      );
      return 0;
    }
    if (result.analysisFailed) return 3;
    console.log(
      `[triage] Report ${result.reportId} written (severity ${result.severity}). NOT auto-remediated — awaiting operator review.`,
    );
    return 1;
  } catch (err) {
    console.error(
      "[triage] error:",
      err instanceof Error ? err.message : String(err),
    );
    return 2;
  } finally {
    closeDatabase();
  }
}

void main().then((code) => process.exit(code));
