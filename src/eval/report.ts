/**
 * V9 W3 step 2 — renders `collectEval` (./queries.ts) as markdown or JSON.
 * Every rate carries its n; n = 0 prints "no population". Notes ride beside
 * the figure they qualify: CENSOR on every wall-clock / tool-call figure
 * (ruling 1), ASYM on every delegated-side figure (ruling 2: no
 * `task_outcomes` rating on that side), TRACE30 on trace-derived figures,
 * LIVE_ONLY on gate/trace/cost figures when the archive contributed rows.
 * Pure: aggregates, ids, enums and labels in, text out.
 *
 * ## Deferred (inventory §7, not built in step 2)
 * - 95 % interval on every rate and the Q2 operator-vs-delegated delta
 * - Q4 weekly rows (schedule_runs / trigger_runs / ritual gates per week) and
 *   the delivery-miss rate
 * - unverified-numbers rate stratified by gate-definition date
 */

import {
  DELEGATED_SIDES,
  MIN_BUCKET_N,
  TRACE_RETENTION_DAYS,
  horizonRun,
  percentile,
  type Bucket,
  type Cell,
  type Counts,
  type EvalData,
  type Side,
} from "./queries.js";

export const CENSOR = "censored: 5/15-min runner timeouts";
export const ASYM = "asym: delegated side has no task_outcomes rating";
export const TRACE30 = `trace ${TRACE_RETENTION_DAYS} d`;
export const LIVE_ONLY = "live rows only";
export const NO_POP = "no population";
export const NO_LINK_LINE = "no link from a judgment to an outcome → no population";
export const SMALL_N = `n<${MIN_BUCKET_N}`;

export interface Figure {
  /** Rate 0–1, minutes, calls or USD; null = no population. */
  value: number | null;
  p90?: number | null;
  n: number;
  unit: "rate" | "min" | "calls" | "usd" | "share" | "count";
  notes: string[];
}

const fig = (value: number | null, n: number, unit: Figure["unit"], notes: string[], p90?: number | null): Figure => ({
  value: n === 0 ? null : value,
  ...(p90 !== undefined && { p90: n === 0 ? null : p90 }),
  n,
  unit,
  notes,
});
const rate = (num: number, n: number, notes: string[]): Figure => fig(n === 0 ? null : num / n, n, "rate", notes);

export function formatFigure(f: Figure): string {
  const tags = f.notes.map((x) => ` [${x}]`).join("");
  if (f.n === 0 || f.value === null) return `${NO_POP}${tags}`;
  let body: string;
  switch (f.unit) {
    case "rate":
      body = `${(f.value * 100).toFixed(1)} %`;
      break;
    case "share":
      body = `${(f.value * 100).toFixed(1)} per 100`;
      break;
    case "usd":
      body = `$${f.value.toFixed(4)}`;
      break;
    case "min":
      body = `p50 ${f.value.toFixed(2)} · p90 ${(f.p90 ?? 0).toFixed(2)} min`;
      break;
    case "calls":
      body = `p50 ${f.value} · p90 ${f.p90 ?? 0} calls`;
      break;
    case "count":
      return `${f.value}${tags}`;
  }
  return `${body} (n=${f.n})${tags}`;
}

const isDelegatedKey = (s: string): boolean => s === "delegated_pooled" || DELEGATED_SIDES.includes(s as Side);

export interface SideRow {
  side: string;
  agentType: string;
  terminal: number;
  finished: Figure;
  wallClock: Figure;
  toolCalls: Figure;
  toolSources: Record<string, number>;
  unverifiedNumbers: Figure;
  costPerFinished: Figure;
}

