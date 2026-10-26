/**
 * Operator script: import a hand edit from the disk mirror into an existing KB row.
 * Real in-memory db + scratch KB mirror (JARVIS_KB_MIRROR_DIR). Synthetic fixtures only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { getFile, upsertFile } from "../src/db/jarvis-fs.js";
import { cancelPendingRegeneration } from "../src/db/jarvis-index.js";
import { drainKbWrites } from "../src/db/kb-write-drain.js";
import { isMainModule, main, parseArgs, runImport } from "./kb-import-from-disk.js";

// pgvector and Drive syncs off (no key / folder; :memory: is not the live db either).
vi.hoisted(() => {
  delete process.env.COMMIT_DB_KEY;
  delete process.env.DRIVE_KB_FOLDER_ID;
});

/** Main must never run on import: the operator gate is the first thing main calls, so it throws here. */
const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/operator-gate.js", () => ({
  requireOperatorContext: () => {
    gate.calls++;
    throw new Error("kb-import main ran on import");
  },
}));

/** Seam for the post-write check: a row corrupted right after upsertFile. */
const ctl = vi.hoisted(() => ({ corruptRow: false, mirrorDir: undefined as string | null | undefined }));
vi.mock("../src/db/jarvis-fs.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db/jarvis-fs.js")>();
  const db = await import("../src/db/index.js");
  return {
    ...real,
    getKbMirrorWriteDir: () => (ctl.mirrorDir !== undefined ? ctl.mirrorDir : real.getKbMirrorWriteDir()),
    upsertFile: (...args: Parameters<typeof real.upsertFile>) => {
      real.upsertFile(...args);
      if (ctl.corruptRow) {
        db.getDatabase().prepare("UPDATE jarvis_files SET content = content || 'x' WHERE path = ?").run(args[0]);
      }
    },
  };
});

const OLD_STAMP = "2000-01-01 00:00:00";
const A = "directives/syn-a.md";
const B = "directives/syn-b.md";
let kbDir: string;
const prevMirror = process.env.JARVIS_KB_MIRROR_DIR;

/** A registry row whose mirror file is then replaced by a synthetic hand edit. */
function seed(path: string, content: string, disk: string | null): void {
  upsertFile(path, `T ${path}`, content, ["x"], "conditional", 55, "when synthetic", ["directives/other.md"]);
  getDatabase().prepare("UPDATE jarvis_files SET updated_at = ?, user_edit_time = ? WHERE path = ?").run(OLD_STAMP, OLD_STAMP, path);
  const file = join(kbDir, path);
  if (disk === null) rmSync(file, { force: true });
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, disk);
  }
}
const statuses = () => (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]!);

beforeEach(() => {
  kbDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-kbimport-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  Object.assign(ctl, { corruptRow: false, mirrorDir: undefined });
  initDatabase(":memory:");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  rmSync(kbDir, { recursive: true, force: true });
  if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
});

