/**
 * v7.7 Spine 3 Phase 4 — S5 skill dispatcher (`skill_run`).
 *
 * Looks up the active version of a skill, validates `args` against the
 * frontmatter-generated Zod schema, runs the body via the shared
 * mini-runner harness, and updates skills accounting + cost_ledger +
 * skill_failures + Prom counters.
 *
 * Phase 4 scope (per spec §7 + §11 Mode 2):
 *
 *   - `runSkill(name, args, options)` is the single execution entry.
 *   - The 3 deferred builtin tools (`skill_describe`/`skill_load`/`skill_run`)
 *     in Bundle 2 all funnel through this function.
 *   - Cycle detection: depth bound 3; `_callStack` threaded through
 *     `options` so a skill body that decides to call another skill can't
 *     recursively self-invoke.
 *   - Anti-list write path (spec §10): on failure increment
 *     `consecutive_failures`, insert `skill_failures`. On success: reset
 *     the counter, mark unresolved failures as `self_recovered`.
 *   - Cost ledger (spec §12 S4 alignment): every run records to
 *     `cost_ledger` with `agent_type='skill:<name>'` so per-skill cost
 *     analysis is one GROUP BY query.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "../db/index.js";
import { recordCost } from "../budget/service.js";
import { createLogger } from "../lib/logger.js";
import { recordSkillRun } from "../observability/prometheus.js";

const log = createLogger("skills:dispatcher");
import { runSkillPrompt, type MiniRunUsage } from "./mini-runner.js";
import { validateSkillArgs } from "./inputs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Spec §15 Q4: depth bound 3 by default. Override via
 * `MC_MAX_SKILL_CALL_DEPTH` env var (positive integer, capped at
 * `MAX_REASONABLE_SKILL_CALL_DEPTH`). Invalid values silently fall back
 * to the default to avoid boot failure on typos.
 */
const MAX_REASONABLE_SKILL_CALL_DEPTH = 20;
function readMaxSkillCallDepth(): number {
  const raw = process.env.MC_MAX_SKILL_CALL_DEPTH;
  if (raw === undefined || raw === "") return 3;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return 3;
  return Math.min(parsed, MAX_REASONABLE_SKILL_CALL_DEPTH);
}
export const MAX_SKILL_CALL_DEPTH = readMaxSkillCallDepth();

/** Default model recorded into cost_ledger when the adapter doesn't surface one. */
const COST_LEDGER_FALLBACK_MODEL = "skill-runner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunSkillOptions {
  /** Override mini-runner timeout. Default 30s. */
  timeoutMs?: number;
  /** Override inference provider. */
  providerName?: string;
  /** Caller abort signal — propagates into the mini-runner. */
  signal?: AbortSignal;
  /** Task id for cost_ledger / skill_failures provenance. */
  taskId?: string;
  /**
   * Skill name call stack (spec §15 Q4). Each nested dispatch appends
   * the skill name; we reject when the new name is already present OR
   * when the stack would exceed MAX_SKILL_CALL_DEPTH. Callers in tool
   * bodies pass the runtime stack through this option.
   */
  _callStack?: string[];
  /**
   * Spec §7: when true the dispatcher MUST NOT mutate skill state
   * (use_count, success_count, consecutive_failures, skill_failures).
   * cost_ledger still records — sandbox-mode runs still cost money.
   * Phase 4 ships the flag; Phase 5 wires test mocks behind it.
   */
  dryRun?: boolean;
}

export type SkillRunErrorClass =
  | "skill_not_found"
  | "skill_inactive"
  | "no_active_version"
  | "skill_corrupt"
  | "input_validation"
  | "cycle_detected"
  | "tool_unavailable"
  | "wrong_output"
  | "timeout"
  | "other";

