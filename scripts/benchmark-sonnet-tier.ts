/**
 * Sonnet-tier (FAST path) A/B benchmark — the deployed `claude-sonnet-4-6`
 * shape vs `claude-sonnet-5-5` at effort medium and low, replaying REAL
 * stored fast tasks through the real FastRunner (2026-09-29; plan in
 * docs/planning/sonnet-tier-benchmark-2026-09-29.md). Sibling of
 * scripts/benchmark-opus-tier.ts, same safety skeleton.
 *
 * Why a harness and not a swap: the Sonnet 5 attempt (06-30→07-01) regressed
 * tokenizer (+30%), cache-read ratio (62%→49%) and delivery before anyone
 * measured it, and was reverted. This measures FIRST, on our own workload.
 *
 * Safety (validate-* pattern):
 *   - live service env inherited via /proc/<MainPID>/environ ONLY with --run —
 *     values never printed;
 *   - everything runs against an ISOLATED COPY of mc.db (scratch path, 0600).
 *     The runner's own DB writes (task_trace_events, scope_telemetry
 *     synthetic row) land in the copy, keyed by a FRESH task id
 *     `<orig>-bench-<arm>` so they never overwrite the stored run's rows and
 *     the V8.4 Stop hook finds no ledger for it (no check_cmd runs);
 *   - the double-cap checkpoint is a KB write (upsertFile), which also
 *     mirrors to disk, syncs to pgvector and to Drive. Before any src import
 *     the harness points JARVIS_KB_MIRROR_DIR at <scratch>/kb-mirror and
 *     deletes COMMIT_DB_KEY + DRIVE_KB_FOLDER_ID, so those three legs are
 *     scratch-only / no-ops. CLAUDE* keys of the launching shell are
 *     stripped before the live env is inherited, so the service's values win;
 *   - `--run` required for real SDK calls; a cumulative --max-usd stops it;
 *   - tools = original scope ∩ READ-ONLY allow-list (each must carry
 *     readOnlyHint — the harness refuses otherwise), and only tasks whose
 *     stored run used nothing outside that list are selected;
 *   - NO DELIVERY: FastRunner.execute() only returns a RunnerOutput. Telegram
 *     / WhatsApp sends, streaming, alerts and the sync surface belong to the
 *     router + dispatcher, which this harness never calls. `onTextChunk` is
 *     left undefined (it is the only streaming hook in the runner). The
 *     runner's 60 s heartbeat emits `task.progress` on the in-process event
 *     bus — nothing subscribes to it in this process;
 *   - fast-runner passes costLedger:false to every SDK call, so no cost_ledger
 *     row is written (not even to the copy).
 *
 * Arms (interleaved per task, order ROTATED per task — ABC, BCA, CAB … — so
 * time-of-day drift is shared and no arm always runs first on a cold prompt
 * cache; `position` 0-based is recorded per row):
 *   A = incumbent (Sonnet 4.6, effort unset), PINNED to --model-a (default
 *       claude-sonnet-4-6; must match /^claude-sonnet-\d/, the claude-sdk.ts
 *       SONNET_MODEL_ID rule) via the seam's defaultModel; thinking per model (disabled on 4.x,
 *       adaptive on 5.x), effort unset → SDK default. Arm A does NOT follow
 *       the live SONNET_MODEL_ID: after the /proc env copy the harness sets
 *       SONNET_MODEL_ID=--model-a and deletes SONNET_EFFORT (the live Sonnet
 *       5.5 canary carries claude-sonnet-5-5 + low), UNLESS the launching
 *       shell set either key itself (launcher wins, as for every key).
 *   B = defaultModel --model-b (claude-sonnet-5-5), adaptive thinking, effort medium.
 *   C = same, effort low.
 *   D = defaultModel --model-d (claude-opus-5-5), adaptive thinking, effort low.
 *   E = same, effort medium.
 * Default --configs is A,B,C; D/E run only when requested.
 * (5.x Sonnet/Opus reject `thinking: {type:"disabled"}` with a 400, so B-E
 * must carry a thinking config.)
 *
 * Usage (repo root):
 *   npx tsx scripts/benchmark-sonnet-tier.ts                 # DRY: task set, arms, tools, out dir (exit 3)
 *   npx tsx scripts/benchmark-sonnet-tier.ts --run           # 20 tasks × 3 arms
 *   npx tsx scripts/benchmark-sonnet-tier.ts --run --tasks=d11c156e,fa72616c --configs=A,C
 *   npx tsx scripts/benchmark-sonnet-tier.ts --run --configs=A,C,D,E   # + Opus 5.5 arms
 *   npx tsx scripts/benchmark-sonnet-tier.ts --summarize --out=<dir>
 *   npx tsx scripts/grade-benchmark.ts <dir> [--run]                # blind LLM grading
 * Flags: --n=20 --tasks=<8-char prefixes> --configs=<subset of A,B,C,D,E> (default A,B,C)
 *        --model-a=claude-sonnet-4-6 --model-b=claude-sonnet-5-5 --model-d=claude-opus-5-5
 *        --max-usd=45 --timeout-s=300 --out=<dir> (default benchmarks/sonnet-tier-<date>/)
 *        --before=<ISO> pool only tasks created before this instant (default: now)
 *        --after=<ISO>  pool only tasks created at/after it (default: --before − 21 days)
 * Pool + reference: the stored production answer (`orig`) is BOTH the
 * tool_jaccard reference (gate 3) and the grader's REFERENCE, so the pool's
 * production model decides what "like production" means. Production fast has
 * run Sonnet 5.5-low since 2026-09-29 05:09 UTC (= arm C's shape); use
 * --before=2026-09-29T05:09:00Z for a Sonnet-4.6 reference. The dry run and
 * summary.md print the pool's date range and reference model(s).
 * Exit: 0 done, 2 usage/error/--max-usd stop, 3 dry.
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
// No imports and no env reads at module load — safe ahead of the env guards.
import { calculateCost } from "../src/budget/pricing.js";

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
// MC_BENCH_SRC_DB (fixture source DB, see the snapshot step) is for dry-run tests only.
if (process.env.MC_BENCH_SRC_DB !== undefined && RUN) {
  console.error("[bench] MC_BENCH_SRC_DB is for fixture dry runs only; refusing --run.");
  process.exit(2);
}
type ArmId = "A" | "B" | "C" | "D" | "E";
const ALL_ARMS: ArmId[] = ["A", "B", "C", "D", "E"];
const CONFIGS = (flag("configs") ?? "A,B,C").split(",").filter(Boolean) as ArmId[];
if (CONFIGS.length === 0 || CONFIGS.some((c) => !ALL_ARMS.includes(c)) || new Set(CONFIGS).size !== CONFIGS.length) {
  console.error("[bench] --configs must be a subset of A,B,C,D,E (no repeats)");
  process.exit(2);
}
const MODEL_A = flag("model-a") ?? "claude-sonnet-4-6";
// Same rule as claude-sdk.ts SONNET_MODEL_ID: anything else would be ignored
// there, so arm A's SONNET_EFFORT neutralisation would not line up.
if (!/^claude-sonnet-\d/.test(MODEL_A)) {
  console.error(`[bench] --model-a must match /^claude-sonnet-\\d/ (got ${MODEL_A})`);
  process.exit(2);
}
const MODEL_B = flag("model-b") ?? "claude-sonnet-5-5";
const MODEL_D = flag("model-d") ?? "claude-opus-5-5";
const MAX_USD = Number(flag("max-usd") ?? "45");
const TIMEOUT_S = Number(flag("timeout-s") ?? "300");
const N = Number(flag("n") ?? "20");
for (const [k, v] of [["max-usd", MAX_USD], ["timeout-s", TIMEOUT_S], ["n", N]] as const) {
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`[bench] --${k} must be a positive number`);
    process.exit(2);
  }
}
const WINDOW_DAYS = 21;
/** ISO flag → SQLite UTC text ("YYYY-MM-DD HH:MM:SS"), the tasks.created_at format. */
function sqliteUtcFlag(name: string): string | undefined {
  const v = flag(name);
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(d.getTime())) {
    console.error(`[bench] --${name} must be an ISO timestamp, e.g. 2026-09-29T05:09:00Z (got ${v})`);
    process.exit(2);
  }
  // A bare value parses in the process TZ, and the service shell runs
  // TZ=America/Mexico_City: the window would silently shift by 6 h.
  if (!/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    console.error(
      `[bench] --${name} needs an explicit Z or ±HH:MM offset, e.g. 2026-09-29T05:09:00Z (got ${v}); a bare time parses in the local TZ (the service shell runs TZ=America/Mexico_City)`,
    );
    process.exit(2);
  }
  return d.toISOString().slice(0, 19).replace("T", " ");
}
const BEFORE = sqliteUtcFlag("before");
const AFTER = sqliteUtcFlag("after");
if (BEFORE && AFTER && AFTER >= BEFORE) {
  console.error(`[bench] --after (${AFTER}) must be earlier than --before (${BEFORE})`);
  process.exit(2);
}
const REPO = "/root/claude/mission-control";
// data/ is gitignored; the snapshot lives there (a session scratchpad or /tmp
// can be cleaned mid-run).
const SCRATCH = process.env.MC_BENCH_SCRATCH ?? join(REPO, "data/sonnet-bench");
if (SUMMARIZE_ONLY && !flag("out")) {
  console.error("[bench] --summarize needs --out=<results dir>");
  process.exit(2);
}
const OUT = flag("out") ?? join(REPO, "benchmarks", `sonnet-tier-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
const CALLS = join(OUT, "calls.jsonl");
const RESULTS_DIR = join(OUT, "results");

// Same list as the Opus harness (local, read-only, in-box). Deliberately
// absent: shell_exec, knowledge_map, pdf_read (URL mode), project_get
// (returns stored credentials), anything web/search/market/social.
const READ_ONLY_ALLOW = [
  "file_read", "jarvis_file_read", "jarvis_file_list", "jarvis_file_search",
  "grep", "glob", "list_dir", "code_search", "data_summarize",
  "project_list", "user_fact_list",
];
// The SDK's built-in tool-search loader (schemas only, no side effects). It
// shows up in stored toolCalls when tool search is armed; neutral for both
// the selection filter and tool_jaccard.
const NEUTRAL_TOOLS = new Set(["ToolSearch"]);

// ---------------------------------------------------------------------------
// Rows + summary (works on partial results — safe mid-run and via --summarize)
// ---------------------------------------------------------------------------
interface CallRow {
  task: string; // 8-char prefix
  title: string;
  arm: ArmId;
  position: number; // 0-based slot in this task's rotated arm order
  model: string; // the arm's requested model
  effective_model: string;
  model_mismatch: boolean;
  cost_usd: number; // Σ per SDK call: total_cost_usd, or calculateCost(usage) when not authoritative
  cost_authoritative: boolean; // every SDK call reported a terminal total_cost_usd
  cost_estimated: boolean; // ≥1 SDK call (abort/timeout) was priced from usage
  runner_cost_usd?: number; // RunnerOutput.tokenUsage.actualCostUsd
  turns: number;
  tool_calls: number;
  tool_names: string[];
  prompt_tokens: number; // total input incl. cache read + creation
  cache_read_tokens: number;
  cache_creation_tokens: number;
  completion_tokens: number;
  cache_read_ratio: number;
  duration_ms: number;
  sdk_calls: number;
  status: string; // RunnerOutput.status (the runner's parseRunnerStatus + promotions)
  raw_status: string; // parseRunnerStatus over the last raw SDK text
  success: boolean;
  empty_completion: boolean;
  text_chars: number;
  tool_jaccard: number;
  msg_truncated: boolean; // replayed user message came from the 500-char telemetry cut
  error?: string;
  // stored production run, for reference
  orig_cost_usd: number;
  orig_turns: number | null;
  orig_tools: string[];
  orig_models?: string[]; // cost_ledger.model of the stored run (absent on runs before 2026-10-06)
  orig_created_at?: string; // tasks.created_at (SQLite UTC)
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const DONE_CLASS = new Set(["DONE", "DONE_WITH_CONCERNS"]);
/** Usage × pricing.ts list rates: the check on the SDK's total_cost_usd for a
 *  new model (an SDK that does not know a model's price shows up here). */
function pricingCost(r: CallRow): number {
  const m = r.effective_model && r.effective_model !== "none" && !r.effective_model.includes("+") ? r.effective_model : r.model;
  return calculateCost(m, r.prompt_tokens, r.completion_tokens, r.cache_read_tokens, r.cache_creation_tokens);
}
/** Request shape per arm (the model comes from the rows, so --summarize labels a past run correctly). */
const ARM_SHAPE: Record<ArmId, string> = {
  A: `incumbent (${MODEL_A}, effort unset): thinking per model (disabled on 4.x, adaptive on 5.x)`,
  B: "adaptive thinking, effort medium",
  C: "adaptive thinking, effort low",
  D: "adaptive thinking, effort low",
  E: "adaptive thinking, effort medium",
};

interface ArmAgg {
  arm: ArmId;
  n: number;
  total_cost: number;
  mean_cost: number;
  mean_s: number;
  median_s: number;
  mean_turns: number;
  mean_tools: number;
  cache_read_ratio: number; // Σ cache_read / Σ prompt (token-weighted)
  mean_cache_read_ratio: number; // per-call mean
  empty: number;
  errors: number;
  status: Record<string, number>;
  mean_jaccard: number;
  mismatches: number;
  estimated: number; // rows whose cost was (partly) estimated from usage
  pricing_cost: number; // Σ usage × src/budget/pricing.ts list rates
  model: string; // requested model(s) of the arm's rows
  completed: number;
  cost_per_completed: number | null;
}

function aggregate(rows: CallRow[]): { paired: string[]; arms: ArmAgg[] } {
  const arms = ALL_ARMS.filter((a) => rows.some((r) => r.arm === a));
  // Paired set: tasks that have a row for EVERY arm present — a --max-usd stop
  // or crash mid-task must not skew one arm's denominator.
  const byTask = new Map<string, Set<ArmId>>();
  for (const r of rows) byTask.set(r.task, (byTask.get(r.task) ?? new Set()).add(r.arm));
  const paired = [...byTask.entries()].filter(([, s]) => arms.every((a) => s.has(a))).map(([t]) => t);
  const pr = rows.filter((r) => paired.includes(r.task));
  return {
    paired,
    arms: arms.map((arm) => {
      const a = pr.filter((r) => r.arm === arm);
      const status: Record<string, number> = {};
      for (const r of a) status[r.status] = (status[r.status] ?? 0) + 1;
      const completed = a.filter((r) => DONE_CLASS.has(r.status) && !r.empty_completion).length;
      const total = a.reduce((s, r) => s + r.cost_usd, 0);
      const promptSum = a.reduce((s, r) => s + r.prompt_tokens, 0);
      return {
        arm,
        n: a.length,
        total_cost: total,
        mean_cost: mean(a.map((r) => r.cost_usd)),
        mean_s: mean(a.map((r) => r.duration_ms)) / 1000,
        median_s: median(a.map((r) => r.duration_ms)) / 1000,
        mean_turns: mean(a.map((r) => r.turns)),
        mean_tools: mean(a.map((r) => r.tool_calls)),
        cache_read_ratio: promptSum ? a.reduce((s, r) => s + r.cache_read_tokens, 0) / promptSum : 0,
        mean_cache_read_ratio: mean(a.map((r) => r.cache_read_ratio)),
        empty: a.filter((r) => r.empty_completion).length,
        errors: a.filter((r) => r.error).length,
        status,
        mean_jaccard: mean(a.map((r) => r.tool_jaccard)),
        mismatches: a.filter((r) => r.model_mismatch).length,
        estimated: a.filter((r) => r.cost_estimated).length,
        pricing_cost: a.reduce((s, r) => s + pricingCost(r), 0),
        model: [...new Set(a.map((r) => r.model))].join("+"),
        completed,
        cost_per_completed: completed ? total / completed : null,
      };
    }),
  };
}

/** Pool date range + reference model(s) of the stored production answers the
 *  rows were compared with (one entry per task). */
function referenceInfo(rows: CallRow[]): { from: string | null; to: string | null; models: Record<string, number>; unknown: number } {
  const byTask = new Map<string, CallRow>();
  for (const r of rows) if (!byTask.has(r.task)) byTask.set(r.task, r);
  const dates = [...byTask.values()].map((r) => r.orig_created_at).filter((d): d is string => !!d).sort();
  const models: Record<string, number> = {};
  let unknown = 0;
  for (const r of byTask.values()) {
    if (!r.orig_models) { unknown++; continue; }
    const k = r.orig_models.length ? r.orig_models.join("+") : "none";
    models[k] = (models[k] ?? 0) + 1;
  }
  return { from: dates[0] ?? null, to: dates.at(-1) ?? null, models, unknown };
}
function referenceLine(ref: ReturnType<typeof referenceInfo>): string {
  const models = Object.entries(ref.models).map(([m, n]) => `${m} ×${n}`).join(", ");
  return (
    `Pool created ${ref.from ?? "n/a"} → ${ref.to ?? "n/a"} UTC · reference (stored production answer) model(s): ${models || "n/a"}` +
    (ref.unknown ? ` · ${ref.unknown} task(s) without a recorded reference model (run predates 2026-10-06)` : "")
  );
}

function renderSummary(rows: CallRow[]): { md: string; json: unknown } {
  const { paired, arms } = aggregate(rows);
  const A = arms.find((x) => x.arm === "A");
  const ref = referenceInfo(rows);
  const ratio = (x: number, y: number | undefined) => (y ? (x / y).toFixed(2) : "n/a");
  const L: string[] = [];
  L.push(`# Sonnet-tier (fast path) benchmark — ${OUT.split("/").pop()}`);
  L.push("");
  L.push(`Generated ${new Date().toISOString()} · rows ${rows.length} · paired tasks ${paired.length} · spend $${rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)}`);
  L.push("");
  L.push(`Arms: ${arms.map((a) => `${a.arm} = ${a.model}, ${ARM_SHAPE[a.arm]}`).join(" · ")}.`);
  L.push("");
  L.push(`${referenceLine(ref)}. tool_jaccard (gate 3) and the grader's REFERENCE are relative to this model: an arm that shares the reference's shape is favoured.`);
  L.push("");
  L.push("Arm order was ROTATED per task (ABC, BCA, CAB, …) so no arm always runs first on a cold prompt cache; each row's 0-based `position` is in calls.jsonl.");
  L.push("");
  L.push("## Per arm (paired tasks only)");
  L.push("");
  L.push("| arm | n | total $ | mean $ | mean s | median s | turns | tool calls | cache-read (Σ) | cache-read (mean) | empty | errors | STATUS | tool_jaccard | model mismatch | est. cost rows | completed | $/completed |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of arms) {
    L.push(
      `| ${a.arm} | ${a.n} | ${a.total_cost.toFixed(3)} | ${a.mean_cost.toFixed(4)} | ${a.mean_s.toFixed(1)} | ${a.median_s.toFixed(1)} | ${a.mean_turns.toFixed(1)} | ${a.mean_tools.toFixed(1)} | ` +
        `${(100 * a.cache_read_ratio).toFixed(1)}% | ${(100 * a.mean_cache_read_ratio).toFixed(1)}% | ${a.empty} | ${a.errors} | ${Object.entries(a.status).map(([k, v]) => `${k}:${v}`).join(" ")} | ` +
        `${a.mean_jaccard.toFixed(2)} | ${a.mismatches} | ${a.estimated} | ${a.completed} | ${a.cost_per_completed === null ? "n/a" : a.cost_per_completed.toFixed(4)} |`,
    );
  }
  L.push("");
  L.push("## Cost two ways (paired tasks)");
  L.push("");
  L.push("| arm | model | SDK total_cost_usd Σ | usage × pricing.ts Σ | SDK / pricing.ts | est. cost rows |");
  L.push("|---|---|---|---|---|---|");
  for (const a of arms) {
    L.push(`| ${a.arm} | ${a.model} | ${a.total_cost.toFixed(3)} | ${a.pricing_cost.toFixed(3)} | ${ratio(a.total_cost, a.pricing_cost)} | ${a.estimated} |`);
  }
  L.push("");
  L.push("A ratio far from 1.00 on one arm means the SDK and src/budget/pricing.ts disagree on that model's price (the SDK column already uses pricing.ts for est. cost rows).");
  L.push("");
  const gates: Record<string, Record<string, boolean | null>> = {};
  if (A) {
    L.push("## Ratios vs A");
    L.push("");
    L.push("| arm | cost | duration | cache-read ratio (Σ) |");
    L.push("|---|---|---|---|");
    for (const a of arms.filter((x) => x.arm !== "A")) {
      L.push(`| ${a.arm}/A | ${ratio(a.total_cost, A.total_cost)} | ${ratio(a.mean_s, A.mean_s)} | ${ratio(a.cache_read_ratio, A.cache_read_ratio)} |`);
    }
    L.push("");
    L.push("## Decision gates (adopt a candidate arm only if ALL four pass vs A — see plan doc)");
    L.push("");
    L.push("| arm | 1 $/completed ≤ A | 2 empty ≤ A and errors ≤ A | 3 tool_jaccard within 0.1 of A | 4 cache-read ≥ A − 10 pts | verdict |");
    L.push("|---|---|---|---|---|---|");
    for (const a of arms.filter((x) => x.arm !== "A")) {
      const g1 = a.cost_per_completed === null || A.cost_per_completed === null ? null : a.cost_per_completed <= A.cost_per_completed;
      const g2 = a.empty <= A.empty && a.errors <= A.errors;
      const g3 = Math.abs(a.mean_jaccard - A.mean_jaccard) <= 0.1;
      const g4 = a.cache_read_ratio >= A.cache_read_ratio - 0.1;
      gates[a.arm] = { cost_per_completed: g1, empty_and_errors: g2, tool_jaccard: g3, cache_read: g4 };
      const f = (b: boolean | null) => (b === null ? "n/a" : b ? "PASS" : "FAIL");
      const verdict = g1 === true && g2 && g3 && g4 ? "PASS" : "FAIL";
      L.push(`| ${a.arm} | ${f(g1)} | ${f(g2)} | ${f(g3)} | ${f(g4)} | ${verdict} |`);
    }
    L.push("");
  }
  L.push("## Per task (cost $ / seconds / turns / tool calls / STATUS)");
  L.push("");
  const armIds = arms.map((a) => a.arm);
  L.push(`| task | title | orig $ | ${armIds.join(" | ")} |`);
  L.push(`|---|---|---|${armIds.map(() => "---").join("|")}|`);
  const tasks = [...new Set(rows.map((r) => r.task))];
  for (const t of tasks) {
    const tr = rows.filter((r) => r.task === t);
    const cells = armIds.map((arm) => {
      const r = tr.find((x) => x.arm === arm);
      return r
        ? `${r.cost_usd.toFixed(3)} / ${(r.duration_ms / 1000).toFixed(0)}s / ${r.turns}t / ${r.tool_calls} / ${r.status}${r.empty_completion ? " EMPTY" : ""}${r.error ? " ERR" : ""}${r.model_mismatch ? " MISMATCH" : ""}`
        : "—";
    });
    L.push(`| ${t}${paired.includes(t) ? "" : " (unpaired)"} | ${oneLine(tr[0].title).replace(/\|/g, "/").slice(0, 50)} | ${tr[0].orig_cost_usd.toFixed(3)} | ${cells.join(" | ")} |`);
  }
  L.push("");
  const errs = rows.filter((r) => r.error);
  if (errs.length) {
    L.push("## Errors");
    L.push("");
    for (const e of errs) L.push(`- ${e.task} ${e.arm}: ${e.error?.slice(0, 200)}`);
    L.push("");
  }
  L.push("Notes: cost is the SDK-reported total_cost_usd summed over every SDK call of the run (resume/auth legs included); a call without a terminal cost (abort/timeout) is priced from its token usage via src/budget/pricing (`est. cost rows`), and that estimate counts toward --max-usd. Aggregates use paired tasks only. `completed` = STATUS DONE/DONE_WITH_CONCERNS with non-empty text. tool_jaccard compares tool-NAME sets with the stored production run (ToolSearch excluded); the replay only has the read-only subset, so it is a proxy. The spend cap is checked after each task-arm, not mid-run. Answers side by side: results/<task>-<arm>.md (orig = stored production answer).");
  L.push("");
  L.push(
    "Fidelity limits: (1) narrower tool scope — each replay gets only the stored scope ∩ the 11-tool read-only allow-list; every replayed task still has a tool that guards.isReadOnlyTool does not class read-only, so none takes the omit-KB branch; " +
      "(2) maxRounds is the CODING tier whenever grep/glob are in the replay scope (the runner keys it on tool names); " +
      "(3) chat history is rebuilt from per-channel `conversations` rows, not the router's in-memory thread buffer; " +
      "(4) the snapshot's KB and JME facts are NEWER than the replayed tasks (facts learned after a task can reach its replay); " +
      "(5) the mc.db + -wal copy is not atomic (a write between the two copies can leave the snapshot a few rows inconsistent); " +
      "(6) the Claude subscription rate limit is shared with the live service — a 429 shows in the error column, not as a model failure. " +
      "Rows with msg_truncated=true replayed the 500-char scope_telemetry cut of the user message (no jme_turns row).",
  );
  return { md: L.join("\n"), json: { out: OUT, generated: new Date().toISOString(), paired, reference: ref, arms, gates } };
}

