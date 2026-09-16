/**
 * Precedent retrieval (agent-memory plan P1, shadow mode).
 *
 * Invariants:
 *   1. Only root `Chat:` tasks in a terminal status inside the window are
 *      candidates; the task being served is never its own precedent.
 *   2. Matching is on the TITLE only (description = the assembled system
 *      prompt on live rows), accent-insensitive on both sides.
 *   3. Every precedent carries outcome + gate verdict + supersededBy.
 *   4. Superseded precedents sort last over the WHOLE scored set — a stale
 *      row with a higher score never cuts a current row at k; failed
 *      precedents keep their score position (labeled, not hidden).
 *   5. Failed tasks snippet from `error`; others from `output`; secrets redacted.
 *   6. shadowLogPrecedents writes ONE recall_audit row via logRecall with
 *      bank `precedents` / source `precedents-shadow`, content = the past
 *      task's outcome text (not its title), and NO row when empty.
 *   7. `MEMORY_PRECEDENTS_MODE` folds anything but `off` to `shadow`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

let mockDb: Database.Database;
vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
  writeWithRetry: (fn: () => void) => fn(),
}));

const logRecallMock = vi.fn();
vi.mock("./recall-utility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recall-utility.js")>();
  return {
    ...actual,
    logRecall: (...args: unknown[]) => logRecallMock(...args),
  };
});

import {
  findPrecedents,
  formatPrecedent,
  precedentsMode,
  shadowLogPrecedents,
} from "./precedents.js";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW - n * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

interface SeedTask {
  id: string;
  title: string;
  description?: string;
  status?: string;
  output?: string | null;
  error?: string | null;
  ageDays?: number;
  spawnType?: string;
}

function seed(t: SeedTask): void {
  mockDb
    .prepare(
      `INSERT INTO tasks (task_id, spawn_type, title, description, status, output, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id,
      t.spawnType ?? "root",
      t.title,
      t.description ?? "",
      t.status ?? "completed",
      t.output ?? null,
      t.error ?? null,
      daysAgo(t.ageDays ?? 1),
    );
}

function gate(taskId: string, state: string): void {
  mockDb
    .prepare(
      `INSERT INTO task_gates (task_id, gate_id, criterion, state, source) VALUES (?, ?, 'c', ?, 'test')`,
    )
    .run(taskId, `g-${Math.random()}`, state);
}

beforeEach(() => {
  mockDb = new Database(":memory:");
  mockDb.exec(`
    CREATE TABLE tasks (
      task_id TEXT UNIQUE NOT NULL,
      spawn_type TEXT DEFAULT 'root',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      output TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE task_gates (
      task_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      criterion TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL
    );
  `);
  logRecallMock.mockClear();
});

const QUERY = "deploy the caddy config for trustr and restart the service";

describe("findPrecedents — candidate population", () => {
  it("returns matching root Chat tasks with outcome, gate and age", () => {
    seed({ id: "a", title: "Chat: deploy caddy config for trustr", output: "Reloaded caddy, verified 200", ageDays: 3 });
    gate("a", "met");
    const out = findPrecedents(QUERY, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      taskId: "a",
      title: "deploy caddy config for trustr",
      outcome: "success",
      gate: "met",
      supersededBy: null,
      ageDays: 3,
    });
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].score).toBeLessThanOrEqual(1);
  });

  it("excludes subtasks, non-Chat titles, non-terminal statuses and out-of-window rows", () => {
    seed({ id: "sub", title: "Chat: deploy caddy config for trustr", spawnType: "subtask" });
    seed({ id: "ritual", title: "Ritual: deploy caddy config for trustr" });
    seed({ id: "running", title: "Chat: deploy caddy config for trustr", status: "running" });
    seed({ id: "old", title: "Chat: deploy caddy config for trustr", ageDays: 120 });
    expect(findPrecedents(QUERY, { now: NOW })).toEqual([]);
  });

  it("never returns the task being served", () => {
    seed({ id: "self", title: "Chat: deploy caddy config for trustr" });
    expect(findPrecedents(QUERY, { now: NOW, excludeTaskId: "self" })).toEqual([]);
  });

  it("requires at least two matched tokens on multi-token queries", () => {
    seed({ id: "weak", title: "Chat: restart the printer" }); // only 'restart'
    expect(findPrecedents(QUERY, { now: NOW })).toEqual([]);
  });

  it("returns [] for a query with fewer than two content tokens (W-2: 1 token ties every title at 1.0)", () => {
    seed({ id: "a", title: "Chat: deploy caddy" });
    expect(findPrecedents("ok", { now: NOW })).toEqual([]);
    expect(findPrecedents("verifica ahora", { now: NOW })).toEqual([]);
  });

  it("matches on the title only — a description full of query words does not qualify (C-1)", () => {
    seed({ id: "sp", title: "Chat: what time is it", description: `${QUERY} ${QUERY}` });
    expect(findPrecedents(QUERY, { now: NOW })).toEqual([]);
  });

  it("folds accents on both sides", () => {
    seed({ id: "acc", title: "Chat: configuracion de caddy para trustr" });
    const out = findPrecedents("revisa la configuración de Caddy para Trustr", { now: NOW });
    expect(out.map((p) => p.taskId)).toEqual(["acc"]);
  });
});

describe("findPrecedents — validity signals", () => {
  it("gate verdict: any failed wins over met; abandoned over pending; none without rows", () => {
    seed({ id: "f", title: "Chat: deploy caddy config for trustr", ageDays: 1 });
    gate("f", "met");
    gate("f", "failed");
    seed({ id: "ab", title: "Chat: deploy caddy config for trustr again", ageDays: 2 });
    gate("ab", "pending");
    gate("ab", "abandoned");
    seed({ id: "n", title: "Chat: deploy caddy config for trustr thrice", ageDays: 3 });
    const byId = Object.fromEntries(
      findPrecedents(QUERY, { now: NOW, k: 5 }).map((p) => [p.taskId, p.gate]),
    );
    expect(byId).toEqual({ f: "failed", ab: "abandoned", n: "none" });
  });

  it("supersededBy points at a later completed task with the identical title", () => {
    seed({ id: "old", title: "Chat: deploy caddy config for trustr", ageDays: 10 });
    seed({ id: "new", title: "Chat: Deploy caddy config for trustr ", ageDays: 2 });
    seed({ id: "newer-failed", title: "Chat: deploy caddy config for trustr", ageDays: 1, status: "failed" });
    const out = findPrecedents(QUERY, { now: NOW, k: 5 });
    const byId = Object.fromEntries(out.map((p) => [p.taskId, p.supersededBy]));
    // `new` is the latest COMPLETED one — the failed retry does not supersede.
    expect(byId.old).toBe("new");
    expect(byId.new).toBeNull();
    expect(byId["newer-failed"]).toBeNull();
  });

  it("supersession key folds accents/case/stopwords like the matcher (I-1)", () => {
    seed({ id: "old", title: "Chat: configuración de caddy para trustr", ageDays: 10 });
    seed({ id: "new", title: "Chat: Configuracion caddy trustr", ageDays: 2 });
    const byId = Object.fromEntries(
      findPrecedents("revisa la configuración de caddy para trustr", { now: NOW, k: 5 }).map((p) => [p.taskId, p.supersededBy]),
    );
    expect(byId).toEqual({ old: "new", new: null });
  });

  it("superseded precedents sort last even with the highest score; failed keep their score position", () => {
    const full = "Chat: deploy caddy config for trustr service restart";
    seed({ id: "old", title: full, ageDays: 10 }); // superseded by `new`, full overlap
    seed({ id: "new", title: full, ageDays: 2 });
    seed({ id: "fail", title: full, status: "failed", error: "caddy validate failed", ageDays: 1 });
    seed({ id: "weak", title: "Chat: deploy caddy config", ageDays: 5 }); // lower overlap, current
    const ids = findPrecedents(QUERY, { now: NOW, k: 5 }).map((p) => p.taskId);
    // score ties break newest-first; `old` outscores `weak` but is stale → last
    expect(ids).toEqual(["fail", "new", "weak", "old"]);
  });

  it("a stale high-score row never cuts a current low-score row at k (W-2)", () => {
    const full = "Chat: deploy caddy config for trustr service restart";
    seed({ id: "old", title: full, ageDays: 10 });
    seed({ id: "new", title: full, ageDays: 2 });
    seed({ id: "weak", title: "Chat: deploy caddy config", ageDays: 5 });
    expect(findPrecedents(QUERY, { now: NOW, k: 2 }).map((p) => p.taskId)).toEqual(["new", "weak"]);
  });
});

describe("findPrecedents — snippets", () => {
  it("uses error text for failed tasks and output otherwise, redacting secrets", () => {
    seed({ id: "f", title: "Chat: deploy caddy config for trustr", status: "failed", output: "partial", error: "validate failed: bad directive" });
    // Assembled at runtime so the repo never holds a secret-shaped literal.
    const fakeKey = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    seed({ id: "s", title: "Chat: deploy caddy config for trustr again", output: `done  with\n\nkey ${fakeKey}` });
    const byId = Object.fromEntries(
      findPrecedents(QUERY, { now: NOW, k: 5 }).map((p) => [p.taskId, p.snippet]),
    );
    expect(byId.f).toBe("validate failed: bad directive");
    expect(byId.s).toMatch(/^done with key /);
    expect(byId.s).not.toContain("abcdefghijklmnop");
    expect(byId.s).toContain("[REDACTED-");
  });

  it("caps snippets at 240 chars", () => {
    seed({ id: "s", title: "Chat: deploy caddy config for trustr", output: "x".repeat(1000) });
    const [p] = findPrecedents(QUERY, { now: NOW });
    expect(p.snippet.length).toBe(241); // 240 + ellipsis
  });

  it("formatPrecedent renders the labels the utility matcher will see", () => {
    seed({ id: "old", title: "Chat: deploy caddy config for trustr", ageDays: 10, output: "reloaded" });
    seed({ id: "new", title: "Chat: deploy caddy config for trustr", ageDays: 2 });
    const old = findPrecedents(QUERY, { now: NOW, k: 5 }).find((p) => p.taskId === "old")!;
    expect(formatPrecedent(old)).toBe(
      "[outcome:success gate:none superseded_by:new 10d] deploy caddy config for trustr → reloaded",
    );
  });
});

describe("shadowLogPrecedents", () => {
  const flush = () => new Promise<void>((r) => setImmediate(r));

  it("logs one recall_audit row under bank precedents / source precedents-shadow", async () => {
    seed({ id: "a", title: "Chat: deploy caddy config for trustr", output: "ok" });
    seed({ id: "f", title: "Chat: deploy caddy config for trustr again", status: "failed", error: "boom" });
    shadowLogPrecedents(QUERY, { now: NOW });
    expect(logRecallMock).not.toHaveBeenCalled(); // deferred off the hot path
    await flush();
    expect(logRecallMock).toHaveBeenCalledTimes(1);
    const input = logRecallMock.mock.calls[0][0];
    expect(input).toMatchObject({
      bank: "precedents",
      source: "precedents-shadow",
      query: QUERY,
      outcomeBreakdown: { success: 1, concerns: 0, failed: 1, unknown: 0 },
    });
    expect(input.results).toHaveLength(2);
    expect(input.topKIds.sort()).toEqual(["a", "f"]);
    expect(input.results[0].tags).toContain("task:" + input.topKIds[0]);
    // content = outcome text, never the (query-shaped) title (W-5)
    expect(input.results.map((r: { content: string }) => r.content).sort()).toEqual(["boom", "ok"]);
  });

  it("writes nothing when there are no precedents", async () => {
    shadowLogPrecedents(QUERY, { now: NOW });
    await flush();
    expect(logRecallMock).not.toHaveBeenCalled();
  });

  it("swallows DB errors instead of throwing into the caller", async () => {
    mockDb.exec("DROP TABLE tasks");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => shadowLogPrecedents(QUERY, { now: NOW })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith(
      "[precedents] shadow log failed:",
      expect.stringContaining("tasks"),
    );
    expect(logRecallMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("precedentsMode", () => {
  it("defaults to shadow, honours off, folds unknown values (incl. inject) to shadow", () => {
    expect(precedentsMode({})).toBe("shadow");
    expect(precedentsMode({ MEMORY_PRECEDENTS_MODE: "off" })).toBe("off");
    expect(precedentsMode({ MEMORY_PRECEDENTS_MODE: "inject" })).toBe("shadow");
    expect(precedentsMode({ MEMORY_PRECEDENTS_MODE: "bogus" })).toBe("shadow");
  });
});
