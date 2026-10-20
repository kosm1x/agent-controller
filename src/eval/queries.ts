/**
 * V9 W3 step 2 — read-only aggregates for the internal eval report
 * (docs/planning/v9-w3-inventory-2026-10-09.md §4–§7; rulings 2026-10-18 in
 * docs/planning/next-sessions-queue.md "W3 step 1 inventory rulings").
 *
 * READ-ONLY over a better-sqlite3 handle the CALLER opens (readonly); this
 * module never opens, initialises or writes a db. It selects ids, enums,
 * timestamps and numbers only: title, description, input, output text,
 * schedule prompt, result_summary, gate criterion/evidence, concern detail
 * and day-log prose never leave SQLite (JSON lengths and `length()` are
 * computed in SQL).
 *
 * Side rule (inventory §4, mutually exclusive, first match wins) over
 * `tasks.metadata` — the JSON the dispatcher writes at INSERT
 * (`{tags, tools, ritualId, threadId}`, src/dispatch/dispatcher.ts):
 *   operator        `tags` contains "messaging"
 *   ritual          `ritualId` set
 *   scheduled       `tags` contains "scheduled" or a `schedule:<id>` tag
 *   swarm_child     `tasks.spawn_type = 'subtask'`
 *   other_delegated any other valid metadata object
 *   unknown         metadata null or invalid
 *
 * Finished (ruling 2): `status = 'completed'` AND (the operator's W1 label
 * when one exists ? label = 'really done' : every runnable ledger gate met).
 * The label (docs/planning/v9-w1-labels.md, ./labels.ts) replaces only the
 * gate condition. Runnable = `shell` / `landing` rows and harness read-back
 * rows (`isReadbackCheck`), never a grade row (`isGradeCheck`, or a gate_id
 * starting `GR-`, case-sensitive); pure manual rows are not runnable. An
 * abandoned, pending or failed runnable gate is not met. Met = `state =
 * 'met'` whatever the evidence column holds: the ledger writer only sets met
 * with evidence (gates.ts `ledgerVerdict`), so an empty-evidence met row is a
 * writer anomaly this report does not second-guess.
 *
 * The W1 GRADER verdict (GR-* rows first, else the newest real
 * `gates.graded` trace) is a separate column: it never decides finished, it
 * is compared with the label and with the ledger.
 *
 * Printed labels (status, agent_type, gate source, decision values,
 * signals…) pass `safeLabel`: anything outside `[a-z][a-z0-9_]{0,31}` prints
 * as "(other)", so a free-text column cannot carry prose into the report.
 */

import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GRADE_ID_PREFIX, isGradeCheck, isReadbackCheck } from "../lib/v8-4/ledger-lines.js";
import type { LabelsRead, OperatorLabel } from "./labels.js";

type Db = Database.Database;

export const SIDES = [
  "operator",
  "ritual",
  "scheduled",
  "swarm_child",
  "other_delegated",
  "unknown",
] as const;
export type Side = (typeof SIDES)[number];
export const DELEGATED_SIDES: readonly Side[] = ["ritual", "scheduled", "swarm_child", "other_delegated"];
export const isDelegated = (s: Side): boolean => DELEGATED_SIDES.includes(s);

export const TERMINAL_STATUSES: readonly string[] = [
  "completed",
  "completed_with_concerns",
  "failed",
  "blocked",
  "needs_context",
  "cancelled",
];

/** Inclusive tool-call ranges. */
export const TOOL_BUCKETS = [
  { label: "0-2", min: 0, max: 2 },
  { label: "3-5", min: 3, max: 5 },
  { label: "6-10", min: 6, max: 10 },
  { label: "11-20", min: 11, max: 20 },
  { label: "21+", min: 21, max: Number.POSITIVE_INFINITY },
] as const;
/** Half-open wall-clock ranges in minutes: [min, max). */
export const WALL_BUCKETS = [
  { label: "<1 min", min: 0, max: 1 },
  { label: "1-5 min", min: 1, max: 5 },
  { label: "5-10 min", min: 5, max: 10 },
  { label: "10-16 min", min: 10, max: 16 },
] as const;

/** Live task retention, parsed exactly as src/db/retention.ts `retentionDays()`; a longer window reads the archive. */
export function liveTaskDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TASKS_RETENTION_DAYS;
  const n = raw ? Number(raw) : 90;
  return Number.isFinite(n) && n >= 14 ? Math.floor(n) : 90;
}
/** Horizon run: a bucket counts only with n ≥ this. */
export const MIN_BUCKET_N = 5;
export const TRACE_RETENTION_DAYS = 30;
export const DEAD_TABLES = ["tune_eval_results", "signal_baselines", "task_mutations", "commit_tasks", "backtest_runs"];

export type ToolSource = "trace" | "runs.tool_calls" | "output.toolCalls";

