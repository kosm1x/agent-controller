/**
 * Synthetic db + archive for the W3 eval tests (src/eval/*.test.ts,
 * scripts/w3-eval-report.test.ts). The db is a FILE under the caller's
 * scratch dir, built with the real schema (initDatabase on that path, the
 * vitest global setup gives every run a throwaway KB mirror) and closed
 * before the report opens it read-only. Every free-text column carries
 * SECRET, which must never reach a rendered report; the synthetic W1 labels
 * file's note column carries NOTE, which must never reach it either.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { ensureScheduledTasksTable } from "../rituals/dynamic.js";

export const SECRET = "W3SECRET-" + "q".repeat(12);
export const NOTE = "W3NOTE-" + "z".repeat(12);

export interface TaskSeed {
  id: string;
  meta: Record<string, unknown> | null;
  agent: string;
  status: string;
  ageDays?: number;
  wallSec?: number;
  spawn?: "root" | "subtask";
  parent?: string;
  runCalls?: string[];
  outputCalls?: string[];
}

/** Expected side per seeded task id (the side rule's answer key). */
export const SEEDS: TaskSeed[] = [
  { id: "op-fast-1", meta: { tags: ["messaging", "123"], threadId: "th" }, agent: "fast", status: "completed", wallSec: 30 },
  { id: "op-fast-2", meta: { tags: ["messaging"] }, agent: "fast", status: "completed_with_concerns", wallSec: 90 },
  { id: "op-fast-3", meta: { tags: ["messaging"] }, agent: "fast", status: "completed", wallSec: 200 },
  { id: "op-fast-4", meta: { tags: ["messaging"] }, agent: "fast", status: "completed", wallSec: 400, runCalls: ["a", "b", "c"] },
  { id: "op-fast-5", meta: { tags: ["messaging"] }, agent: "fast", status: "completed", wallSec: 20, outputCalls: ["a"] },
  { id: "op-fast-6", meta: { tags: ["messaging"] }, agent: "fast", status: "completed", wallSec: 45 },
  { id: "op-fast-7", meta: { tags: ["messaging"] }, agent: "fast", status: "completed", wallSec: -60 }, // completed < started
  { id: "op-heavy-1", meta: { tags: ["messaging"] }, agent: "heavy", status: "completed", wallSec: 700 },
  { id: "rit-1", meta: { ritualId: "morning-briefing" }, agent: "fast", status: "completed", wallSec: 60 },
  { id: "sch-1", meta: { tags: ["scheduled", "schedule:s1"] }, agent: "fast", status: "completed", wallSec: 10 },
  { id: "sch-2", meta: { tags: ["schedule:s2"] }, agent: "fast", status: "failed", wallSec: 300 },
  { id: "child-1", meta: null, agent: "heavy", status: "completed", wallSec: 960, spawn: "subtask", parent: "sch-1" },
  { id: "other-1", meta: { tools: ["web_read"] }, agent: "fast", status: "blocked", wallSec: 5 },
  { id: "unk-1", meta: null, agent: "fast", status: "needs_context" },
  { id: "op-old", meta: { tags: ["messaging"] }, agent: "fast", status: "completed", ageDays: 100, wallSec: 30 },
];

export const EXPECTED_SIDE: Record<string, string> = {
  "op-fast-1": "operator",
  "op-fast-2": "operator",
  "op-fast-3": "operator",
  "op-fast-4": "operator",
  "op-fast-5": "operator",
  "op-fast-6": "operator",
  "op-fast-7": "operator",
  "op-heavy-1": "operator",
  "rit-1": "ritual",
  "sch-1": "scheduled",
  "sch-2": "scheduled",
  "child-1": "swarm_child",
  "other-1": "other_delegated",
  "unk-1": "unknown",
};

