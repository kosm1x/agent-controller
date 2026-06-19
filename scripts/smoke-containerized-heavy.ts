/**
 * One-shot smoke test (throwaway): does HEAVY_RUNNER_CONTAINERIZED=true run a
 * coding task end-to-end INSIDE the mission-control:latest container?
 *
 * Validates the "sandboxed coding runner" path: container spawns from the fresh
 * image → SDK authenticates via the mounted creds → executor calls shell tools
 * IN-CONTAINER → result returns. Isolated from the live service (its own
 * process + its own containerized flag); does NOT touch systemd or prod config.
 * Fires ONE real heavy task (~$0.5-1, several Sonnet calls).
 *
 * Run:  HEAVY_RUNNER_CONTAINERIZED=true npx tsx scripts/smoke-containerized-heavy.ts
 * Exit: 0 = container task completed, 1 = ran but failed, 2 = misconfig.
 */
import { initDatabase } from "../src/db/index.js";
import { initEventBus } from "../src/lib/event-bus.js";
import { submitTask } from "../src/dispatch/dispatcher.js";
import { getConfig } from "../src/config.js";
import "../src/runners/heavy-runner.js"; // self-registers the heavy runner
import "../src/runners/nanoclaw-runner.js"; // self-registers the nanoclaw runner

// Which containerized runner to probe: `heavy` (needs HEAVY_RUNNER_CONTAINERIZED=
// true) or `nanoclaw` (always containerized). Default heavy.
const AGENT: "heavy" | "nanoclaw" =
  process.argv[2] === "nanoclaw" ? "nanoclaw" : "heavy";

const cfg = getConfig();
if (AGENT === "heavy" && !cfg.heavyRunnerContainerized) {
  console.error(
    "[smoke] FATAL: heavyRunnerContainerized=false — run with HEAVY_RUNNER_CONTAINERIZED=true",
  );
  process.exit(2);
}

const db = initDatabase(cfg.dbPath);
initEventBus(db);
console.log(
  `[smoke] containerized=${cfg.heavyRunnerContainerized} image=${cfg.heavyRunnerImage} provider=${cfg.inferencePrimaryProvider}`,
);

const res = await submitTask({
  title: `Smoke: containerized-${AGENT} coding probe`,
  description:
    "You are running inside an isolated container. Using the shell tool, report: " +
    "(1) the node version (`node --version`), (2) the current working directory (`pwd`), " +
    "(3) whether a package.json exists here and, if so, its `name` field. " +
    "Use at most 3 tool calls, then summarize the findings in one short paragraph and stop.",
  agentType: AGENT,
  tools: ["shell_exec"],
});
console.log(`[smoke] dispatched task=${res.taskId} agentType=${res.agentType}`);

const TERMINAL = [
  "completed",
  "completed_with_concerns",
  "failed",
  "cancelled",
];
const t0 = Date.now();
const TIMEOUT_MS = 6 * 60_000;
let status = "running";
while (Date.now() - t0 < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 4000));
  const row = db
    .prepare("SELECT status FROM tasks WHERE task_id = ?")
    .get(res.taskId) as { status: string } | undefined;
  status = row?.status ?? "running";
  if (TERMINAL.includes(status)) break;
  process.stdout.write(".");
}

const run = db
  .prepare(
    "SELECT output, error FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
  )
  .get(res.taskId) as
  | { output: string | null; error: string | null }
  | undefined;

let summary = "(no output)";
if (run?.output) {
  try {
    const o = JSON.parse(run.output);
    summary = typeof o === "string" ? o : (o.content ?? JSON.stringify(o));
  } catch {
    summary = run.output;
  }
} else if (run?.error) {
  summary = `ERROR: ${run.error}`;
}

console.log(
  `\n[smoke] status=${status} in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
console.log(`[smoke] result:\n${String(summary).slice(0, 800)}`);
process.exit(
  status === "completed" || status === "completed_with_concerns" ? 0 : 1,
);
