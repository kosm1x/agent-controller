/**
 * Blind LLM grader for a fast-tier benchmark run
 * (`benchmarks/sonnet-tier-<stamp>/`, written by scripts/benchmark-sonnet-tier.ts;
 * plan in docs/planning/model-tier-rerun-2026-10-06.md).
 *
 * Per task: the replayed request (`results/<task>-request.md`; older runs
 * without it fall back to the task title), the stored production answer
 * (`results/<task>-orig.md`, shown as REFERENCE context, not ground truth) and
 * every arm's answer (`results/<task>-<arm>.md`, answer text only — the header
 * naming the model is stripped). Arms are shuffled with a seeded PRNG and
 * relabelled R1..Rk, so the grader never sees an arm id or model. ONE grader
 * call per task returns strict JSON {R1:{fit,grounding,quality,rationale},…},
 * integer 1-5:
 *   fit       — does it answer what was asked;
 *   grounding — no invented specifics vs the original context;
 *   quality   — register / length / usefulness for the operator's Spanish
 *               WhatsApp/Telegram chat.
 *
 * Inference: the existing queryClaudeSdk path with the benchmark seam's
 * `defaultModel` (setOpusTierBenchmarkOverride) — no tools, maxTurns 1,
 * costLedger false. Same operator-side safety as the harness: --run required
 * to spend; live env inherited from /proc/<MainPID>/environ (never printed;
 * CLAUDE* keys of the launching shell stripped first; launcher keys win);
 * KB mirror → scratch, pgvector + Drive off, budget off; the outbound secret
 * scrub reads its index from an ISOLATED mc.db copy (scratch, 0600).
 *
 * Output (inside the benchmark dir, gitignored, 0700/0600):
 *   <dir>/grades/grades.jsonl     one row per task: blind→arm mapping, scores, cost
 *   <dir>/grades/grades-summary.md per-arm means (fit/grounding/quality, n), Δ vs A, per-task table
 * A re-run skips tasks already graded without error (resume after a --max-usd
 * stop). Resume is keyed on (task, grader model, seed, sorted arm set): when
 * grades.jsonl already holds a row graded under a different key the run
 * refuses, unless --force-mixed (then only key-matching rows count as done;
 * the latest row per task wins in the summary).
 * --arms=… is strict: a task missing any requested arm is skipped (logged), so
 * every arm's mean is over the same tasks.
 * --max-usd is checked BEFORE each call against spent + that call's rough
 * estimate; the run stops (exit 2, resumable) when the next call would cross it.
 * The cap is per invocation: a resumed run starts a fresh --max-usd budget
 * (spend from earlier invocations is not counted).
 * The isolated mc.db copy (it includes projects.credentials) is removed when
 * every --run exits: success, error, or Ctrl-C / SIGTERM (exit 130 / 143).
 *
 * Usage (repo root):
 *   npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-<stamp>            # DRY: what would be graded (exit 3)
 *   npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-<stamp> --run
 *   npx tsx scripts/grade-benchmark.ts benchmarks/sonnet-tier-<stamp> --summarize
 * Flags: --grader-model=claude-opus-5-5 --max-usd=10 --arms=A,C,D,E --tasks=<8-char prefixes>
 *        --seed=grade-v1 --timeout-s=300 --force-mixed
 * Exit: 0 done, 2 usage/error/--max-usd stop, 3 dry.
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// No imports and no env reads at module load — safe ahead of the env guards.
import { calculateCost, getPricing } from "../src/budget/pricing.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for scripts/grade-benchmark.test.ts)
// ---------------------------------------------------------------------------
export const AXES = ["fit", "grounding", "quality"] as const;
export type Axis = (typeof AXES)[number];
export type Score = Record<Axis, number> & { rationale: string };

const SEP = "\n\n---\n\n";
/** The arm-file metadata line the harness writes (`status=… cost=$… <n>s
 *  turns=… tools=[…] model=…[ error=…]`), immediately followed by the separator. */
const STATUS_LINE = /\n\nstatus=\S+ cost=\S+ \S+ turns=\S+ tools=\[[^\]\n]*\] model=\S+(?: error=[\s\S]*?)?\n\n---\n\n/;