/** Builds `<dir>/mc.db`; returns its path. */
export function buildEvalFixture(dir: string): string {
  const dbPath = join(dir, "mc.db");
  initDatabase(dbPath);
  try {
    ensureScheduledTasksTable();
    const db = getDatabase();
    db.pragma("foreign_keys = OFF"); // judgments / decisions without parent rows
    const ins = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
    for (const s of SEEDS) {
      const age = `-${s.ageDays ?? 1} days`;
      ins(
        `INSERT INTO tasks (task_id, parent_task_id, spawn_type, title, description, status, agent_type, input, output, error, metadata,
                            created_at, started_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now', ?), datetime('now', ?), ${s.wallSec === undefined ? "NULL" : "datetime('now', ?, ?)"})`,
        s.id,
        s.parent ?? null,
        s.spawn ?? "root",
        SECRET,
        SECRET,
        s.status,
        s.agent,
        JSON.stringify({ q: SECRET }),
        JSON.stringify({ text: SECRET, ...(s.outputCalls && { toolCalls: s.outputCalls }) }),
        SECRET,
        s.meta ? JSON.stringify(s.meta) : null,
        age,
        age,
        ...(s.wallSec === undefined ? [] : [age, `${s.wallSec >= 0 ? "+" : ""}${s.wallSec} seconds`]),
      );
      if (s.runCalls) {
        ins(
          `INSERT INTO runs (run_id, task_id, agent_type, input, output, tool_calls) VALUES (?,?,?,?,?,?)`,
          `run-${s.id}`,
          s.id,
          s.agent,
          SECRET,
          SECRET,
          JSON.stringify(s.runCalls),
        );
      }
    }
    const trace = (taskId: string, name: string, attrs: unknown, n = 1) => {
      for (let i = 0; i < n; i++) {
        ins(`INSERT INTO task_trace_events (task_id, name, tool, attrs) VALUES (?,?,?,?)`, taskId, name, name === "tool.called" ? "web_read" : null, attrs === null ? null : JSON.stringify(attrs));
      }
    };
    trace("op-fast-1", "tool.called", null, 4);
    trace("child-1", "tool.called", null, 25);
    trace("rit-1", "task.started", null);
    trace("op-fast-1", "numbers.audited", { found: 3, unverified: 1, evidence_chunks: 1, annotated: 0 });
    trace("op-fast-4", "numbers.audited", { found: 2, unverified: 0, evidence_chunks: 1, annotated: 0 });
    trace("rit-1", "numbers.audited", { found: 0, unverified: 0, evidence_chunks: 0, annotated: 0 });
    trace("sch-1", "numbers.audited", { error: SECRET });
    const graded = (taskId: string, met: number, failed: number) =>
      trace(taskId, "gates.graded", { mode: "shadow", iteration: 1, criteria: [{ id: "g1", verdict: failed ? "failed" : "met", evidence: SECRET }], criteria_total: 1, counts: { met, failed, pending: 0 }, status_before: "completed" });
    // W1 grader: on op-heavy-1 an older failed grade, then a newer met one → met (newest trace wins).
    graded("op-heavy-1", 0, 1);
    graded("op-heavy-1", 1, 0);
    // Not a real grade (has a reason) → ignored; then a real met trace, but op-fast-3's GR-1 failed row wins.
    trace("op-fast-3", "gates.graded", { mode: "shadow", criteria: [], counts: { met: 1, failed: 0, pending: 0 }, reason: "skipped_simple" });
    graded("op-fast-3", 1, 0);
    graded("op-fast-4", 1, 0);
    graded("child-1", 1, 0);
    trace("op-fast-1", "feedback.explicit", { signal: "positive" });
    // A ts that sorts before every real one and is no timestamp: MIN(ts) must print as "(other)".
    ins(`INSERT INTO task_trace_events (task_id, name, ts) VALUES ('op-fast-1', 'task.noise', ?)`, "!" + SECRET);

    const gate = (taskId: string, gateId: string, kind: string, cmd: string | null, state: string, source: string, ev: string | null, age = "-0 days") =>
      ins(
        `INSERT INTO task_gates (task_id, gate_id, criterion, check_kind, check_cmd, state, evidence, source, created_at)
         VALUES (?,?,?,?,?,?,?,?, datetime('now', ?))`,
        taskId,
        gateId,
        SECRET,
        kind,
        cmd,
        state,
        ev,
        source,
        age,
      );
    gate("op-fast-3", "G1", "shell", "true", "failed", "submission", SECRET);
    gate("op-fast-3", "GR-1", "manual", "grade:spec", "failed", "harness", SECRET); // grade row: grader, not runnable
    gate("op-fast-4", "RB-1", "manual", "readback:jarvis_file_write", "met", "harness", SECRET);
    gate("op-fast-4", "G2", "shell", "true", "met", "plan", SECRET);
    gate("op-fast-4", "M1", "manual", null, "pending", "plan", null); // pure manual: not runnable
    gate("op-fast-5", "G3", "shell", "true", "abandoned", "plan", null);
    gate("op-fast-6", "gr-check", "shell", "true", "met", "plan", SECRET); // lower-case gr-: runnable, not a grade row
    gate("op-fast-6", "RB-2", "manual", "readback:jarvis_file_write", "pending", "harness", null); // pending read-back: not met
    gate("op-heavy-1", "G4", "shell", "true", "failed", "plan", SECRET);
    gate("rit-1", "R1", "shell", "true", "met", "ritual", null); // met with empty evidence: met (state rule)
    gate("sch-1", "R2", "manual", null, "abandoned", "ritual", null);
    gate("op-old", "G5", "shell", "true", "met", "plan", SECRET, "-100 days"); // outside a 90-d window
    gate("op-fast-1", "G6", "shell", "grade:x", "met", "submission", SECRET); // shell + grade: cmd: a ledger row, not a grade row

    const cost = (taskId: string, usd: number) =>
      ins(`INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd) VALUES ('r', ?, 'fast', ?)`, taskId, usd);
    cost("op-fast-1", 0.5);
    cost("op-fast-4", 1.5);
    cost("ghost-task", 2);

    ins(`INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary, decision) VALUES ('t','gmail_send','x',?,?, 'confirmed')`, SECRET, SECRET);
    ins(`INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary, decision) VALUES ('t','gmail_send','x',?,?, 'confirmed')`, SECRET, SECRET);
    ins(`INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary, decision) VALUES ('t','gmail_send','x',?,?, 'confirmed')`, SECRET, SECRET);
    ins(`INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary, decision) VALUES ('t','gmail_send','x',?,?, 'expired')`, SECRET, SECRET);
    // decision is free TEXT (no CHECK): a prose value must print as "(other)".
    ins(`INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary, decision) VALUES ('t','gmail_send','x',?,?,?)`, SECRET, SECRET, SECRET);
    ins(
      `INSERT INTO decisions (capability, autonomy_level, status, capability_token_json, payload_json, proposed_at, thread_id)
       VALUES ('gmail_send', 1, 'committed', ?, ?, datetime('now', '-1 days'), 't')`,
      SECRET,
      SECRET,
    );
    ins(
      `INSERT INTO decisions (capability, autonomy_level, status, capability_token_json, payload_json, proposed_at, thread_id)
       VALUES ('gmail_send', 1, 'vetoed', ?, ?, datetime('now', '-1 days'), 't')`,
      SECRET,
      SECRET,
    );
    ins(`INSERT INTO schedule_runs (schedule_id, task_id, status, result_summary) VALUES ('s1','sch-1','completed',?)`, SECRET);
    ins(`INSERT INTO schedule_runs (schedule_id, task_id, status, result_summary) VALUES ('s2','sch-2','failed',?)`, SECRET);
    ins(`INSERT INTO trigger_runs (trigger_kind, outcome, detail) VALUES ('cron_morning','fired',?)`, SECRET);
    ins(`INSERT INTO trigger_runs (trigger_kind, outcome, detail) VALUES ('cron_morning','failed',?)`, SECRET);
    ins(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, confidence, created_at) VALUES ('b', ?, 'at_risk', ?, 'green', datetime('now', '-1 days'))`,
      SECRET,
      SECRET,
    );
    ins(`INSERT INTO task_outcomes (task_id, classified_as, ran_on, feedback_signal) VALUES ('op-fast-1','fast','fast','positive')`);
    const today = new Date().toISOString().slice(0, 10);
    ins(`INSERT INTO jarvis_files (id, path, title, content) VALUES ('d1', ?, ?, ?)`, `logs/day-logs/${today}.md`, SECRET, `${SECRET}\nline two\nline three`);
    ins(`INSERT INTO jarvis_files (id, path, title, content) VALUES ('d2', 'logs/day-logs/2001-01-01.md', ?, ?)`, SECRET, SECRET);
  } finally {
    closeDatabase();
  }
  return dbPath;
}

/** `<dir>/archive/` with two retention files; returns the archive dir. */
export function writeEvalArchive(dir: string): string {
  const archive = join(dir, "archive");
  mkdirSync(archive, { recursive: true });
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const task = (id: string, days: number, extra: Record<string, unknown> = {}) => ({
    table: "tasks",
    row: {
      task_id: id,
      spawn_type: "root",
      title: SECRET,
      description: SECRET,
      status: "completed",
      agent_type: "fast",
      metadata: JSON.stringify({ tags: ["messaging"] }),
      output: JSON.stringify({ text: SECRET, toolCalls: ["a", "b"] }),
      created_at: ago(days),
      started_at: ago(days),
      completed_at: ago(days),
      ...extra,
    },
  });
  const file1 = [
    task("arc-1", 120),
    { table: "runs", row: { id: 5, task_id: "arc-1", tool_calls: JSON.stringify(["a", "b", "c", "d", "e", "f", "g"]), output: SECRET } },
    task("arc-2", 130),
    task("op-fast-1", 120), // also live → the live row wins
    task("arc-ancient", 400), // outside a 200-d window
    task("arc-neg", 125, { started_at: ago(125), completed_at: ago(126) }), // completed < started → wall unknown
  ];
  const file2 = [task("arc-2", 130, { status: "failed" })]; // same id in a later file
  writeFileSync(join(archive, "tasks-retention-2026-07-05-04-01-06.jsonl.gz"), gzipSync(file1.map((l) => JSON.stringify(l)).join("\n") + "\n"));
  writeFileSync(
    join(archive, "tasks-retention-2026-07-06-10-30-00.jsonl.gz"),
    gzipSync(file2.map((l) => JSON.stringify(l)).join("\n") + "\n{not json " + SECRET + "\n" + JSON.stringify({ table: "tasks", row: { title: SECRET } }) + "\n"),
  );
  const truncated = gzipSync(JSON.stringify(task("arc-trunc", 110)) + "\n");
  writeFileSync(join(archive, "tasks-retention-2026-07-05-12-00-00.jsonl.gz"), truncated.subarray(0, Math.floor(truncated.length / 2)));
  writeFileSync(join(archive, "unrelated.txt"), SECRET);
  return archive;
}

/** A synthetic docs/planning/v9-w1-labels.md under `dir`; returns its path. */
export function writeEvalLabels(dir: string): string {
  const path = join(dir, "v9-w1-labels.md");
  const head = "| task_id | graded (UTC) | grader | final status | signal | label | catch | note |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
  writeFileSync(
    path,
    [
      "# W1 labels (synthetic)",
      "",
      "## Label rules",
      "",
      head,
      `| \`sch-1\` | x | met | completed | - | not done | no | ${NOTE} (outside a Rows section: ignored) |`,
      "",
      "## Rows",
      "",
      head,
      `| \`op-fast-4\` | 2026-10-05 05:03 | met | completed | - | really done | no | ${NOTE} (superseded by the later row) |`,
      `| \`op-fast-3\` | 2026-10-06 05:03 | failed | completed | - | really done | yes | ${NOTE} |`,
      `| \`sch-1\` | 2026-10-06 05:03 | - | completed | - | Really done | no | ${NOTE} (wrong case: skipped) |`,
      `| sch-1 | 2026-10-06 05:03 | - | completed | - | really done | no | ${NOTE} (no backticks: skipped) |`,
      `| \`op-fast-4\` | 2026-10-06 05:03 | met | completed | - | not done | yes | ${NOTE} |`,
      `| \`sch-2\` | 2026-10-06 05:03 | - | failed | - | really done | no | ${NOTE} |`,
      `| \`ghost-id\` | 2026-10-06 05:03 | met | completed | - | really done | no | ${NOTE} |`,
      `| \`rit-1\` | 2026-10-06 05:03 | met | completed | - | maybe | no | ${NOTE} |`,
      "",
      "## Rows — count 2",
      "",
      head,
      `| \`CHILD-1\` | 2026-10-19 20:00 | met | completed | - | really done | no | ${NOTE} |`, // upper case: matches child-1
      "",
      "## Tally",
      "",
      `| \`op-fast-1\` | not done | ${NOTE} |`,
    ].join("\n"),
  );
  return path;
}
