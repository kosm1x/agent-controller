/**
 * V8.2 Phase 9 — judgment-assembly producer harness (operator run).
 *
 * Runs `runJudgmentAssembly` ON DEMAND against a real brief, so the operator can
 * (a) smoke-test the §9 producer against the LIVE model without waiting for the
 * 06:00 cron, and (b) accumulate §17 shadow `judgments` faster than 1/day. Same
 * convention as `scripts/run-sycophancy-probe.ts` / `verify-v82-cache.ts`: DRY by
 * default (no SDK calls, no rows), `--run` to fire (burns tokens, writes rows).
 *
 * NOT a unit test and NOT CI — with `--run` it fires REAL Claude Agent SDK calls
 * and writes `judgments` / `attributed_claims` rows. Works regardless of
 * `V82_JUDGMENT_PRODUCER_ENABLED` (that flag gates the AUTOMATIC 06:00 pass; this
 * is an explicit operator action). The rows it writes are NOT delivered — the
 * operator-facing brief is untouched (shadow discipline).
 *
 * Brief source (in order):
 *   --construct  → build a FRESH morning brief now (1 V8.1 infer + S2 critic),
 *                  then produce against it. Cleanest for repeated accumulation.
 *   --brief <id> → a specific proposed_briefings row.
 *   (default)    → the latest morning brief already in proposed_briefings.
 *                  NOTE re-running on the SAME brief APPENDS more judgment rows;
 *                  prefer --construct when accumulating shadow volume.
 *
 * Usage (repo root, with the service's ~/.claude credentials):
 *   npx tsx scripts/run-judgment-producer.ts                  # DRY: which judgments would run
 *   npx tsx scripts/run-judgment-producer.ts --run            # fire against the latest brief
 *   npx tsx scripts/run-judgment-producer.ts --run --construct        # fresh brief, then produce
 *   npx tsx scripts/run-judgment-producer.ts --run --limit 1          # cap judgments this run
 *   npx tsx scripts/run-judgment-producer.ts --run --brief <uuid>     # a specific brief
 *
 * Exit codes: 0 = produced ≥1 judgment, 1 = ran but wrote 0, 2 = error,
 *             3 = dry (no --run), 4 = no brief available.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { BriefingSchema, type Briefing } from "../src/briefing/schema.js";
import { constructBriefing } from "../src/briefing/construct.js";
import {
  runJudgmentAssembly,
  selectJudgments,
  deriveStrategicQuestion,
} from "../src/lib/v8-2/produce.js";
import { getJudgmentById } from "../src/lib/v8-2/judgments-store.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.MC_DB_PATH ?? resolve(REPO_ROOT, "data/mc.db");

/** Hard ceiling — mirrors the producer's ABS_MAX_JUDGMENTS_PER_BRIEF. */
const ABS_MAX = 6;
const DEFAULT_MAX = 3;

/** Tiny argv reader (no dep) — matches the sibling harness style. */
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadBrief(briefId?: string): Briefing | null {
  const db = getDatabase();
  const row = (
    briefId
      ? db
          .prepare(
            `SELECT briefing_json FROM proposed_briefings WHERE briefing_id = ?`,
          )
          .get(briefId)
      : db
          .prepare(
            `SELECT briefing_json FROM proposed_briefings
              WHERE surface = 'morning'
              ORDER BY generated_at DESC LIMIT 1`,
          )
          .get()
  ) as { briefing_json: string } | undefined;
  if (!row) return null;
  const parsed = BriefingSchema.safeParse(JSON.parse(row.briefing_json));
  if (!parsed.success) {
    console.error(
      "[producer] latest brief failed schema parse:",
      parsed.error.message,
    );
    return null;
  }
  return parsed.data;
}

function claimStats(judgmentId: number): { total: number; resolved: number } {
  const r = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(resolver_status='resolved'),0) AS resolved
         FROM attributed_claims WHERE judgment_id = ?`,
    )
    .get(judgmentId) as { total: number; resolved: number };
  return r;
}

async function main(): Promise<number> {
  const armed = flag("run") || process.env.MC_PRODUCER_RUN === "1";
  const limitRaw = opt("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : DEFAULT_MAX;
  const max = Math.min(
    Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX,
    ABS_MAX,
  );

  initDatabase(DB_PATH);
  try {
    // 1. Obtain a Briefing.
    let briefing: Briefing | null;
    if (flag("construct")) {
      console.log(
        "[producer] constructing a fresh morning brief (1 infer + S2 critic)...",
      );
      const c = await constructBriefing({ surface: "morning" });
      if (!c.ok) {
        console.error(
          `[producer] constructBriefing failed at ${c.stage}: ${c.detail}`,
        );
        return 4;
      }
      briefing = c.briefing;
    } else {
      briefing = loadBrief(opt("brief"));
      if (!briefing) {
        console.error(
          "[producer] no morning brief found — pass --construct to build one.",
        );
        return 4;
      }
    }

    // 2. Dry preview — which judgments would run, and their derived questions.
    const selected = selectJudgments(briefing.judgments, max);
    console.log(
      `[producer] brief ${briefing.briefing_id} — ${briefing.judgments.length} judgment(s); selecting top ${selected.length} (cap ${max}):`,
    );
    for (const j of selected) {
      console.log(
        `  • [${j.posture}/${j.confidence}] ${j.subject} (${j.kind})\n      → ${deriveStrategicQuestion(j)}`,
      );
    }

    if (!armed) {
      console.log(
        `[producer] DRY — no SDK calls, no rows written. --run fires ≈${selected.length} judgment(s) × up to ~11 Sonnet calls each (delivery stays off; rows not shown to operator).`,
      );
      return 3;
    }

    // 3. Fire the producer.
    console.log("[producer] running (real model; writing shadow rows)...");
    const t0 = Date.now();
    const result = await runJudgmentAssembly(briefing, { maxJudgments: max });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[producer] done in ${secs}s — attempted ${result.attempted}, wrote ${result.written} judgment(s): [${result.judgmentIds.join(", ")}]`,
    );

    for (const id of result.judgmentIds) {
      const row = getJudgmentById(id);
      if (!row) continue;
      const cs = claimStats(id);
      const trail = row.criticTrailJson
        ? (JSON.parse(row.criticTrailJson) as {
            verdict?: string;
            iterations?: number;
          })
        : {};
      const hit =
        cs.total > 0 ? `${Math.round((100 * cs.resolved) / cs.total)}%` : "—";
      console.log(
        `  ✓ #${id} [${row.posture}/${row.confidence ?? "—"}] ${row.subject}` +
          ` — critic=${trail.verdict ?? "?"}(${trail.iterations ?? "?"}x), claims ${cs.resolved}/${cs.total} resolved (${hit})`,
      );
    }

    if (result.written === 0) {
      console.log(
        "[producer] wrote 0 — every selected judgment was skipped (decomposition failed) or errored. Check the logs above.",
      );
      return 1;
    }
    console.log(
      "[producer] shadow rows written. Track §17 progress with: ./mc-ctl briefing-gate",
    );
    return 0;
  } finally {
    closeDatabase();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[producer] error:", err);
    process.exit(2);
  });