/**
 * Header/answer split of a results/*.md file, independent of what the task
 * title contains (a title may itself hold a `---` separator):
 *   - arm file: the header ends at the explicit `status=… model=…` line;
 *   - orig file with `title` known (from an arm file): the header is exactly
 *     `# …` + title;
 *   - otherwise the first separator (orig files of older runs).
 * `title` is returned when the header pins it down.
 */
export function parseResultFile(content: string, title?: string): { header: string; answer: string; title?: string } {
  const nl = content.indexOf("\n\n");
  const m = STATUS_LINE.exec(content);
  if (m) {
    const end = m.index + m[0].length;
    return { header: content.slice(0, end - SEP.length), answer: content.slice(end).trim(), title: nl >= 0 && nl < m.index ? content.slice(nl + 2, m.index) : undefined };
  }
  if (title !== undefined && nl >= 0 && content.startsWith(`\n\n${title}${SEP}`, nl)) {
    const end = nl + 2 + title.length + SEP.length;
    return { header: content.slice(0, end - SEP.length), answer: content.slice(end).trim(), title };
  }
  const i = content.indexOf(SEP);
  if (i < 0) return { header: "", answer: content.trim() };
  return { header: content.slice(0, i), answer: content.slice(i + SEP.length).trim() };
}

/** Title line(s) of an orig.md header: everything after the `# …` line. */
export function titleFromHeader(header: string): string {
  const j = header.indexOf("\n\n");
  return j < 0 ? "" : header.slice(j + 2).trim();
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic Fisher-Yates (mulberry32 seeded by `seed`). */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let a = fnv1a(seed);
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Blind labels: R1..Rk → arm id, in shuffled order. */
export function blindMapping(arms: readonly string[], seed: string): Record<string, string> {
  const m: Record<string, string> = {};
  seededShuffle(arms, seed).forEach((arm, i) => (m[`R${i + 1}`] = arm));
  return m;
}

/** Strict parse of the grader's JSON: every label present, every axis an integer 1-5. */
export function parseGrades(text: string, labels: readonly string[]): Record<string, Score> {
  const t = text.replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in grader output");
  const obj = JSON.parse(t.slice(a, b + 1)) as Record<string, Record<string, unknown>>;
  const out: Record<string, Score> = {};
  for (const label of labels) {
    const g = obj[label];
    if (!g || typeof g !== "object") throw new Error(`grader output lacks ${label}`);
    const s = { rationale: typeof g.rationale === "string" ? g.rationale : "" } as Score;
    for (const axis of AXES) {
      const v = g[axis];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) {
        throw new Error(`${label}.${axis} is not an integer 1-5 (${JSON.stringify(v)})`);
      }
      s[axis] = v;
    }
    out[label] = s;
  }
  const extra = Object.keys(obj).filter((k) => !labels.includes(k));
  if (extra.length) throw new Error(`grader output has unknown labels: ${extra.join(",")}`);
  return out;
}

export const GRADER_SYSTEM = [
  "You are a strict, blind evaluator of answers written by Jarvis, one operator's personal assistant, which talks with the operator in Spanish over WhatsApp and Telegram.",
  "You get: the request (with recent prior turns when it was a chat), a REFERENCE answer that production delivered at the time (it had the full tool set; it is context, not ground truth — it can be wrong), and K candidate answers labelled R1..RK in random order. Candidates may have had fewer tools than production.",
  "Score EACH candidate independently, integers 1-5 (5 excellent, 3 acceptable with clear flaws, 1 fails):",
  "- fit: does it answer what was actually asked (the right question, the whole ask, the requested form such as length or format)?",
  "- grounding: no invented specifics. A name, number, date, file, quote or fact that is not in the request, the prior turns or the reference answer, and not plausibly returned by a tool the candidate reports calling, counts against it. Honestly saying something could not be checked is grounded.",
  "- quality: register, length and usefulness for the operator reading on a phone in a Spanish chat: direct, the right length for the ask, no internal narration, no stray tool-request lines or status markers, actionable.",
  'Return ONLY one JSON object, no prose and no code fence, with exactly the keys R1..RK: {"R1":{"fit":4,"grounding":5,"quality":3,"rationale":"<= 40 words, English"},...}',
].join("\n");

