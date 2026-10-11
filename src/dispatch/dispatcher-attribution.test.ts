/**
 * S6 WS2 — `submitTask` writes `tasks.project_slug` / `project_source` ONCE,
 * in its INSERT, from `resolveProjectAttribution` (spec
 * docs/planning/s6-project-contract-spec-2026-10-11.md §4). Real `:memory:`
 * db; no runner is registered, so each dispatch fails fast after the insert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({ emitEvent: vi.fn() }),
}));
vi.mock("./classifier.js", () => ({
  classify: vi.fn(() => ({
    agentType: "fast",
    score: 1,
    reason: "test",
    explicit: false,
    modelTier: "standard",
  })),
}));
const attributionWarn = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/logger.js")>();
  return {
    ...real,
    createLogger: (module: string) =>
      module === "attribution"
        ? Object.assign(real.createLogger(module), { warn: attributionWarn })
        : real.createLogger(module),
  };
});
const emitTrace = vi.hoisted(() => vi.fn());
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: emitTrace }));

import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { ensureScheduledTasksTable } from "../rituals/dynamic.js";
import { submitTask, type TaskSubmission } from "./dispatcher.js";

const cols = (taskId: string) =>
  getDatabase()
    .prepare("SELECT project_slug, project_source FROM tasks WHERE task_id = ?")
    .get(taskId) as { project_slug: string | null; project_source: string | null };

const claim = (scheduleId: string, slug: string | null) =>
  getDatabase()
    .prepare("UPDATE scheduled_tasks SET project_slug = ? WHERE schedule_id = ?")
    .run(slug, scheduleId);

beforeEach(() => {
  initDatabase(":memory:");
  ensureScheduledTasksTable();
  getDatabase()
    .prepare(
      `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr) VALUES ('s-1','n','d','0 9 * * 1')`,
    )
    .run();
  // Every slug a test expects to persist names a projects row (C1 validator).
  const project = getDatabase().prepare(
    "INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, 'active', ?)",
  );
  project.run("p1", "acme-radar", "Acme", JSON.stringify({ aliases: ["acme"] }));
  project.run("p2", "other-proj", "Other", "{}");
  emitTrace.mockClear();
});

afterEach(() => {
  closeDatabase();
});

const base: TaskSubmission = { title: "t", description: "d" };

describe("submitTask — project attribution at insert", () => {
  it("a run of a claimed schedule: (slug, schedule); an unclaimed one: NULLs", async () => {
    const free = await submitTask({ ...base, tags: ["scheduled", "schedule:s-1"] });
    expect(cols(free.taskId)).toEqual({ project_slug: null, project_source: null });
    claim("s-1", "acme-radar");
    const run = await submitTask({ ...base, tags: ["scheduled", "schedule:s-1"] });
    expect(cols(run.taskId)).toEqual({ project_slug: "acme-radar", project_source: "schedule" });
  });

  it("a sub-task inherits its parent's slug AND source", async () => {
    claim("s-1", "acme-radar");
    const parent = await submitTask({ ...base, tags: ["schedule:s-1"] });
    const child = await submitTask({ ...base, parentTaskId: parent.taskId, spawnType: "subtask" });
    expect(cols(child.taskId)).toEqual({ project_slug: "acme-radar", project_source: "schedule" });
  });

  it("chat: the named project, then the thread's next unnamed turn inherits it as `thread`", async () => {
    const named = await submitTask({
      ...base,
      threadId: "th-1",
      projectSlug: "acme-radar",
      projectSource: "chat",
    });
    expect(cols(named.taskId)).toEqual({ project_slug: "acme-radar", project_source: "chat" });
    const next = await submitTask({ ...base, threadId: "th-1" });
    expect(cols(next.taskId)).toEqual({ project_slug: "acme-radar", project_source: "thread" });
    const otherThread = await submitTask({ ...base, threadId: "th-2" });
    expect(cols(otherThread.taskId)).toEqual({ project_slug: null, project_source: null });
  });

  it("a detector folder name is stored as its row slug; an unknown one is not stored", async () => {
    const folder = await submitTask({ ...base, threadId: "th-9", projectSlug: "acme-folder", projectSource: "chat" });
    expect(cols(folder.taskId)).toEqual({ project_slug: "acme-radar", project_source: "chat" });
    const unknown = await submitTask({ ...base, projectSlug: "gira-estrellas", projectSource: "chat" });
    expect(cols(unknown.taskId)).toEqual({ project_slug: null, project_source: null });
  });

  it("emits attribution.resolved with {slug, source} only, or nulls", async () => {
    const r = await submitTask({ ...base, projectSlug: "acme-radar", projectSource: "inbound" });
    const none = await submitTask({ ...base });
    const ev = emitTrace.mock.calls.map((c) => c[0]).filter((e) => e.name === "attribution.resolved");
    expect(ev).toEqual([
      { taskId: r.taskId, name: "attribution.resolved", attrs: { slug: "acme-radar", source: "inbound" } },
      { taskId: none.taskId, name: "attribution.resolved", attrs: { slug: null, source: null } },
    ]);
  });

  it("W3a: a throwing validator (canonicalProjectSlug) returns null, not a crash — the row is inserted with NULLs and the warn is emitted", async () => {
    attributionWarn.mockClear();
    // The validator's first read targets `projects`; without the table it throws.
    getDatabase().prepare("ALTER TABLE projects RENAME TO projects_gone").run();
    const r = await submitTask({ ...base, projectSlug: "acme-radar", projectSource: "chat" });
    expect(cols(r.taskId)).toEqual({ project_slug: null, project_source: null });
    expect(attributionWarn).toHaveBeenCalledWith(
      expect.objectContaining({ source: "validate" }),
      expect.any(String),
    );
  });

  it("inbound seam: a submitted slug with source inbound", async () => {
    const r = await submitTask({ ...base, projectSlug: "acme-radar", projectSource: "inbound" });
    expect(cols(r.taskId)).toEqual({ project_slug: "acme-radar", project_source: "inbound" });
  });

  it("set once: a retry is a new row with its own resolution; the original row is never rewritten", async () => {
    claim("s-1", "acme-radar");
    const submission: TaskSubmission = { ...base, tags: ["scheduled", "schedule:s-1"] };
    const original = await submitTask(submission);
    expect(cols(original.taskId)).toEqual({ project_slug: "acme-radar", project_source: "schedule" });

    // The record changes hands before the retry (the dispatcher's
    // required-tool retry shape: the submission spread + retry markers).
    claim("s-1", "other-proj");
    const retry = await submitTask({ ...submission, _isRequiredToolRetry: true, retryCount: 1 });

    expect(retry.taskId).not.toBe(original.taskId);
    expect(cols(original.taskId)).toEqual({ project_slug: "acme-radar", project_source: "schedule" });
    expect(cols(retry.taskId)).toEqual({ project_slug: "other-proj", project_source: "schedule" });
  });
});
