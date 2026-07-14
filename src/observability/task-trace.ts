/**
 * Task-trace store — V8.5 Phase 6 (plan §7b, merged from plan-9-10 Sprint 1).
 *
 * Per-task forensic timeline: `task.started → tool.called / turn.completed →
 * task.completed | task.failed`, correlated by task_id in the
 * `task_trace_events` table (created in db/index.ts init). Answers "which
 * tool/round killed this task" without journalctl archaeology. Viewer:
 * `mc-ctl trace <task_id>`.
 *
 * OTel-shaped by design: an event is (name, timestamp, attributes) and the
 * emit seam is this ONE function at the runner/dispatcher layer — a future
 * Langfuse/OTel exporter subscribes here without re-instrumenting call sites
 * (instrumentation-backend-coupling lesson: instrument the stable seam, not
 * the swappable strategy).
 *
 * Coverage: dispatcher lifecycle events cover EVERY runner; per-turn/per-tool
 * events exist only where the SDK loop runs in-process (fast runner —
 * queryClaudeSdk threads `trace`). Container runners (nanoclaw, heavy
 * sandbox) run their SDK loop inside Docker: their traces show lifecycle +
 * the runs-row aggregate, which the viewer renders as a fallback.
 *
 * Every writer is best-effort and never throws — a trace hiccup must not
 * fail the task it is observing.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../db/index.js";
import { errMsg } from "../lib/err-msg.js";

/** Event names — a closed set so the viewer and queries can rely on them. */
export type TraceEventName =
  | "task.started"
  | "task.fallback"
  | "tool.called"
  | "turn.completed"
  | "task.completed"
  | "task.failed"
  | "task.watchdog_failed";

export interface TraceEvent {
  taskId: string;
  name: TraceEventName;
  runId?: string;
  /** Assistant-turn number (1-based) where this event happened. */
  round?: number;
  tool?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number;
  /** Small JSON-serializable extras (agent_type, error, title…). Keep tiny —
   *  this is a timeline, not a payload store. */
  attrs?: Record<string, unknown>;
}

export interface TraceEventRow {
  id: number;
  task_id: string;
  run_id: string | null;
  ts: string;
  name: string;
  round: number | null;
  tool: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  attrs: string | null;
}

/** Cap attrs JSON so a pathological error string can't bloat the table. */
const ATTRS_MAX_CHARS = 2000;

/**
 * Prepared-statement cache keyed by DB handle (audit W1/rec: this is the
 * highest-frequency writer on the chat path — ~150 emits on a 50-turn task —
 * so don't recompile the INSERT per emit). WeakMap because tests re-init
 * :memory: handles; a stale statement on a closed handle must not survive.
 */
const insertStmtCache = new WeakMap<Database.Database, Database.Statement>();

/** Warn throttle (audit W2): under sustained lock contention a single task
 *  would otherwise spam journald with 150 identical lines. */
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;
let suppressedWarns = 0;

/** Test helper: reset the warn throttle so emit-failure specs are
 *  order-independent (mirrors _resetRitualFailureAlertState). */
export function _resetTraceWarnThrottle(): void {
  lastWarnAt = 0;
  suppressedWarns = 0;
}

/**
 * Append one trace event. Best-effort: failures are throttled warnings —
 * tracing must never break (or meaningfully slow) the traced task.
 */
export function emitTraceEvent(ev: TraceEvent): void {
  try {
    let attrs: string | null = null;
    if (ev.attrs !== undefined) {
      attrs = JSON.stringify(ev.attrs);
      if (attrs.length > ATTRS_MAX_CHARS) {
        attrs = JSON.stringify({ truncated: attrs.slice(0, ATTRS_MAX_CHARS) });
      }
    }
    const db = getDatabase();
    let stmt = insertStmtCache.get(db);
    if (!stmt) {
      stmt = db.prepare(
        `INSERT INTO task_trace_events
           (task_id, run_id, name, round, tool, tokens_in, tokens_out,
            cost_usd, latency_ms, attrs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertStmtCache.set(db, stmt);
    }
    stmt.run(
      ev.taskId,
      ev.runId ?? null,
      ev.name,
      ev.round ?? null,
      ev.tool ?? null,
      ev.tokensIn ?? null,
      ev.tokensOut ?? null,
      ev.costUsd ?? null,
      ev.latencyMs ?? null,
      attrs,
    );
  } catch (err) {
    const now = Date.now();
    if (now - lastWarnAt >= WARN_INTERVAL_MS) {
      const suffix =
        suppressedWarns > 0 ? ` (+${suppressedWarns} suppressed)` : "";
      console.warn(
        `[task-trace] emit failed (non-fatal, ${ev.name} for ${ev.taskId}): ${errMsg(err)}${suffix}`,
      );
      lastWarnAt = now;
      suppressedWarns = 0;
    } else {
      suppressedWarns++;
    }
  }
}

/** Full ordered timeline for a task (insertion order = replay order). */
export function getTrace(taskId: string): TraceEventRow[] {
  return getDatabase()
    .prepare(
      `SELECT id, task_id, run_id, ts, name, round, tool, tokens_in,
              tokens_out, cost_usd, latency_ms, attrs
       FROM task_trace_events WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId) as TraceEventRow[];
}

/** Trace retention. Traces are incident forensics — 30 days covers every
 *  post-mortem this year while keeping the table bounded (~thousands of
 *  rows/day worst case). Called from the daily retention cron. */
export const TRACE_RETENTION_DAYS = 30;

export function pruneTraceEvents(days: number = TRACE_RETENTION_DAYS): number {
  try {
    const info = getDatabase()
      .prepare(
        `DELETE FROM task_trace_events
         WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ? || ' days')`,
      )
      .run(days);
    return info.changes;
  } catch (err) {
    console.warn(`[task-trace] prune failed (non-fatal): ${errMsg(err)}`);
    return 0;
  }
}