export interface ReportModel {
  title: string;
  window: { days: number; since: string; generatedAt: string };
  rows: {
    live: number;
    liveDays: number;
    liveDaysSource: string;
    archiveRead: boolean;
    archiveFiles: number;
    archiveSkippedFiles: number;
    archiveBadLines: number;
    archiveRowsInWindow: number;
    archiveMerged: number;
  };
  labelsLine: string;
  traceWindow: string;
  definitions: string[];
  sides: SideRow[];
  orphanCost: string;
  ledger: Array<{ side: string; agentType: string; source: string; tasks: number; allMet: Figure; anyFailed: Figure; abandoned: Figure }>;
  gateWeeks: EvalData["gateWeeks"];
  gateWeeksNotes: string[];
  horizon: Array<{
    group: string;
    tool: Array<{ bucket: string; finished: Figure }>;
    toolLargest: string;
    toolUnknown: number;
    wall: Array<{ bucket: string; finished: Figure }>;
    wallLargest: string;
    wallUnknown: number;
    wallBeyond: number;
  }>;
  w1: {
    labelled: number;
    reallyDone: number;
    notDone: number;
    labelOverrides: number;
    graded: number;
    gradedMet: number;
    gradedFailed: number;
    vsLabel: { agreement: Figure; graderMetLabelNotDone: number; graderFailedLabelReallyDone: number };
    vsLedger: Figure;
  };
  boundary: {
    approvals: Array<[string, Figure]>;
    decisions: Array<[string, Figure]>;
    overridden: Figure;
    vetoed: Figure;
    reverted: Figure;
  };
  q4: {
    scheduleRuns: Array<[string, Figure]>;
    triggers: Array<{ kind: string; fired: number; skipped: number; failed: number; notes: string[] }> | null;
    ritualGates: Array<[string, Figure]>;
    blocked: number;
    needsContext: number;
  };
  q1q3: {
    judgments: Array<{ week: string; posture: string; confidence: string; n: number }> | null;
    judgmentsWithConcession: number | null;
    decisionsWithJudgment: number | null;
    feedbackExplicit: Array<[string, Figure]>;
    outcomesWeekly: Array<{ week: string; signal: string; n: number }> | null;
    dayLogs: { files: number; lines: number } | null;
    linkLine: string;
  };
  deadTables: EvalData["other"]["deadTables"];
}

/** Shares of a count map; [] when the table is absent. */
function shares(c: Counts | null, unit: Figure["unit"], notes: string[]): Array<[string, Figure]> {
  if (c === null) return [];
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  if (total === 0) return [["(all)", fig(null, 0, unit, notes)]];
  return Object.entries(c)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, fig(v / total, total, unit, notes)]);
}

function sideRow(c: Cell, liveOnly: boolean): SideRow {
  const asym = isDelegatedKey(c.side) ? [ASYM] : [];
  const lo = liveOnly ? [LIVE_ONLY] : [];
  return {
    side: c.side,
    agentType: c.agentType,
    terminal: c.terminal,
    finished: rate(c.finished, c.terminal, [...asym, ...lo]),
    wallClock: fig(percentile(c.wall, 0.5), c.wall.length, "min", [CENSOR, ...asym], percentile(c.wall, 0.9)),
    toolCalls: fig(percentile(c.tools, 0.5), c.tools.length, "calls", [CENSOR, ...asym], percentile(c.tools, 0.9)),
    toolSources: c.toolSources,
    unverifiedNumbers: rate(c.numbersUnverified, c.numbersWithFigures, [TRACE30, ...asym, ...lo]),
    costPerFinished: fig(c.finishedLive === 0 ? null : c.costFinishedUsd / c.finishedLive, c.finishedLive, "usd", [...asym, ...lo]),
  };
}

const largest = (b: readonly Bucket[]): string => {
  const { best, stop } = horizonRun(b);
  const head = best ? `${best.label} (n=${best.n})` : "none";
  return stop ? `${head}; run stops at ${stop.label} (${stop.reason})` : head;
};
/** Bucket figure: n < MIN_BUCKET_N carries the SMALL_N note. */
const bucketFig = (b: Bucket, notes: string[]): Figure => rate(b.finished, b.n, b.n > 0 && b.n < MIN_BUCKET_N ? [...notes, SMALL_N] : notes);