export interface SkillRunResult {
  /** True when the LLM returned a parseable, non-error JSON response. */
  ok: boolean;
  skillName: string;
  /** UUID; null on skill_not_found (we have nothing to attribute). */
  skillId: string | null;
  /** Resolved active version id; null when no current version is pointed at. */
  versionId: number | null;
  /** Parsed LLM output on success. */
  output: Record<string, unknown> | null;
  /** Single error class on failure. */
  errorClass: SkillRunErrorClass | null;
  /** Short diagnostic. */
  errorDetail: string | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface ResolvedSkillRow {
  skill_id: string;
  name: string;
  active: number;
  current_version_id: number | null;
}

interface ResolvedVersionRow {
  id: number;
  body: string;
  inputs_json: string;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Invoke a skill by name. Never throws — all failure paths return a
 * fully-populated SkillRunResult so tool wrappers can render a uniform
 * error envelope to the LLM.
 *
 * Side effects (when ok=true):
 *   - reset `consecutive_failures=0`
 *   - increment `use_count` + `success_count`
 *   - mark any `skill_failures` rows with `resolved_at IS NULL` as
 *     `resolution='self_recovered'`
 *   - INSERT cost_ledger
 *   - bump `mc_skills_run_total{name, result="ok"}`
 *
 * Side effects (when ok=false, except cycle_detected and the early
 * lookup failures which can't be attributed to a known skill_id):
 *   - increment `use_count` + `consecutive_failures`
 *   - INSERT skill_failures
 *   - INSERT cost_ledger
 *   - bump `mc_skills_run_total{name, result=<errorClass>}`
 */
export async function runSkill(
  name: string,
  args: unknown,
  options: RunSkillOptions = {},
): Promise<SkillRunResult> {
  const t0 = Date.now();
  const callStack = options._callStack ?? [];

  // Cycle detection BEFORE DB lookup — cheap defense against runaway
  // recursion when the skill registry is busy.
  if (callStack.includes(name)) {
    bumpRunCounter(name, "cycle_detected");
    return {
      ok: false,
      skillName: name,
      skillId: null,
      versionId: null,
      output: null,
      errorClass: "cycle_detected",
      errorDetail: `skill "${name}" already in call stack [${callStack.join(" → ")}]`,
      durationMs: Date.now() - t0,
    };
  }
  if (callStack.length >= MAX_SKILL_CALL_DEPTH) {
    bumpRunCounter(name, "cycle_detected");
    return {
      ok: false,
      skillName: name,
      skillId: null,
      versionId: null,
      output: null,
      errorClass: "cycle_detected",
      errorDetail: `max skill call depth ${MAX_SKILL_CALL_DEPTH} exceeded (stack: ${callStack.join(" → ")})`,
      durationMs: Date.now() - t0,
    };
  }

  const skill = lookupSkill(name);
  if (!skill) {
    bumpRunCounter(name, "skill_not_found");
    return {
      ok: false,
      skillName: name,
      skillId: null,
      versionId: null,
      output: null,
      errorClass: "skill_not_found",
      errorDetail: `no skill named "${name}"`,
      durationMs: Date.now() - t0,
    };
  }
  if (skill.active !== 1) {
    bumpRunCounter(name, "skill_inactive");
    return {
      ok: false,
      skillName: name,
      skillId: skill.skill_id,
      versionId: null,
      output: null,
      errorClass: "skill_inactive",
      errorDetail: `skill "${name}" is archived (active=0)`,
      durationMs: Date.now() - t0,
    };
  }
  if (skill.current_version_id === null) {
    bumpRunCounter(name, "no_active_version");
    return {
      ok: false,
      skillName: name,
      skillId: skill.skill_id,
      versionId: null,
      output: null,
      errorClass: "no_active_version",
      errorDetail: `skill "${name}" has no current_version_id (never went through skillSave)`,
      durationMs: Date.now() - t0,
    };
  }

  const version = lookupVersion(skill.current_version_id);
  if (!version) {
    // current_version_id pointer is dangling — DB integrity issue.
    bumpRunCounter(name, "no_active_version");
    return {
      ok: false,
      skillName: name,
      skillId: skill.skill_id,
      versionId: skill.current_version_id,
      output: null,
      errorClass: "no_active_version",
      errorDetail: `skill_versions row ${skill.current_version_id} missing for "${name}"`,
      durationMs: Date.now() - t0,
    };
  }

  // Input validation — generate Zod schema from the version's inputs_json.
  // W3 fold: a corrupt inputs_json column is an INFRASTRUCTURE failure,
  // not a user-input failure. Classify separately so it doesn't burn
  // anti-list counter strikes against a skill whose VERSION row is
  // damaged (operator must repair the row; the skill itself is innocent).
  const argsCheck = validateSkillArgs(version.inputs_json, args);
  if (!argsCheck.ok) {
    const isCorrupt = argsCheck.reason.startsWith("skill inputs_json corrupt");
    return finalizeFailure({
      skill,
      version,
      input: args,
      errorClass: isCorrupt ? "skill_corrupt" : "input_validation",
      detail: argsCheck.reason,
      taskId: options.taskId ?? null,
      dryRun: options.dryRun ?? false,
      t0,
    });
  }

  // LLM dispatch via the shared mini-runner. Spec §7: the skill body
  // becomes the system prompt; the validated args become the user JSON.
  const llmResult = await runSkillPrompt(version.body, argsCheck.value, {
    timeoutMs: options.timeoutMs,
    providerName: options.providerName,
    signal: options.signal,
  });

  switch (llmResult.status) {
    case "timeout":
      return finalizeFailure({
        skill,
        version,
        input: argsCheck.value,
        errorClass: "timeout",
        detail: llmResult.message ?? "skill run timed out",
        taskId: options.taskId ?? null,
        dryRun: options.dryRun ?? false,
        t0,
        llmUsage: llmResult.usage,
      });
    case "empty":
    case "unparseable":
    case "error":
      return finalizeFailure({
        skill,
        version,
        input: argsCheck.value,
        errorClass: "wrong_output",
        detail: llmResult.message ?? `mini-runner status=${llmResult.status}`,
        taskId: options.taskId ?? null,
        dryRun: options.dryRun ?? false,
        t0,
        llmUsage: llmResult.usage,
      });
    case "ok":
      break;
  }

  // OK path: the skill itself may have returned a structured {error,...}
  // payload, which counts as a graceful failure (the skill body validated
  // an invariant and returned an error envelope). Treat it like a
  // wrong_output failure — anti-list still increments — but surface the
  // skill's own error class.
  const output = llmResult.output!;
  if (typeof output.error === "string" && output.error.length > 0) {
    return finalizeFailure({
      skill,
      version,
      input: argsCheck.value,
      errorClass: "wrong_output",
      detail: `skill returned error=${output.error}: ${
        typeof output.detail === "string" ? output.detail.slice(0, 200) : ""
      }`,
      taskId: options.taskId ?? null,
      dryRun: options.dryRun ?? false,
      t0,
      // Cost ledger still records — the LLM ran.
      llmUsage: llmResult.usage,
    });
  }

  // Success path.
  if (!(options.dryRun ?? false)) {
    incrementSuccess(skill.skill_id);
    resolveOpenFailures(skill.skill_id);
  }
  writeCostLedger({
    skillName: skill.name,
    taskId: options.taskId ?? null,
    usage: llmResult.usage,
  });
  bumpRunCounter(skill.name, "ok");

  // Touch use_count too if dryRun (we already skipped incrementSuccess);
  // safety net is the explicit "no skill writes on dryRun" comment above.

  return {
    ok: true,
    skillName: skill.name,
    skillId: skill.skill_id,
    versionId: version.id,
    output,
    errorClass: null,
    errorDetail: null,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// DB lookups
// ---------------------------------------------------------------------------

function lookupSkill(name: string): ResolvedSkillRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare(
        `SELECT skill_id, name, active, current_version_id
         FROM skills
         WHERE name = ?`,
      )
      .get(name) as ResolvedSkillRow | undefined) ?? null
  );
}

function lookupVersion(versionId: number): ResolvedVersionRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare(
        `SELECT id, body, inputs_json
         FROM skill_versions
         WHERE id = ?`,
      )
      .get(versionId) as ResolvedVersionRow | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// Side-effect helpers
// ---------------------------------------------------------------------------

interface FailureContext {
  skill: ResolvedSkillRow;
  version: ResolvedVersionRow;
  input: unknown;
  errorClass: Exclude<
    SkillRunErrorClass,
    | "skill_not_found"
    | "skill_inactive"
    | "no_active_version"
    | "cycle_detected"
  >;
  detail: string;
  taskId: string | null;
  dryRun: boolean;
  t0: number;
  /**
   * Real provider-reported usage. When the LLM never ran (input_validation,
   * skill_corrupt) this is { promptTokens: 0, completionTokens: 0, model:
   * "skill-runner" } so the cost_ledger row still has a coherent shape.
   */
  llmUsage?: MiniRunUsage;
}

function finalizeFailure(ctx: FailureContext): SkillRunResult {
  // W3 fold: a skill_corrupt classification is an infrastructure failure
  // (operator's data is damaged, not the user's call). Don't burn an
  // anti-list strike against a skill whose VERSION row is broken.
  if (!ctx.dryRun && ctx.errorClass !== "skill_corrupt") {
    incrementFailure(ctx.skill.skill_id);
    writeSkillFailure(ctx);
  }
  writeCostLedger({
    skillName: ctx.skill.name,
    taskId: ctx.taskId,
    usage: ctx.llmUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      model: COST_LEDGER_FALLBACK_MODEL,
    },
  });
  bumpRunCounter(ctx.skill.name, ctx.errorClass);
  return {
    ok: false,
    skillName: ctx.skill.name,
    skillId: ctx.skill.skill_id,
    versionId: ctx.version.id,
    output: null,
    errorClass: ctx.errorClass,
    errorDetail: ctx.detail,
    durationMs: Date.now() - ctx.t0,
  };
}

function incrementSuccess(skillId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE skills
       SET use_count = use_count + 1,
           success_count = success_count + 1,
           consecutive_failures = 0,
           last_used = datetime('now'),
           updated_at = datetime('now')
     WHERE skill_id = ?`,
  ).run(skillId);
}

function incrementFailure(skillId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE skills
       SET use_count = use_count + 1,
           consecutive_failures = consecutive_failures + 1,
           last_failure_at = datetime('now'),
           last_used = datetime('now'),
           updated_at = datetime('now')
     WHERE skill_id = ?`,
  ).run(skillId);
}