export interface TaskFact {
  taskId: string;
  side: Side;
  agentType: string;
  status: string;
  wallMin: number | null;
  toolCalls: number | null;
  toolSource: ToolSource | null;
  runnableTotal: number;
  runnableMet: number;
  /** W1 grader verdict (separate column; never decides finished). */
  grader: "met" | "failed" | null;
  /** Operator W1 label (docs/planning/v9-w1-labels.md); replaces the gate condition. */
  label: OperatorLabel | null;
  costUsd: number;
  /** Numbers audit (newest `numbers.audited` trace): null = no trace. */
  numbers: { found: number; unverified: number } | "error" | null;
  archived: boolean;
}

export function classifySide(metadata: string | null, spawnType: string | null): Side {
  let meta: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(metadata ?? "null");
    if (v && typeof v === "object" && !Array.isArray(v)) meta = v as Record<string, unknown>;
  } catch {
    meta = null;
  }
  const tags = Array.isArray(meta?.tags) ? meta.tags.filter((t): t is string => typeof t === "string") : [];
  if (tags.includes("messaging")) return "operator";
  if (typeof meta?.ritualId === "string" && meta.ritualId.length > 0) return "ritual";
  if (tags.includes("scheduled") || tags.some((t) => t.startsWith("schedule:"))) return "scheduled";
  if (spawnType === "subtask") return "swarm_child";
  return meta ? "other_delegated" : "unknown";
}

/** finished per ruling 2; the operator label replaces only the gate condition. */
export function isFinished(t: Pick<TaskFact, "status" | "label" | "runnableTotal" | "runnableMet">): boolean {
  if (t.status !== "completed") return false;
  if (t.label !== null) return t.label === "really done";
  return t.runnableMet === t.runnableTotal;
}

/** A timestamp printed as-is only when it has a timestamp's shape. */
export function safeTimestamp(v: string | null): string | null {
  if (v === null) return null;
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v) ? v : "(other)";
}

/** A value printed as a label: an enum-shaped token, else "(other)". */
export function safeLabel(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  const s = String(v);
  return /^[a-z][a-z0-9_]{0,31}$/.test(s) ? s : "(other)";
}

/** Nearest-rank percentile; null on an empty list. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]!;
}

export function toolBucket(n: number): string {
  return TOOL_BUCKETS.find((b) => n >= b.min && n <= b.max)!.label;
}
/** null = beyond the last bucket (≥ 16 min). */
export function wallBucket(min: number): string | null {
  return WALL_BUCKETS.find((b) => min >= b.min && min < b.max)?.label ?? null;
}

/** SQLite `datetime()` text, UTC. */
export const sqliteText = (d: Date): string => d.toISOString().replace("T", " ").slice(0, 19);
const parseMs = (s: unknown): number | null => {
  if (typeof s !== "string" || !s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
};

export function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Negative (completed_at < started_at) or missing → unknown. */
const wallOrNull = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v >= 0 ? v : null);

// ── archive (ruling 3) ──────────────────────────────────────────────────────

export interface ArchiveRead {
  /** Files read whole. */
  files: number;
  /** Files that would not gunzip (truncated / not gzip): skipped whole. */
  skippedFiles: number;
  /** Lines that were not a `{table, row}` record with a string task_id. */
  badLines: number;
  /** Archived task rows whose created_at is in the window (before dedupe). */
  rowsInWindow: number;
  tasks: Array<Omit<TaskFact, "runnableTotal" | "runnableMet" | "grader" | "label" | "costUsd" | "numbers">>;
}

/**
 * `data/archive/tasks-retention-*.jsonl.gz` (writer src/db/retention.ts): one
 * `{table:"tasks"|"runs", row}` per line. Read-only; the newest row per
 * task_id wins inside the archive. Tool calls come from the newest archived
 * run's `tool_calls`, else the task's `output.toolCalls` length.
 */