/** Rough grader-call cost: chars/3.5 input tokens, ~1.5k thinking + 120/candidate output. */
export function estimateGradeCost(request: string, reference: string, cands: Candidate[], graderModel: string): number {
  const p = getPricing(graderModel);
  const inTok = (GRADER_SYSTEM.length + buildGraderPrompt(request, reference, cands).length) / 3.5;
  return (inTok / 1000) * p.promptCostPer1k + ((1500 + 120 * cands.length) / 1000) * p.completionCostPer1k;
}

/** Pre-spend cap: the reason to stop when the next call's estimate would cross --max-usd, else null. */
export function preSpendStop(spent: number, estimate: number, maxUsd: number): string | null {
  return spent + estimate > maxUsd
    ? `spent $${spent.toFixed(2)} + next call est $${estimate.toFixed(2)} would exceed --max-usd ${maxUsd}`
    : null;
}

/** Resume key: grader model, seed and the sorted arm set (the task is the map key). */
export function gradeKey(graderModel: string, seed: string, arms: readonly string[]): string {
  return `${graderModel}|${seed}|${[...arms].sort().join(",")}`;
}
export function rowKey(r: GradeRow): string {
  return gradeKey(r.grader_model, r.seed, Object.values(r.mapping));
}

/**
 * Split the jobs into done / to-grade against the existing rows. `mismatched`
 * lists tasks whose latest error-free row was graded under another key
 * (another grader model, seed or arm set); the caller refuses unless
 * --force-mixed, in which case those tasks are re-graded.
 */
export function resumePlan(rows: GradeRow[], jobs: Array<{ task: string; key: string }>): { done: Set<string>; mismatched: Array<{ task: string; had: string; want: string }> } {
  const latest = new Map(latestGrades(rows).map((r) => [r.task, r]));
  const done = new Set<string>();
  const mismatched: Array<{ task: string; had: string; want: string }> = [];
  for (const j of jobs) {
    const r = latest.get(j.task);
    if (!r) continue;
    const had = rowKey(r);
    if (had === j.key) done.add(j.task);
    else mismatched.push({ task: j.task, had, want: j.key });
  }
  return { done, mismatched };
}

export interface Candidate {
  label: string;
  answer: string;
  tools?: string[];
}
export function buildGraderPrompt(request: string, reference: string, cands: Candidate[]): string {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[cut ${s.length - n} chars]` : s);
  const L = ["# REQUEST", "", cap(request, 12000), "", "# REFERENCE (production answer at the time)", "", cap(reference, 8000) || "(empty)", ""];
  for (const c of cands) {
    L.push(`# ${c.label}${c.tools ? ` (tools called: ${c.tools.length ? c.tools.join(", ") : "none"})` : ""}`, "");
    L.push(cap(c.answer, 12000) || "(empty answer — nothing was delivered)", "");
  }
  L.push(`Grade ${cands.map((c) => c.label).join(", ")} now. JSON only.`);
  return L.join("\n");
}

export interface GradeRow {
  task: string;
  grader_model: string;
  seed: string;
  mapping: Record<string, string>; // blind label → arm
  scores: Record<string, Score>; // arm → score (empty on error)
  arm_models: Record<string, string>;
  request_source: "request.md" | "title";
  cost_usd: number;
  cost_authoritative: boolean;
  pricing_cost_usd: number;
  effective_model: string;
  duration_ms: number;
  graded_at: string;
  error?: string;
}

const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Latest error-free row per task wins. */
export function latestGrades(rows: GradeRow[]): GradeRow[] {
  const by = new Map<string, GradeRow>();
  for (const r of rows) if (!r.error) by.set(r.task, r);
  return [...by.values()];
}

