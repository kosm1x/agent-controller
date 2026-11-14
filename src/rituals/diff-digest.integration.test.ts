/**
 * The weekly diff digest on the real schema through initDatabase(":memory:"):
 * it lists auto-improvement tasks of the last 7 days and `jarvis_files` rows
 * under the four watched prefixes updated in the last 7 days, newest first.
 * Row ages are written with the database's own clock, the same clock both
 * statements compare against. `git log` runs through a mocked child process
 * (empty output, so no commit section) and the broadcast goes to a mocked
 * router whose captured HTML is what the cases read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  execFile: vi.fn(),
}));

// Promisified execFile resolves through util.promisify.custom; it returns an
// empty stdout and never starts a process.
vi.mock("child_process", () => {
  Object.defineProperty(m.execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => {
      m.execFile(...args);
      return Object.assign(Promise.resolve({ stdout: "", stderr: "" }), {
        child: { stdin: { end: () => {} } },
      });
    },
  });
  return { execFile: m.execFile };
});

vi.mock("../messaging/index.js", () => ({
  getRouter: () => ({ broadcastToAll: m.broadcastToAll }),
}));

import { initDatabase, closeDatabase } from "../db/index.js";
import { executeDiffDigest } from "./diff-digest.js";

let db: ReturnType<typeof initDatabase>;

function task(taskId: string, title: string, status: string, age: string): void {
  db.prepare(
    `INSERT INTO tasks (task_id, title, description, status, created_at)
     VALUES (?, ?, 'synthetic', ?, datetime('now', ?))`,
  ).run(taskId, title, status, age);
}

function file(path: string, age: string): void {
  db.prepare(
    `INSERT INTO jarvis_files (id, path, title, updated_at)
     VALUES (?, ?, 'synthetic', datetime('now', ?))`,
  ).run(`id-${path}`, path, age);
}

async function digestHtml(): Promise<{ html: string; sections: number }> {
  const result = await executeDiffDigest();
  expect(result.sent).toBe(true);
  expect(m.broadcastToAll).toHaveBeenCalledTimes(1);
  return { html: m.broadcastToAll.mock.calls[0][0] as string, sections: result.sections };
}

beforeEach(() => {
  db = initDatabase(":memory:");
  m.broadcastToAll.mockResolvedValue(undefined);
});

afterEach(() => {
  closeDatabase();
  vi.clearAllMocks();
});

describe("executeDiffDigest — auto-improvement tasks of the last 7 days", () => {
  it("lists matching tasks newest first and leaves out old or unrelated ones", async () => {
    task("t-old", "🤖 Auto-improvement: eight days ago", "completed", "-8 days");
    task("t-2", "🤖 Auto-improvement: two days ago", "failed", "-2 days");
    task("t-1", "🤖 Auto-improvement: one day ago", "completed", "-1 days");
    task("t-x", "Weekly report", "completed", "-1 days");

    const { html, sections } = await digestHtml();
    const one = html.indexOf("✅ 🤖 Auto-improvement: one day ago (completed)");
    const two = html.indexOf("❌ 🤖 Auto-improvement: two days ago (failed)");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(html).not.toContain("eight days ago");
    expect(html).not.toContain("Weekly report");
    expect(sections).toBeGreaterThanOrEqual(1);
    expect(m.execFile).toHaveBeenCalledTimes(1);
  });
});

describe("executeDiffDigest — knowledge-base changes of the last 7 days", () => {
  it("lists the four watched prefixes newest first and leaves out old or unwatched paths", async () => {
    // initDatabase seeds directive rows of its own; the cases read only the
    // synthetic paths below.
    file("knowledge/proposals/p-new.md", "-1 days");
    file("knowledge/execution-patterns/e-mid.md", "-2 days");
    file("logs/decisions/d-old.md", "-3 days");
    file("directives/x-oldest.md", "-4 days");
    file("knowledge/proposals/p-stale.md", "-8 days");
    file("notes/unwatched.md", "-1 days");

    const { html, sections } = await digestHtml();
    const order = [
      "knowledge/proposals/p-new.md",
      "knowledge/execution-patterns/e-mid.md",
      "logs/decisions/d-old.md",
      "directives/x-oldest.md",
    ].map((p) => html.indexOf(`• ${p} — `));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("p-stale.md");
    expect(html).not.toContain("notes/unwatched.md");
    expect(html).toContain("<b>Directive / Pattern Changes</b>");
    expect(html).not.toContain("<b>Auto-improvement Tasks</b>");
    expect(sections).toBe(1);
  });
});