export function readArchive(dir: string, sinceMs: number): ArchiveRead {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => /^tasks-retention-.*\.jsonl\.gz$/.test(f)).sort();
  } catch {
    return { files: 0, skippedFiles: 0, badLines: 0, rowsInWindow: 0, tasks: [] };
  }
  const tasks = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, { id: number; calls: number | null }>();
  let rowsInWindow = 0;
  let files = 0;
  let skippedFiles = 0;
  let badLines = 0;
  for (const name of names) {
    let lines: string[];
    try {
      lines = gunzipSync(readFileSync(join(dir, name))).toString("utf-8").split("\n");
    } catch {
      skippedFiles++;
      continue;
    }
    files++;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { table?: unknown; row?: Record<string, unknown> } | null;
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        rec = null;
      }
      const row = rec?.row;
      if (!rec || !row || typeof row !== "object" || typeof row.task_id !== "string") {
        badLines++;
        continue;
      }
      if (rec.table === "tasks") {
        const at = parseMs(row.created_at);
        if (at === null || at < sinceMs) continue;
        rowsInWindow++;
        tasks.set(row.task_id, row);
      } else if (rec.table === "runs") {
        let calls: number | null = null;
        try {
          const v: unknown = JSON.parse(String(row.tool_calls ?? "null"));
          if (Array.isArray(v)) calls = v.length;
        } catch {
          calls = null;
        }
        const id = num(row.id);
        const prev = runs.get(row.task_id);
        if (!prev || id >= prev.id) runs.set(row.task_id, { id, calls });
      }
    }
  }
  const out: ArchiveRead["tasks"] = [];
  for (const [taskId, row] of tasks) {
    const started = parseMs(row.started_at);
    const completed = parseMs(row.completed_at);
    let outputCalls: number | null = null;
    try {
      const o: unknown = JSON.parse(String(row.output ?? "null"));
      const tc = o && typeof o === "object" ? (o as { toolCalls?: unknown }).toolCalls : undefined;
      if (Array.isArray(tc)) outputCalls = tc.length;
    } catch {
      outputCalls = null;
    }
    const runCalls = runs.get(taskId)?.calls ?? null;
    out.push({
      taskId,
      side: classifySide(typeof row.metadata === "string" ? row.metadata : null, typeof row.spawn_type === "string" ? row.spawn_type : null),
      agentType: safeLabel(row.agent_type ?? "unknown"),
      status: safeLabel(row.status ?? "unknown"),
      wallMin: wallOrNull(started !== null && completed !== null ? (completed - started) / 60_000 : null),
      toolCalls: runCalls ?? outputCalls,
      toolSource: runCalls !== null ? "runs.tool_calls" : outputCalls !== null ? "output.toolCalls" : null,
      archived: true,
    });
  }
  return { files, skippedFiles, badLines, rowsInWindow, tasks: out };
}

// ── task facts ──────────────────────────────────────────────────────────────

interface LiveTaskRow {
  task_id: string;
  metadata: string | null;
  spawn_type: string | null;
  agent_type: string | null;
  status: string;
  wall_min: number | null;
  run_calls: number | null;
  output_calls: number | null;
}

export interface FactsResult {
  facts: TaskFact[];
  liveRows: number;
  archive: { read: boolean; files: number; skippedFiles: number; badLines: number; rowsInWindow: number; merged: number };
}

