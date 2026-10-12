/**
 * Operator script: registry-aware KB folder rename. Real in-memory db +
 * scratch KB mirror (JARVIS_KB_MIRROR_DIR). Synthetic rows only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { getFile, upsertFile } from "../src/db/jarvis-fs.js";
import { createProject, getProject } from "../src/db/projects.js";
import { parseArgs, runRename } from "./kb-folder-rename.js";

/** Crash injection: a thrown error stands in for a killed process. */
const ctl = vi.hoisted(() => ({ moveCalls: 0, moveThrowAt: 0, deleteThrowOn: "" }));
vi.mock("../src/db/jarvis-fs.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db/jarvis-fs.js")>();
  return {
    ...real,
    moveFile: (from: string, to: string) => {
      ctl.moveCalls++;
      if (ctl.moveCalls === ctl.moveThrowAt) throw new Error("synthetic crash before move");
      return real.moveFile(from, to);
    },
    syncDeleteFromKbMirror: (p: string) => {
      if (p === ctl.deleteThrowOn) {
        ctl.deleteThrowOn = "";
        throw new Error("synthetic crash before disk delete");
      }
      real.syncDeleteFromKbMirror(p);
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
let kbDir: string;
let backupDir: string;
let lines: string[];

const OLD = "projects/Acme-X/";
const NEW = "projects/acme-x/";
const FILES = ["README.md", "notes.md", "sub/deep.md"];

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-kbrename-test-"));
  backupDir = join(kbDir, "..", `${kbDir.split("/").pop()}-backup`);
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  delete process.env.COMMIT_DB_KEY;
  Object.assign(ctl, { moveCalls: 0, moveThrowAt: 0, deleteThrowOn: "" });
  initDatabase(":memory:");
  lines = [];
  for (const f of FILES) upsertFile(`${OLD}${f}`, f, `synthetic ${f}`);
  upsertFile("projects/other/index.md", "idx", `see ${OLD}README.md`);
  createProject("acme-x", "Acme X", {
    config: { kb_folder: OLD, kb_readme: `${OLD}README.md`, kb_path: "projects/Acme-X", aliases: ["acme"] },
  });
  createProject("other", "Other", { config: { kb_folder: "projects/other/" } });
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

const run = (argv: string[], liveDbPath?: string) =>
  runRename(argv, { backupDir, liveDbPath, log: (l) => lines.push(l) });

function registryPaths(prefix = "projects/"): string[] {
  return (
    getDatabase().prepare("SELECT path FROM jarvis_files WHERE path GLOB ? ORDER BY path").all(`${prefix}*`) as Array<{
      path: string;
    }>
  ).map((r) => r.path);
}

/** Files on disk under a KB folder (recursive, relative to it). */
function diskFiles(folder: string): string[] {
  const root = join(kbDir, folder);
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; parentPath: string; name: string }>)
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort();
}

