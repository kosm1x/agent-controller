import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  written: [] as string[],
}));

vi.mock("./index.js", () => ({ getDatabase: () => state.db }));
vi.mock("./jarvis-fs.js", () => ({
  upsertFile: (_path: string, _title: string, content: string) => {
    state.written.push(content);
  },
}));

import { regenerateIndex } from "./jarvis-index.js";

function add(path: string, content = "x"): void {
  state.db
    .prepare(
      "INSERT INTO jarvis_files (path, title, content, updated_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .run(path, path, content);
}

describe("regenerateIndex (audit 2026-09-22 context-02)", () => {
  beforeEach(() => {
    state.db = new Database(":memory:");
    state.db.exec(
      "CREATE TABLE jarvis_files (path TEXT PRIMARY KEY, title TEXT, content TEXT, updated_at TEXT)",
    );
    state.written = [];
    add("knowledge/a.md");
    add("projects/alpha/README.md");
  });

  it("is byte-identical after a write to an existing directory", () => {
    regenerateIndex();
    add("knowledge/b.md", "a much longer body ".repeat(200));
    add("projects/alpha/notes.md");
    regenerateIndex();
    expect(state.written).toHaveLength(2);
    expect(state.written[1]).toBe(state.written[0]);
    expect(state.written[0]).not.toMatch(
      /Recientes|Actualizado|archivos ·|KB ·|\(\d+\)|\d{4}-\d{2}-\d{2}/,
    );
  });

  it("a path with a leading slash adds no empty [[/|]] entry", () => {
    add("/root/claude/knowledge/x.md");
    regenerateIndex();
    expect(state.written[0]).not.toContain("[[/|]]");
    expect(state.written[0]).toContain("[[knowledge/|knowledge]]");
  });

  it("changes when a new top-level directory or project appears", () => {
    regenerateIndex();
    add("projects/beta/README.md");
    add("NorthStar/goal.md");
    regenerateIndex();
    expect(state.written[1]).not.toBe(state.written[0]);
    expect(state.written[1]).toContain("[[projects/beta/|beta]]");
    expect(state.written[1]).toContain("[[NorthStar/|NorthStar]]");
  });
});