export function loadTaskFacts(
  db: Db,
  opts: { since: Date; archiveDir: string | null; labels?: ReadonlyMap<string, OperatorLabel> },
): FactsResult {
  const since = sqliteText(opts.since);
  const live = db
    .prepare(
      `SELECT t.task_id, t.metadata, t.spawn_type, t.agent_type, t.status,
              (strftime('%s', t.completed_at) - strftime('%s', t.started_at)) / 60.0 AS wall_min,
              (SELECT CASE WHEN json_valid(r.tool_calls)
                           THEN (CASE WHEN json_type(r.tool_calls) = 'array' THEN json_array_length(r.tool_calls) END) END
                 FROM runs r WHERE r.task_id = t.task_id ORDER BY r.id DESC LIMIT 1) AS run_calls,
              CASE WHEN json_valid(t.output)
                   THEN (CASE WHEN json_type(t.output, '$.toolCalls') = 'array'
                              THEN json_array_length(t.output, '$.toolCalls') END) END AS output_calls
         FROM tasks t
        WHERE datetime(t.created_at) >= datetime(?)`,
    )
    .all(since) as LiveTaskRow[];

  const gates = new Map<string, { total: number; met: number; grTotal: number; grMet: number; grFailed: number }>();
  if (hasTable(db, "task_gates")) {
    for (const r of db.prepare(`SELECT task_id, gate_id, check_kind, check_cmd, state FROM task_gates`).all() as Array<{
      task_id: string;
      gate_id: string;
      check_kind: string;
      check_cmd: string | null;
      state: string;
    }>) {
      const g = gates.get(r.task_id) ?? { total: 0, met: 0, grTotal: 0, grMet: 0, grFailed: 0 };
      const grade = isGradeCheck(r.check_kind, r.check_cmd) || r.gate_id.startsWith(GRADE_ID_PREFIX);
      if (grade) {
        if (r.state !== "abandoned") g.grTotal++;
        if (r.state === "met") g.grMet++;
        if (r.state === "failed") g.grFailed++;
      } else if (r.check_kind === "shell" || r.check_kind === "landing" || isReadbackCheck(r.check_kind, r.check_cmd)) {
        g.total++;
        if (r.state === "met") g.met++;
      }
      gates.set(r.task_id, g);
    }
  }

  const toolCounts = new Map<string, number>();
  const numbers = new Map<string, TaskFact["numbers"]>();
  const graded = new Map<string, "met" | "failed" | null>();
  if (hasTable(db, "task_trace_events")) {
    for (const r of db
      .prepare(`SELECT task_id, COUNT(*) AS n FROM task_trace_events WHERE name = 'tool.called' GROUP BY task_id`)
      .all() as Array<{ task_id: string; n: number }>) {
      toolCounts.set(r.task_id, r.n);
    }
    for (const r of db
      .prepare(
        `SELECT task_id, json_extract(attrs, '$.found') AS found, json_extract(attrs, '$.unverified') AS unv,
                json_extract(attrs, '$.error') IS NOT NULL AS err
           FROM task_trace_events WHERE name = 'numbers.audited' AND json_valid(attrs) ORDER BY id`,
      )
      .all() as Array<{ task_id: string; found: unknown; unv: unknown; err: number }>) {
      numbers.set(r.task_id, r.err ? "error" : { found: num(r.found), unverified: num(r.unv) });
    }
    for (const r of db
      .prepare(
        `SELECT task_id, json_extract(attrs, '$.counts.met') AS m, json_extract(attrs, '$.counts.failed') AS f,
                json_extract(attrs, '$.counts.pending') AS p
           FROM task_trace_events
          WHERE name = 'gates.graded' AND json_valid(attrs)
            AND json_extract(attrs, '$.counts') IS NOT NULL
            AND json_extract(attrs, '$.reason') IS NULL AND json_extract(attrs, '$.error') IS NULL
            AND json_extract(attrs, '$.action') IS NULL
          ORDER BY id`,
      )
      .all() as Array<{ task_id: string; m: unknown; f: unknown; p: unknown }>) {
      graded.set(r.task_id, num(r.f) > 0 ? "failed" : num(r.m) > 0 && num(r.p) === 0 ? "met" : null);
    }
  }

  const cost = new Map<string, number>();
  if (hasTable(db, "cost_ledger")) {
    for (const r of db
      .prepare(`SELECT task_id, SUM(cost_usd) AS usd FROM cost_ledger GROUP BY task_id`)
      .all() as Array<{ task_id: string; usd: number }>) {
      cost.set(r.task_id, num(r.usd));
    }
  }

  const enrich = (base: ArchiveRead["tasks"][number]): TaskFact => {
    const g = gates.get(base.taskId);
    const traceCalls = toolCounts.get(base.taskId) ?? 0;
    const grader: TaskFact["grader"] =
      g && g.grFailed > 0 ? "failed" : g && g.grTotal > 0 && g.grMet === g.grTotal ? "met" : (graded.get(base.taskId) ?? null);
    return {
      ...base,
      ...(traceCalls > 0 && { toolCalls: traceCalls, toolSource: "trace" as const }),
      runnableTotal: g?.total ?? 0,
      runnableMet: g?.met ?? 0,
      grader,
      label: opts.labels?.get(base.taskId.toLowerCase()) ?? null,
      costUsd: cost.get(base.taskId) ?? 0,
      numbers: numbers.get(base.taskId) ?? null,
    };
  };

  const facts: TaskFact[] = live.map((r) =>
    enrich({
      taskId: r.task_id,
      side: classifySide(r.metadata, r.spawn_type),
      agentType: safeLabel(r.agent_type ?? "unknown"),
      status: safeLabel(r.status),
      wallMin: wallOrNull(typeof r.wall_min === "number" ? r.wall_min : null),
      toolCalls: r.run_calls ?? r.output_calls,
      toolSource: r.run_calls !== null ? "runs.tool_calls" : r.output_calls !== null ? "output.toolCalls" : null,
      archived: false,
    }),
  );

  const archive = { read: false, files: 0, skippedFiles: 0, badLines: 0, rowsInWindow: 0, merged: 0 };
  if (opts.archiveDir !== null) {
    const a = readArchive(opts.archiveDir, opts.since.getTime());
    archive.read = true;
    archive.files = a.files;
    archive.skippedFiles = a.skippedFiles;
    archive.badLines = a.badLines;
    archive.rowsInWindow = a.rowsInWindow;
    const seen = new Set(facts.map((f) => f.taskId));
    for (const t of a.tasks) {
      if (seen.has(t.taskId)) continue; // the live row wins
      seen.add(t.taskId);
      facts.push(enrich(t));
      archive.merged++;
    }
  }
  return { facts, liveRows: live.length, archive };
}

// ── per side × agent_type ───────────────────────────────────────────────────

export interface Cell {
  side: Side | "delegated_pooled";
  agentType: string;
  terminal: number;
  finished: number;
  /** Wall-clock minutes of finished tasks. */
  wall: number[];
  /** Tool-call counts of finished tasks. */
  tools: number[];
  toolSources: Record<ToolSource | "none", number>;
  /** Live finished tasks only (cost / traces are live tables). */
  finishedLive: number;
  costFinishedUsd: number;
  numbersWithFigures: number;
  numbersUnverified: number;
  numbersErrors: number;
}