function readRows(): CallRow[] {
  return existsSync(CALLS)
    ? readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallRow)
    : [];
}
function finish(): void {
  const { md, json } = renderSummary(readRows());
  writeFileSync(join(OUT, "summary.md"), md, { mode: 0o600 });
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(json, null, 2), { mode: 0o600 });
  console.log(`\n${md}\n[bench] summary ${join(OUT, "summary.md")}`);
}

if (SUMMARIZE_ONLY) {
  finish();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1) Live env (only with --run) — inherited via /proc, never printed.
// ---------------------------------------------------------------------------
// The inherit loop below never overwrites a key already set, so a CLAUDE*
// key from the launching shell (e.g. a Claude Code session) would shadow the
// service's. Strip them first; the service's own values come back via /proc.
const strippedClaudeKeys = Object.keys(process.env).filter((k) => /^CLAUDE/.test(k));
for (const k of strippedClaudeKeys) delete process.env[k];
// Arm A neutralisation keys the launching shell set itself (those win).
const launcherSonnet = new Set(["SONNET_MODEL_ID", "SONNET_EFFORT"].filter((k) => k in process.env));
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
// Arm A must run --model-a at the SDK default effort, not the live canary
// (SONNET_MODEL_ID=claude-sonnet-5-5 + SONNET_EFFORT=low): claude-sdk.ts reads
// SONNET_MODEL_ID once at import (below) and SONNET_EFFORT per call, applying
// the effort to any call whose effective model equals SONNET_MODEL_ID.
if (!launcherSonnet.has("SONNET_MODEL_ID")) process.env.SONNET_MODEL_ID = MODEL_A;
if (!launcherSonnet.has("SONNET_EFFORT")) delete process.env.SONNET_EFFORT;
console.log(
  `[bench] arm-A env: SONNET_MODEL_ID=${process.env.SONNET_MODEL_ID ?? "(unset)"} (${launcherSonnet.has("SONNET_MODEL_ID") ? "launching shell" : "pinned to --model-a"}) · ` +
    `SONNET_EFFORT=${process.env.SONNET_EFFORT ?? "(unset)"} (${launcherSonnet.has("SONNET_EFFORT") ? "launching shell" : "cleared"})`,
);
// Side-effect guards — BEFORE any src import (drive-sync reads
// DRIVE_KB_FOLDER_ID at module load). A KB write from the runner (double-cap
// checkpoint → upsertFile) then mirrors into scratch (getMirrorDir() reads
// the var per call), skips pgvector (isPgvectorEnabled = !!COMMIT_DB_KEY)
// and skips Drive (syncToDrive returns when the folder id is empty).
const KB_MIRROR = join(SCRATCH, "kb-mirror");
mkdirSync(KB_MIRROR, { recursive: true, mode: 0o700 });
process.env.JARVIS_KB_MIRROR_DIR = KB_MIRROR;
delete process.env.COMMIT_DB_KEY;
delete process.env.DRIVE_KB_FOLDER_ID;
console.log(
  `[bench] env guards: KB mirror -> ${KB_MIRROR} · pgvector off · Drive off · ${strippedClaudeKeys.length} launching-shell CLAUDE* key(s) stripped`,
);
process.env.BUDGET_ENABLED = "false";
process.env.BUDGET_ENFORCE = "false";
// Jev shadow is log-only in production (never feeds the answer); off here so a
// replay makes no Jev calls and every arm sees the same prompt path.
process.env.JEV_SHADOW_CONSUMERS = "";

