/**
 * Opus-tier A/B benchmark — `claude-opus-4-8` (incumbent) vs `claude-opus-5`
 * on the Prometheus complex paths, replaying REAL stored heavy tasks
 * (2026-09-15; plan in docs/planning/opus-tier-benchmark-2026-09-15.md).
 *
 * Why a harness and not a swap: the Sonnet 5 attempt (06-30→07-01) regressed
 * tokenizer (+30%), cache-read ratio (62%→49%) and delivery before anyone
 * measured it. This measures FIRST, on our own workload, with nothing live.
 *
 * Safety (validate-* pattern, CLAUDE.md "Validating a risky / never-run path"):
 *   - live service env inherited via /proc/<MainPID>/environ ONLY with --run —
 *     never printed;
 *   - every phase runs against an ISOLATED COPY of mc.db (scratch path, 0600);
 *   - `--run` required for real SDK calls; a cumulative --max-usd stops the run;
 *   - executor replays (stage 2) get an explicit READ-ONLY, in-box tool
 *     allow-list (file/grep/glob/list/code_search/pdf/project reads; no
 *     shell_exec, nothing that leaves the box);
 *   - planner/reflect/selfAssess pass costLedger:false; the executor's seam
 *     metering writes go to the snapshot, not the live ledger.
 *
 * Arms (interleaved per task so time-of-day drift is shared):
 *   A = production shape: thinking disabled, effort unset (SDK default "high")
 *   B = adaptive thinking + effort medium (the claude-api guidance for Opus 5's
 *       two thinking-disabled failure modes: tool call written into visible
 *       text, `<thinking>` tag leakage)
 *   × models 4-8 / 5  → 4 arms.
 *
 * Stages:
 *   1 (default) plan() on every task, reflect() on every task (goal results
 *     reconstructed from the stored run), selfAssess() on single-goal tasks
 *     (stored finalAnswer == the goal's output). No tools. ~cents per call.
 *   2 executeGraph() with the read-only allow-list on the --tasks given, then
 *     reflect() on the fresh result. Real tool loops — dollars per run.
 *
 * Usage (repo root):
 *   npx tsx scripts/benchmark-opus-tier.ts                       # DRY: task set, arms, stage-2 tool list
 *   npx tsx scripts/benchmark-opus-tier.ts --run                 # stage 1, default task set
 *   npx tsx scripts/benchmark-opus-tier.ts --run --stage=2 --tasks=b8e2700a,656a4b94,b324396a
 *   npx tsx scripts/benchmark-opus-tier.ts --summarize --out=<dir>   # re-render summary.md
 * Flags: --models=a,b  --configs=A,B  --tasks=<8-char prefixes>  --out=<dir>
 *        --max-usd=N (stage 1 default 20, stage 2 default 40)  --effort-b=medium
 * Exit: 0 done, 2 usage/error, 3 dry.
 */
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
};
const RUN = argv.includes("--run");
const SUMMARIZE_ONLY = argv.includes("--summarize");
const STAGE = Number(flag("stage") ?? "1");
if (STAGE !== 1 && STAGE !== 2) {
  console.error("[bench] --stage must be 1 or 2");
  process.exit(2);
}
const MODELS = (flag("models") ?? "claude-opus-4-8,claude-opus-5").split(",");
const CONFIGS = (flag("configs") ?? "A,B").split(",") as Array<"A" | "B">;
const EFFORT_B = (flag("effort-b") ?? "medium") as "low" | "medium" | "high" | "max";
const MAX_USD = Number(flag("max-usd") ?? (STAGE === 2 ? "40" : "20"));
if (!Number.isFinite(MAX_USD) || MAX_USD <= 0) {
  console.error("[bench] --max-usd must be a positive number");
  process.exit(2);
}
// data/ is gitignored; a session scratchpad or /tmp can be cleaned mid-run.
const SCRATCH = process.env.MC_BENCH_SCRATCH ?? "/root/claude/mission-control/data/opus-bench";
if (SUMMARIZE_ONLY && !flag("out")) {
  console.error("[bench] --summarize needs --out=<results dir>");
  process.exit(2);
}
const OUT = flag("out") ?? join(SCRATCH, `stage${STAGE}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
const RESULTS = join(OUT, "results.jsonl");

// Default replay set: 3 use-case families, all Opus-run heavy tasks (30d).
// Single-goal rows double as selfAssess inputs (stored finalAnswer == goal output).
const DEFAULT_TASKS = [
  "d6920620", // Skill evolution — 2026-09-05 (nightly ritual, 4 goals)
  "1ae5fe56", // Skill evolution — 2026-09-03
  "7ab38110", // Williams W37 analyst commentary rewrite (6 goals, 31 tool calls)
  "b324396a", // trustr.mx handover review (3 goals, read-only)
  "656a4b94", // Read LEARNINGS doc + report (2 goals, read-only)
  "613df433", // Fantasy 10k USD strategy (6 goals, $8.42 — the expensive shape)
  "eb91914c", // Deep research self-eval (3 goals, score 0.65)
  "e71f51d5", // Google Doc audit (4 goals, 34 KB description)
  "b8e2700a", // Swarm child: inspect demo files (1 goal) → selfAssess
  "8202d36a", // Swarm child (1 goal) → selfAssess
  "62229255", // Swarm child (1 goal) → selfAssess
  "92f0ceec", // Bariatric swarm child (1 goal) → selfAssess
  "bcaf39e5", // Bariatric consolidate action plans (1 goal, 18 tool calls) → selfAssess
];
const TASKS = (flag("tasks") ?? DEFAULT_TASKS.join(",")).split(",").filter(Boolean);

// Executor replays (stage 2) may only call these — local, read-only,
// in-box tools (each must ALSO carry readOnlyHint in the registry; the
// harness refuses to run if any is missing — see stage-2 init). Deliberately
// absent: shell_exec (the stored runs used it; replays trade that fidelity
// for zero write risk), knowledge_map (writes maps + its own un-metered
// infer despite readOnlyHint), pdf_read (URL mode leaves the box),
// project_get (returns stored credentials), and anything search/market/
// social/web.
const READ_ONLY_ALLOW = [
  "file_read", "jarvis_file_read", "jarvis_file_list", "jarvis_file_search",
  "grep", "glob", "list_dir", "code_search", "data_summarize",
  "project_list", "user_fact_list",
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Summary renderer (works on partial results — safe to call mid-run)
// ---------------------------------------------------------------------------
interface CallRow {
  task: string;
  family: string;
  phase: "plan" | "reflect" | "assess" | "execute";
  model: string;
  config: "A" | "B";
  reportedModel?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  numTurns?: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  textChars: number;
  bareJson?: boolean;
  fencedJson?: boolean;
  thinkingLeak: boolean;
  toolCallInText: boolean;
  goals?: number;
  criteria?: number;
  gates?: number;
  storedGoals?: number;
  score?: number;
  storedScore?: number;
  met?: boolean | null;
  toolCalls?: number;
  storedToolCalls?: number;
  completedGoals?: number;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function renderSummary(rows: CallRow[]): string {
  const arms = [...new Set(rows.map((r) => `${r.model}|${r.config}`))].sort();
  const lines: string[] = [];
  lines.push(`# Opus-tier benchmark — ${OUT.split("/").pop()} — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Rows: ${rows.length} · tasks: ${new Set(rows.map((r) => r.task)).size} · spend: $${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`);
  lines.push("");
  for (const phase of ["plan", "reflect", "assess", "execute"] as const) {
    const ph = rows.filter((r) => r.phase === phase);
    if (ph.length === 0) continue;
    lines.push(`## ${phase}`);
    lines.push("");
    lines.push(
      "| arm | n | ok | bare JSON | think-leak | tool-in-text | prompt tok | cache-read | compl tok | $/call | s/call | turns | " +
        (phase === "plan" ? "goals (stored) | criteria | gates |" : phase === "execute" ? "tool calls (stored) | goals done | score |" : phase === "reflect" ? "score (stored) | success agree |" : "met (stored run completed every one) |"),
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|" + (phase === "plan" ? "---|---|---|" : phase === "execute" ? "---|---|---|" : phase === "reflect" ? "---|---|" : "---|"));
    for (const arm of arms) {
      const [model, config] = arm.split("|");
      const a = ph.filter((r) => r.model === model && r.config === config);
      if (a.length === 0) continue;
      // Rates/means over OK rows only — a failed row carries zeros and would
      // deflate exactly the token/cost comparison the decision rule turns on.
      const okRows = a.filter((r) => r.ok);
      const prompt = mean(okRows.map((r) => r.promptTokens));
      const cacheRead = okRows.reduce((s, r) => s + r.cacheReadTokens, 0);
      const promptSum = okRows.reduce((s, r) => s + r.promptTokens, 0);
      const isExec = phase === "execute"; // per-call text/turn stats are not defined for a whole graph run
      const base =
        `| ${model} ${config} | ${a.length} | ${pct(okRows.length, a.length)} | ${isExec ? "n/a" : pct(okRows.filter((r) => r.bareJson).length, okRows.length)} | ` +
        `${a.filter((r) => r.thinkingLeak).length} | ${a.filter((r) => r.toolCallInText).length} | ${prompt.toFixed(0)} | ` +
        `${pct(cacheRead, promptSum)} | ${mean(okRows.map((r) => r.completionTokens)).toFixed(0)} | ` +
        `${mean(okRows.map((r) => r.costUsd)).toFixed(3)} | ${(mean(okRows.map((r) => r.durationMs)) / 1000).toFixed(1)} | ${isExec ? "n/a" : mean(okRows.map((r) => r.numTurns ?? 0)).toFixed(1)} |`;
      let tail = "";
      if (phase === "plan") {
        tail = ` ${mean(okRows.map((r) => r.goals ?? 0)).toFixed(1)} (${mean(okRows.map((r) => r.storedGoals ?? 0)).toFixed(1)}) | ${mean(okRows.map((r) => r.criteria ?? 0)).toFixed(1)} | ${mean(okRows.map((r) => r.gates ?? 0)).toFixed(1)} |`;
      } else if (phase === "execute") {
        tail = ` ${mean(okRows.map((r) => r.toolCalls ?? 0)).toFixed(1)} (${mean(okRows.map((r) => r.storedToolCalls ?? 0)).toFixed(1)}) | ${mean(okRows.map((r) => r.completedGoals ?? 0)).toFixed(1)}/${mean(okRows.map((r) => r.storedGoals ?? 0)).toFixed(1)} | ${mean(okRows.map((r) => r.score ?? 0)).toFixed(2)} |`;
      } else if (phase === "reflect") {
        const agree = okRows.filter((r) => (r.score ?? 0) >= 0.8 === (r.storedScore ?? 0) >= 0.8).length;
        tail = ` ${mean(okRows.map((r) => r.score ?? 0)).toFixed(2)} (${mean(okRows.map((r) => r.storedScore ?? 0)).toFixed(2)}) | ${pct(agree, okRows.length)} |`;
      } else {
        // Every assess input is a goal the stored 4.8 run completed, so met=true is the expected reading.
        const metRows = okRows.filter((r) => r.met !== null && r.met !== undefined);
        tail = ` ${pct(metRows.filter((r) => r.met).length, metRows.length)} |`;
      }
      lines.push(base + tail);
    }
    lines.push("");
  }
  const errs = rows.filter((r) => !r.ok);
  if (errs.length) {
    lines.push("## Errors");
    lines.push("");
    for (const e of errs) lines.push(`- ${e.task} ${e.phase} ${e.model}/${e.config}: ${e.error}`);
    lines.push("");
  }
  lines.push("Agreement columns compare against the STORED 4.8 production run (a proxy, not ground truth): reflect = success threshold 0.8 on both; assess = met on a goal the stored run completed. Spend cap is checked after each recorded call/graph run, not mid-run.");
  return lines.join("\n");
}

if (SUMMARIZE_ONLY) {
  const rows = existsSync(RESULTS)
    ? readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallRow)
    : [];
  const md = renderSummary(rows);
  writeFileSync(join(OUT, "summary.md"), md);
  console.log(md);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1) Live env (only with --run) — inherited via /proc, never printed.