describe("runImport", () => {
  it("nothing to do when disk equals the row", () => {
    seed(A, "same\n", "same\n");
    expect(runImport({ apply: true, paths: [A] }).ok).toBe(true);
    expect(statuses()).toContain(`PASS ${A} nothing-to-do`);
    expect(getFile(A)!.updated_at).toBe(OLD_STAMP);
  });

  it("imports the disk content as a user edit and keeps the row metadata", () => {
    seed(A, "line one\nold two\n", "line one\nnew two\n");
    const before = getFile(A)!;
    expect(runImport({ apply: true, paths: [A] }).ok).toBe(true);
    const row = getFile(A)!;
    expect(row.content).toBe("line one\nnew two\n");
    expect(row).toMatchObject({
      title: before.title,
      tags: before.tags,
      qualifier: "conditional",
      priority: 55,
      condition: "when synthetic",
      related_to: before.related_to,
    });
    expect(row.updated_at).not.toBe(OLD_STAMP);
    expect(row.user_edit_time).not.toBe(OLD_STAMP);
    expect(statuses()).toEqual(
      expect.arrayContaining([`  ${A}:2 - old two`, `  ${A}:2 + new two`, expect.stringMatching(/^PASS .*changedLines=1 .*imported$/)]),
    );
  });

  it("dry run writes nothing", () => {
    seed(A, "old\n", "new\n");
    expect(runImport({ apply: false, paths: [A] }).ok).toBe(true);
    expect(getFile(A)).toMatchObject({ content: "old\n", updated_at: OLD_STAMP, user_edit_time: OLD_STAMP });
  });

  it("a missing row is FAIL and nothing is created", () => {
    mkdirSync(join(kbDir, "directives"), { recursive: true });
    writeFileSync(join(kbDir, A), "orphan\n");
    expect(runImport({ apply: true, paths: [A] }).ok).toBe(false);
    expect(statuses()[0]).toMatch(/^FAIL .*no registry row; new files register through upsertFile/);
    expect(getFile(A)).toBeNull();
  });

  it("a missing disk file is FAIL", () => {
    seed(A, "old\n", null);
    expect(runImport({ apply: true, paths: [A] }).ok).toBe(false);
    expect(statuses()[0]).toMatch(/^FAIL .*disk file missing/);
    expect(getFile(A)!.content).toBe("old\n");
  });

  it("refuses NorthStar/, skills/<name>/SKILL.md and paths leaving the KB", () => {
    for (const p of ["NorthStar/goal.md", "skills/x/SKILL.md", "../outside.md"]) {
      seed(p === "../outside.md" ? A : p, "old\n", "new\n");
      expect(runImport({ apply: true, paths: [p] }).ok).toBe(false);
    }
    const lines = statuses();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^FAIL NorthStar\/goal\.md .*retired/),
        expect.stringMatching(/^FAIL skills\/x\/SKILL\.md .*critic-gated/),
        expect.stringMatching(/^FAIL \.\.\/outside\.md .*relative/),
      ]),
    );
    expect(getFile("NorthStar/goal.md")!.content).toBe("old\n");
    expect(getFile("skills/x/SKILL.md")!.content).toBe("old\n");
  });

  it("FAIL when the row does not hold the disk content after the write", () => {
    seed(A, "old\n", "new\n");
    ctl.corruptRow = true;
    expect(runImport({ apply: true, paths: [A] }).ok).toBe(false);
    expect(statuses()).toEqual(expect.arrayContaining([expect.stringMatching(/^FAIL .*row differs after write/)]));
  });

  it("FAIL with no mirror for this db", () => {
    seed(A, "old\n", "new\n");
    ctl.mirrorDir = null;
    expect(runImport({ apply: true, paths: [A] }).ok).toBe(false);
    expect(statuses()).toEqual([`FAIL ${A} no mirror for this db`]);
    expect(getFile(A)!.content).toBe("old\n");
  });

  describe("links at the mirror path", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-kbimport-outside-"));
      writeFileSync(join(outside, "syn-a.md"), "synthetic outside text\n");
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    const expectRefused = (reason: RegExp) => {
      expect(runImport({ apply: true, paths: [A] }).ok).toBe(false);
      expect(statuses()).toEqual([expect.stringMatching(reason)]);
      expect(statuses().some((l) => l.includes("outside text"))).toBe(false);
      expect(getFile(A)).toMatchObject({ content: "old\n", updated_at: OLD_STAMP });
    };

    it("refuses a symlink to a file outside the mirror", () => {
      seed(A, "old\n", null);
      symlinkSync(join(outside, "syn-a.md"), join(kbDir, A));
      expectRefused(/^FAIL .* disk file is a symlink$/);
    });

    it("refuses a hard-linked file", () => {
      seed(A, "old\n", null);
      linkSync(join(outside, "syn-a.md"), join(kbDir, A));
      expectRefused(/^FAIL .* disk file has more than one hard link$/);
    });

    it("refuses a file reached through a symlinked directory", () => {
      seed(A, "old\n", null);
      rmSync(join(kbDir, "directives"), { recursive: true, force: true });
      symlinkSync(outside, join(kbDir, "directives"));
      expectRefused(/^FAIL .* disk file resolves outside the mirror$/);
    });
  });

  it("two-pass: one failing path blocks the good one", () => {
    seed(A, "old\n", "new\n");
    seed(B, "old\n", null);
    expect(runImport({ apply: true, paths: [A, B] }).ok).toBe(false);
    expect(getFile(A)).toMatchObject({ content: "old\n", updated_at: OLD_STAMP });
    expect(statuses()).toEqual(expect.arrayContaining([expect.stringMatching(/^FAIL directives\/syn-a\.md .*not written/)]));
  });
});

