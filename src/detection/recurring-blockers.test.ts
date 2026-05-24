/**
 * Recurring-blocker detector tests (V8.1 Phase 5 B3).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { detectRecurringBlockers } from "./recurring-blockers.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Insert a task with an error, status, and activity age. */
function insertFailed(opts: {
  error: string;
  status?: string;
  ageDays?: number;
}): string {
  const id = `t-${crypto.randomUUID()}`;
  getDatabase()
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, error, updated_at)
       VALUES (?, 'task', 'desc', ?, ?, datetime('now', ?))`,
    )
    .run(id, opts.status ?? "failed", opts.error, `-${opts.ageDays ?? 0} days`);
  return id;
}

const rbCount = (): number =>
  (
    getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM recurring_blockers")
      .get() as { n: number }
  ).n;

describe("detectRecurringBlockers", () => {
  it("surfaces a blocker recurring across 3+ distinct tasks", () => {
    for (let i = 0; i < 3; i++) insertFailed({ error: "ECONNREFUSED 8888" });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("recurring_blocker");
    expect(signals[0]!.taskCount).toBe(3);
    expect(signals[0]!.taskIds).toHaveLength(3);
    expect(signals[0]!.lastSeenAt).toBeTruthy();
    expect(signals[0]!.summary).toContain("(last seen today)");
    expect(rbCount()).toBe(1);
  });

  it("does not surface a blocker seen on only 2 tasks", () => {
    insertFailed({ error: "rate limit" });
    insertFailed({ error: "rate limit" });
    expect(detectRecurringBlockers()).toEqual([]);
    expect(rbCount()).toBe(0);
  });

  it("clusters case- and whitespace-variant error text together", () => {
    insertFailed({ error: "ECONNREFUSED  8888" });
    insertFailed({ error: "econnrefused 8888" });
    insertFailed({ error: "ECONNREFUSED\n8888" });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.taskCount).toBe(3);
  });

  it("does not merge distinct errors", () => {
    insertFailed({ error: "error A" });
    insertFailed({ error: "error B" });
    insertFailed({ error: "error C" });
    expect(detectRecurringBlockers()).toEqual([]);
  });

  it("ignores failed tasks outside the 14-day window", () => {
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "old error", ageDays: 30 });
    expect(detectRecurringBlockers()).toEqual([]);
  });

  it("ignores non-failed tasks", () => {
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "x", status: "completed" });
    expect(detectRecurringBlockers()).toEqual([]);
  });

  it("upsert is idempotent — re-running keeps one row per signature", () => {
    for (let i = 0; i < 3; i++) insertFailed({ error: "flaky" });
    detectRecurringBlockers();
    detectRecurringBlockers();
    expect(rbCount()).toBe(1);
    expect(
      (
        getDatabase()
          .prepare("SELECT task_count FROM recurring_blockers")
          .get() as { task_count: number }
      ).task_count,
    ).toBe(3);
  });

  it("honours a custom minTasks threshold", () => {
    insertFailed({ error: "twice" });
    insertFailed({ error: "twice" });
    expect(detectRecurringBlockers({ minTasks: 2 })).toHaveLength(1);
  });

  it("auto-resolves a cluster whose newest failure is older than 3 days", () => {
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "fixed-since", ageDays: 5 });
    const signals = detectRecurringBlockers();
    expect(signals).toEqual([]);
    const row = getDatabase()
      .prepare("SELECT resolved_at, resolution_signal FROM recurring_blockers")
      .get() as {
      resolved_at: string | null;
      resolution_signal: string | null;
    };
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolution_signal).toBe("auto-stale");
  });

  it("does NOT auto-resolve a cluster with a recent failure (last_seen < 3d)", () => {
    // Two old + one fresh — cluster's last_seen is today, NOT stale.
    insertFailed({ error: "still-live", ageDays: 5 });
    insertFailed({ error: "still-live", ageDays: 5 });
    insertFailed({ error: "still-live", ageDays: 0 });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.taskCount).toBe(3);
    const row = getDatabase()
      .prepare("SELECT resolved_at FROM recurring_blockers")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).toBeNull();
  });

  it("does not re-surface a previously-resolved cluster on subsequent runs", () => {
    // First run: all old → auto-resolved.
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "gone-quiet", ageDays: 5 });
    expect(detectRecurringBlockers()).toEqual([]);
    // Second run with no new failures: still resolved, still not surfaced.
    const signals = detectRecurringBlockers();
    expect(signals).toEqual([]);
  });

  it("RE-surfaces a previously-resolved cluster when a NEW failure arrives", () => {
    // Audit C1 regression guard: once a cluster has been auto-resolved, a
    // genuine recurrence must re-surface. Without the `resolved_at = NULL`
    // clause on the upsert, the cluster would stay resolved forever and the
    // operator would never hear about the relapse.
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "comes-back", ageDays: 5 });
    expect(detectRecurringBlockers()).toEqual([]);
    let row = getDatabase()
      .prepare("SELECT resolved_at FROM recurring_blockers")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).not.toBeNull();

    insertFailed({ error: "comes-back", ageDays: 0 });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.taskCount).toBe(4);
    expect(signals[0]!.summary).toContain("(last seen today)");
    row = getDatabase()
      .prepare("SELECT resolved_at FROM recurring_blockers")
      .get() as { resolved_at: string | null };
    expect(row.resolved_at).toBeNull();
  });

  it("includes a days-ago hint in the summary for the LLM judge", () => {
    // Mix of 2-day-old failures; last_seen will be 2d, not stale yet.
    for (let i = 0; i < 3; i++)
      insertFailed({ error: "warm but cooling", ageDays: 2 });
    const signals = detectRecurringBlockers();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.summary).toContain("(last seen 2d ago)");
  });
});