describe("kb-folder-rename — apply", () => {
  it("moves registry rows, disk files, old dirs and the project row keys", async () => {
    expect(await run([OLD, NEW])).toBe(0);

    expect(registryPaths()).toEqual([...FILES.map((f) => `${NEW}${f}`), "projects/other/index.md"].sort());
    for (const f of FILES) {
      expect(readFileSync(join(kbDir, NEW, f), "utf-8")).toBe(`synthetic ${f}`);
      expect(existsSync(join(kbDir, OLD, f))).toBe(false);
      expect(getFile(`${NEW}${f}`)?.content).toBe(`synthetic ${f}`);
    }
    expect(existsSync(join(kbDir, OLD, "sub"))).toBe(false);
    expect(existsSync(join(kbDir, OLD))).toBe(false);

    expect(getProject("acme-x")!.config).toEqual({
      kb_folder: NEW,
      kb_readme: `${NEW}README.md`,
      kb_path: "projects/acme-x",
      aliases: ["acme"],
    });
    expect(getProject("other")!.config).toEqual({ kb_folder: "projects/other/" });

    // links counted, never rewritten
    expect(lines).toContain(`content links to ${OLD}: 1 row(s) — links not rewritten (manual)`);
    expect(getFile("projects/other/index.md")?.content).toBe(`see ${OLD}README.md`);
    expect(lines).toContain(`rows: 3   subfolders: 1   already under ${NEW}: 0`);
    expect(lines.some((l) => l.includes("npx tsx src/db/pgvector-backfill.ts"))).toBe(true);
    expect(readdirSync(backupDir).sort().map((n) => n.replace(/\d.*?(\.db|\.tar\.gz)$/, "$1"))).toEqual([
      "kb-folder-pre-kbrename-.tar.gz",
      "mc-db-pre-kbrename-.db",
    ]);
  });

  it("accepts the folders without trailing slashes", async () => {
    expect(await run(["projects/Acme-X", "projects/acme-x"])).toBe(0);
    expect(registryPaths()).toContain(`${NEW}sub/deep.md`);
  });

  it("an unrelated row already under new is not a refusal", async () => {
    upsertFile(`${NEW}existing.md`, "e", "x");
    expect(await run([OLD, NEW])).toBe(0);
    expect(registryPaths(NEW)).toHaveLength(4);
    expect(existsSync(join(kbDir, OLD))).toBe(false);
  });

  it("--dry-run prints the plan and mirror root, and writes nothing", async () => {
    const before = registryPaths();
    expect(await run([OLD, NEW, "--dry-run"])).toBe(0);
    expect(registryPaths()).toEqual(before);
    for (const f of FILES) expect(existsSync(join(kbDir, OLD, f))).toBe(true);
    expect(existsSync(join(kbDir, NEW))).toBe(false);
    expect(getProject("acme-x")!.config.kb_folder).toBe(OLD);
    expect(existsSync(backupDir)).toBe(false);
    expect(lines).toContain(`mirror root: ${kbDir}`);
    expect(lines).toContain(`  ${OLD}sub/deep.md  ->  ${NEW}sub/deep.md`);
    expect(lines).toContain(`  acme-x.kb_folder  ->  ${NEW}`);
  });

  it("a non-empty old dir is left in place and exits 3", async () => {
    writeFileSync(join(kbDir, OLD, "sub", "stray.txt"), "disk-only");
    expect(await run([OLD, NEW])).toBe(3);
    expect(existsSync(join(kbDir, OLD, "sub", "stray.txt"))).toBe(true);
    expect(existsSync(join(kbDir, OLD, "sub", "deep.md"))).toBe(false);
    expect(registryPaths()).toContain(`${NEW}sub/deep.md`);
  });

  it("the backup exists before the first move (first move crashes)", async () => {
    ctl.moveThrowAt = 1;
    await expect(run([OLD, NEW])).rejects.toThrow("synthetic crash");
    expect(readdirSync(backupDir).sort().map((n) => n.replace(/\d.*?(\.db|\.tar\.gz)$/, "$1"))).toEqual([
      "kb-folder-pre-kbrename-.tar.gz",
      "mc-db-pre-kbrename-.db",
    ]);
    expect(registryPaths(OLD)).toHaveLength(3);
    expect(lines.some((l) => l.startsWith("[restore] to undo instead"))).toBe(true);
  });
});

describe("kb-folder-rename — idempotent resume (25 files, 4 subfolders)", () => {
  const BIG_OLD = "projects/Big-X/";
  const BIG_NEW = "projects/big-x/";
  const BIG = ["", "a/", "b/", "c/", "c/d/"].flatMap((d) => [1, 2, 3, 4, 5].map((i) => `${d}f${i}.md`));

  beforeEach(() => {
    for (const f of BIG) upsertFile(`${BIG_OLD}${f}`, f, `big ${f}`);
    createProject("big-x", "Big X", { config: { kb_folder: BIG_OLD, kb_readme: `${BIG_OLD}f1.md` } });
  });

  function expectFinished(): void {
    expect(registryPaths(BIG_OLD)).toHaveLength(0);
    expect(registryPaths(BIG_NEW)).toHaveLength(25);
    expect(diskFiles(BIG_OLD)).toEqual([]);
    expect(diskFiles(BIG_NEW)).toEqual([...BIG].sort());
    expect(existsSync(join(kbDir, BIG_OLD))).toBe(false);
    expect(getProject("big-x")!.config).toEqual({ kb_folder: BIG_NEW, kb_readme: `${BIG_NEW}f1.md` });
  }

  it("a crash at file 13 is finished by a re-run", async () => {
    expect(BIG).toHaveLength(25);
    ctl.moveThrowAt = 13;
    await expect(run([BIG_OLD, BIG_NEW])).rejects.toThrow("synthetic crash");
    expect(registryPaths(BIG_NEW)).toHaveLength(12);
    expect(getProject("big-x")!.config.kb_folder).toBe(BIG_OLD);

    expect(await run([BIG_OLD, BIG_NEW])).toBe(0);
    expect(lines).toContain(`rows: 13   subfolders: 4   already under ${BIG_NEW}: 12`);
    expectFinished();
  });

  it("a crash after the last registry move, before its disk delete, is finished by a re-run", async () => {
    const lastOld = registryPaths(BIG_OLD).at(-1)!;
    ctl.deleteThrowOn = lastOld;
    await expect(run([BIG_OLD, BIG_NEW])).rejects.toThrow("synthetic crash");
    expect(registryPaths(BIG_OLD)).toHaveLength(0);
    expect(existsSync(join(kbDir, lastOld))).toBe(true);

    expect(await run([BIG_OLD, BIG_NEW])).toBe(0);
    expect(lines).toContain("[sweep] 1 leftover old disk file(s) removed.");
    expectFinished();
  });
});