export function buildCells(facts: readonly TaskFact[]): Cell[] {
  const cells = new Map<string, Cell>();
  const get = (side: Cell["side"], agentType: string): Cell => {
    const k = `${side}|${agentType}`;
    let c = cells.get(k);
    if (!c) {
      c = {
        side,
        agentType,
        terminal: 0,
        finished: 0,
        wall: [],
        tools: [],
        toolSources: { trace: 0, "runs.tool_calls": 0, "output.toolCalls": 0, none: 0 },
        finishedLive: 0,
        costFinishedUsd: 0,
        numbersWithFigures: 0,
        numbersUnverified: 0,
        numbersErrors: 0,
      };
      cells.set(k, c);
    }
    return c;
  };
  for (const f of facts) {
    if (!TERMINAL_STATUSES.includes(f.status)) continue;
    const targets = [get(f.side, f.agentType)];
    if (isDelegated(f.side)) targets.push(get("delegated_pooled", f.agentType));
    const fin = isFinished(f);
    for (const c of targets) {
      c.terminal++;
      if (f.numbers === "error") c.numbersErrors++;
      else if (f.numbers && f.numbers.found > 0) {
        c.numbersWithFigures++;
        if (f.numbers.unverified > 0) c.numbersUnverified++;
      }
      if (!fin) continue;
      c.finished++;
      if (f.wallMin !== null) c.wall.push(f.wallMin);
      if (f.toolCalls !== null) c.tools.push(f.toolCalls);
      c.toolSources[f.toolSource ?? "none"]++;
      if (!f.archived) {
        c.finishedLive++;
        c.costFinishedUsd += f.costUsd;
      }
    }
  }
  const order = (s: Cell["side"]) => (s === "delegated_pooled" ? SIDES.length : SIDES.indexOf(s));
  return [...cells.values()].sort((a, b) => order(a.side) - order(b.side) || a.agentType.localeCompare(b.agentType));
}

// ── time horizon ────────────────────────────────────────────────────────────

export interface Bucket {
  label: string;
  n: number;
  finished: number;
}
export interface Horizon {
  group: "all" | "operator" | "delegated";
  tool: Bucket[];
  toolUnknown: number;
  wall: Bucket[];
  wallUnknown: number;
  wallBeyond: number;
}

export function buildHorizon(facts: readonly TaskFact[]): Horizon[] {
  const groups: Horizon["group"][] = ["all", "operator", "delegated"];
  return groups.map((group) => {
    const h: Horizon = {
      group,
      tool: TOOL_BUCKETS.map((b) => ({ label: b.label, n: 0, finished: 0 })),
      toolUnknown: 0,
      wall: WALL_BUCKETS.map((b) => ({ label: b.label, n: 0, finished: 0 })),
      wallUnknown: 0,
      wallBeyond: 0,
    };
    for (const f of facts) {
      if (!TERMINAL_STATUSES.includes(f.status)) continue;
      if (group === "operator" && f.side !== "operator") continue;
      if (group === "delegated" && !isDelegated(f.side)) continue;
      const fin = isFinished(f) ? 1 : 0;
      if (f.toolCalls === null) h.toolUnknown++;
      else {
        const b = h.tool.find((x) => x.label === toolBucket(f.toolCalls!))!;
        b.n++;
        b.finished += fin;
      }
      if (f.wallMin === null) h.wallUnknown++;
      else {
        const label = wallBucket(f.wallMin);
        if (label === null) h.wallBeyond++;
        else {
          const b = h.wall.find((x) => x.label === label)!;
          b.n++;
          b.finished += fin;
        }
      }
    }
    return h;
  });
}

/**
 * The contiguous run from the lowest bucket where every bucket has n ≥
 * MIN_BUCKET_N and a finished rate ≥ 50 %: `best` = its highest bucket (null
 * when the first bucket already fails), `stop` = the bucket that ended it.
 */
export function horizonRun(buckets: readonly Bucket[]): { best: Bucket | null; stop: { label: string; reason: "n<5" | "<50 %" } | null } {
  let best: Bucket | null = null;
  for (const b of buckets) {
    if (b.n < MIN_BUCKET_N) return { best, stop: { label: b.label, reason: "n<5" } };
    if (b.finished / b.n < 0.5) return { best, stop: { label: b.label, reason: "<50 %" } };
    best = b;
  }
  return { best, stop: null };
}

// ── ledger per gate source ──────────────────────────────────────────────────

export interface LedgerCell {
  side: Side | "delegated_pooled";
  agentType: string;
  source: string;
  tasks: number;
  allMet: number;
  anyFailed: number;
  abandoned: number;
}
export interface GateWeek {
  week: string;
  source: string;
  met: number;
  failed: number;
  abandoned: number;
  pending: number;
  tasks: number;
}

/** SQL twin of `isGradeCheck(kind, cmd) || gate_id.startsWith(GRADE_ID_PREFIX)` (case-sensitive). */
const NOT_GRADE_SQL = `NOT ((check_kind = 'manual' AND substr(COALESCE(check_cmd, ''), 1, 6) = 'grade:') OR gate_id GLOB 'GR-*')`;

