/**
 * V9 W1 — the grader gate's SPECS: what the completion grader judges, and
 * where those specs live in each mode (docs/planning/v9-w1-decision-2026-10.md
 * §4, option B: a capable-tier grader as one more gate inside the V8.4
 * completion ledger, not a second "done" decision).
 *
 * A criterion is gradeable when no command can check it:
 *   (a) Prometheus PROSE criteria — `splitCriteria` keeps only object-form
 *       criteria with a `check` as runnable gates; the rest reached the ledger
 *       never and were judged only by the in-loop `selfAssess` (same tier,
 *       fails open). Captured where the plan's gates are declared
 *       (orchestrator / swarm) via `proseGradeSpecsFromGoal`.
 *   (b) existing `manual` ledger rows from submissions / rituals (never
 *       flipped by `evaluateLedger`; read as unverified until now).
 * Read-back, landing and shell gates are untouched.
 *
 * Mode (`TASK_GATES_GRADER`, separate from `TASK_GATES_MODE`):
 *   off      (default; unknown values too) — nothing declared, stored, called.
 *   shadow   — prose specs are NOT declared as rows (a row would appear in the
 *              live `Gates:` line under TASK_GATES_MODE=enforce). They wait in
 *              an in-memory per-task registry — a restart loses them, which is
 *              acceptable for shadow measurement. The consumer grades them
 *              in the background after the ledger work (never awaited by the
 *              completion seam) and records verdicts on the `gates.graded`
 *              trace only.
 *   enforce  — prose specs become harness `GR-*` manual rows whose check is
 *              `grade:<origin>`; existing manual rows are graded in place
 *              through `recordGradeVerdict`. Requires TASK_GATES_MODE != off:
 *              with the ledger off there is no consumer to read the rows, so
 *              enforce resolves to off (dormant is the safe direction).
 *
 * Specs follow the plan's lifecycle (`syncGradeSpecs`): registered for the
 * initial plan, reconciled on every replan (removed / rewritten goals'
 * specs withdrawn, new goals' specs registered under fresh ids), and
 * withdrawn for goals left unfinished on an early exit — so a criterion of
 * work never attempted is never graded `failed`. Swarm-registered ids carry
 * their own namespace (`GR-sw.`) so a child that runs its own planner
 * (`GR-g-1.1`, …) cannot collide with them.
 *
 * Ledger doctrine holds: the model has no writer for these rows (`GR-` is
 * reserved for source=harness in `declareGates`; gate-check ignores ABANDON
 * lines that target a GR row), `met` requires evidence, and nothing here can
 * promote a status — a `failed` grade demotes through the existing enforce
 * logic in consumer.ts.
 */
import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { isSimpleTask } from "../../prometheus/model-tier.js";
import { emitTraceEvent } from "../../observability/task-trace.js";
import {
  MAX_EVIDENCE,
  declareGates,
  gatesMode,
  isGradeRow,
  parseAbandonLines,
  singleLineRedacted,
  type GateRow,
} from "./gates.js";
import {
  GRADE_ID_PREFIX,
  GRADE_PREFIX,
  isReadbackCheck,
} from "./ledger-lines.js";

export { GRADE_ID_PREFIX };

export type GraderMode = "off" | "shadow" | "enforce";
export type GradeOrigin = "prose" | "manual";

/** One criterion the grader judges. `id` is the ledger gate id (GR-* or the manual row's). */
export interface GradeSpec {
  id: string;
  criterion: string;
  origin: GradeOrigin;
}

export type GradeVerdictKind = "met" | "failed" | "pending";

/** The grader's per-criterion answer. `met` always carries non-empty evidence. */
export interface GradeVerdict {
  id: string;
  verdict: GradeVerdictKind;
  evidence: string;
}

/**
 * Why a graded run is not a plain verdict set (outcomes states, decision
 * note §2): never a new ledger state, always a named reason on the trace.
 */