// ---------------------------------------------------------------------------
if (RUN) {
  let pid = process.env.MC_PID ?? "";
  if (!pid) {
    try {
      pid = execSync("systemctl show -p MainPID --value mission-control", { encoding: "utf8" }).trim();
    } catch {
      /* ignore */
    }
  }
  if (!pid || !existsSync(`/proc/${pid}/environ`)) {
    console.error("[bench] cannot find the live mission-control env (MainPID); set MC_PID=<pid>.");
    process.exit(2);
  }
  for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0 && !(kv.slice(0, i) in process.env)) process.env[kv.slice(0, i)] = kv.slice(i + 1);
  }
}
process.env.BUDGET_ENABLED = "false";
process.env.BUDGET_ENFORCE = "false";

// ---------------------------------------------------------------------------
// 2) Isolated DB copy (always — the dry run lists the task set from it).
// ---------------------------------------------------------------------------
const SRC_DB = "/root/claude/mission-control/data/mc.db";
const DST_DB = join(SCRATCH, "bench.db");
mkdirSync(SCRATCH, { recursive: true });
copyFileSync(SRC_DB, DST_DB);
chmodSync(DST_DB, 0o600);
for (const ext of ["-wal", "-shm"]) {
  if (existsSync(SRC_DB + ext)) {
    copyFileSync(SRC_DB + ext, DST_DB + ext);
    chmodSync(DST_DB + ext, 0o600);
  }
}
const { initDatabase, getDatabase } = await import("../src/db/index.js");
initDatabase(DST_DB);
const db = getDatabase();

