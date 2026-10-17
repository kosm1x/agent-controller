/**
 * S6 ruling 5b (2026-10-12) — capabilities a task reaches ONLY through its
 * attributed project's record (spec docs/planning/s6-project-contract-spec-2026-10-11.md
 * ruling 5; queue 3f). Two consumers:
 *   - record-gated core tools (`capabilities.tools`, today `crm_query`, owned
 *     by `pulso-aura-upfront`): offered to a run only when its project's
 *     record declares the tool (`recordGatedToolScope`);
 *   - X accounts (`secrets` names `SECRET_X_AUTH_TOKEN__<HANDLE>` …), read by
 *     `lib/x-poster/config.ts` through `currentRunProject` + `projectConfigs`.
 *
 * The record is read from its projection (`projects.config`, operator-only
 * keys), the task's project from `tasks.project_slug` (S6 WS2 attribution).
 *
 * MIGRATION (stated to the operator; removed in a follow-up once the records
 * exist): while NO record declares a capability, every run keeps today's
 * env-keyed behaviour and logs one `… env-keyed fallback` line per task.
 * Outside a dispatcher run (cron, boot) there is no task: today's
 * behaviour, no trace. The interactive confirm seam runs a confirmed call
 * under its task's attribution (`withAttributedTask`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getDatabase } from "../db/index.js";
import { errMsg } from "../lib/err-msg.js";
import { currentRunTaskId } from "../tools/rule-of-two.js";
import { emitTraceEvent } from "../observability/task-trace.js";

import { RECORD_GATED_TOOLS } from "./record.js";

export { RECORD_GATED_TOOLS };
export type RecordGatedTool = (typeof RECORD_GATED_TOOLS)[number];

export function isRecordGatedTool(name: string): name is RecordGatedTool {
  return (RECORD_GATED_TOOLS as readonly string[]).includes(name);
}

export interface RunProject {
  /** null: attributed to no task (`withAttributedTask(null, …)`). */
  taskId: string | null;
  /** `tasks.project_slug`; null for operator-level work (or a missing row). */
  slug: string | null;
}

/**
 * The task a call is attributed to when it runs outside the task's own run:
 * the router's confirm seam executes an operator-confirmed call after the run
 * that showed the card has ended. Deliberately NOT `enterRunToolContext`:
 * that would hand the Rule-of-Two / V8.3 pipeline an empty prior instead of
 * the unknown one it fails closed on, and record the call's evidence and
 * write outcome against the finished task. Read only by `currentRunProject`.
 */
const attributedTask = new AsyncLocalStorage<{ taskId: string | null }>();

/**
 * Run `fn` attributed to `taskId`; `null` = attributed to NO task (a card
 * re-armed at boot: `tool_approvals` keeps no task id). Such a call resolves
 * as an unattributed task: the env fallback while no record declares, else
 * nothing record-gated is reachable.
 */
export function withAttributedTask<T>(taskId: string | null, fn: () => T): T {
  return attributedTask.run({ taskId }, fn);
}

/**
 * The current run's (or attributed) task and its project; null with neither
 * (outside any run). An attribution to no task gives `{ taskId: null, slug:
 * null }`. Throws on a db error.
 */
export function currentRunProject(): RunProject | null {
  const attributed = attributedTask.getStore();
  if (attributed && attributed.taskId === null) return { taskId: null, slug: null };
  const taskId = currentRunTaskId() ?? attributed?.taskId;
  if (taskId === undefined) return null;
  const row = getDatabase()
    .prepare("SELECT project_slug FROM tasks WHERE task_id = ?")
    .get(taskId) as { project_slug?: unknown } | undefined;
  const slug = typeof row?.project_slug === "string" && row.project_slug !== "" ? row.project_slug : null;
  return { taskId, slug };
}

/** Trace key of a decision that belongs to no task (the timeline needs one). */
const NO_TASK_TRACE_KEY = "attribution:none";
/** Trace key of a process-level record finding (no task involved). */
const RECORDS_TRACE_KEY = "project-records";

export interface ProjectConfigEntry {
  slug: string;
  config: Record<string, unknown>;
  /**
   * The row's config is not valid JSON: the row counts as DECLARING (record
   * mode, fail closed) and contributes nothing — a corrupt declaring record
   * must not flip every task back to the env fallback.
   */
  invalid?: true;
}

const recordFindings = new Set<string>();
/**
 * A process-level finding about the records (no task): one console.warn and
 * one trace event per `key` per process. Slugs and names only, never a value.
 */
export function warnRecordFindingOnce(
  key: string,
  line: string,
  name: "capability.record_invalid" | "capability.handle_shared",
  attrs: Record<string, unknown>,
): void {
  if (recordFindings.has(key)) return;
  if (recordFindings.size >= 1000) recordFindings.clear();
  recordFindings.add(key);
  console.warn(line);
  emitTraceEvent({ taskId: RECORDS_TRACE_KEY, name, attrs });
}

