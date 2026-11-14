import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  written: [] as string[],
}));

// The statements under test are the two reads of the real `jarvis_files`
// table; the INDEX.md write is recorded instead of performed. The real
// `seedDirectives` stays because `initDatabase` calls it.
vi.mock("./jarvis-fs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jarvis-fs.js")>()),
  upsertFile: (_path: string, _title: string, content: string) => {
    state.written.push(content);
  },
}));

import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { cancelPendingRegeneration, markIndexDirty, regenerateIndex } from "./jarvis-index.js";

function add(path: string, content = "x"): void {
  getDatabase()
    .prepare(
      "INSERT INTO jarvis_files (id, path, title, content, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(path, path, path, content);
}

describe("regenerateIndex (audit 2026-09-22 context-02)", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    state.written = [];
    add("knowledge/a.md");
    add("projects/alpha/README.md");
  });
  // The seeded directive writes mark the index dirty; cancel that timer so it
  // never fires into a later case.
  afterEach(() => {
    closeDatabase();
    cancelPendingRegeneration();
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
    add("inbox/new.md");
    regenerateIndex();
    expect(state.written[1]).not.toBe(state.written[0]);
    expect(state.written[1]).toContain("[[projects/beta/|beta]]");
    expect(state.written[1]).toContain("[[inbox/|inbox]]");
  });

  it("lists directories and projects in ascending order, whatever the insert order", () => {
    add("archive/old.md");
    add("projects/gamma/README.md");
    add("projects/beta/README.md");
    regenerateIndex();
    const [, structure, projects] = state.written[0]!.split(/^## .*$/m);
    const links = (section: string | undefined) => section?.match(/\[\[[^\]]+\]\]/g);
    expect(links(structure)).toEqual([
      "[[archive/|archive]]",
      "[[directives/|directives]]",
      "[[knowledge/|knowledge]]",
      "[[projects/|projects]]",
    ]);
    expect(links(projects)).toEqual([
      "[[projects/alpha/|alpha]]",
      "[[projects/beta/|beta]]",
      "[[projects/gamma/|gamma]]",
    ]);
  });

  it("NorthStar retired (2026-11-03): no NorthStar dir or line even while rows exist", () => {
    add("NorthStar/goals/y.md");
    add("NorthStar/x.md");
    add("northstar/lower.md");
    regenerateIndex();
    const index = state.written[0]!;
    expect(index).not.toMatch(/northstar/i);
    expect(index).toContain("[[knowledge/|knowledge]]");
    expect(index).toContain("project_list + el day-log");
  });
});

describe("markIndexDirty timer (2026-10-20)", () => {
  // A mark left by an earlier case would make this one a no-op.
  beforeEach(() => cancelPendingRegeneration());
  afterEach(() => {
    cancelPendingRegeneration();
    vi.restoreAllMocks();
  });

  it("never holds a process open (a late mark after drainKbWrites + close cannot fire)", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    markIndexDirty();
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
  });
});