export function buildReportModel(d: EvalData): ReportModel {
  const liveOnly = d.archive.merged > 0;
  const lo = liveOnly ? [LIVE_ONLY] : [];
  const o = d.other;
  const zeroOrPop = (v: number | null, notes: string[]): Figure => fig(v === null || v === 0 ? null : v, v ?? 0, "count", notes);
  return {
    title: "V9 W3 internal eval (read-only)",
    window: { days: d.days, since: d.since, generatedAt: d.generatedAt },
    rows: {
      live: d.liveRows,
      liveDays: d.liveDays,
      liveDaysSource: d.liveDaysSource,
      archiveRead: d.archive.read,
      archiveFiles: d.archive.files,
      archiveSkippedFiles: d.archive.skippedFiles,
      archiveBadLines: d.archive.badLines,
      archiveRowsInWindow: d.archive.rowsInWindow,
      archiveMerged: d.archive.merged,
    },
    labelsLine: d.labels.found
      ? `operator W1 labels: ${d.labels.path} — ${d.labels.rows} labelled task ids (${d.labels.skipped} table rows skipped), ${d.labels.inWindow} in window`
      : `operator W1 labels: file not found at ${d.labels.path} — no labels, gates decide every task`,
    traceWindow: `traces: ${TRACE_RETENTION_DAYS}-d retention, earliest event ${o.traceEarliest ?? "none"}; trace figures cover that window only`,
    definitions: [
      "finished = status 'completed' AND (operator W1 label when present ? label 'really done' : every runnable gate (shell, landing, harness read-back) in state 'met'); a pending, failed or abandoned runnable gate is not met; the label replaces only the gate condition (ruling 2026-10-18 #2); the W1 grader verdict is a separate column and never decides finished",
      "sides (tasks.metadata, first match): operator = tag 'messaging' · ritual = metadata.ritualId · scheduled = tag 'scheduled' or 'schedule:<id>' · swarm_child = spawn_type 'subtask' · other_delegated = other valid metadata · unknown = metadata null/invalid; delegated_pooled = the four delegated sides",
      "rates over terminal tasks; wall-clock and tool calls over finished tasks; tool calls from tool.called traces when the task has any, else the newest run's tool_calls, else output.toolCalls (counts per source in 'tool src')",
      `[${CENSOR}]: GOAL_TIMEOUT_MS 5 min / ORCHESTRATOR_TIMEOUT_MS 15 min set the ceiling, long tasks fail or are cut off (ruling 1)`,
      `[${ASYM}]: operator chat alone carries task_outcomes ratings; delegated figures rest on status + ledger only (ruling 2)`,
      `[${TRACE30}]: from task_trace_events, kept 30 d (ruling 3)`,
      ...(liveOnly
        ? [`[${LIVE_ONLY}]: the archive holds tasks + runs only; gates, traces and cost come from live tables, archived tasks are excluded from cost`]
        : []),
      "costs are unaudited — run ./mc-ctl audit-claim before quoting any figure",
    ],
    sides: d.cells.map((c) => sideRow(c, liveOnly)),
    orphanCost:
      o.orphanCost === null
        ? "cost_ledger: table absent"
        : `cost_ledger rows in window with no task row: ${o.orphanCost.rows} rows · ${o.orphanCost.tasks} task ids · $${o.orphanCost.usd.toFixed(4)} (not in any figure above)`,
    ledger: d.ledger.map((l) => {
      const notes = [...(isDelegatedKey(l.side) ? [ASYM] : []), ...lo];
      return {
        side: l.side,
        agentType: l.agentType,
        source: l.source,
        tasks: l.tasks,
        allMet: rate(l.allMet, l.tasks, notes),
        anyFailed: rate(l.anyFailed, l.tasks, notes),
        abandoned: rate(l.abandoned, l.tasks, notes),
      };
    }),
    gateWeeks: d.gateWeeks,
    gateWeeksNotes: lo,
    horizon: d.horizon.map((h) => {
      const notes = [CENSOR, ...(h.group === "operator" ? [] : [ASYM])];
      return {
        group: h.group,
        tool: h.tool.map((b) => ({ bucket: b.label, finished: bucketFig(b, notes) })),
        toolLargest: largest(h.tool),
        toolUnknown: h.toolUnknown,
        wall: h.wall.map((b) => ({ bucket: b.label, finished: bucketFig(b, notes) })),
        wallLargest: largest(h.wall),
        wallUnknown: h.wallUnknown,
        wallBeyond: h.wallBeyond,
      };
    }),
    w1: {
      labelled: d.w1.labelled,
      reallyDone: d.w1.labelledReallyDone,
      notDone: d.w1.labelledNotDone,
      labelOverrides: d.w1.labelOverrides,
      graded: d.w1.graded,
      gradedMet: d.w1.gradedMet,
      gradedFailed: d.w1.gradedFailed,
      vsLabel: {
        agreement: rate(d.w1.vsLabel.agree, d.w1.vsLabel.n, [TRACE30, ...lo]),
        graderMetLabelNotDone: d.w1.vsLabel.graderMetLabelNotDone,
        graderFailedLabelReallyDone: d.w1.vsLabel.graderFailedLabelReallyDone,
      },
      vsLedger: rate(d.w1.vsLedger.agree, d.w1.vsLedger.n, [TRACE30, ...lo]),
    },
    boundary: {
      approvals: shares(o.approvals, "share", []),
      decisions: shares(o.decisions, "rate", []),
      overridden: zeroOrPop(o.decisionsOverridden, []),
      vetoed: zeroOrPop(o.decisionsVetoed, []),
      reverted: zeroOrPop(o.decisionsReverted, []),
    },
    q4: {
      scheduleRuns: shares(o.scheduleRuns, "rate", [ASYM]),
      triggers: o.triggers?.map((t) => ({ ...t, notes: [ASYM] })) ?? null,
      ritualGates: shares(o.ritualGates, "rate", [ASYM, ...lo]),
      blocked: d.statusCounts.blocked ?? 0,
      needsContext: d.statusCounts.needs_context ?? 0,
    },
    q1q3: {
      judgments: o.judgmentsWeekly,
      judgmentsWithConcession: o.judgmentsWithConcession,
      decisionsWithJudgment: o.decisionsWithJudgment,
      feedbackExplicit: shares(o.feedbackExplicit, "rate", [TRACE30]),
      outcomesWeekly: o.outcomesWeekly,
      dayLogs: o.dayLogs,
      linkLine: NO_LINK_LINE,
    },
    deadTables: o.deadTables,
  };
}