// ---------------------------------------------------------------------------
// 2) Isolated DB copy (always — the dry run lists the task set from it).
// ---------------------------------------------------------------------------
// MC_BENCH_SRC_DB: fixture DB for scripts/benchmark-tier-summary.test.ts (refused with --run above).
const SRC_DB = process.env.MC_BENCH_SRC_DB ?? join(REPO, "data/mc.db");
const DST_DB = join(SCRATCH, "bench.db");
mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
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

// ---------------------------------------------------------------------------
// 3) Task set (from the snapshot)
// ---------------------------------------------------------------------------
type ConversationTurn = import("../src/runners/types.js").ConversationTurn;
const { CACHE_BREAK_MARKER, isPoisonedExchange } = await import("../src/messaging/router.js");
const { figuresProvenanceSection, timeContextLine } = await import("../src/messaging/prompt-sections.js");
const { USER_TIMEZONE } = await import("../src/lib/timezone.js");

interface Candidate {
  task: string;
  taskId: string;
  title: string;
  description: string; // reconstructed (cache marker re-inserted when the split is found)
  split: boolean;
  tools: string[]; // original scope ∩ READ_ONLY_ALLOW
  modelTier?: string;
  history?: ConversationTurn[];
  priorTurns: number;
  msgTruncated: boolean;
  origTools: string[];
  origCost: number;
  origTurns: number | null;
  origText: string;
  origModels: string[];
  createdAt: string;
}