function warnInvalidRecordOnce(slug: string): void {
  warnRecordFindingOnce(
    `invalid\0${slug}`,
    `[projects] project ${slug}: config is not valid JSON; record mode forced, nothing reachable through it`,
    "capability.record_invalid",
    { slug },
  );
}

/** Every project row's projected `config` (record-owned keys included). Throws on a db error. */
export function projectConfigs(): ProjectConfigEntry[] {
  const rows = getDatabase().prepare("SELECT slug, config FROM projects").all() as Array<{
    slug: unknown;
    config: unknown;
  }>;
  const out: ProjectConfigEntry[] = [];
  for (const r of rows) {
    if (typeof r.slug !== "string") continue;
    let config: unknown = {};
    try {
      config = typeof r.config === "string" && r.config !== "" ? JSON.parse(r.config) : {};
    } catch {
      warnInvalidRecordOnce(r.slug);
      out.push({ slug: r.slug, config: {}, invalid: true });
      continue;
    }
    out.push({
      slug: r.slug,
      config: config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {},
    });
  }
  return out;
}

/** A scope decision's trace payload: slugs, mode and names only, never a value. */
export interface ScopeTraceAttrs {
  slug: string | null;
  mode: "fallback" | "record";
  tool?: string;
  handles?: string[];
}

const traced = new Set<string>();
/**
 * Log `line` and emit one `capability.scope` trace event, once per task
 * (bounded; lines and attrs carry slugs and names only, never a value).
 */
export function traceOncePerTask(taskId: string | null, line: string, attrs: ScopeTraceAttrs): void {
  const key = `${taskId}\0${line}`;
  if (traced.has(key)) return;
  if (traced.size >= 1000) traced.clear();
  traced.add(key);
  console.log(line);
  emitTraceEvent({
    taskId: taskId ?? NO_TASK_TRACE_KEY,
    name: "capability.scope",
    ...(attrs.tool !== undefined && { tool: attrs.tool }),
    attrs: { ...attrs },
  });
}

/** A failed record lookup (fail closed): one `capability.scope` event per failure, no error text. */
export function traceLookupFailure(scope: string): void {
  emitTraceEvent({
    taskId: currentRunTaskId() ?? NO_TASK_TRACE_KEY,
    name: "capability.scope",
    attrs: { slug: null, mode: "record", scope, lookup: "failed" },
  });
}

/** Tests: forget the once-per-task / once-per-process dedupe. */
export function _resetCapabilityTracesForTests(): void {
  traced.clear();
  recordFindings.clear();
}

/** The `capabilities.tools` a projected record config declares. */
export function declaredCapabilityTools(config: Record<string, unknown>): string[] {
  const caps = config.capabilities as { tools?: unknown } | undefined;
  if (!caps || typeof caps !== "object" || !Array.isArray(caps.tools)) return [];
  return caps.tools.filter((t): t is string => typeof t === "string");
}

export type ToolCapabilityScope =
  | { mode: "outside-run"; offered: true }
  | { mode: "fallback"; offered: true; slug: string | null }
  | { mode: "record"; offered: boolean; slug: string | null };

/**
 * Whether the current run may use `tool`: outside a run, yes (no task);
 * while no record declares it, yes (migration fallback, traced per task);
 * otherwise only when the run's attributed project's record declares it.
 * A db error inside a run fails closed.
 */
export function recordGatedToolScope(tool: RecordGatedTool): ToolCapabilityScope {
  let run: RunProject | null;
  let configs: ProjectConfigEntry[];
  try {
    run = currentRunProject();
    if (!run) return { mode: "outside-run", offered: true };
    configs = projectConfigs();
  } catch (err) {
    console.warn(`[${tool}] project record lookup failed (${errMsg(err)}); not offered`);
    traceLookupFailure(tool);
    return { mode: "record", offered: false, slug: null };
  }
  const owners = configs.filter((c) => declaredCapabilityTools(c.config).includes(tool)).map((c) => c.slug);
  // An unparseable row may be a declaring one: record mode (fail closed).
  if (owners.length === 0 && !configs.some((c) => c.invalid)) {
    traceOncePerTask(
      run.taskId,
      `[${tool}] no record-declared capability for project ${run.slug ?? "none"}; env-keyed fallback`,
      { slug: run.slug, mode: "fallback", tool },
    );
    return { mode: "fallback", offered: true, slug: run.slug };
  }
  const offered = run.slug !== null && owners.includes(run.slug);
  if (!offered) {
    traceOncePerTask(run.taskId, `[${tool}] not a capability of project ${run.slug ?? "none"}; not offered`, {
      slug: run.slug,
      mode: "record",
      tool,
    });
  }
  return { mode: "record", offered, slug: run.slug };
}

/** Registry filter: false only for a record-gated tool the current run's project does not declare. */
export function isToolOfferedToCurrentRun(name: string): boolean {
  return !isRecordGatedTool(name) || recordGatedToolScope(name).offered;
}