/** Task-level verdict per gate source: failed > abandoned > all met > pending. Grade rows are the grader's column, not the ledger. */
export function buildLedger(db: Db, facts: readonly TaskFact[], since: Date): { cells: LedgerCell[]; weeks: GateWeek[] } {
  if (!hasTable(db, "task_gates")) return { cells: [], weeks: [] };
  const byId = new Map(facts.map((f) => [f.taskId, f]));
  const rows = db
    .prepare(
      `SELECT task_id, source, COUNT(*) AS n,
              SUM(state = 'met') AS met,
              SUM(state = 'failed') AS failed, SUM(state = 'abandoned') AS abandoned
         FROM task_gates WHERE ${NOT_GRADE_SQL} GROUP BY task_id, source`,
    )
    .all() as Array<{ task_id: string; source: string; n: number; met: number; failed: number; abandoned: number }>;
  const cells = new Map<string, LedgerCell>();
  for (const r of rows) {
    const f = byId.get(r.task_id);
    if (!f) continue;
    const sides: LedgerCell["side"][] = [f.side, ...(isDelegated(f.side) ? (["delegated_pooled"] as const) : [])];
    for (const side of sides) {
      const source = safeLabel(r.source);
      const k = `${side}|${f.agentType}|${source}`;
      const c = cells.get(k) ?? { side, agentType: f.agentType, source, tasks: 0, allMet: 0, anyFailed: 0, abandoned: 0 };
      c.tasks++;
      if (num(r.failed) > 0) c.anyFailed++;
      else if (num(r.abandoned) > 0) c.abandoned++;
      else if (num(r.met) === r.n) c.allMet++;
      cells.set(k, c);
    }
  }
  const weeks = db
    .prepare(
      `SELECT strftime('%Y-W%W', created_at) AS week, source,
              SUM(state = 'met') AS met, SUM(state = 'failed') AS failed,
              SUM(state = 'abandoned') AS abandoned, SUM(state = 'pending') AS pending,
              COUNT(DISTINCT task_id) AS tasks
         FROM task_gates WHERE datetime(created_at) >= datetime(?) AND ${NOT_GRADE_SQL}
        GROUP BY week, source ORDER BY week, source`,
    )
    .all(sqliteText(since)) as GateWeek[];
  const order = (s: LedgerCell["side"]) => (s === "delegated_pooled" ? SIDES.length : SIDES.indexOf(s));
  return {
    cells: [...cells.values()].sort(
      (a, b) => order(a.side) - order(b.side) || a.agentType.localeCompare(b.agentType) || a.source.localeCompare(b.source),
    ),
    weeks: weeks.map((w) => ({
      ...w,
      source: safeLabel(w.source),
      met: num(w.met),
      failed: num(w.failed),
      abandoned: num(w.abandoned),
      pending: num(w.pending),
    })),
  };
}

// ── W1: label, grader, ledger ───────────────────────────────────────────────

export interface W1Summary {
  labelled: number;
  labelledReallyDone: number;
  labelledNotDone: number;
  /** Labelled completed tasks whose finished verdict differs from the gate-only verdict. */
  labelOverrides: number;
  graded: number;
  gradedMet: number;
  gradedFailed: number;
  /** Labelled tasks that also carry a grader verdict (§7 metric). */
  vsLabel: { n: number; agree: number; graderMetLabelNotDone: number; graderFailedLabelReallyDone: number };
  /** Graded tasks that also have ≥ 1 runnable gate. */
  vsLedger: { n: number; agree: number };
}

export function w1Summary(facts: readonly TaskFact[]): W1Summary {
  const s: W1Summary = {
    labelled: 0,
    labelledReallyDone: 0,
    labelledNotDone: 0,
    labelOverrides: 0,
    graded: 0,
    gradedMet: 0,
    gradedFailed: 0,
    vsLabel: { n: 0, agree: 0, graderMetLabelNotDone: 0, graderFailedLabelReallyDone: 0 },
    vsLedger: { n: 0, agree: 0 },
  };
  for (const f of facts) {
    const gatesMet = f.runnableMet === f.runnableTotal;
    if (f.label !== null) {
      s.labelled++;
      if (f.label === "really done") s.labelledReallyDone++;
      else s.labelledNotDone++;
      if (f.status === "completed" && isFinished(f) !== gatesMet) s.labelOverrides++;
    }
    if (f.grader === null) continue;
    s.graded++;
    if (f.grader === "met") s.gradedMet++;
    else s.gradedFailed++;
    if (f.label !== null) {
      s.vsLabel.n++;
      if ((f.grader === "met") === (f.label === "really done")) s.vsLabel.agree++;
      else if (f.grader === "met") s.vsLabel.graderMetLabelNotDone++;
      else s.vsLabel.graderFailedLabelReallyDone++;
    }
    if (f.runnableTotal > 0) {
      s.vsLedger.n++;
      if ((f.grader === "met") === gatesMet) s.vsLedger.agree++;
    }
  }
  return s;
}

// ── small grouped counts ────────────────────────────────────────────────────

export type Counts = Record<string, number>;

function counts(db: Db, table: string, sql: string, ...params: unknown[]): Counts | null {
  if (!hasTable(db, table)) return null;
  const out: Counts = {};
  for (const r of db.prepare(sql).all(...params) as Array<{ k: unknown; n: number }>) {
    const k = safeLabel(r.k);
    out[k] = (out[k] ?? 0) + num(r.n);
  }
  return out;
}