export type GraderReason =
  | "budget_exhausted"
  | "grader_unavailable"
  | "no_verdict"
  | "skipped_simple"
  | "skipped_concurrency"
  | `interrupted — ${string}`;

export interface GraderUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Attrs of the `gates.graded` trace event (one per grading decision). */
export interface GradedTraceAttrs {
  mode: Exclude<GraderMode, "off">;
  /** Always 1 in v1 (no replan on a failed grade — decision note §5 Phase 6). */
  iteration: 1;
  /** Model that actually answered; null when no call was made or it threw. */
  model: string | null;
  /**
   * Per-criterion verdicts, shrunk to fit the 2000-char attrs cap: evidence
   * first, then dropped, then the list itself (`counts` always survives).
   */
  criteria: Array<{ id: string; verdict: GradeVerdictKind; evidence?: string }>;
  /** Criteria count before any shrinking. */
  criteria_total: number;
  /** Verdict counts over ALL criteria — survives every shrink step. */
  counts: Record<GradeVerdictKind, number>;
  latency_ms: number;
  usage: GraderUsage | null;
  cost_usd?: number;
  reason?: GraderReason;
  status_before: string;
}

export const DEFAULT_GRADER_BUDGET_MS = 90_000;
const MIN_GRADER_BUDGET_MS = 5_000;
const MAX_GRADER_BUDGET_MS = 600_000;
const MAX_CRITERION = 500; // mirrors gates.ts
/** Shadow registry bound — tasks that die before the consumer must not grow it forever. */
const MAX_SHADOW_TASKS = 500;

export function graderMode(env: NodeJS.ProcessEnv = process.env): GraderMode {
  const raw = (env.TASK_GATES_GRADER ?? "off").trim().toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "shadow") return "shadow";
  return "off";
}

/** The mode every caller acts on: enforce without a ledger consumer is off. */
export function effectiveGraderMode(
  env: NodeJS.ProcessEnv = process.env,
): GraderMode {
  const mode = graderMode(env);
  if (mode === "enforce" && gatesMode(env) === "off") return "off";
  return mode;
}

/** `TASK_GATES_GRADER_BUDGET_MS`, clamped to [5 s, 10 min]; junk ⇒ 90 s. */
export function graderBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TASK_GATES_GRADER_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GRADER_BUDGET_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GRADER_BUDGET_MS;
  return Math.min(MAX_GRADER_BUDGET_MS, Math.max(MIN_GRADER_BUDGET_MS, n));
}

/**
 * Id namespace: `plan` for the orchestrator's own planner goals
 * (`GR-<goal>.<n>`), `swarm` for goals a swarm parent hands to a child
 * (`GR-sw.<goal>.<n>`). A swarm child routed to a runner with its own
 * planner registers `GR-g-1.1`… for ITS goals on the same task id — distinct
 * namespaces keep both sets (INSERT OR IGNORE would drop one silently).
 */
export type GradeIdNamespace = "plan" | "swarm";

/** `GR-<goal>.<n>` / `GR-sw.<goal>.<n>` — goal part sanitised like plan gate ids, within GATE_ID_RE. */
export function gradeGateId(
  goalId: string,
  n: number,
  ns: GradeIdNamespace = "plan",
): string {
  return `${GRADE_ID_PREFIX}${ns === "swarm" ? "sw." : ""}${goalId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20)}.${n}`;
}

/**
 * Prose criteria of one planner goal: its `completionCriteria` minus the ones
 * that carry a runnable proof on `metadata.gates` (those are plan gates
 * already), whitespace-collapsed, de-duplicated, capped. Leaves
 * `splitCriteria`'s contract untouched — it reads both of its outputs.
 */
