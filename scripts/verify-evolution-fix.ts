/**
 * Verify the skill-evolution deterministic-persist + Opus-pin fix (e9f7721).
 *
 * NOT a unit test: fires a REAL heavy/Opus run (~$1.50). Operator-run, --run
 * gated. Runs the actual `createEvolutionRitual` through `submitTask` against an
 * ISOLATED snapshot of data/mc.db, so it cannot contend with the live service
 * or pollute live memory. Exercises the exact fixed path:
 *   createEvolutionRitual (no memory_store) -> submitTask -> heavy-runner
 *   -> collectFinalAnswer -> dispatcher persistResult -> memory.retain.
 *
 * PASS = task reaches completed AND a NEW [evolution] memory row was stored.
 *
 *   (env loaded from the live service via the wrapper)
 *   npx tsx scripts/verify-evolution-fix.ts --run [label]
 *
 * Exit: 0 PASS · 1 CHECK (not completed or nothing persisted) · 2 error · 3 dry.
 */

import { copyFileSync, existsSync, chmodSync } from "fs";
import { initDatabase, getDatabase } from "../src/db/index.js";
import { initMemoryService } from "../src/memory/index.js";
import { ToolSourceManager } from "../src/tools/source.js";
import { BuiltinToolSource } from "../src/tools/sources/builtin.js";
import { toolRegistry } from "../src/tools/registry.js";
import { submitTask } from "../src/dispatch/dispatcher.js";
import { createEvolutionRitual } from "../src/rituals/evolution.js";
import "../src/runners/heavy-runner.js"; // side-effect: registers the heavy runner

const LIVE = "data/mc.db";
const SNAP = "/tmp/mc-evolution-verify.db";
const TERMINAL = new Set([
  "completed",
  "completed_with_concerns",
  "failed",
  "blocked",
  "cancelled",
  "needs_context",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  if (!process.argv.includes("--run")) {
    console.log("[verify-evolution] DRY — pass --run to fire a real Opus run.");
    return 3;
  }
  // Exercise the fixed SOURCE in-process, never the stale container image.
  process.env.HEAVY_RUNNER_CONTAINERIZED = "false";

  // Isolated snapshot of the live DB (+ WAL/SHM) — full memory snapshot.
  for (const suf of ["", "-wal", "-shm"]) {
    if (existsSync(LIVE + suf)) copyFileSync(LIVE + suf, SNAP + suf);
  }
  chmodSync(SNAP, 0o600);

  initDatabase(SNAP);
  await initMemoryService();
  const mgr = new ToolSourceManager();
  mgr.addSource(new BuiltinToolSource());
  await mgr.initAll(toolRegistry);

  const db = getDatabase();
  const beforeMaxId =
    (
      db
        .prepare("SELECT COALESCE(MAX(id),0) AS m FROM conversations")
        .get() as {
        m: number;
      }
    ).m ?? 0;

  const label = process.argv[3] ?? "verify";
  const ritual = createEvolutionRitual(label);
  console.log(
    `[verify-evolution] ritual: agentType=${ritual.agentType} tools=${JSON.stringify(ritual.tools)} persistResult=${JSON.stringify(ritual.persistResult)}`,
  );

  const { taskId, agentType, classification } = await submitTask(ritual);
  console.log(
    `[verify-evolution] submitted taskId=${taskId} agentType=${agentType} explicit=${classification.explicit}`,
  );

  // Poll until terminal (heavy run ~5-8 min).
  const start = Date.now();
  const MAX_MS = 12 * 60_000;
  let status = "queued";
  while (Date.now() - start < MAX_MS) {
    await sleep(5000);
    const row = db
      .prepare("SELECT status FROM tasks WHERE task_id=?")
      .get(taskId) as { status?: string } | undefined;
    status = row?.status ?? "missing";
    if (TERMINAL.has(status)) break;
    console.log(
      `[verify-evolution] ...${Math.round((Date.now() - start) / 1000)}s status=${status}`,
    );
  }
  console.log(`[verify-evolution] FINAL task status = ${status}`);

  // The dispatcher persists AFTER the status flip (same continuation) — give it
  // a grace window to land + flush.
  await sleep(8000);

  const mem = db
    .prepare(
      `SELECT id, bank, tags, source, length(content) AS len, substr(content,1,220) AS preview
         FROM conversations
        WHERE id > ? AND tags LIKE '%evolution%'
        ORDER BY id DESC LIMIT 5`,
    )
    .all(beforeMaxId) as Array<Record<string, unknown>>;

  console.log(
    `[verify-evolution] NEW [evolution] memories stored: ${mem.length}`,
  );
  for (const m of mem) console.log("  " + JSON.stringify(m));

  const completed =
    status === "completed" || status === "completed_with_concerns";
  const persisted = mem.length > 0;
  const ok = completed && persisted;
  console.log(
    ok
      ? "[verify-evolution] PASS — ritual completed AND report persisted deterministically."
      : `[verify-evolution] CHECK — completed=${completed} persisted=${persisted}.`,
  );
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[verify-evolution] ERROR", e);
    process.exit(2);
  });
