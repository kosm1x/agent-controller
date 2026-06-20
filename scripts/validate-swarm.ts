/**
 * One-off swarm validation harness (operator/agent run, NOT CI).
 *
 * The `swarm` runner has 0 lifetime executions — its plan-decompose → parallel
 * sub-task fan-out → poll → aggregate path has never run in prod. Before wiring
 * live chat fan-outs to it, this debuts it END-TO-END but SAFELY:
 *   - against an ISOLATED COPY of the live DB (/tmp/swarm-validate.db) so it never
 *     contends with the running service or pollutes live task/cost state;
 *   - inheriting the live service's env (model endpoints etc.) via /proc/<pid>/environ
 *     so sub-agents reach the same inference backend (secrets are loaded, never printed);
 *   - with a BOUNDED non-filesystem fan-out (3 independent text items) so sub-tasks
 *     classify to `fast` (not the nanoclaw sandbox) and the result is verifiable from
 *     the DB (sub-task rows + outputs), not host-vs-container /tmp writes.
 *
 * `--run` required (it fires REAL SDK calls — small, but real spend).
 * Usage:  npx tsx scripts/validate-swarm.ts --run     (run from repo root)
 * Exit:   0 = PASS (decomposed + fanned out + sub-tasks completed), 1 = FAIL/PARTIAL,
 *         2 = error, 3 = dry (no --run).
 */
import {
  readFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";

// 1) Inherit the live service's env (INFERENCE_*, keys, TZ) via /proc — never printed.
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

// 2) Isolate the DB: snapshot the live one (incl. WAL/shm) into /tmp.
const SRC = "/root/claude/mission-control/data/mc.db";
const DST = "/tmp/swarm-validate.db";
for (const suf of ["", "-wal", "-shm"]) {
  try {
    if (existsSync(DST + suf)) rmSync(DST + suf);
    if (existsSync(SRC + suf)) {
      copyFileSync(SRC + suf, DST + suf);
      // The copy is a full snapshot of mc.db (irreplaceable memories) — keep it
      // root-only at rest in /tmp, not world-readable.
      chmodSync(DST + suf, 0o600);
    }
  } catch {
    /* best-effort */
  }
}

// 3) Init the ISOLATED db BEFORE importing any runtime that calls getDatabase().
const { initDatabase, getDatabase } = await import("../src/db/index.js");
initDatabase(DST);

// 4) Register runners (side-effect imports) + dispatcher.
await import("../src/runners/fast-runner.js");
await import("../src/runners/heavy-runner.js");
await import("../src/runners/swarm-runner.js");
const { submitTask } = await import("../src/dispatch/dispatcher.js");

if (!process.argv.includes("--run")) {
  console.log(
    `[validate-swarm] DRY — pass --run to fire. livePid=${livePid ?? "?"} db=${DST}`,
  );
  process.exit(3);
}

// 5) Register the builtin tool source (index.ts:203-217) so `fast` sub-agents have
// tools — without this they fail with "No tools available." (harness-only setup;
// the live service registers builtin + MCP + Google + Memory + Skills sources).
const { toolRegistry } = await import("../src/tools/registry.js");
const { ToolSourceManager } = await import("../src/tools/source.js");
const { BuiltinToolSource } = await import("../src/tools/sources/builtin.js");
const sourceManager = new ToolSourceManager();
sourceManager.addSource(new BuiltinToolSource());
await sourceManager.initAll(toolRegistry);
console.log(
  `[validate-swarm] registered ${toolRegistry.list().length} builtin tools`,
);

const TASK_PHRASE =
  "Independent fan-out. For EACH of these three topics — the APPLE, the BANANA, and the CHERRY — produce one short factual sentence about that fruit. The three are fully independent; do all three.";

async function main() {
  console.log(
    `[validate-swarm] livePid=${livePid ?? "?"} isolated-db=${DST} — submitting swarm task...`,
  );
  const res = await submitTask({
    title: "Validate swarm fan-out",
    description: TASK_PHRASE,
    agentType: "swarm",
    priority: "medium",
    interactive: false,
  } as Parameters<typeof submitTask>[0]);
  const swarmTaskId = (res as { taskId?: string })?.taskId;
  console.log(`[validate-swarm] swarm taskId=${swarmTaskId}`);

  const db = getDatabase();
  const TERMINAL = ["completed", "completed_with_concerns", "failed"];
  const start = Date.now();
  const TIMEOUT_MS = 8 * 60 * 1000;
  let parentStatus = "unknown";
  while (Date.now() - start < TIMEOUT_MS) {
    const p = db
      .prepare("SELECT status FROM tasks WHERE task_id = ?")
      .get(swarmTaskId) as { status?: string } | undefined;
    parentStatus = p?.status ?? "unknown";
    const subN = (
      db
        .prepare("SELECT COUNT(*) n FROM tasks WHERE parent_task_id = ?")
        .get(swarmTaskId) as { n: number }
    ).n;
    process.stdout.write(
      `\r[validate-swarm] parent=${parentStatus} subtasks=${subN} t=${Math.round((Date.now() - start) / 1000)}s   `,
    );
    if (TERMINAL.includes(parentStatus)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }

  const subs = db
    .prepare(
      "SELECT task_id, status, agent_type, length(output) ol, substr(title,1,46) t FROM tasks WHERE parent_task_id = ? ORDER BY id",
    )
    .all(swarmTaskId) as Array<{
    task_id: string;
    status: string;
    agent_type: string;
    ol: number | null;
    t: string;
  }>;

  console.log("\n\n=== SWARM VALIDATION RESULT ===");
  console.log(`parent status : ${parentStatus}`);
  console.log(`sub-tasks     : ${subs.length}`);
  for (const s of subs)
    console.log(`  [${s.status}] ${s.agent_type} out=${s.ol ?? 0}b  ${s.t}`);

  const completedSubs = subs.filter((s) =>
    s.status.startsWith("completed"),
  ).length;
  const fannedOut = subs.length >= 2;
  const parentOk = parentStatus.startsWith("completed");
  const verdict =
    parentOk && fannedOut && completedSubs >= 2
      ? "PASS — swarm decomposed, fanned out, and sub-tasks completed"
      : parentOk && subs.length <= 1
        ? "WEAK — swarm completed but did NOT fan out (planner made ≤1 goal)"
        : "FAIL/PARTIAL — see statuses above";
  console.log(`\nVERDICT: ${verdict}`);
  process.exit(verdict.startsWith("PASS") ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[validate-swarm] ERROR:", err);
  process.exit(2);
});