function resolveOpenFailures(skillId: string): void {
  // Spec §10 prescribes resolution='self_recovered', but the Phase 1
  // skill_failures schema CHECK only admits ('reverted_version',
  // 'fixed_in_new_version','archived') | NULL. Per the same
  // schema-reset queue item that catches `created_by='operator-override'`
  // (S5-P2-I1), `self_recovered` is deferred to v8.0 schema reset.
  // Workaround: set `resolved_at` to mark the row resolved (anti-list
  // filter is the load-bearing invariant; it queries `resolved_at IS
  // NULL`) and leave `resolution` NULL. Tracked as S5-P4-B1-I1.
  const db = getDatabase();
  db.prepare(
    `UPDATE skill_failures
       SET resolved_at = datetime('now')
     WHERE skill_id = ?
       AND resolved_at IS NULL`,
  ).run(skillId);
}

function writeSkillFailure(ctx: FailureContext): void {
  // Map dispatcher's error classes onto the skill_failures CHECK enum.
  // The CHECK constraint admits: wrong_output, tool_unavailable, timeout,
  // critic_runtime_fail, other. Map the dispatcher-side classes that
  // don't have a direct match (input_validation) onto 'other'.
  const mapped: string =
    ctx.errorClass === "input_validation"
      ? "other"
      : ctx.errorClass === "tool_unavailable"
        ? "tool_unavailable"
        : ctx.errorClass === "timeout"
          ? "timeout"
          : ctx.errorClass === "wrong_output"
            ? "wrong_output"
            : "other";

  const db = getDatabase();
  db.prepare(
    `INSERT INTO skill_failures
       (skill_id, task_id, input_json, error_class, error_detail)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    ctx.skill.skill_id,
    ctx.taskId,
    safeJson(ctx.input),
    mapped,
    `[${ctx.errorClass}] ${ctx.detail}`.slice(0, 1024),
  );
}

interface CostCtx {
  skillName: string;
  taskId: string | null;
  usage: MiniRunUsage;
}

function writeCostLedger(ctx: CostCtx): void {
  // Spec §12 / S4 alignment: every skill_run writes ONE cost_ledger row
  // tagged agent_type=`skill:<name>`. C1 audit fold: the dispatcher
  // invokes infer() directly (outside any runner), so this row is the
  // ONLY record of the call's spend. Real provider-reported tokens land
  // here; cost_usd is left as 0 (calculateCost has no entry for the
  // "skill-runner" fallback model — operator wires it at Phase 5 once
  // model attribution travels through the InferenceResponse). For
  // now per-skill spend = SUM(prompt_tokens + completion_tokens)
  // GROUP BY agent_type LIKE 'skill:%' — usable for relative spend
  // attribution within a window even without USD cost.
  //
  // task_id: when caller omits, generate a UUID so the cost_ledger
  // row has a unique handle for log correlation. cost_ledger.task_id
  // is NOT NULL; empty-string sentinel would defeat the spec §12
  // join discipline.
  const taskId = ctx.taskId ?? randomUUID();
  try {
    recordCost({
      runId: randomUUID(),
      taskId,
      agentType: `skill:${ctx.skillName}`,
      model: ctx.usage.model,
      promptTokens: ctx.usage.promptTokens,
      completionTokens: ctx.usage.completionTokens,
    });
  } catch (err) {
    // Cost ledger failure must not abort the skill run.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "cost_ledger write failed",
    );
  }
}

function bumpRunCounter(name: string, result: string): void {
  // Match Phase 2 B2's dynamic-import pattern — keeps the counter
  // chain decoupled and surface the failure path per the
  // counter-recovery-path discipline.
  void Promise.resolve()
    .then(() => recordSkillRun(name, result))
    .catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "counter bump failed",
      );
    });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // W5 fold: lossy fallback gets at least the top-level keys so the
    // operator can correlate the failed input against the skill's
    // expected shape during forensics.
    const keys =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).slice(0, 20)
        : [];
    return JSON.stringify({
      _unserializable: typeof value,
      keys,
    });
  }
}