interface StoredTask {
  task: string;
  taskId: string;
  title: string;
  description: string;
  family: string;
  graph: { goals: Record<string, import("../src/prometheus/types.js").Goal> };
  finalAnswer: string;
  storedScore: number;
  storedToolCalls: string[];
  storedDurationMs: number;
}
function familyOf(title: string): string {
  if (/skill evolution/i.test(title)) return "ritual";
  if (/^\[swarm\]/i.test(title)) return "swarm-child";
  if (/fantasy|estrateg|research/i.test(title)) return "strategy";
  return "ops";
}
const stored: StoredTask[] = [];
for (const prefix of TASKS) {
  const row = db
    .prepare(
      `SELECT t.task_id, t.title, t.description, r.goal_graph, r.output, r.tool_calls, r.duration_ms
         FROM tasks t JOIN runs r ON r.task_id = t.task_id
        WHERE t.task_id LIKE ? AND r.status = 'completed' AND r.goal_graph IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get(`${prefix}%`) as
    | { task_id: string; title: string; description: string; goal_graph: string; output: string; tool_calls: string | null; duration_ms: number }
    | undefined;
  if (!row) {
    console.error(`[bench] task ${prefix}: no completed run with a goal_graph — skipped`);
    continue;
  }
  const out = JSON.parse(row.output ?? "{}") as { finalAnswer?: string; score?: number };
  stored.push({
    task: prefix,
    taskId: row.task_id,
    title: row.title,
    description: row.description || row.title,
    family: familyOf(row.title),
    graph: JSON.parse(row.goal_graph),
    finalAnswer: out.finalAnswer ?? "",
    storedScore: out.score ?? 0,
    storedToolCalls: row.tool_calls ? (JSON.parse(row.tool_calls) as string[]) : [],
    storedDurationMs: row.duration_ms,
  });
}
if (stored.length === 0) {
  console.error("[bench] no replayable tasks");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 3) Tools (stage 2 only): builtin source, READ-ONLY allow-list.
// ---------------------------------------------------------------------------
const { toolRegistry } = await import("../src/tools/registry.js");
{
  const { ToolSourceManager } = await import("../src/tools/source.js");
  const { BuiltinToolSource } = await import("../src/tools/sources/builtin.js");
  const sm = new ToolSourceManager();
  sm.addSource(new BuiltinToolSource());
  await sm.initAll(toolRegistry);
}
// Refuse, never narrow: `getDefinitions([])` hands the model the WHOLE registry
// (shell_exec included), so a missing/renamed/no-longer-read-only tool must stop
// the run rather than silently shrink — or empty — the allow-list.
const missing = READ_ONLY_ALLOW.filter((n) => toolRegistry.get(n)?.readOnlyHint !== true);
if (missing.length > 0) {
  console.error(`[bench] allow-list tools missing or not readOnlyHint: ${missing.join(", ")} — refusing to run`);
  process.exit(2);
}
const readOnlyTools = [...READ_ONLY_ALLOW].sort();

// ---------------------------------------------------------------------------
// 4) Arms
// ---------------------------------------------------------------------------
const { setOpusTierBenchmarkOverride } = await import("../src/inference/claude-sdk.js");
interface Arm {
  model: string;
  config: "A" | "B";
}
const ARMS: Arm[] = MODELS.flatMap((model) => CONFIGS.map((config) => ({ model, config })));

console.log(`[bench] stage ${STAGE} · ${stored.length} task(s) · arms: ${ARMS.map((a) => `${a.model}/${a.config}`).join(", ")} · max $${MAX_USD} · out ${OUT}`);
for (const t of stored) {
  const goals = Object.keys(t.graph.goals).length;
  console.log(`  ${t.task} [${t.family}] goals=${goals} storedScore=${t.storedScore} tools=${t.storedToolCalls.length} desc=${t.description.length}ch — ${t.title.slice(0, 70)}`);
}
console.log(`[bench] stage-2 read-only tool allow-list (${readOnlyTools.length}): ${readOnlyTools.join(", ")}`);
if (!RUN) {
  console.log("[bench] DRY — pass --run to fire real SDK calls (see plan doc for the per-stage estimate).");
  process.exit(3);
}

// ---------------------------------------------------------------------------
// 5) Run
// ---------------------------------------------------------------------------
type SdkResult = import("../src/inference/claude-sdk.js").ClaudeSdkResult;
let lastRaw: SdkResult | undefined;
let spent = 0;
const THINK_LEAK_RE = /<\/?thinking>|<\/?antml:thinking>/i;
const TOOL_IN_TEXT_RE = /<(antml:)?(function_calls|invoke)\b|mcp__jarvis__[a-z_]+\s*[({]|"tool_use"\s*:/i;

function armOverride(arm: Arm) {
  return arm.config === "A"
    ? { opusModel: arm.model, noFallback: true, tap: (r: SdkResult) => (lastRaw = r) }
    : { opusModel: arm.model, thinking: { type: "adaptive" as const }, effort: EFFORT_B, noFallback: true, tap: (r: SdkResult) => (lastRaw = r) };
}

function record(base: Omit<CallRow, keyof RawFields> & Partial<RawFields>): void {
  const raw = lastRaw;
  const text = raw?.text ?? "";
  const trimmed = text.trim();
  let bare = false;
  try {
    JSON.parse(trimmed);
    bare = true;
  } catch {
    /* not bare */
  }
  const row: CallRow = {
    reportedModel: raw?.model,
    durationMs: raw?.durationMs ?? 0,
    numTurns: raw?.numTurns,
    promptTokens: raw?.usage.promptTokens ?? 0,
    completionTokens: raw?.usage.completionTokens ?? 0,
    cacheReadTokens: raw?.usage.cacheReadTokens ?? 0,
    cacheCreationTokens: raw?.usage.cacheCreationTokens ?? 0,
    costUsd: raw?.costUsd ?? 0,
    textChars: text.length,
    bareJson: bare,
    fencedJson: !bare && /```json/i.test(text),
    thinkingLeak: THINK_LEAK_RE.test(text),
    toolCallInText: TOOL_IN_TEXT_RE.test(text),
    ...base,
  } as CallRow;
  spent += row.costUsd;
  appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  console.log(
    `  ${row.task} ${row.phase.padEnd(7)} ${row.model}/${row.config} ok=${row.ok} ${(row.durationMs / 1000).toFixed(0)}s $${row.costUsd.toFixed(3)} tok=${row.promptTokens}/${row.completionTokens} cacheR=${row.cacheReadTokens}` +
      (row.goals !== undefined ? ` goals=${row.goals}/${row.storedGoals} gates=${row.gates}` : "") +
      (row.score !== undefined ? ` score=${row.score}/${row.storedScore}` : "") +
      (row.met !== undefined ? ` met=${row.met}` : "") +
      (row.thinkingLeak ? " THINK-LEAK" : "") +
      (row.toolCallInText ? " TOOL-IN-TEXT" : "") +
      (row.error ? ` err=${row.error.slice(0, 120)}` : ""),
  );
  lastRaw = undefined;
  if (spent > MAX_USD) {
    console.error(`[bench] spend $${spent.toFixed(2)} exceeded --max-usd ${MAX_USD}; stopping.`);
    finish();
    process.exit(2);
  }
}
type RawFields = Pick<CallRow, "reportedModel" | "durationMs" | "numTurns" | "promptTokens" | "completionTokens" | "cacheReadTokens" | "cacheCreationTokens" | "costUsd" | "textChars" | "bareJson" | "fencedJson" | "thinkingLeak" | "toolCallInText">;