describe("module entry", () => {
  it("does not run main when imported", () => {
    expect(isMainModule()).toBe(false);
    expect(gate.calls).toBe(0);
  });

  it("parses repeated --path and --apply, refuses anything else", () => {
    expect(parseArgs(["--path", A, "--path", B, "--apply"])).toEqual({ paths: [A, B], apply: true });
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["--path"])).toHaveProperty("error");
    expect(parseArgs(["--path", "--x"])).toHaveProperty("error");
    expect(parseArgs(["--bogus"])).toHaveProperty("error");
  });

  const spyDeps = (ok: boolean) => ({
    requireOperatorContext: vi.fn(),
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    runImport: vi.fn(() => ({ ok, written: 0 })),
    drainKbWrites: vi.fn(async () => {}),
  });

  it("main refuses bad arguments before opening the database", async () => {
    for (const argv of [["--bogus"], ["--path", A, "--bogus"], ["--path", "--x"], []]) {
      const deps = spyDeps(true);
      expect(await main(argv, deps), argv.join(" ")).toBe(1);
      expect(deps.requireOperatorContext).toHaveBeenCalledOnce();
      expect(deps.initDatabase).not.toHaveBeenCalled();
    }
  });

  it("main returns 1 when the import fails", async () => {
    expect(await main(["--path", A], spyDeps(false))).toBe(1);
  });

  const orderDeps = (order: string[], written = 0) => ({
    requireOperatorContext: vi.fn(() => void order.push("gate")),
    initDatabase: vi.fn(() => void order.push("init")),
    closeDatabase: vi.fn(() => void order.push("close")),
    runImport: vi.fn(() => {
      order.push("run");
      return { ok: true, written };
    }),
    drainKbWrites: vi.fn(async (): Promise<void> => void order.push("drain")),
  });

  it("main runs the operator gate before opening the database", async () => {
    const order: string[] = [];
    const deps = orderDeps(order);
    expect(await main(["--path", A], deps)).toBe(0);
    // Dry run: nothing written, nothing to drain.
    expect(order).toEqual(["gate", "init", "run", "close"]);
    expect(deps.runImport).toHaveBeenCalledWith({ paths: [A], apply: false });
    deps.requireOperatorContext.mockImplementation(() => {
      throw new Error("refused");
    });
    deps.initDatabase.mockClear();
    await expect(main(["--path", A], deps)).rejects.toThrow("refused");
    expect(deps.initDatabase).not.toHaveBeenCalled();
  });

  it("--apply that wrote rows drains the syncs and INDEX.md before closing the database", async () => {
    const order: string[] = [];
    expect(await main(["--path", A, "--apply"], orderDeps(order, 1))).toBe(0);
    expect(order).toEqual(["gate", "init", "run", "drain", "close"]);
  });

  it("--apply that wrote nothing does not drain (no INDEX.md rewrite)", async () => {
    const order: string[] = [];
    expect(await main(["--path", A, "--apply"], orderDeps(order, 0))).toBe(0);
    expect(order).toEqual(["gate", "init", "run", "close"]);
  });

  it("--apply: a drain still in flight holds closeDatabase back", async () => {
    const order: string[] = [];
    const deps = orderDeps(order, 1);
    let release!: () => void;
    deps.drainKbWrites.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const run = main(["--path", A, "--apply"], deps);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(deps.closeDatabase).not.toHaveBeenCalled();
    release();
    expect(await run).toBe(0);
    expect(order.at(-1)).toBe("close");
  });

  it("real runImport + real drainKbWrites: INDEX.md is current before closeDatabase (syncs off)", async () => {
    // A row inserted behind upsertFile's back: INDEX.md does not list its project yet.
    seed(A, "old\n", "new\n");
    getDatabase()
      .prepare("INSERT INTO jarvis_files (id, path, title, content) VALUES ('p', 'projects/zeta-syn/a.md', 'P', 'x')")
      .run();
    expect(getFile("INDEX.md")?.content ?? "").not.toContain("zeta-syn");
    let indexAtClose: string | undefined;
    const deps = {
      requireOperatorContext: vi.fn(),
      initDatabase: vi.fn(),
      closeDatabase: vi.fn(() => void (indexAtClose = getFile("INDEX.md")?.content)),
      runImport,
      drainKbWrites,
    };
    expect(await main(["--path", A, "--apply"], deps)).toBe(0);
    expect(getFile(A)?.content).toBe("new\n");
    expect(indexAtClose).toContain("[[projects/zeta-syn/|zeta-syn]]");
    await new Promise((r) => setTimeout(r, 50)); // the late dynamic-import mark
    cancelPendingRegeneration();
  });
});
