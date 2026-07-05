/**
 * Resume-run harness — the operator entry point for Prometheus partial
 * re-execution (2026-07-05 hardening sweep, wiring the `resume.ts` feature the
 * operator asked to finish). `resume.ts`/`resume-loader.ts` are complete + unit
 * tested; this is the safe CLI debut of a never-run-in-prod path, per CLAUDE.md
 * "Validating a risky / never-run path":
 *   - inherits the live service's env (INFERENCE_* / keys) via /proc — never printed;
 *   - loads + resumes against an ISOLATED COPY of mc.db (/tmp/resume-run.db) so it
 *     never contends with the running service or mutates live task state;
 *   - `--run` required to fire real SDK calls (resume re-executes failed goals).
 *
 * Usage:
 *   npx tsx scripts/resume-run.ts <taskId> [goalId]          # DRY: list resumable/failed goals
 *   npx tsx scripts/resume-run.ts <taskId> [goalId] --run    # actually resume
 * Exit: 0 = resumed OK, 1 = resumed but task still failed / not resumable,
 *       2 = usage/error, 3 = dry (no --run).
 *
 * NOTE (Lane E finding): only per-goal STATUS is persisted in runs.goal_graph,
 * not per-goal result TEXT, so resumed upstream context is thin by design. The
 * returned tokenUsage is the merged executor+reflect usage; this harness prints
 * it but does NOT write cost_ledger (that seam belongs to the dispatcher) — a
 * manual resume is rare and its cost is shown for the operator to note.
 */
import {
  readFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";

// 1) Inherit the live service env (INFERENCE_*, keys, TZ) via /proc — never printed.
function loadLiveEnv(): string | null {
  let pid = process.env.MC_PID ?? "";
  if (!pid) {
    try {
      pid = execSync("systemctl show -p MainPID --value mission-control", {
        encoding: "utf8",
      }).trim();
    } catch {
      /* ignore */
    }
  }
  if (pid && existsSync(`/proc/${pid}/environ`)) {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const kv of raw.split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) {
        const k = kv.slice(0, i);
        if (!(k in process.env)) process.env[k] = kv.slice(i + 1);
      }
    }
    return pid;
  }
  return null;
}
const livePid = loadLiveEnv();

// 2) Parse args (taskId + optional goalId, --run flag).
const RUN = process.argv.includes("--run");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const taskId = positional[0];
const goalIdArg = positional[1];
if (!taskId) {
  console.error(
    "usage: resume-run.ts <taskId> [goalId] [--run]  (run from repo root)",
  );
  process.exit(2);
}

// 3) Isolate the DB: snapshot the live one (incl. WAL/shm) into /tmp, root-only.
const SRC = "/root/claude/mission-control/data/mc.db";
const DST = "/tmp/resume-run.db";
for (const suf of ["", "-wal", "-shm"]) {
  try {
    if (existsSync(DST + suf)) rmSync(DST + suf);
    if (existsSync(SRC + suf)) {
      copyFileSync(SRC + suf, DST + suf);
      chmodSync(DST + suf, 0o600);
    }
  } catch {
    /* best-effort */
  }
}

// 4) Init the ISOLATED db BEFORE importing anything that calls getDatabase().
const { initDatabase, getDatabase } = await import("../src/db/index.js");
initDatabase(DST);

const { GoalStatus } = await import("../src/prometheus/types.js");
const { loadResumableRun } = await import("../src/prometheus/resume-loader.js");

const db = getDatabase();
const taskRow = db
  .prepare("SELECT title, description FROM tasks WHERE task_id = ?")
  .get(taskId) as { title?: string; description?: string } | undefined;
if (!taskRow) {
  console.error(`[resume-run] no task ${taskId} in ${DST}`);
  process.exit(2);
}
const taskDescription = taskRow.description || taskRow.title || "";

const loaded = loadResumableRun(taskId);
if (!loaded) {
  console.log(
    `[resume-run] task ${taskId} is NOT resumable (missing run / no persisted goal_graph / malformed). Nothing to do.`,
  );
  process.exit(1);
}

const failed = loaded.graph.getByStatus(GoalStatus.FAILED);
const goalId = goalIdArg ?? failed[0]?.id;

console.log(
  `[resume-run] task ${taskId} (livePid=${livePid ?? "?"}, db=${DST})`,
);
console.log(
  `[resume-run] resumable — ${failed.length} failed goal(s): ${failed.map((g) => g.id).join(", ") || "(none)"}`,
);
if (!goalId) {
  console.log(
    "[resume-run] no failed goal to resume from (and none supplied). Pass an explicit goalId to force.",
  );
  process.exit(1);
}

if (!RUN) {
  console.log(
    `[resume-run] DRY — would resume from goal '${goalId}'. Pass --run to fire real SDK calls.`,
  );
  process.exit(3);
}

// 5) Register the builtin tool source so re-executed goals have tools (index.ts
// parity — without this sub-agents fail with "No tools available.").
const { toolRegistry } = await import("../src/tools/registry.js");
const { ToolSourceManager } = await import("../src/tools/source.js");
const { BuiltinToolSource } = await import("../src/tools/sources/builtin.js");
const sourceManager = new ToolSourceManager();
sourceManager.addSource(new BuiltinToolSource());
await sourceManager.initAll(toolRegistry);

const { resumeFromRun } = await import("../src/prometheus/resume.js");

console.log(`[resume-run] resuming from '${goalId}'...`);
const result = await resumeFromRun(taskId, taskDescription, goalId);
if (!result) {
  console.log("[resume-run] resume returned null (not resumable).");
  process.exit(1);
}
const u = result.tokenUsage;
console.log(
  `[resume-run] done — success=${result.success} durationMs=${result.durationMs} ` +
    `tokens=(prompt ${u.promptTokens}, completion ${u.completionTokens}` +
    `${u.cacheReadTokens ? `, cacheRead ${u.cacheReadTokens}` : ""})`,
);
console.log(
  "[resume-run] NOTE: ran against an isolated DB copy — the live task row was not mutated. Cost not written to cost_ledger (manual resume).",
);
process.exit(result.success ? 0 : 1);