function finish(): void {
  const rows = readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallRow);
  const md = renderSummary(rows);
  writeFileSync(join(OUT, "summary.md"), md);
  console.log(`\n${md}\n[bench] spent $${spent.toFixed(2)} · results ${RESULTS}`);
}

const { plan } = await import("../src/prometheus/planner.js");
const { reflect } = await import("../src/prometheus/reflector.js");
const { selfAssess, executeGraph } = await import("../src/prometheus/executor.js");
const { GoalGraph } = await import("../src/prometheus/goal-graph.js");
const { GoalStatus } = await import("../src/prometheus/types.js");
type ExecutionResult = import("../src/prometheus/types.js").ExecutionResult;

function storedExecutionResult(t: StoredTask): ExecutionResult {
  const ids = Object.keys(t.graph.goals).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const last = ids[ids.length - 1];
  const goalResults: ExecutionResult["goalResults"] = {};
  for (const id of ids) {
    const g = t.graph.goals[id];
    goalResults[id] = {
      goalId: id,
      ok: g.status === GoalStatus.COMPLETED,
      result: id === last || ids.length === 1 ? t.finalAnswer : "Completed (per-goal output text is not persisted; see the final goal's result).",
      durationMs: Math.round(t.storedDurationMs / ids.length),
      toolCalls: id === last ? t.storedToolCalls.length : 0,
      toolNames: id === last ? t.storedToolCalls : [],
      toolFailures: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
    };
  }
  const summary: Record<string, number> = {};
  for (const g of Object.values(t.graph.goals)) summary[g.status] = (summary[g.status] ?? 0) + 1;
  return {
    goalResults,
    summary,
    totalToolCalls: t.storedToolCalls.length,
    totalToolNames: t.storedToolCalls,
    totalToolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    toolRepairs: [],
  };
}