const table = (head: string[], rows: string[][]): string[] =>
  rows.length === 0
    ? [`(${NO_POP})`]
    : [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
const shareLines = (xs: Array<[string, Figure]>, absent: string): string[] =>
  xs.length === 0 ? [`- ${absent}`] : xs.map(([k, f]) => `- ${k}: ${formatFigure(f)}`);

export function renderMarkdown(m: ReportModel): string {
  const out: string[] = [];
  out.push(`# ${m.title}`, "");
  out.push(`- window: ${m.window.days} d (created_at ≥ ${m.window.since} UTC), generated ${m.window.generatedAt}`);
  out.push(
    `- rows: ${m.rows.live} live tasks (live retention ${m.rows.liveDays} d (${m.rows.liveDaysSource}), TASKS_RETENTION_DAYS); ${
      m.rows.archiveRead
        ? `archive read (window > ${m.rows.liveDays} d): ${m.rows.archiveFiles} files read, ${m.rows.archiveSkippedFiles} skipped, ${m.rows.archiveBadLines} bad lines; ${m.rows.archiveRowsInWindow} archived rows in window, ${m.rows.archiveMerged} merged after dedupe by task_id`
        : `archive not read (window ≤ ${m.rows.liveDays} d)`
    }`,
  );
  out.push(`- ${m.labelsLine}`);
  out.push(`- ${m.traceWindow}`);
  for (const d of m.definitions) out.push(`- ${d}`);
  out.push("");

  out.push("## Per side × agent_type (Q2: operator vs delegated)", "");
  out.push(
    ...table(
      ["side", "agent_type", "terminal", "finished", "wall-clock (finished)", "tool calls (finished)", "tool src", "unverified numbers", "cost / finished"],
      m.sides.map((r) => [
        r.side,
        r.agentType,
        String(r.terminal),
        formatFigure(r.finished),
        formatFigure(r.wallClock),
        formatFigure(r.toolCalls),
        `trace=${r.toolSources.trace} runs=${r.toolSources["runs.tool_calls"]} output=${r.toolSources["output.toolCalls"]} none=${r.toolSources.none}`,
        formatFigure(r.unverifiedNumbers),
        formatFigure(r.costPerFinished),
      ]),
    ),
  );
  out.push("", `- ${m.orphanCost}`, "");

  out.push(
    "## Ledger per gate source (all rows incl. manual, grade rows excluded — see W1; task-level: failed > abandoned > all met; the finished verdict uses runnable rows only)",
    "",
  );
  out.push(
    ...table(
      ["side", "agent_type", "source", "tasks", "all met", "any failed", "abandoned"],
      m.ledger.map((l) => [l.side, l.agentType, l.source, String(l.tasks), formatFigure(l.allMet), formatFigure(l.anyFailed), formatFigure(l.abandoned)]),
    ),
  );
  out.push("");
  out.push(
    `## Gate-definition date (task_gates.created_at week, %Y-W%W Monday-start UTC; gate rows in window, grade rows excluded)${m.gateWeeksNotes.map((x) => ` [${x}]`).join("")}`,
    "",
  );
  out.push(
    ...table(
      ["week", "source", "met", "failed", "abandoned", "pending", "tasks"],
      m.gateWeeks.map((w) => [w.week, w.source, String(w.met), String(w.failed), String(w.abandoned), String(w.pending), String(w.tasks)]),
    ),
  );
  out.push("");

  out.push("## Time horizon (finished rate per bucket; no fit)", "");
  for (const h of m.horizon) {
    out.push(`### ${h.group}`, "");
    out.push(...table(["tool calls", "finished"], h.tool.map((b) => [b.bucket, formatFigure(b.finished)])));
    out.push(`- largest tool-call bucket still ≥ 50 % (contiguous from the lowest, n ≥ ${MIN_BUCKET_N} each): ${h.toolLargest} [${CENSOR}]; no tool count: ${h.toolUnknown}`, "");
    out.push(...table(["wall-clock", "finished"], h.wall.map((b) => [b.bucket, formatFigure(b.finished)])));
    out.push(
      `- largest wall-clock bucket still ≥ 50 % (contiguous from the lowest, n ≥ ${MIN_BUCKET_N} each): ${h.wallLargest} [${CENSOR}]; beyond 16 min: ${h.wallBeyond}; wall-clock unknown: ${h.wallUnknown} (no timestamps or completed_at < started_at)`,
      "",
    );
  }

  out.push("## W1: operator label, grader, ledger", "");
  out.push(
    `- labelled in window: ${m.w1.labelled} (really done ${m.w1.reallyDone}, not done ${m.w1.notDone}); label overrides of the gate-only verdict: ${m.w1.labelOverrides}`,
  );
  out.push(
    `- grader verdicts in window (GR-* gate rows first, else the newest real gates.graded trace; separate column, never decides finished): ${m.w1.graded} (met ${m.w1.gradedMet}, failed ${m.w1.gradedFailed})`,
  );
  out.push(
    `- grader-vs-label agreement (labelled tasks with a grader verdict): ${formatFigure(m.w1.vsLabel.agreement)}; grader met / label not done: ${m.w1.vsLabel.graderMetLabelNotDone}; grader failed / label really done: ${m.w1.vsLabel.graderFailedLabelReallyDone}`,
  );
  out.push(`- grader-vs-runnable-gates agreement (graded tasks with ≥ 1 runnable gate): ${formatFigure(m.w1.vsLedger)}`, "");

  out.push("## Boundary (§6)", "");
  out.push("tool_approvals.decision per 100 gated actions:", ...shareLines(m.boundary.approvals, "tool_approvals: table absent"));
  out.push("decisions.status shares:", ...shareLines(m.boundary.decisions, "decisions: table absent"));
  out.push(`- overridden (operator_override_kind vetoed / accepted_with_modification): ${formatFigure(m.boundary.overridden)}`);
  out.push(`- vetoed (decisions.status): ${formatFigure(m.boundary.vetoed)}`);
  out.push(`- reverted: ${formatFigure(m.boundary.reverted)}`, "");

  out.push("## Q4 sustainability", "");
  out.push("schedule_runs.status shares:", ...shareLines(m.q4.scheduleRuns, "schedule_runs: table absent"));
  out.push("trigger_runs.outcome by trigger_kind:");
  if (m.q4.triggers === null) out.push("- trigger_runs: table absent");
  else if (m.q4.triggers.length === 0) out.push(`- ${NO_POP} [${ASYM}]`);
  else
    for (const t of m.q4.triggers)
      out.push(`- ${t.kind}: fired ${t.fired} · skipped ${t.skipped} · failed ${t.failed}${t.notes.map((x) => ` [${x}]`).join("")}`);
  out.push("ritual gates (task_gates.source = 'ritual') by state:", ...shareLines(m.q4.ritualGates, "task_gates: table absent"));
  out.push(`- tasks blocked: ${m.q4.blocked} · needs_context: ${m.q4.needsContext}`, "");

  out.push("## Q1 / Q3 populations (counts and labels only)", "");
  out.push(`- ${m.q1q3.linkLine}`);
  out.push(`- decisions with a judgment_id: ${m.q1q3.decisionsWithJudgment ?? "table absent"}; judgments with concession_kind: ${m.q1q3.judgmentsWithConcession ?? "table absent"}`);
  out.push("judgments by posture × confidence per week:", "");
  out.push(
    ...(m.q1q3.judgments === null
      ? ["- judgments: table absent"]
      : table(["week", "posture", "confidence", "n"], m.q1q3.judgments.map((j) => [j.week, j.posture, j.confidence, String(j.n)]))),
  );
  out.push("", "feedback.explicit traces by signal:", ...shareLines(m.q1q3.feedbackExplicit, "task_trace_events: table absent"));
  out.push("", "task_outcomes.feedback_signal per week (operator chat only):", "");
  out.push(
    ...(m.q1q3.outcomesWeekly === null
      ? ["- task_outcomes: table absent"]
      : table(["week", "signal", "n"], m.q1q3.outcomesWeekly.map((x) => [x.week, x.signal, String(x.n)]))),
  );
  out.push(
    `- day-log reach (logs/day-logs/YYYY-MM-DD.md dated in window): ${m.q1q3.dayLogs === null ? "jarvis_files: table absent" : `${m.q1q3.dayLogs.files} files, ${m.q1q3.dayLogs.lines} lines`}`,
    "",
  );

  out.push("## Dead / empty tables (reported, never pruned)", "");
  for (const t of m.deadTables) out.push(`- ${t.name}: ${t.rows === null ? "table absent" : `${t.rows} rows`}`);
  return out.join("\n") + "\n";
}

export function renderJson(m: ReportModel): string {
  return JSON.stringify(m, null, 2) + "\n";
}