describe("kb-folder-rename — refusals (exit 1, nothing changed)", () => {
  it("parseArgs refuses bad folders, same folder, uppercase new, wrong arity, unknown flags", () => {
    for (const argv of [
      ["knowledge/x/", NEW],
      [OLD, "projects/a/b/"],
      [OLD, "projects/../x/"],
      [OLD, "projects/-x/"],
      ["projects/a", "projects/a/"],
      [OLD, "projects/Acme-Y/"],
      [OLD, "projects/acme_y/"],
      [OLD],
      [OLD, NEW, "extra/"],
      [OLD, NEW, "--force"],
    ])
      expect(parseArgs(argv)).toHaveProperty("error");
    expect(parseArgs([OLD, "projects/acme-x", "--dry-run"])).toEqual({ oldDir: OLD, newDir: NEW, dryRun: true });
  });

  it("refuses an uppercase new folder at run time", async () => {
    expect(await run([OLD, "projects/Acme-Y/"])).toBe(1);
    expect(registryPaths()).toContain(`${OLD}README.md`);
  });

  it("refuses when there are no rows under old or new (case-sensitive)", async () => {
    expect(await run(["projects/acme-X/", "projects/acme-y/"])).toBe(1);
    expect(registryPaths()).toContain(`${OLD}README.md`);
  });

  it("refuses when a remaining move's target already exists under new", async () => {
    upsertFile(`${NEW}README.md`, "e", "x");
    const before = registryPaths();
    expect(await run([OLD, NEW])).toBe(1);
    expect(registryPaths()).toEqual(before);
    expect(existsSync(join(kbDir, OLD, "README.md"))).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses when old and new are the same directory on disk", async () => {
    symlinkSync(join(kbDir, OLD), join(kbDir, "projects/acme-x"));
    expect(await run([OLD, NEW])).toBe(1);
    expect(registryPaths(OLD)).toHaveLength(3);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses when JARVIS_KB_MIRROR_DIR is set while the open db is the live db", async () => {
    closeDatabase();
    const dbFile = join(kbDir, "live-standin.db");
    initDatabase(dbFile);
    upsertFile(`${OLD}README.md`, "r", "x");
    expect(await run([OLD, NEW], dbFile)).toBe(1);
    expect(registryPaths(OLD)).toEqual([`${OLD}README.md`]);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses when the KB mirror is disabled for the open db", async () => {
    const vitest = process.env.VITEST;
    delete process.env.JARVIS_KB_MIRROR_DIR;
    delete process.env.VITEST;
    try {
      expect(await run([OLD, NEW])).toBe(1);
      expect(lines).toContain("mirror root: DISABLED");
    } finally {
      process.env.VITEST = vitest;
      process.env.JARVIS_KB_MIRROR_DIR = kbDir;
    }
    expect(registryPaths(OLD)).toHaveLength(3);
    expect(existsSync(join(kbDir, OLD, "README.md"))).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
  });
});

describe("kb-folder-rename — source pins", () => {
  const src = readFileSync(join(here, "kb-folder-rename.ts"), "utf-8");
  it("never removes recursively", () => {
    expect(src).not.toMatch(/rmSync|\brm\b|-rf\b/);
  });
  it("never writes a KB file directly", () => {
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream/);
  });
});

describe("CLI entry — operator login-session gated (5a: { tty: false }, like cleanup-jarvis-kb)", () => {
  // A login-session gate cannot be made to refuse from inside a login session
  // (vitest runs in one), so the pin is source order: the gate call is the
  // { tty: false } form and precedes the first db open.
  it("calls requireOperatorContext({ tty: false }) before initDatabase", () => {
    const src = readFileSync(join(here, "kb-folder-rename.ts"), "utf-8");
    const gate = src.indexOf('requireOperatorContext("kb-folder-rename", { tty: false })');
    // The db opens inside main(); the gate must run before main() is invoked.
    const entry = src.indexOf("main().then(");
    expect(gate).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(entry);
    expect(src.slice(gate, entry)).not.toMatch(/initDatabase\(/);
    expect(src).not.toMatch(/requireOperatorTerminal\(|tty:\s*true/);
  });
});