export function proseCriteriaOfGoal(
  completionCriteria: readonly string[] | undefined,
  metadata: Record<string, unknown> | undefined,
): string[] {
  const runnable = new Set<string>();
  if (Array.isArray(metadata?.gates)) {
    for (const g of metadata.gates as unknown[]) {
      const c = (g as { criterion?: unknown } | null)?.criterion;
      if (typeof c === "string" && c.trim()) runnable.add(c.trim());
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of completionCriteria ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || runnable.has(trimmed)) continue;
    const c = trimmed.replace(/\s+/g, " ").slice(0, MAX_CRITERION);
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/** The goal's prose criteria as specs numbered from 1 (fresh registration). */
export function proseGradeSpecsFromGoal(
  goalId: string,
  completionCriteria: readonly string[] | undefined,
  metadata: Record<string, unknown> | undefined,
  ns: GradeIdNamespace = "plan",
): GradeSpec[] {
  return proseCriteriaOfGoal(completionCriteria, metadata).map((c, i) => ({
    id: gradeGateId(goalId, i + 1, ns),
    criterion: c,
    origin: "prose" as const,
  }));
}

// ── shadow registry (in-memory; restart loses it — acceptable for shadow) ──

const shadowSpecsByTask = new Map<string, GradeSpec[]>();

/** Returns the shadow specs registered for the task and forgets them. */
export function takeShadowGradeSpecs(taskId: string): GradeSpec[] {
  const specs = shadowSpecsByTask.get(taskId) ?? [];
  shadowSpecsByTask.delete(taskId);
  return specs;
}

/** Test seam. */
export function _resetShadowGradeSpecs(): void {
  shadowSpecsByTask.clear();
}

/** Test seam: read without freeing. */
export function _peekShadowGradeSpecs(taskId: string): GradeSpec[] {
  return shadowSpecsByTask.get(taskId) ?? [];
}

export interface RegisterGradeSpecsResult {
  mode: GraderMode;
  registered: number;
  skipped?: "simple";
}

/**
 * Plan-time entry point (orchestrator / swarm): keep the prose specs where
 * the current mode wants them. off ⇒ nothing; SIMPLE-class task ⇒ nothing
 * (traced); shadow ⇒ registry; enforce ⇒ harness `GR-*` manual rows.
 * Never throws — a grading hiccup must not fail planning.
 */
export function registerGradeSpecs(
  taskId: string,
  specs: readonly GradeSpec[],
  taskDescription: string,
  opts: { env?: NodeJS.ProcessEnv; db?: Database.Database } = {},
): RegisterGradeSpecsResult {
  const mode = effectiveGraderMode(opts.env);
  if (mode === "off" || specs.length === 0) return { mode, registered: 0 };
  try {
    if (isSimpleTask(taskDescription)) {
      emitTraceEvent({
        taskId,
        name: "gates.graded",
        attrs: {
          ...buildGradedAttrs({
            mode,
            verdicts: specs.map((s) => ({
              id: s.id,
              verdict: "pending",
              evidence: "not graded — simple-class task",
            })),
            reason: "skipped_simple",
            statusBefore: "planned",
          }),
        },
      });
      return { mode, registered: 0, skipped: "simple" };
    }
    if (mode === "shadow") {
      const prev = shadowSpecsByTask.get(taskId) ?? [];
      const ids = new Set(prev.map((s) => s.id));
      const next = [...prev, ...specs.filter((s) => !ids.has(s.id))];
      shadowSpecsByTask.delete(taskId); // re-insert ⇒ newest last for the cap
      shadowSpecsByTask.set(taskId, next);
      while (shadowSpecsByTask.size > MAX_SHADOW_TASKS) {
        const oldest = shadowSpecsByTask.keys().next().value;
        if (oldest === undefined) break;
        shadowSpecsByTask.delete(oldest);
      }
      const registered = next.length - prev.length;
      traceSpecs(taskId, mode, "registered", specs, { registered });
      return { mode, registered };
    }
    const registered = declareGates(
      taskId,
      specs.map((s) => ({
        id: s.id,
        criterion: s.criterion,
        kind: "manual" as const,
        check: `${GRADE_PREFIX}${s.origin}`,
      })),
      "harness",
      opts.db ?? getDatabase(),
    );
    // An id already on the ledger is ignored by declareGates — never silent.
    const dropped = specs.length - registered;
    if (dropped > 0) {
      console.warn(
        `[grader] ${taskId}: ${dropped} grade spec(s) not declared — id already on the ledger`,
      );
    }
    traceSpecs(taskId, mode, "registered", specs, {
      registered,
      ...(dropped > 0 && { dropped }),
    });
    return { mode, registered };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[grader] ${taskId}: grade specs not registered: ${msg}`);
    traceSpecs(taskId, mode, "error", specs, { error: msg.slice(0, 300) });
    return { mode, registered: 0 };
  }
}

const TRACE_MAX_SPEC_IDS = 40;
const CRITERION_STEPS = [200, 120, 80, 40] as const;

/**
 * One `gates.grade_specs` trace per spec lifecycle step (R1 audit I6). A
 * registration also carries each spec's criterion text (shadow keeps no
 * other copy — the labelling readout joins it; R2 audit W3), shrunk like
 * `buildGradedAttrs` to stay under the trace attrs cap: criterion text
 * first, then the criteria list, then the id list. Never throws.
 */
function traceSpecs(
  taskId: string,
  mode: Exclude<GraderMode, "off">,
  action: "registered" | "withdrawn" | "error",
  specs: readonly GradeSpec[],
  extra: Record<string, unknown>,
): void {
  try {
    const withCriteria = action === "registered";
    const build = (nIds: number, nCrit: number, per: number) => ({
      mode,
      action,
      total: specs.length,
      ids: specs.slice(0, nIds).map((s) => s.id),
      ...(withCriteria && {
        criteria: specs.slice(0, nCrit).map((s) => ({
          id: s.id,
          criterion: singleLineRedacted(s.criterion, per),
        })),
      }),
      ...extra,
    });
    const fits = (a: object) => JSON.stringify(a).length <= TRACE_ATTRS_TARGET;
    const maxIds = Math.min(specs.length, TRACE_MAX_SPEC_IDS);
    let attrs: Record<string, unknown> | null = null;
    for (const per of CRITERION_STEPS) {
      const a = build(maxIds, withCriteria ? maxIds : 0, per);
      if (fits(a)) {
        attrs = a;
        break;
      }
    }
    for (let n = maxIds - 1; !attrs && n >= 0; n--) {
      const a = build(maxIds, withCriteria ? n : 0, CRITERION_STEPS.at(-1)!);
      if (fits(a)) attrs = a;
    }
    for (let n = maxIds - 1; !attrs && n >= 0; n--) {
      const a = build(n, 0, 0);
      if (fits(a)) attrs = a;
    }
    emitTraceEvent({
      taskId,
      name: "gates.grade_specs",
      attrs: attrs ?? build(0, 0, 0),
    });
  } catch {
    /* tracing must never break planning */
  }
}
/**
 * Withdraw specs that must never be graded (goal unfinished, removed or
 * rewritten by a replan): enforce ⇒ their still-pending GR rows ABANDONED
 * with the reason (visible on the Gates line); shadow ⇒ dropped from the
 * registry. Returns how many were withdrawn. Never throws.
 */
export function withdrawGradeSpecs(
  taskId: string,
  specs: readonly GradeSpec[],
  reason: string,
  opts: { env?: NodeJS.ProcessEnv; db?: Database.Database } = {},
): number {
  const mode = effectiveGraderMode(opts.env);
  if (mode === "off" || specs.length === 0) return 0;
  try {
    const ids = new Set(specs.map((s) => s.id));
    let withdrawn = 0;
    if (mode === "shadow") {
      const prev = shadowSpecsByTask.get(taskId);
      if (prev) {
        const next = prev.filter((s) => !ids.has(s.id));
        withdrawn = prev.length - next.length;
        shadowSpecsByTask.set(taskId, next);
      }
    } else {
      const db = opts.db ?? getDatabase();
      const stmt = db.prepare(
        `UPDATE task_gates
            SET state = 'abandoned', abandon_reason = ?, checked_at = datetime('now')
          WHERE task_id = ? AND gate_id = ? AND source = 'harness'
            AND check_kind = 'manual' AND state = 'pending'
            AND check_cmd LIKE '${GRADE_PREFIX}%'`,
      );
      const r = reason.slice(0, 300);
      db.transaction(() => {
        for (const id of ids) withdrawn += stmt.run(r, taskId, id).changes;
      })();
    }
    traceSpecs(taskId, mode, "withdrawn", specs, {
      withdrawn,
      reason: reason.slice(0, 200),
    });
    return withdrawn;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[grader] ${taskId}: grade specs not withdrawn: ${msg}`);
    traceSpecs(taskId, mode, "error", specs, { error: msg.slice(0, 300) });
    return 0;
  }
}

// ── plan lifecycle (orchestrator) ──────────────────────────────────────────

/** What one orchestration has registered, per goal; ids are never reused. */
export interface GradeSpecPlan {
  byGoal: Map<string, GradeSpec[]>;
  used: Set<string>;
}

export function newGradeSpecPlan(): GradeSpecPlan {
  return { byGoal: new Map(), used: new Set() };
}

export interface PlanGoalLike {
  id: string;
  completionCriteria?: readonly string[];
  metadata?: Record<string, unknown>;
}

/**
 * Bring the registered specs in line with the CURRENT goal graph (initial
 * plan, resume, every replan). A goal criterion already registered keeps
 * its id; a removed goal's — or a rewritten criterion's — spec is
 * withdrawn with `reason`; a new criterion gets a fresh, never-used id (a
 * reused id would hit the abandoned row and be dropped). On the first
 * enforce sync of a run (plan empty) the task's existing GR rows are read
 * first: a resumed plan adopts its still-pending rows and never reuses an
 * abandoned id. Never throws.
 */
export function syncGradeSpecs(
  taskId: string,
  plan: GradeSpecPlan,
  goals: readonly PlanGoalLike[],
  taskDescription: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    db?: Database.Database;
    reason?: string;
  } = {},
): { registered: number; withdrawn: number } {
  if (effectiveGraderMode(opts.env) === "off") {
    return { registered: 0, withdrawn: 0 };
  }
  try {
    if (
      effectiveGraderMode(opts.env) === "enforce" &&
      plan.used.size === 0 &&
      plan.byGoal.size === 0
    ) {
      adoptLedgerGradeRows(taskId, plan, goals, opts.db ?? getDatabase());
    }
    const next = new Map<string, GradeSpec[]>();
    const added: GradeSpec[] = [];
    const kept = new Set<string>();
    for (const goal of goals) {
      const prev = plan.byGoal.get(goal.id) ?? [];
      const specs: GradeSpec[] = [];
      for (const c of proseCriteriaOfGoal(
        goal.completionCriteria,
        goal.metadata,
      )) {
        const same = prev.find((s) => s.criterion === c);
        if (same) {
          specs.push(same);
          kept.add(same.id);
          continue;
        }
        let n = 1;
        while (plan.used.has(gradeGateId(goal.id, n))) n++;
        const spec: GradeSpec = {
          id: gradeGateId(goal.id, n),
          criterion: c,
          origin: "prose",
        };
        plan.used.add(spec.id);
        specs.push(spec);
        added.push(spec);
      }
      if (specs.length > 0) next.set(goal.id, specs);
    }
    const gone = [...plan.byGoal.values()]
      .flat()
      .filter((s) => !kept.has(s.id));
    plan.byGoal = next;
    const withdrawn =
      gone.length > 0
        ? withdrawGradeSpecs(
            taskId,
            gone,
            opts.reason ?? "goal removed or rewritten by a replan",
            opts,
          )
        : 0;
    const registered =
      added.length > 0
        ? registerGradeSpecs(taskId, added, taskDescription, opts).registered
        : 0;
    return { registered, withdrawn };
  } catch (err) {
    console.warn(
      `[grader] ${taskId}: grade specs not synced: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { registered: 0, withdrawn: 0 };
  }
}

/**
 * Resume (enforce): every GR row already on the task's ledger reserves its
 * id; a still-pending planner row (`GR-<goal>.<n>`, not the swarm's
 * `GR-sw.*`) of a goal in the graph is adopted as already registered, so
 * the sync keeps it (same criterion) or withdraws it (criterion gone).
 */
function adoptLedgerGradeRows(
  taskId: string,
  plan: GradeSpecPlan,
  goals: readonly PlanGoalLike[],
  db: Database.Database,
): void {
  const rows = db
    .prepare(
      `SELECT gate_id, criterion, state FROM task_gates
        WHERE task_id = ? AND source = 'harness' AND check_kind = 'manual'
          AND check_cmd LIKE '${GRADE_PREFIX}%' ORDER BY rowid`,
    )
    .all(taskId) as Array<{ gate_id: string; criterion: string; state: string }>;
  for (const r of rows) {
    plan.used.add(r.gate_id);
    if (r.state !== "pending") continue;
    const goal = goals.find((g) => {
      const head = gradeGateId(g.id, 0).slice(0, -1); // "GR-<goal>."
      return (
        r.gate_id.startsWith(head) && /^\d+$/.test(r.gate_id.slice(head.length))
      );
    });
    if (!goal) continue;
    const list = plan.byGoal.get(goal.id) ?? [];
    list.push({ id: r.gate_id, criterion: r.criterion, origin: "prose" });
    plan.byGoal.set(goal.id, list);
  }
}

/** Early exit: the unfinished goals' specs are withdrawn, never graded `failed`. */
export function withdrawGradeSpecsForGoals(
  taskId: string,
  plan: GradeSpecPlan,
  goalIds: readonly string[],
  reason: string,
  opts: { env?: NodeJS.ProcessEnv; db?: Database.Database } = {},
): number {
  const specs = goalIds.flatMap((g) => plan.byGoal.get(g) ?? []);
  for (const g of goalIds) plan.byGoal.delete(g);
  return withdrawGradeSpecs(taskId, specs, reason, opts);
}

/**
 * Completion-time spec collection. enforce: the task's pending GR rows
 * (prose) + pending manual rows; shadow: the registry's prose specs + pending
 * manual rows (read, never written). A manual row the report ABANDONs is left
 * to that surrender — `evaluateLedger` records it right after; grading it
 * first would let a graded `failed` be voided by the line (or vice versa).
 */
export function collectGradeSpecs(
  taskId: string,
  rows: readonly GateRow[],
  deliverable: string,
  mode: Exclude<GraderMode, "off">,
): GradeSpec[] {
  const abandoned = new Set(
    parseAbandonLines(deliverable).map((a) => a.gateId),
  );
  const prose: GradeSpec[] =
    mode === "shadow"
      ? takeShadowGradeSpecs(taskId)
      : rows
          .filter((r) => isGradeRow(r) && r.state === "pending")
          .map((r) => ({
            id: r.gate_id,
            criterion: r.criterion,
            origin: "prose" as const,
          }));
  const manual: GradeSpec[] = rows
    .filter(
      (r) =>
        r.check_kind === "manual" &&
        r.state === "pending" &&
        !isReadbackCheck(r.check_kind, r.check_cmd) &&
        !isGradeRow(r) &&
        !abandoned.has(r.gate_id),
    )
    .map((r) => ({ id: r.gate_id, criterion: r.criterion, origin: "manual" }));
  return [...prose, ...manual];
}

/**
 * Harness-only writer for a grade (enforce). Touches only `manual`, still
 * `pending`, non-read-back rows; `met` without evidence is refused (false).
 * A `pending` verdict keeps the state and records WHY in evidence (reads as
 * unverified — never failed, never met).
 */
export function recordGradeVerdict(
  taskId: string,
  verdict: GradeVerdict,
  db: Database.Database = getDatabase(),
): boolean {
  // The evidence lands on the `Gates:` line: one line, redacted (R1 W3).
  const evidence = singleLineRedacted(verdict.evidence, MAX_EVIDENCE);
  if (verdict.verdict === "met" && !evidence) return false;
  const info = db
    .prepare(
      `UPDATE task_gates SET state = ?, evidence = ?, checked_at = datetime('now')
        WHERE task_id = ? AND gate_id = ? AND check_kind = 'manual'
          AND state = 'pending'
          AND (check_cmd IS NULL OR check_cmd NOT LIKE 'readback:%')`,
    )
    .run(verdict.verdict, evidence || null, taskId, verdict.id);
  return info.changes > 0;
}

/** Task did not complete ⇒ its pending grade gates are surrendered with the reason (visible). */
export function abandonPendingGradeRows(
  taskId: string,
  reason: string,
  db: Database.Database = getDatabase(),
): number {
  return db
    .prepare(
      `UPDATE task_gates
          SET state = 'abandoned', abandon_reason = ?, checked_at = datetime('now')
        WHERE task_id = ? AND source = 'harness' AND check_kind = 'manual'
          AND state = 'pending' AND check_cmd LIKE '${GRADE_PREFIX}%'`,
    )
    .run(reason.slice(0, 300), taskId).changes;
}

/**
 * Trace attrs live under ATTRS_MAX_CHARS (2000) — past it the row is stored
 * as `{truncated}` and the readout loses it (R1 audit W2). Measure the
 * serialized attrs and shrink until they fit: per-criterion evidence first,
 * then evidence dropped, then the criteria list cut. mode / model / reason /
 * counts / usage always survive.
 */
const TRACE_MAX_CRITERIA = 12;
/**
 * Mirrors task-trace's ATTRS_MAX_CHARS (a test pins the two equal). A local
 * copy, not an import: many suites mock task-trace with a bare factory.
 */
export const TRACE_ATTRS_MAX_CHARS = 2000;
/** Headroom for credential redaction at emit time (it can lengthen a match). */
const TRACE_ATTRS_TARGET = TRACE_ATTRS_MAX_CHARS - 150;
const EVIDENCE_STEPS = [160, 100, 60, 30, 0] as const;

export function buildGradedAttrs(args: {
  mode: Exclude<GraderMode, "off">;
  verdicts: readonly GradeVerdict[];
  statusBefore: string;
  model?: string | null;
  latencyMs?: number;
  usage?: GraderUsage | null;
  costUsd?: number;
  reason?: GraderReason;
}): GradedTraceAttrs {
  const counts: Record<GradeVerdictKind, number> = {
    met: 0,
    failed: 0,
    pending: 0,
  };
  for (const v of args.verdicts) counts[v.verdict]++;
  const build = (n: number, per: number): GradedTraceAttrs => ({
    mode: args.mode,
    iteration: 1,
    model: args.model ?? null,
    criteria: args.verdicts.slice(0, n).map((v) => ({
      id: v.id,
      verdict: v.verdict,
      ...(per > 0 && { evidence: v.evidence.slice(0, per) }),
    })),
    criteria_total: args.verdicts.length,
    counts,
    latency_ms: args.latencyMs ?? 0,
    usage: args.usage ?? null,
    ...(args.costUsd !== undefined && { cost_usd: args.costUsd }),
    ...(args.reason !== undefined && {
      reason: args.reason.slice(0, 300) as GraderReason,
    }),
    status_before: args.statusBefore.slice(0, 60),
  });
  const fits = (a: GradedTraceAttrs) =>
    JSON.stringify(a).length <= TRACE_ATTRS_TARGET;
  for (const per of EVIDENCE_STEPS) {
    const a = build(TRACE_MAX_CRITERIA, per);
    if (fits(a)) return a;
  }
  for (let n = TRACE_MAX_CRITERIA - 1; n >= 0; n--) {
    const a = build(n, 0);
    if (fits(a)) return a;
  }
  return build(0, 0);
}