for (const t of stored) {
  const storedGoals = Object.keys(t.graph.goals).length;
  console.log(`\n[bench] ${t.task} — ${t.title.slice(0, 80)}`);
  for (const arm of ARMS) {
    setOpusTierBenchmarkOverride(armOverride(arm));
    const base = { task: t.task, family: t.family, model: arm.model, config: arm.config, storedGoals };
    if (STAGE === 1) {
      // plan
      try {
        const { graph } = await plan(t.description, true);
        const goals = graph.getAll();
        const gates = goals.reduce((n, g) => n + (((g.metadata as { gates?: unknown[] })?.gates?.length) ?? 0), 0);
        record({ ...base, phase: "plan", ok: true, goals: goals.length, criteria: goals.reduce((n, g) => n + g.completionCriteria.length, 0), gates });
      } catch (err) {
        record({ ...base, phase: "plan", ok: false, error: String((err as Error)?.message ?? err) });
      }
      // reflect (stored execution result → same input for every arm)
      try {
        const { result } = await reflect(t.description, GoalGraph.fromJSON(t.graph), storedExecutionResult(t), undefined, true);
        record({ ...base, phase: "reflect", ok: true, score: result.score, storedScore: t.storedScore });
      } catch (err) {
        record({ ...base, phase: "reflect", ok: false, error: String((err as Error)?.message ?? err), storedScore: t.storedScore });
      }
      // selfAssess (single-goal tasks only: stored finalAnswer == the goal output)
      if (storedGoals === 1 && t.finalAnswer) {
        const goal = Object.values(t.graph.goals)[0];
        try {
          const r = await selfAssess(goal, t.finalAnswer, [], true);
          record({ ...base, phase: "assess", ok: r.assessment !== null, met: r.assessment?.met ?? null });
        } catch (err) {
          record({ ...base, phase: "assess", ok: false, error: String((err as Error)?.message ?? err) });
        }
      }
    } else {
      // stage 2: fresh graph (statuses reset) → executeGraph with read-only tools → reflect
      const fresh = JSON.parse(JSON.stringify(t.graph)) as StoredTask["graph"];
      for (const g of Object.values(fresh.goals)) g.status = GoalStatus.PENDING;
      const graph = GoalGraph.fromJSON(fresh);
      const t0 = Date.now();
      try {
        const exec = await executeGraph(graph, readOnlyTools, undefined, Number(process.env.GOAL_TIMEOUT_MS ?? 300000), undefined, true);
        lastRaw = undefined; // executor = many SDK calls; aggregate from ExecutionResult instead
        const completed = graph.getByStatus(GoalStatus.COMPLETED).length;
        let reflectScore: number | undefined;
        let reflectErr: string | undefined;
        try {
          const { result } = await reflect(t.description, graph, exec, undefined, true);
          reflectScore = result.score;
        } catch (e) {
          reflectErr = String((e as Error)?.message ?? e);
        }
        const reflectRaw = lastRaw;
        lastRaw = undefined;
        record({
          ...base,
          phase: "execute",
          ok: true,
          durationMs: Date.now() - t0,
          promptTokens: exec.tokenUsage.promptTokens,
          completionTokens: exec.tokenUsage.completionTokens,
          cacheReadTokens: exec.tokenUsage.cacheReadTokens ?? 0,
          cacheCreationTokens: exec.tokenUsage.cacheCreationTokens ?? 0,
          costUsd: exec.tokenUsage.actualCostUsd ?? 0,
          reportedModel: exec.tokenUsage.actualModel,
          textChars: Object.values(exec.goalResults).reduce((n, g) => n + (g.result?.length ?? 0), 0),
          thinkingLeak: Object.values(exec.goalResults).some((g) => THINK_LEAK_RE.test(g.result ?? "")),
          toolCallInText: Object.values(exec.goalResults).some((g) => TOOL_IN_TEXT_RE.test(g.result ?? "")),
          toolCalls: exec.totalToolCalls,
          storedToolCalls: t.storedToolCalls.length,
          completedGoals: completed,
          score: reflectScore,
          storedScore: t.storedScore,
        });
        lastRaw = reflectErr ? undefined : reflectRaw;
        record({ ...base, phase: "reflect", ok: !reflectErr, error: reflectErr, score: reflectScore, storedScore: t.storedScore });
      } catch (err) {
        // A nested call (goal loop, selfAssess, condense) may have tapped last —
        // never let it pose as the graph run. Spend already made by the goal
        // loops is not recoverable from a thrown executeGraph; the graph's
        // goals are counted so the loss is visible in the row.
        lastRaw = undefined;
        record({
          ...base,
          phase: "execute",
          ok: false,
          durationMs: Date.now() - t0,
          error: String((err as Error)?.message ?? err),
          storedToolCalls: t.storedToolCalls.length,
          completedGoals: graph.getByStatus(GoalStatus.COMPLETED).length,
        });
      }
    }
  }
}
setOpusTierBenchmarkOverride(undefined);
finish();
process.exit(0);
