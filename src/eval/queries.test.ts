/**
 * W3 step 2 queries over a synthetic FILE db (src/test-utils/w3-eval-fixture.ts),
 * opened read-only the way the script opens the live one.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_SIDE, buildEvalFixture, writeEvalArchive, writeEvalLabels } from "../test-utils/w3-eval-fixture.js";
import { readW1Labels, type LabelsRead } from "./labels.js";
import {
  classifySide,
  collectEval,
  horizonRun,
  isFinished,
  liveTaskDays,
  loadTaskFacts,
  percentile,
  readArchive,
  safeLabel,
  safeTimestamp,
  toolBucket,
  wallBucket,
  type EvalData,
  type TaskFact,
} from "./queries.js";

let dir: string;
let db: Database.Database;
let labels: LabelsRead;
let data: EvalData;
let facts: Map<string, TaskFact>;

const NO_LABELS = (): LabelsRead => readW1Labels(join(dir, "absent-labels.md"));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "w3-eval-q-"));
  const dbPath = buildEvalFixture(dir);
  writeEvalArchive(dir);
  labels = readW1Labels(writeEvalLabels(dir));
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const now = new Date();
  data = collectEval(db, { days: 90, now, archiveDir: join(dir, "archive"), labels, liveDays: 90 });
  facts = new Map(
    loadTaskFacts(db, { since: new Date(now.getTime() - 90 * 86_400_000), archiveDir: null, labels: labels.labels }).facts.map((f) => [
      f.taskId,
      f,
    ]),
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cell = (side: string, agent: string) => data.cells.find((c) => c.side === side && c.agentType === agent)!;
const fact = (id: string) => facts.get(id)!;

describe("side rule (tasks.metadata, first match wins)", () => {
  it("classifies every seeded task into its side", () => {
    for (const [id, side] of Object.entries(EXPECTED_SIDE)) expect(facts.get(id)?.side, id).toBe(side);
  });

  it("orders messaging > ritualId > scheduled tags > subtask > other > unknown", () => {
    expect(classifySide(JSON.stringify({ tags: ["messaging", "scheduled"], ritualId: "r" }), "subtask")).toBe("operator");
    expect(classifySide(JSON.stringify({ tags: ["scheduled"], ritualId: "r" }), "root")).toBe("ritual");
    expect(classifySide(JSON.stringify({ tags: ["schedule:abc"] }), "subtask")).toBe("scheduled");
    expect(classifySide(JSON.stringify({ tools: ["x"] }), "subtask")).toBe("swarm_child");
    expect(classifySide(null, "subtask")).toBe("swarm_child");
    expect(classifySide(JSON.stringify({ tools: ["x"] }), "root")).toBe("other_delegated");
    expect(classifySide("not json", "root")).toBe("unknown");
    expect(classifySide(null, "root")).toBe("unknown");
    expect(classifySide(JSON.stringify(["messaging"]), "root")).toBe("unknown");
  });

  it("the window excludes rows older than --days", () => {
    expect(facts.has("op-old")).toBe(false);
    expect(data.liveRows).toBe(14);
  });
});

describe("finished (ruling 2: completed AND label ? 'really done' : runnable gates met)", () => {
  it("unlabelled tasks fall back to the gates", () => {
    expect(isFinished(fact("op-fast-1"))).toBe(true); // no gates
    expect(isFinished(fact("sch-1"))).toBe(true); // only a manual (abandoned) gate
    expect(isFinished(fact("op-fast-5"))).toBe(false); // abandoned runnable gate
  });

  it("completed_with_concerns is not finished", () => {
    expect(isFinished(fact("op-fast-2"))).toBe(false);
  });

  it("a labelled 'not done' task with every runnable gate met is NOT finished", () => {
    expect(fact("op-fast-4")).toMatchObject({ label: "not done", runnableTotal: 2, runnableMet: 2 });
    expect(isFinished(fact("op-fast-4"))).toBe(false);
  });

  it("a labelled 'really done' task with a failed runnable gate IS finished", () => {
    expect(fact("op-fast-3")).toMatchObject({ label: "really done", runnableTotal: 1, runnableMet: 0 });
    expect(isFinished(fact("op-fast-3"))).toBe(true);
  });

  it("a label never rescues a non-completed status", () => {
    expect(fact("sch-2")).toMatchObject({ label: "really done", status: "failed" });
    expect(isFinished(fact("sch-2"))).toBe(false);
  });

  it("the grader verdict never decides finished", () => {
    expect(fact("op-heavy-1")).toMatchObject({ grader: "met", label: null, runnableTotal: 1, runnableMet: 0 });
    expect(isFinished(fact("op-heavy-1"))).toBe(false);
  });

  it("met = state 'met' even with empty evidence", () => {
    expect(fact("rit-1")).toMatchObject({ runnableTotal: 1, runnableMet: 1 });
    expect(isFinished(fact("rit-1"))).toBe(true);
  });

  it("a pending read-back row is runnable and not met; a lower-case gr- shell gate is runnable, not a grade row", () => {
    expect(fact("op-fast-6")).toMatchObject({ runnableTotal: 2, runnableMet: 1, grader: null });
    expect(isFinished(fact("op-fast-6"))).toBe(false);
  });

  it("a missing labels file falls back to the gates for every task", () => {
    const none = NO_LABELS();
    expect(none).toMatchObject({ found: false, skipped: 0 });
    const f = loadTaskFacts(db, { since: new Date(Date.now() - 90 * 86_400_000), archiveDir: null, labels: none.labels }).facts;
    const by = new Map(f.map((x) => [x.taskId, x]));
    expect(isFinished(by.get("op-fast-4")!)).toBe(true);
    expect(isFinished(by.get("op-fast-3")!)).toBe(false);
    const d = collectEval(db, { days: 90, now: new Date(), archiveDir: join(dir, "archive"), labels: none, liveDays: 90 });
    expect(d.labels).toMatchObject({ found: false, rows: 0, inWindow: 0 });
    expect(d.w1.labelled).toBe(0);
  });

  it("operator fast: 3 of 7 terminal finished", () => {
    expect(cell("operator", "fast")).toMatchObject({ terminal: 7, finished: 3 });
  });
});

describe("W1 grader column", () => {
  it("a GR-* failed row wins over a newer met trace", () => {
    expect(fact("op-fast-3").grader).toBe("failed");
  });

  it("the newest real gates.graded trace wins over an older one", () => {
    expect(fact("op-heavy-1").grader).toBe("met");
  });

  it("label / grader / ledger summary", () => {
    expect(data.labels).toMatchObject({ found: true, rows: 5, skipped: 3, inWindow: 4 });
    expect(fact("child-1").label).toBe("really done"); // labelled as CHILD-1
    expect(fact("sch-1").label).toBeNull(); // only wrong-case / unbackticked rows
    expect(data.w1).toEqual({
      labelled: 4,
      labelledReallyDone: 3,
      labelledNotDone: 1,
      labelOverrides: 2,
      graded: 4,
      gradedMet: 3,
      gradedFailed: 1,
      vsLabel: { n: 3, agree: 1, graderMetLabelNotDone: 1, graderFailedLabelReallyDone: 1 },
      vsLedger: { n: 3, agree: 2 },
    });
  });
});

describe("per-cell figures", () => {
  it("percentile is nearest-rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
  });

  it("wall-clock and tool calls of finished tasks, tool source per task", () => {
    const c = cell("operator", "fast");
    expect(c.wall.map((x) => Math.round(x * 100) / 100).sort()).toEqual([0.5, 3.33]);
    expect(c.tools).toEqual([4]);
    expect(c.toolSources).toEqual({ trace: 1, "runs.tool_calls": 0, "output.toolCalls": 0, none: 2 });
    expect(fact("op-fast-4")).toMatchObject({ toolCalls: 3, toolSource: "runs.tool_calls" });
    expect(fact("op-fast-5")).toMatchObject({ toolCalls: 1, toolSource: "output.toolCalls" });
    expect(fact("child-1")).toMatchObject({ toolCalls: 25, toolSource: "trace" });
    expect(fact("rit-1")).toMatchObject({ toolCalls: null, toolSource: null }); // traces, but no tool.called
  });

  it("negative wall-clock (completed_at < started_at) is unknown: out of percentiles and buckets", () => {
    expect(fact("op-fast-7")).toMatchObject({ status: "completed", wallMin: null });
    expect(isFinished(fact("op-fast-7"))).toBe(true);
    const op = data.horizon.find((h) => h.group === "operator")!;
    expect(op.wallUnknown).toBe(1);
    expect(op.wall.reduce((a, b) => a + b.n, 0) + op.wallBeyond + op.wallUnknown).toBe(8); // 7 fast + 1 heavy
  });

  it("unverified-number rate counts tasks with figures; errors apart", () => {
    const c = cell("operator", "fast");
    expect([c.numbersWithFigures, c.numbersUnverified]).toEqual([2, 1]);
    expect(cell("scheduled", "fast").numbersErrors).toBe(1);
  });

  it("cost per finished task from cost_ledger; orphan rows counted apart", () => {
    const c = cell("operator", "fast");
    expect([c.finishedLive, c.costFinishedUsd]).toEqual([3, 0.5]);
    expect(data.other.orphanCost).toEqual({ rows: 1, usd: 2, tasks: 1 });
  });

  it("delegated_pooled pools the four delegated sides only", () => {
    expect(cell("delegated_pooled", "fast").terminal).toBe(4); // rit-1, sch-1, sch-2, other-1 (unknown excluded)
    expect(cell("delegated_pooled", "heavy").terminal).toBe(1); // child-1
  });
});

describe("time-horizon buckets", () => {
  it("bucket boundaries", () => {
    expect([0, 2, 3, 5, 6, 10, 11, 20, 21, 99].map(toolBucket)).toEqual([
      "0-2", "0-2", "3-5", "3-5", "6-10", "6-10", "11-20", "11-20", "21+", "21+",
    ]);
    expect([0, 0.99, 1, 4.99, 5, 9.99, 10, 15.99, 16].map(wallBucket)).toEqual([
      "<1 min", "<1 min", "1-5 min", "1-5 min", "5-10 min", "5-10 min", "10-16 min", "10-16 min", null,
    ]);
  });

  it("finished rate per bucket over the fixture (16 min is beyond)", () => {
    const all = data.horizon.find((h) => h.group === "all")!;
    expect(all.tool.map((b) => [b.label, b.n, b.finished])).toEqual([
      ["0-2", 1, 0], ["3-5", 2, 1], ["6-10", 0, 0], ["11-20", 0, 0], ["21+", 1, 1],
    ]);
    expect(all.wall.map((b) => [b.label, b.n, b.finished])).toEqual([
      ["<1 min", 5, 2], ["1-5 min", 3, 2], ["5-10 min", 2, 0], ["10-16 min", 1, 0],
    ]);
    expect([all.wallBeyond, all.wallUnknown, all.toolUnknown]).toEqual([1, 2, 10]);
    expect(horizonRun(all.tool)).toEqual({ best: null, stop: { label: "0-2", reason: "n<5" } });
    expect(horizonRun(all.wall)).toEqual({ best: null, stop: { label: "<1 min", reason: "<50 %" } });
  });

  it("largest bucket = top of the contiguous run from the lowest bucket, n ≥ 5 and ≥ 50 % each", () => {
    const b = (label: string, n: number, finished: number) => ({ label, n, finished });
    expect(horizonRun([b("a", 5, 3), b("b", 6, 3), b("c", 2, 2), b("d", 9, 9)])).toEqual({
      best: b("b", 6, 3),
      stop: { label: "c", reason: "n<5" },
    });
    expect(horizonRun([b("a", 5, 5), b("b", 5, 2), b("c", 9, 9)])).toEqual({ best: b("a", 5, 5), stop: { label: "b", reason: "<50 %" } });
    expect(horizonRun([b("a", 5, 5), b("b", 5, 5)])).toEqual({ best: b("b", 5, 5), stop: null });
    expect(horizonRun([b("a", 4, 4), b("b", 10, 10)])).toEqual({ best: null, stop: { label: "a", reason: "n<5" } });
    expect(horizonRun([b("a", 0, 0)])).toEqual({ best: null, stop: { label: "a", reason: "n<5" } });
  });
});

describe("ledger, boundary, Q4, Q1/Q3, dead tables", () => {
  it("task-level verdict per gate source; grade rows are not ledger rows", () => {
    const op = data.ledger.filter((l) => l.side === "operator" && l.agentType === "fast");
    expect(op.map((l) => [l.source, l.tasks, l.allMet, l.anyFailed, l.abandoned])).toEqual([
      ["harness", 2, 1, 0, 0],
      ["plan", 3, 1, 0, 1],
      ["submission", 2, 1, 1, 0], // op-fast-1's shell gate with a grade: cmd is a ledger row
    ]);
    expect(fact("op-fast-1")).toMatchObject({ runnableTotal: 1, runnableMet: 1, grader: null });
  });

  it("gate-definition weeks: in-window, non-grade rows only", () => {
    expect(data.gateWeeks.reduce((a, w) => a + w.met + w.failed + w.abandoned + w.pending, 0)).toBe(11);
    expect(new Set(data.gateWeeks.map((w) => w.week)).size).toBe(1); // the 100-d-old gate is out of window
  });

  it("boundary, Q4 and Q1/Q3 populations", () => {
    const o = data.other;
    expect(o.approvals).toEqual({ confirmed: 3, expired: 1, "(other)": 1 });
    expect(o.decisions).toEqual({ committed: 1, vetoed: 1 });
    expect([o.decisionsOverridden, o.decisionsVetoed, o.decisionsReverted, o.decisionsWithJudgment]).toEqual([0, 1, 0, 0]);
    expect(o.scheduleRuns).toEqual({ completed: 1, failed: 1 });
    expect(o.triggers).toEqual([{ kind: "cron_morning", fired: 1, skipped: 0, failed: 1 }]);
    expect(o.ritualGates).toEqual({ met: 1, abandoned: 1 });
    expect([data.statusCounts.blocked, data.statusCounts.needs_context]).toEqual([1, 1]);
    expect(o.judgmentsWeekly?.map((j) => [j.posture, j.confidence, j.n])).toEqual([["at_risk", "green", 1]]);
    expect(o.feedbackExplicit).toEqual({ positive: 1 });
    expect(o.outcomesWeekly?.map((x) => [x.signal, x.n])).toEqual([["positive", 1]]);
    expect(o.dayLogs).toEqual({ files: 1, lines: 3 });
  });

  it("safeLabel lets enum-shaped tokens through and nothing else", () => {
    expect(["completed_with_concerns", "cron_morning", "fast", "a2a"].map(safeLabel)).toEqual(["completed_with_concerns", "cron_morning", "fast", "a2a"]);
    expect(["W3SECRET-x", "gave me what I needed", "", "a".repeat(33), "Confirmed"].map(safeLabel)).toEqual(Array(5).fill("(other)"));
    expect(safeLabel(null)).toBe("(null)");
  });

  it("traceEarliest prints only a timestamp-shaped value", () => {
    expect(safeTimestamp("2026-10-20T03:18:15.309Z")).toBe("2026-10-20T03:18:15.309Z");
    expect(safeTimestamp("2026-10-20 03:18:15")).toBe("2026-10-20 03:18:15");
    expect(safeTimestamp("!W3SECRET")).toBe("(other)");
    expect(safeTimestamp("2026-10-20")).toBe("(other)");
    expect(safeTimestamp(null)).toBeNull();
    expect(data.other.traceEarliest).toBe("(other)"); // the fixture's "!…" ts sorts first
  });

  it("dead tables report a row count or absence, never pruned", () => {
    const byName = Object.fromEntries(data.other.deadTables.map((t) => [t.name, t.rows]));
    expect(Object.keys(byName)).toEqual(["tune_eval_results", "signal_baselines", "task_mutations", "commit_tasks", "backtest_runs"]);
    expect(byName.tune_eval_results).toBe(0);
    expect(byName.commit_tasks).toBeNull(); // no writer creates it in a fresh schema
  });
});

describe("archive reach (ruling 3)", () => {
  it("live retention parses TASKS_RETENTION_DAYS like src/db/retention.ts", () => {
    expect(liveTaskDays({})).toBe(90);
    expect(liveTaskDays({ TASKS_RETENTION_DAYS: "120" })).toBe(120);
    expect(liveTaskDays({ TASKS_RETENTION_DAYS: "120.7" })).toBe(120);
    expect(liveTaskDays({ TASKS_RETENTION_DAYS: "9" })).toBe(90);
    expect(liveTaskDays({ TASKS_RETENTION_DAYS: "abc" })).toBe(90);
  });

  it("--days ≤ live retention never reads the archive", () => {
    expect(data.archive).toEqual({ read: false, files: 0, skippedFiles: 0, badLines: 0, rowsInWindow: 0, merged: 0 });
    const d = collectEval(db, { days: 200, now: new Date(), archiveDir: join(dir, "archive"), labels, liveDays: 300 });
    expect(d.archive.read).toBe(false);
    expect(d.liveDays).toBe(300);
  });

  it("past live retention: reads every retention file, skips a truncated one, counts bad lines, dedupes by task_id, live row wins", () => {
    const d = collectEval(db, { days: 200, now: new Date(), archiveDir: join(dir, "archive"), labels, liveDays: 90 });
    expect(d.archive).toEqual({ read: true, files: 2, skippedFiles: 1, badLines: 2, rowsInWindow: 5, merged: 3 });
    expect(d.horizon.find((h) => h.group === "all")!.wallUnknown).toBe(3); // op-fast-7, unk-1, arc-neg
    expect(d.liveRows).toBe(15); // op-old (100 d) now in window
    const all = loadTaskFacts(db, { since: new Date(Date.now() - 200 * 86_400_000), archiveDir: join(dir, "archive") }).facts;
    expect(all.filter((f) => f.taskId === "op-fast-1")).toHaveLength(1);
    expect(all.find((f) => f.taskId === "op-fast-1")!.archived).toBe(false);
    expect(all.filter((f) => f.taskId === "arc-2")).toHaveLength(1);
    expect(all.find((f) => f.taskId === "arc-2")).toMatchObject({ status: "failed", toolCalls: 2, toolSource: "output.toolCalls" });
    expect(all.find((f) => f.taskId === "arc-1")).toMatchObject({ archived: true, toolCalls: 7, toolSource: "runs.tool_calls" });
    expect(all.some((f) => f.taskId === "arc-ancient" || f.taskId === "arc-trunc")).toBe(false);
    expect(all.find((f) => f.taskId === "arc-neg")).toMatchObject({ archived: true, wallMin: null });
  });

  it("an absent archive dir reads zero files", () => {
    expect(readArchive(join(dir, "nope"), 0)).toEqual({ files: 0, skippedFiles: 0, badLines: 0, rowsInWindow: 0, tasks: [] });
  });
});