export interface OtherSections {
  traceEarliest: string | null;
  orphanCost: { rows: number; usd: number; tasks: number } | null;
  approvals: Counts | null;
  decisions: Counts | null;
  decisionsOverridden: number | null;
  decisionsVetoed: number | null;
  decisionsReverted: number | null;
  decisionsWithJudgment: number | null;
  scheduleRuns: Counts | null;
  triggers: Array<{ kind: string; fired: number; skipped: number; failed: number }> | null;
  ritualGates: Counts | null;
  judgmentsWeekly: Array<{ week: string; posture: string; confidence: string; n: number }> | null;
  judgmentsWithConcession: number | null;
  feedbackExplicit: Counts | null;
  outcomesWeekly: Array<{ week: string; signal: string; n: number }> | null;
  dayLogs: { files: number; lines: number } | null;
  deadTables: Array<{ name: string; rows: number | null }>;
}

export function loadOtherSections(db: Db, opts: { since: Date; archiveIds: ReadonlySet<string> }): OtherSections {
  const since = sqliteText(opts.since);
  const scalar = (table: string, sql: string, ...p: unknown[]): number | null =>
    hasTable(db, table) ? num((db.prepare(sql).get(...p) as { n: unknown }).n) : null;

  let orphanCost: OtherSections["orphanCost"] = null;
  if (hasTable(db, "cost_ledger")) {
    const rows = db
      .prepare(
        `SELECT c.task_id, COUNT(*) AS n, SUM(c.cost_usd) AS usd FROM cost_ledger c
          WHERE datetime(c.created_at) >= datetime(?)
            AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = c.task_id)
          GROUP BY c.task_id`,
      )
      .all(since) as Array<{ task_id: string; n: number; usd: number }>;
    orphanCost = { rows: 0, usd: 0, tasks: 0 };
    for (const r of rows) {
      if (opts.archiveIds.has(r.task_id)) continue;
      orphanCost.rows += r.n;
      orphanCost.usd += num(r.usd);
      orphanCost.tasks++;
    }
  }

  const triggers = hasTable(db, "trigger_runs")
    ? (
        db
          .prepare(
            `SELECT trigger_kind AS kind, SUM(outcome = 'fired') AS fired, SUM(outcome = 'skipped') AS skipped,
                    SUM(outcome = 'failed') AS failed
               FROM trigger_runs WHERE datetime(fired_at) >= datetime(?) GROUP BY trigger_kind ORDER BY trigger_kind`,
          )
          .all(since) as Array<{ kind: string; fired: number; skipped: number; failed: number }>
      ).map((r) => ({ kind: safeLabel(r.kind), fired: num(r.fired), skipped: num(r.skipped), failed: num(r.failed) }))
    : null;

  const judgmentsWeekly = hasTable(db, "judgments")
    ? (db
        .prepare(
          `SELECT strftime('%Y-W%W', created_at) AS week, posture, COALESCE(confidence, '(null)') AS confidence, COUNT(*) AS n
             FROM judgments WHERE datetime(created_at) >= datetime(?)
            GROUP BY week, posture, confidence ORDER BY week, posture, confidence`,
        )
        .all(since) as Array<{ week: string; posture: string; confidence: string; n: number }>).map((j) => ({
        ...j,
        posture: safeLabel(j.posture),
        confidence: j.confidence === "(null)" ? j.confidence : safeLabel(j.confidence),
      }))
    : null;

  const outcomesWeekly = hasTable(db, "task_outcomes")
    ? (db
        .prepare(
          `SELECT strftime('%Y-W%W', created_at) AS week, COALESCE(feedback_signal, '(null)') AS signal, COUNT(*) AS n
             FROM task_outcomes WHERE datetime(created_at) >= datetime(?)
            GROUP BY week, signal ORDER BY week, signal`,
        )
        .all(since) as Array<{ week: string; signal: string; n: number }>).map((x) => ({
        ...x,
        signal: x.signal === "(null)" ? x.signal : safeLabel(x.signal),
      }))
    : null;

  let dayLogs: OtherSections["dayLogs"] = null;
  if (hasTable(db, "jarvis_files")) {
    // Counts only: the content never leaves SQLite (newline count in SQL).
    const r = db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(length(content) - length(replace(content, char(10), '')) + (length(content) > 0)), 0) AS lines
           FROM jarvis_files
          WHERE path GLOB 'logs/day-logs/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md'
            AND substr(path, 15, 10) >= substr(?, 1, 10)`,
      )
      .get(since) as { files: number; lines: number };
    dayLogs = { files: num(r.files), lines: num(r.lines) };
  }

  return {
    traceEarliest: hasTable(db, "task_trace_events")
      ? safeTimestamp((db.prepare("SELECT MIN(ts) AS t FROM task_trace_events").get() as { t: string | null }).t ?? null)
      : null,
    orphanCost,
    approvals: counts(
      db,
      "tool_approvals",
      "SELECT decision AS k, COUNT(*) AS n FROM tool_approvals WHERE datetime(requested_at) >= datetime(?) GROUP BY decision",
      since,
    ),
    decisions: counts(
      db,
      "decisions",
      "SELECT status AS k, COUNT(*) AS n FROM decisions WHERE datetime(proposed_at) >= datetime(?) GROUP BY status",
      since,
    ),
    decisionsOverridden: scalar(
      "decisions",
      `SELECT COUNT(*) AS n FROM decisions WHERE datetime(proposed_at) >= datetime(?)
          AND operator_override_kind IN ('vetoed', 'accepted_with_modification')`,
      since,
    ),
    decisionsVetoed: scalar(
      "decisions",
      "SELECT COUNT(*) AS n FROM decisions WHERE datetime(proposed_at) >= datetime(?) AND status = 'vetoed'",
      since,
    ),
    decisionsReverted: scalar(
      "decisions",
      `SELECT COUNT(*) AS n FROM decisions WHERE datetime(proposed_at) >= datetime(?)
          AND (status = 'reverted' OR reverted_at IS NOT NULL)`,
      since,
    ),
    decisionsWithJudgment: scalar(
      "decisions",
      "SELECT COUNT(*) AS n FROM decisions WHERE datetime(proposed_at) >= datetime(?) AND judgment_id IS NOT NULL",
      since,
    ),
    scheduleRuns: counts(
      db,
      "schedule_runs",
      "SELECT status AS k, COUNT(*) AS n FROM schedule_runs WHERE datetime(spawned_at) >= datetime(?) GROUP BY status",
      since,
    ),
    triggers,
    ritualGates: counts(
      db,
      "task_gates",
      "SELECT state AS k, COUNT(*) AS n FROM task_gates WHERE source = 'ritual' AND datetime(created_at) >= datetime(?) GROUP BY state",
      since,
    ),
    judgmentsWeekly,
    judgmentsWithConcession: scalar(
      "judgments",
      "SELECT COUNT(*) AS n FROM judgments WHERE datetime(created_at) >= datetime(?) AND concession_kind IS NOT NULL",
      since,
    ),
    feedbackExplicit: counts(
      db,
      "task_trace_events",
      `SELECT CASE WHEN json_valid(attrs) THEN json_extract(attrs, '$.signal') END AS k, COUNT(*) AS n
         FROM task_trace_events WHERE name = 'feedback.explicit' AND datetime(ts) >= datetime(?) GROUP BY k`,
      since,
    ),
    outcomesWeekly,
    dayLogs,
    deadTables: DEAD_TABLES.map((name) => ({
      name,
      rows: hasTable(db, name) ? num((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: unknown }).n) : null,
    })),
  };
}

// ── one call ────────────────────────────────────────────────────────────────

export interface EvalData {
  generatedAt: string;
  days: number;
  since: string;
  liveRows: number;
  /** Live task retention used to decide the archive read (TASKS_RETENTION_DAYS). */
  liveDays: number;
  /** "service env" | "shell env" | "default" (scripts/w3-eval-report.ts). */
  liveDaysSource: string;
  archive: FactsResult["archive"];
  labels: { path: string; found: boolean; rows: number; skipped: number; inWindow: number };
  cells: Cell[];
  horizon: Horizon[];
  ledger: LedgerCell[];
  gateWeeks: GateWeek[];
  w1: W1Summary;
  /** Terminal counts by status for blocked / needs_context (Q4). */
  statusCounts: Counts;
  other: OtherSections;
}

export function collectEval(
  db: Db,
  opts: { days: number; now: Date; archiveDir: string; labels: LabelsRead; liveDays?: number; liveDaysSource?: string },
): EvalData {
  const since = new Date(opts.now.getTime() - opts.days * 86_400_000);
  const liveDays = opts.liveDays ?? liveTaskDays();
  const { facts, liveRows, archive } = loadTaskFacts(db, {
    since,
    archiveDir: opts.days > liveDays ? opts.archiveDir : null,
    labels: opts.labels.labels,
  });
  const ledger = buildLedger(db, facts, since);
  const statusCounts: Counts = {};
  for (const f of facts) statusCounts[f.status] = (statusCounts[f.status] ?? 0) + 1;
  return {
    generatedAt: opts.now.toISOString(),
    days: opts.days,
    since: sqliteText(since),
    liveRows,
    liveDays,
    liveDaysSource: opts.liveDaysSource ?? "default",
    archive,
    labels: {
      path: opts.labels.path,
      found: opts.labels.found,
      rows: opts.labels.labels.size,
      skipped: opts.labels.skipped,
      inWindow: facts.filter((f) => f.label !== null).length,
    },
    cells: buildCells(facts),
    horizon: buildHorizon(facts),
    ledger: ledger.cells,
    gateWeeks: ledger.weeks,
    w1: w1Summary(facts),
    statusCounts,
    other: loadOtherSections(db, { since, archiveIds: new Set(facts.filter((f) => f.archived).map((f) => f.taskId)) }),
  };
}