const EXCLUDE_TITLE = ["schedule", "recordatorio", "envía", "send"];
const EXCLUDE_PROBE = ["eval-probe", "tuning", "var-tune"];

/** "YYYY-MM-DD HH:MM:SS" (SQLite UTC) → the router's `[Hoy: …]` line at that instant. */
function timeLineAt(sqliteUtc: string): string {
  const d = new Date(sqliteUtc.replace(" ", "T") + "Z");
  const iso = d.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
  const weekday = d.toLocaleDateString("es-MX", { timeZone: USER_TIMEZONE, weekday: "long" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: USER_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
  return timeContextLine(`${iso} (${weekday})`, time);
}

/**
 * Re-insert the cache-break marker the dispatcher stripped at persistence.
 * The router's stable half ends with figuresProvenanceSection() (last P2
 * section); stripCacheMarker replaced the marker with ONE "\n". Not found
 * (prompt text drifted, or P2 truncated) → whole description stays stable.
 */
function restoreSplit(desc: string): { description: string; split: boolean } {
  const tail = figuresProvenanceSection();
  const i = desc.lastIndexOf(tail);
  if (i < 0 || desc[i + tail.length] !== "\n") return { description: desc, split: false };
  const end = i + tail.length;
  return { description: desc.slice(0, end) + CACHE_BREAK_MARKER + desc.slice(end + 1), split: true };
}

/** Thread buffer as the router hydrates it: last 15 `conversations` rows for the channel before the task. */
function priorTurnsFor(channel: string, createdAt: string): ConversationTurn[] {
  const rows = db
    .prepare(
      `SELECT content FROM conversations
        WHERE bank = 'mc-jarvis'
          AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value = ?)
          AND created_at < ?
        ORDER BY created_at DESC LIMIT 15`,
    )
    .all(channel, createdAt) as { content: string }[];
  const turns: ConversationTurn[] = [];
  for (const { content } of rows.reverse()) {
    const j = content.indexOf("\nJarvis: ");
    if (j === -1) continue;
    const user = content.slice("User: ".length, j).trim();
    const jarvis = content.slice(j + "\nJarvis: ".length).trim();
    if (user) turns.push({ role: "user", content: user });
    if (jarvis && !isPoisonedExchange(jarvis)) turns.push({ role: "assistant", content: jarvis });
  }
  return turns;
}

const rows = db
  .prepare(
    `SELECT task_id, title, description, metadata, classification, output, created_at
       FROM tasks
      WHERE agent_type = 'fast' AND status IN ('completed','completed_with_concerns')
        AND spawn_type = 'root' AND output IS NOT NULL
        AND created_at >= COALESCE(?, datetime(COALESCE(?, 'now'), ?))
        AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC, task_id ASC`,
  )
  .all(AFTER ?? null, BEFORE ?? null, `-${WINDOW_DAYS} days`, BEFORE ?? null, BEFORE ?? null) as Array<{
  task_id: string;
  title: string;
  description: string;
  metadata: string | null;
  classification: string | null;
  output: string;
  created_at: string;
}>;

const pool: Candidate[] = [];
const skipped: Record<string, number> = {};
const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
for (const r of rows) {
  const lt = r.title.toLowerCase();
  if (r.title.startsWith("Chat: El usuario envió una imagen")) { skip("vision"); continue; }
  if (EXCLUDE_PROBE.some((p) => `${lt} ${(r.metadata ?? "").toLowerCase()}`.includes(p))) { skip("probe"); continue; }
  if (EXCLUDE_TITLE.some((p) => lt.includes(p))) { skip("title-keyword"); continue; }
  let meta: { tags?: string[]; tools?: string[] } = {};
  let out: { text?: string; toolCalls?: string[] } = {};
  try {
    meta = r.metadata ? JSON.parse(r.metadata) : {};
    out = JSON.parse(r.output);
  } catch {
    skip("bad-json");
    continue;
  }
  if (meta.tags?.includes("loop")) { skip("loop"); continue; }
  const origTools = (out.toolCalls ?? []).filter((n) => !NEUTRAL_TOOLS.has(n));
  if (origTools.some((n) => !READ_ONLY_ALLOW.includes(n))) { skip("used-non-read-only-tool"); continue; }
  const tools = (meta.tools ?? []).filter((n) => READ_ONLY_ALLOW.includes(n));
  // Empty ∩ would hand the runner no scope (getDefinitions([]) = whole registry
  // on the non-SDK path) — never replay without an explicit read-only scope.
  if (tools.length === 0) { skip("no-read-only-scope"); continue; }

  let history: ConversationTurn[] | undefined;
  let priorTurns = 0;
  let msgTruncated = false;
  let description = r.description;
  let split = false;
  const isChat = r.title.startsWith("Chat: ") && (meta.tags ?? []).includes("messaging");
  if (isChat) {
    // jme_turns holds the full user text (owner Telegram only);
    // scope_telemetry.message is cut at 500 chars (scope-telemetry.ts).
    const msg =
      (db.prepare("SELECT content FROM jme_turns WHERE task_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(r.task_id) as { content?: string } | undefined)?.content ??
      (db.prepare("SELECT message FROM scope_telemetry WHERE task_id = ? ORDER BY id LIMIT 1").get(r.task_id) as { message?: string } | undefined)?.message;
    if (!msg) { skip("no-user-message"); continue; }
    msgTruncated = msg.length === 500;
    const channel = (meta.tags ?? [])[1] ?? "telegram";
    const prior = priorTurnsFor(channel, r.created_at);
    priorTurns = prior.length;
    history = [...prior, { role: "user", content: `${timeLineAt(r.created_at)}\n\n${msg}` }];
    ({ description, split } = restoreSplit(r.description));
  }
  let modelTier: string | undefined;
  try {
    modelTier = r.classification ? (JSON.parse(r.classification) as { modelTier?: string }).modelTier : undefined;
  } catch {
    /* none */
  }
  const origCost = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM cost_ledger WHERE task_id = ? AND agent_type = 'fast'").get(r.task_id) as { c: number }).c;
  const origModels = (db.prepare("SELECT DISTINCT model FROM cost_ledger WHERE task_id = ? AND agent_type = 'fast' ORDER BY model").all(r.task_id) as { model: string }[]).map((x) => x.model);
  const turnRow = db.prepare("SELECT COUNT(*) AS n FROM task_trace_events WHERE task_id = ? AND name = 'turn.completed'").get(r.task_id) as { n: number };
  pool.push({
    task: r.task_id.slice(0, 8),
    taskId: r.task_id,
    title: r.title,
    description,
    split,
    tools,
    modelTier,
    history,
    priorTurns,
    msgTruncated,
    origTools,
    origCost,
    origTurns: turnRow.n > 0 ? turnRow.n : null,
    origText: out.text ?? "",
    origModels,
    createdAt: r.created_at,
  });
}

const WINDOW_LABEL = `created ${AFTER ?? `${BEFORE ?? "now"} − ${WINDOW_DAYS}d`} → ${BEFORE ?? "now"} UTC`;
const wanted = flag("tasks")?.split(",").filter(Boolean);
let selected: Candidate[];
if (wanted) {
  selected = [];
  for (const p of wanted) {
    const hit = pool.find((c) => c.taskId.startsWith(p));
    if (hit) selected.push(hit);
    else console.error(`[bench] task ${p}: not in the eligible pool (${WINDOW_LABEL} + filters) — skipped`);
  }
} else {
  selected = pool.slice(0, N);
}
if (selected.length === 0) {
  console.error("[bench] no replayable tasks");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 4) Tools: builtin source, READ-ONLY allow-list (refuse, never narrow)
// ---------------------------------------------------------------------------
const { toolRegistry } = await import("../src/tools/registry.js");
{
  const { ToolSourceManager } = await import("../src/tools/source.js");
  const { BuiltinToolSource } = await import("../src/tools/sources/builtin.js");
  const sm = new ToolSourceManager();
  sm.addSource(new BuiltinToolSource());
  await sm.initAll(toolRegistry);
}
const missing = READ_ONLY_ALLOW.filter((n) => toolRegistry.get(n)?.readOnlyHint !== true);
if (missing.length > 0) {
  console.error(`[bench] allow-list tools missing or not readOnlyHint: ${missing.join(", ")} — refusing to run`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 5) Arms + DRY listing
// ---------------------------------------------------------------------------
const ARM_MODEL: Record<ArmId, string> = { A: MODEL_A, B: MODEL_B, C: MODEL_B, D: MODEL_D, E: MODEL_D };
const ARM_EFFORT: Record<Exclude<ArmId, "A">, "low" | "medium"> = { B: "medium", C: "low", D: "low", E: "medium" };
const ARM_DESC: Record<ArmId, string> = {
  A: `${MODEL_A} · thinking per model · effort ${process.env.SONNET_EFFORT && MODEL_A === process.env.SONNET_MODEL_ID ? `${process.env.SONNET_EFFORT} (launching shell SONNET_EFFORT)` : "unset"} (incumbent, pinned)`,
  B: `${MODEL_B} · thinking adaptive · effort medium`,
  C: `${MODEL_B} · thinking adaptive · effort low`,
  D: `${MODEL_D} · thinking adaptive · effort low`,
  E: `${MODEL_D} · thinking adaptive · effort medium`,
};

console.log(`[bench] ${selected.length} task(s) of ${pool.length} eligible (${rows.length} fast root completed, ${WINDOW_LABEL}; skipped ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(" ")})`);
console.log(
  `[bench] ${referenceLine(referenceInfo(selected.map((c) => ({ task: c.task, orig_created_at: c.createdAt, orig_models: c.origModels }) as CallRow)))}`,
);
for (const c of selected) {
  console.log(
    `  ${c.task} tier=${c.modelTier ?? "-"} orig$=${c.origCost.toFixed(3)} origTurns=${c.origTurns ?? "n/a"} origTools=[${c.origTools.join(",") || "none"}] ` +
      `replayTools=${c.tools.length} history=${c.history ? `${c.priorTurns}+1` : "none"}${c.msgTruncated ? " msg=CUT500" : ""} split=${c.history ? c.split : "n/a"} — ${oneLine(c.title).slice(0, 70)}`,
  );
}
{
  const { isReadOnlyTool } = await import("../src/inference/guards.js");
  const omitKb = selected.filter((c) => c.tools.every((t) => isReadOnlyTool(t))).length;
  console.log(`[bench] replay scopes: omit-KB (all guards-read-only) ${omitKb}/${selected.length} · user message cut at 500 chars ${selected.filter((c) => c.msgTruncated).length}/${selected.length}`);
}
console.log(`[bench] arms (interleaved, order rotated per task): ${CONFIGS.map((a) => `${a} = ${ARM_DESC[a]}`).join(" | ")}`);
console.log(`[bench] read-only tool allow-list (${READ_ONLY_ALLOW.length}): ${[...READ_ONLY_ALLOW].sort().join(", ")}`);
console.log(`[bench] max $${MAX_USD} · timeout ${TIMEOUT_S}s per task-arm · snapshot ${DST_DB} · out ${OUT}`);
if (!RUN) {
  console.log("[bench] DRY — pass --run to fire real SDK calls (see plan doc for the estimate).");
  process.exit(3);
}

// ---------------------------------------------------------------------------
// 6) Run
// ---------------------------------------------------------------------------
const { getConfig } = await import("../src/config.js");
if (getConfig().inferencePrimaryProvider !== "claude-sdk") {
  console.error("[bench] inferencePrimaryProvider is not claude-sdk — the arms would not reach the SDK seam; refusing.");
  process.exit(2);
}
const { setOpusTierBenchmarkOverride } = await import("../src/inference/claude-sdk.js");
const { fastRunner } = await import("../src/runners/fast-runner.js");
const { parseRunnerStatus } = await import("../src/runners/status.js");
const { generateEmbedding } = await import("../src/inference/embeddings.js");
type SdkResult = import("../src/inference/claude-sdk.js").ClaudeSdkResult;
type RunnerInput = import("../src/runners/types.js").RunnerInput;

mkdirSync(RESULTS_DIR, { recursive: true, mode: 0o700 });
chmodSync(OUT, 0o700);
const ERROR_RE = /\[error_api_response|error_max_turns|\[error_max_budget_usd|\[refusal\]/;

let taps: SdkResult[] = [];
const tap = (r: SdkResult) => taps.push(r);
function armOverride(arm: ArmId) {
  // A: model pinned, thinking/effort left to the production defaults.
  if (arm === "A") return { defaultModel: MODEL_A, tap };
  return { defaultModel: ARM_MODEL[arm], thinking: { type: "adaptive" as const }, effort: ARM_EFFORT[arm], tap };
}
/** What the replay asked (read by scripts/grade-benchmark.ts): the last prior
 *  turns for context, then the replayed user message — or, for a non-chat
 *  task, its description (the task prompt). Capped; private (0600). */
function requestFile(c: Candidate): string {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[cut ${s.length - n} chars]` : s);
  const L = [`# ${c.task} — replayed request`, "", c.title, ""];
  if (c.history) {
    const prior = c.history.slice(0, -1).slice(-4);
    if (prior.length) {
      L.push(`## Prior turns (last ${prior.length} of ${c.priorTurns})`, "");
      for (const t of prior) L.push(`**${t.role}:** ${cap(t.content, 1500)}`, "");
    }
    L.push(`## Request${c.msgTruncated ? " (cut at 500 chars in telemetry)" : ""}`, "", cap(c.history.at(-1)!.content, 8000), "");
  } else {
    L.push("## Request (task description)", "", cap(c.description, 8000), "");
  }
  return L.join("\n");
}
function jaccard(a: string[], b: string[]): number {
  const x = new Set(a.filter((n) => !NEUTRAL_TOOLS.has(n)));
  const y = new Set(b.filter((n) => !NEUTRAL_TOOLS.has(n)));
  if (x.size === 0 && y.size === 0) return 1;
  const inter = [...x].filter((n) => y.has(n)).length;
  return inter / new Set([...x, ...y]).size;
}

let spent = 0;
for (const [i, c] of selected.entries()) {
  console.log(`\n[bench] ${c.task} — ${oneLine(c.title).slice(0, 80)}`);
  writeFileSync(join(RESULTS_DIR, `${c.task}-orig.md`), `# ${c.task} — stored production answer\n\n${c.title}\n\n---\n\n${c.origText}\n`, { mode: 0o600 });
  writeFileSync(join(RESULTS_DIR, `${c.task}-request.md`), requestFile(c), { mode: 0o600 });
  const order = CONFIGS.map((_, j) => CONFIGS[(i + j) % CONFIGS.length]);
  for (const [position, arm] of order.entries()) {
    // JME recall embeds the last user turn (≤2,000 chars) under a 1.5 s
    // timeout; warm the 5-min embedding cache so the arm that runs first is
    // not the only one to miss the JME block on a cold embed. Re-warmed per
    // arm (a hit is free) so a long task cannot outlive the TTL.
    if (c.history) await generateEmbedding(c.history.at(-1)!.content.slice(0, 2000));
    taps = [];
    setOpusTierBenchmarkOverride(armOverride(arm));
    const input: RunnerInput = {
      taskId: `${c.taskId}-bench-${arm}`,
      runId: `bench-${arm}-${c.task}`,
      title: c.title,
      description: c.description,
      tools: c.tools,
      modelTier: c.modelTier,
      conversationHistory: c.history,
      signal: AbortSignal.timeout(TIMEOUT_S * 1000),
      // onTextChunk deliberately undefined — no streaming surface.
    };
    const t0 = Date.now();
    let text = "";
    let error: string | undefined;
    let status = "BLOCKED";
    let success = false;
    let runnerCost: number | undefined;
    let runnerModel: string | undefined;
    try {
      const out = await fastRunner.execute(input);
      const o = out.output;
      text = typeof o === "string" ? o : (o?.text ?? o?.finalAnswer ?? "") || "";
      status = out.status ?? parseRunnerStatus(text).status;
      success = out.success;
      runnerCost = out.tokenUsage?.actualCostUsd;
      runnerModel = out.tokenUsage?.actualModel;
      if (out.error) error = out.error;
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    } finally {
      setOpusTierBenchmarkOverride(undefined);
    }
    const rawText = taps.map((t) => t.text).join("\n");
    if (!error && ERROR_RE.test(rawText)) error = rawText.match(ERROR_RE)?.[0];
    const usage = taps.reduce(
      (s, t) => ({
        p: s.p + t.usage.promptTokens,
        c: s.c + t.usage.completionTokens,
        r: s.r + t.usage.cacheReadTokens,
        w: s.w + t.usage.cacheCreationTokens,
      }),
      { p: 0, c: 0, r: 0, w: 0 },
    );
    const names = taps.flatMap((t) => t.toolCalls).filter((n) => !NEUTRAL_TOOLS.has(n));
    const costAuthoritative = taps.every((t) => t.costAuthoritative);
    const cost = taps.reduce(
      (s, t) =>
        s +
        (t.costAuthoritative
          ? t.costUsd
          : calculateCost(t.model || ARM_MODEL[arm], t.usage.promptTokens, t.usage.completionTokens, t.usage.cacheReadTokens, t.usage.cacheCreationTokens)),
      0,
    );
    const models = [...new Set(taps.map((t) => t.model))];
    const effective = models.length === 1 ? models[0] : models.join("+") || runnerModel || "none";
    const row: CallRow = {
      task: c.task,
      title: c.title,
      arm,
      position,
      model: ARM_MODEL[arm],
      effective_model: effective,
      model_mismatch: models.length === 0 || models.some((m) => m !== ARM_MODEL[arm]),
      cost_usd: cost,
      cost_authoritative: costAuthoritative,
      cost_estimated: !costAuthoritative,
      runner_cost_usd: runnerCost,
      turns: taps.reduce((s, t) => s + t.numTurns, 0),
      tool_calls: names.length,
      tool_names: [...new Set(names)],
      prompt_tokens: usage.p,
      cache_read_tokens: usage.r,
      cache_creation_tokens: usage.w,
      completion_tokens: usage.c,
      cache_read_ratio: usage.p ? usage.r / usage.p : 0,
      duration_ms: Date.now() - t0,
      sdk_calls: taps.length,
      status,
      raw_status: parseRunnerStatus(taps.at(-1)?.text ?? "").status,
      success,
      empty_completion: text.trim().length === 0,
      text_chars: text.length,
      tool_jaccard: jaccard(names, c.origTools),
      msg_truncated: c.msgTruncated,
      ...(error && { error }),
      orig_cost_usd: c.origCost,
      orig_turns: c.origTurns,
      orig_tools: c.origTools,
      orig_models: c.origModels,
      orig_created_at: c.createdAt,
    };
    spent += row.cost_usd;
    appendFileSync(CALLS, JSON.stringify(row) + "\n", { mode: 0o600 });
    writeFileSync(
      join(RESULTS_DIR, `${c.task}-${arm}.md`),
      `# ${c.task} — arm ${arm} (${ARM_DESC[arm]})\n\n${c.title}\n\nstatus=${row.status} cost=$${row.cost_usd.toFixed(4)} ${(row.duration_ms / 1000).toFixed(0)}s turns=${row.turns} tools=[${row.tool_names.join(",")}] model=${row.effective_model}${row.error ? ` error=${row.error}` : ""}\n\n---\n\n${text}\n`,
      { mode: 0o600 },
    );
    console.log(
      `  ${arm}@${position} ${row.effective_model} $${row.cost_usd.toFixed(4)}${row.cost_estimated ? "(est)" : ""} ${(row.duration_ms / 1000).toFixed(0)}s turns=${row.turns} tools=${row.tool_calls} cacheR=${(100 * row.cache_read_ratio).toFixed(0)}% ${row.status}` +
        (row.empty_completion ? " EMPTY" : "") + (row.model_mismatch ? " MODEL-MISMATCH" : "") + (row.error ? ` err=${row.error.slice(0, 120)}` : ""),
    );
    if (spent >= MAX_USD) {
      console.error(`[bench] spend $${spent.toFixed(2)} reached --max-usd ${MAX_USD}; stopping.`);
      finish();
      process.exit(2);
    }
  }
}
setOpusTierBenchmarkOverride(undefined);
finish();
console.log(`[bench] spent $${spent.toFixed(2)}`);
process.exit(0);