export function renderGradeSummary(rows: GradeRow[], benchDir: string): string {
  const ok = latestGrades(rows);
  const arms = [...new Set(ok.flatMap((r) => Object.keys(r.scores)))].sort();
  const models: Record<string, string> = {};
  for (const r of ok) for (const [a, m] of Object.entries(r.arm_models)) models[a] ??= m;
  const L: string[] = [];
  L.push(`# Blind grades — ${benchDir.split("/").filter(Boolean).pop()}`);
  L.push("");
  const graders = [...new Set(ok.map((r) => r.grader_model))].join(", ") || "n/a";
  const spend = rows.reduce((s, r) => s + r.cost_usd, 0);
  L.push(`Generated ${new Date().toISOString()} · graded tasks ${ok.length} · grader ${graders} · grader spend $${spend.toFixed(2)} (all rows incl. errors) · errors ${rows.filter((r) => r.error).length}`);
  L.push("");
  L.push("## Per arm (means, 1-5)");
  L.push("");
  L.push("| arm | model | n | fit | grounding | quality | mean | Δfit vs A | Δgrounding vs A | Δquality vs A | none below A by > 0.3 |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const m = (arm: string, axis: Axis) => mean(ok.filter((r) => r.scores[arm]).map((r) => r.scores[arm][axis]));
  for (const arm of arms) {
    const n = ok.filter((r) => r.scores[arm]).length;
    const v = AXES.map((x) => m(arm, x));
    const all = mean(v.filter((x): x is number => x !== null));
    const d = AXES.map((x) => {
      const a = m(arm, x);
      const base = m("A", x);
      return a === null || base === null || arm === "A" ? null : a - base;
    });
    const within = arm === "A" || !arms.includes("A") ? "—" : d.every((x) => x !== null && x >= -0.3) ? "PASS" : "FAIL";
    L.push(`| ${arm} | ${models[arm] ?? "?"} | ${n} | ${v.map(fmt).join(" | ")} | ${fmt(all)} | ${d.map((x) => (x === null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(2))).join(" | ")} | ${within} |`);
  }
  L.push("");
  L.push("Δ uses each arm's own n; with paired runs every arm has the same tasks. The decision rule (plan doc §3) also needs the harness's four gates and the zero-tool count.");
  L.push("");
  L.push("## Per task (fit/grounding/quality)");
  L.push("");
  L.push(`| task | ${arms.join(" | ")} |`);
  L.push(`|---|${arms.map(() => "---").join("|")}|`);
  for (const r of ok) {
    L.push(`| ${r.task} | ${arms.map((a) => (r.scores[a] ? AXES.map((x) => r.scores[a][x]).join("/") : "—")).join(" | ")} |`);
  }
  L.push("");
  const errs = rows.filter((r) => r.error);
  if (errs.length) {
    L.push("## Errors");
    L.push("");
    for (const e of errs) L.push(`- ${e.task}: ${e.error?.slice(0, 200)}`);
    L.push("");
  }
  L.push("Rationales and the blind mapping per task are in grades.jsonl (private: they paraphrase chat content).");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const RUN = argv.includes("--run");
  const SUMMARIZE = argv.includes("--summarize");
  const FORCE_MIXED = argv.includes("--force-mixed");
  const dirArg = argv.find((a) => !a.startsWith("--"));
  if (!dirArg) {
    console.error("[grade] usage: npx tsx scripts/grade-benchmark.ts <benchmarks/sonnet-tier-<stamp>> [--run|--summarize]");
    return 2;
  }
  const DIR = resolve(dirArg);
  const RESULTS = join(DIR, "results");
  if (!existsSync(RESULTS)) {
    console.error(`[grade] ${RESULTS} not found — expected a benchmark-sonnet-tier output dir`);
    return 2;
  }
  const GRADER_MODEL = flag("grader-model") ?? "claude-opus-5-5";
  const MAX_USD = Number(flag("max-usd") ?? "10");
  const TIMEOUT_S = Number(flag("timeout-s") ?? "300");
  const SEED = flag("seed") ?? "grade-v1";
  for (const [k, v] of [["max-usd", MAX_USD], ["timeout-s", TIMEOUT_S]] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`[grade] --${k} must be a positive number`);
      return 2;
    }
  }
  const OUT = join(DIR, "grades");
  const GRADES = join(OUT, "grades.jsonl");
  const readGrades = (): GradeRow[] =>
    existsSync(GRADES) ? readFileSync(GRADES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GradeRow) : [];
  const finish = () => {
    const md = renderGradeSummary(readGrades(), DIR);
    writeFileSync(join(OUT, "grades-summary.md"), md, { mode: 0o600 });
    console.log(`\n${md}\n[grade] summary ${join(OUT, "grades-summary.md")}`);
  };
  if (SUMMARIZE) {
    if (!existsSync(GRADES)) {
      console.error(`[grade] ${GRADES} not found`);
      return 2;
    }
    finish();
    return 0;
  }

  // --- task set from results/ (+ calls.jsonl for models / tools) ---
  const wantArms = flag("arms")?.split(",").filter(Boolean);
  const wantTasks = flag("tasks")?.split(",").filter(Boolean);
  const files = readdirSync(RESULTS);
  const calls = existsSync(join(DIR, "calls.jsonl"))
    ? readFileSync(join(DIR, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { task: string; arm: string; model: string; tool_names?: string[] })
    : [];
  interface Job {
    task: string;
    request: string;
    requestSource: GradeRow["request_source"];
    reference: string;
    arms: Array<{ arm: string; answer: string; tools?: string[] }>;
    armModels: Record<string, string>;
  }
  const jobs: Job[] = [];
  for (const f of files.filter((x) => x.endsWith("-orig.md")).sort()) {
    const task = f.slice(0, -"-orig.md".length);
    if (wantTasks && !wantTasks.some((p) => task.startsWith(p))) continue;
    const reqPath = join(RESULTS, `${task}-request.md`);
    const hasReq = existsSync(reqPath);
    const armFiles = files.filter((x) => new RegExp(`^${task}-([A-Z])\\.md$`).test(x)).sort();
    const present = armFiles.map((x) => x.slice(task.length + 1, -3));
    const lacking = wantArms?.filter((a) => !present.includes(a)) ?? [];
    if (lacking.length) {
      // Paired means: a task without every requested arm would leave that arm's mean over fewer tasks.
      console.log(`[grade] skip ${task}: lacks requested arm(s) ${lacking.join(",")} (has ${present.join(",") || "none"})`);
      continue;
    }
    let title: string | undefined;
    const arms = present
      .filter((a) => !wantArms || wantArms.includes(a))
      .map((arm) => {
        const parsed = parseResultFile(readFileSync(join(RESULTS, `${task}-${arm}.md`), "utf8"));
        title ??= parsed.title;
        return { arm, answer: parsed.answer, tools: calls.find((c) => c.task === task && c.arm === arm)?.tool_names };
      });
    if (arms.length < 2) continue; // nothing to compare
    const orig = parseResultFile(readFileSync(join(RESULTS, f), "utf8"), title);
    const armModels: Record<string, string> = {};
    for (const a of arms) armModels[a.arm] = calls.find((c) => c.task === task && c.arm === a.arm)?.model ?? "?";
    jobs.push({
      task,
      request: hasReq ? readFileSync(reqPath, "utf8") : `(request text not stored by this run; task title follows)\n\n${orig.title ?? titleFromHeader(orig.header)}`,
      requestSource: hasReq ? "request.md" : "title",
      reference: orig.answer,
      arms,
      armModels,
    });
  }
  if (jobs.length === 0) {
    console.error("[grade] no task with ≥2 arm answers to grade");
    return 2;
  }
  const keyOf = (j: Job) => gradeKey(GRADER_MODEL, SEED, j.arms.map((a) => a.arm));
  const { done, mismatched } = resumePlan(readGrades(), jobs.map((j) => ({ task: j.task, key: keyOf(j) })));
  if (mismatched.length) {
    const ex = mismatched.slice(0, 5).map((x) => `${x.task} (graded ${x.had}, now ${x.want})`).join("; ");
    if (!FORCE_MIXED) {
      console.error(
        `[grade] ${GRADES} holds ${mismatched.length} task(s) graded under a different grader|seed|arms key: ${ex}. ` +
          "Re-run with the same --grader-model/--seed/--arms, use a fresh benchmark copy, or pass --force-mixed to re-grade those tasks (the summary then mixes keys).",
      );
      return 2;
    }
    console.log(`[grade] --force-mixed: re-grading ${mismatched.length} task(s) graded under another key: ${ex}`);
  }
  const todo = jobs.filter((j) => !done.has(j.task));

  const estOf = (j: Job) => estimateGradeCost(j.request, j.reference, j.arms.map((a, i) => ({ label: `R${i + 1}`, answer: a.answer, tools: a.tools })), GRADER_MODEL);
  const est = todo.reduce((s, j) => s + estOf(j), 0);
  console.log(`[grade] ${DIR}`);
  console.log(`[grade] ${jobs.length} task(s) gradable, ${done.size} already graded, ${todo.length} to grade · grader ${GRADER_MODEL} · seed ${SEED} · max $${MAX_USD} · rough est $${est.toFixed(2)}`);
  for (const j of todo) {
    console.log(`  ${j.task} arms=${j.arms.map((a) => a.arm).join(",")} request=${j.requestSource} ref=${j.reference.length}ch`);
  }
  if (todo.some((j) => j.requestSource === "title")) {
    console.log("[grade] NOTE: runs older than 2026-10-06 have no <task>-request.md — the grader sees only the task title as the request.");
  }
  if (!RUN) {
    console.log("[grade] DRY — pass --run to fire real grader calls.");
    return 3;
  }

  // --- live env (operator-side), guards, isolated DB — before any other src import ---
  const stripped = Object.keys(process.env).filter((k) => /^CLAUDE/.test(k));
  for (const k of stripped) delete process.env[k];
  const launcherEffort = "SONNET_EFFORT" in process.env;
  let pid = process.env.MC_PID ?? "";
  if (!pid) {
    try {
      pid = execSync("systemctl show -p MainPID --value mission-control", { encoding: "utf8" }).trim();
    } catch {
      /* ignore */
    }
  }
  if (!pid || !existsSync(`/proc/${pid}/environ`)) {
    console.error("[grade] cannot find the live mission-control env (MainPID); set MC_PID=<pid>.");
    return 2;
  }
  for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0 && !(kv.slice(0, i) in process.env)) process.env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  // A Sonnet grader must not inherit the canary's SONNET_EFFORT (launcher wins).
  if (!launcherEffort) delete process.env.SONNET_EFFORT;
  // With TOOL_SEARCH_ENABLED=true claude-sdk.ts adds ToolSearch to
  // allowedTools even when toolNames is empty; on a maxTurns:1 grader call a
  // ToolSearch turn would end in error_max_turns. The grader needs no tools.
  delete process.env.TOOL_SEARCH_ENABLED;
  const SCRATCH = process.env.MC_BENCH_SCRATCH ?? join("/root/claude/mission-control", "data/grade-bench");
  mkdirSync(join(SCRATCH, "kb-mirror"), { recursive: true, mode: 0o700 });
  process.env.JARVIS_KB_MIRROR_DIR = join(SCRATCH, "kb-mirror");
  delete process.env.COMMIT_DB_KEY;
  delete process.env.DRIVE_KB_FOLDER_ID;
  process.env.BUDGET_ENABLED = "false";
  process.env.BUDGET_ENFORCE = "false";
  console.log(`[grade] env guards: KB mirror -> ${process.env.JARVIS_KB_MIRROR_DIR} · pgvector off · Drive off · tool search off · ${stripped.length} launching-shell CLAUDE* key(s) stripped`);
  // The outbound secret scrub (queryClaudeSdk) builds its index from the DB.
  const SRC_DB = "/root/claude/mission-control/data/mc.db";
  const DST_DB = join(SCRATCH, "bench.db");
  const { initDatabase, closeDatabase } = await import("../src/db/index.js");
  // The copy carries projects.credentials; it is only needed while grading.
  const removeCopy = () => {
    try {
      closeDatabase();
    } catch {
      /* not opened */
    }
    for (const ext of ["", "-wal", "-shm"]) rmSync(DST_DB + ext, { force: true });
    console.log(`[grade] removed the isolated mc.db copy ${DST_DB}`);
  };
  // Ctrl-C / kill skip the finally below; remove the copy before exiting.
  process.once("SIGINT", () => {
    removeCopy();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    removeCopy();
    process.exit(143);
  });
  try {
    copyFileSync(SRC_DB, DST_DB);
    chmodSync(DST_DB, 0o600);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(SRC_DB + ext)) {
        copyFileSync(SRC_DB + ext, DST_DB + ext);
        chmodSync(DST_DB + ext, 0o600);
      }
    }
    initDatabase(DST_DB);
    const { queryClaudeSdk, setOpusTierBenchmarkOverride } = await import("../src/inference/claude-sdk.js");
    type SdkResult = import("../src/inference/claude-sdk.js").ClaudeSdkResult;

    mkdirSync(OUT, { recursive: true, mode: 0o700 });
    chmodSync(OUT, 0o700);
    const ERROR_RE = /\[error_api_response|error_max_turns|\[error_max_budget_usd|\[refusal\]|\[timeout/;
    let spent = 0;
    for (const j of todo) {
      const stop = preSpendStop(spent, estOf(j), MAX_USD);
      if (stop) {
        console.error(`[grade] ${j.task}: ${stop}; stopping before the call (re-run resumes).`);
        finish();
        return 2;
      }
      const mapping = blindMapping(j.arms.map((a) => a.arm), `${SEED}:${j.task}`);
      const labels = Object.keys(mapping);
      const cands = labels.map((label) => {
        const a = j.arms.find((x) => x.arm === mapping[label])!;
        return { label, answer: a.answer, tools: a.tools };
      });
      const taps: SdkResult[] = [];
      setOpusTierBenchmarkOverride({ defaultModel: GRADER_MODEL, tap: (r) => taps.push(r) });
      const t0 = Date.now();
      let text = "";
      let error: string | undefined;
      try {
        const r = await queryClaudeSdk({
          prompt: buildGraderPrompt(j.request, j.reference, cands),
          systemPrompt: GRADER_SYSTEM,
          toolNames: [],
          maxTurns: 1,
          costLedger: false,
          abortSignal: AbortSignal.timeout(TIMEOUT_S * 1000),
        });
        text = r.text;
      } catch (err) {
        error = String((err as Error)?.message ?? err);
      } finally {
        setOpusTierBenchmarkOverride(undefined);
      }
      let scores: Record<string, Score> = {};
      if (!error && ERROR_RE.test(text)) error = text.match(ERROR_RE)?.[0];
      if (!error) {
        try {
          const byLabel = parseGrades(text, labels);
          for (const label of labels) scores[mapping[label]] = byLabel[label];
        } catch (err) {
          error = `parse: ${String((err as Error)?.message ?? err)}`;
          scores = {};
        }
      }
      const cost = taps.reduce(
        (s, t) => s + (t.costAuthoritative ? t.costUsd : calculateCost(t.model || GRADER_MODEL, t.usage.promptTokens, t.usage.completionTokens, t.usage.cacheReadTokens, t.usage.cacheCreationTokens)),
        0,
      );
      const priced = taps.reduce(
        (s, t) => s + calculateCost(t.model || GRADER_MODEL, t.usage.promptTokens, t.usage.completionTokens, t.usage.cacheReadTokens, t.usage.cacheCreationTokens),
        0,
      );
      spent += cost;
      const row: GradeRow = {
        task: j.task,
        grader_model: GRADER_MODEL,
        seed: SEED,
        mapping,
        scores,
        arm_models: j.armModels,
        request_source: j.requestSource,
        cost_usd: cost,
        cost_authoritative: taps.length > 0 && taps.every((t) => t.costAuthoritative),
        pricing_cost_usd: priced,
        effective_model: [...new Set(taps.map((t) => t.model))].join("+") || "none",
        duration_ms: Date.now() - t0,
        graded_at: new Date().toISOString(),
        ...(error && { error }),
      };
      appendFileSync(GRADES, JSON.stringify(row) + "\n", { mode: 0o600 });
      console.log(
        `  ${j.task} ${row.effective_model} $${cost.toFixed(4)} (pricing.ts $${priced.toFixed(4)}) ${(row.duration_ms / 1000).toFixed(0)}s ` +
          (error ? `ERR ${error.slice(0, 120)}` : Object.entries(scores).sort().map(([a, s]) => `${a}=${s.fit}/${s.grounding}/${s.quality}`).join(" ")),
      );
    }
    finish();
    console.log(`[grade] spent $${spent.toFixed(2)}`);
    return 0;
  } finally {
    removeCopy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[grade] ${String((err as Error)?.stack ?? err)}`);
      process.exit(2);
    },
  );
}
