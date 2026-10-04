/**
 * KB mirror gate (2026-10-04 incident): with JARVIS_KB_MIRROR_DIR unset and
 * outside vitest, the default mirror dir may be written or deleted only when
 * the open db is (kernel-resolved) the live mc.db.
 *
 * vitest diverts the mirror (VITEST is set), so these tests strip VITEST and
 * JARVIS_KB_MIRROR_DIR inside SYNCHRONOUS windows only, and every writer call
 * passes an explicit temp target: nothing here can name the real KB or mc.db.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase } from "./index.js";
import {
  getKbMirrorWriteDir,
  isLiveDatabaseFile,
  mirrorToDisk,
  resolveMirrorWriteDir,
  syncDeleteFromKbMirror,
  type KbMirrorTarget,
} from "./jarvis-fs.js";

let root: string;
let liveDb: string; // stands in for data/mc.db
let scratchDb: string;
let snapshotDb: string;
let liveLink: string;
let kbDir: string; // stands in for the default mirror dir

/** Run `fn` as a non-vitest process with no mirror override, then restore. */
function outsideVitest<T>(fn: () => T): T {
  const saved = {
    VITEST: process.env.VITEST,
    JARVIS_KB_MIRROR_DIR: process.env.JARVIS_KB_MIRROR_DIR,
  };
  delete process.env.VITEST;
  delete process.env.JARVIS_KB_MIRROR_DIR;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kb-mirror-gate-"));
  mkdirSync(join(root, "live", "data"), { recursive: true });
  liveDb = join(root, "live", "data", "mc.db");
  writeFileSync(liveDb, "");
  scratchDb = join(root, "scratch", "synth.db");
  mkdirSync(join(root, "scratch"));
  writeFileSync(scratchDb, "");
  snapshotDb = join(root, "eval-gate-snap", "mc.db");
  mkdirSync(join(root, "eval-gate-snap"));
  copyFileSync(liveDb, snapshotDb); // VACUUM INTO equivalent: a new inode
  liveLink = join(root, "link-to-live.db");
  symlinkSync(liveDb, liveLink);
  kbDir = join(root, "kb");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isLiveDatabaseFile", () => {
  it("live db path → live", () => {
    expect(isLiveDatabaseFile(liveDb, liveDb)).toBe(true);
  });
  it("scratch db → not live", () => {
    expect(isLiveDatabaseFile(scratchDb, liveDb)).toBe(false);
  });
  it("symlink to the live db → live (either side)", () => {
    expect(isLiveDatabaseFile(liveLink, liveDb)).toBe(true);
    expect(isLiveDatabaseFile(liveDb, liveLink)).toBe(true);
  });
  it("non-canonical spelling of the live path → live", () => {
    const spelled = `${root}/live/data/../data/./mc.db`; // join() would normalise
    expect(isLiveDatabaseFile(spelled, liveDb)).toBe(true);
  });
  it("snapshot copy in tmp → not live", () => {
    expect(isLiveDatabaseFile(snapshotDb, liveDb)).toBe(false);
  });
  it("memory/temp db (empty file name) and missing files → not live", () => {
    expect(isLiveDatabaseFile("", liveDb)).toBe(false);
    expect(isLiveDatabaseFile(join(root, "nope.db"), liveDb)).toBe(false);
    expect(isLiveDatabaseFile(liveDb, join(root, "nope.db"))).toBe(false);
  });
});

describe("resolveMirrorWriteDir (pure)", () => {
  const target = (): KbMirrorTarget => ({ defaultDir: kbDir, liveDbPath: liveDb });

  it("no env + live db → default dir", () => {
    expect(resolveMirrorWriteDir({}, () => liveDb, target())).toBe(kbDir);
  });
  it("no env + symlink to live db → default dir", () => {
    expect(resolveMirrorWriteDir({}, () => liveLink, target())).toBe(kbDir);
  });
  it("no env + scratch db → disabled", () => {
    expect(resolveMirrorWriteDir({}, () => scratchDb, target())).toBeNull();
  });
  it("no env + eval-gate snapshot → disabled", () => {
    expect(resolveMirrorWriteDir({}, () => snapshotDb, target())).toBeNull();
  });
  it("no env + no db / :memory: → disabled", () => {
    expect(resolveMirrorWriteDir({}, () => "", target())).toBeNull();
  });
  it("explicit JARVIS_KB_MIRROR_DIR is honoured for any db, without consulting it", () => {
    const openDb = vi.fn(() => scratchDb);
    const env = { JARVIS_KB_MIRROR_DIR: "/x/explicit" };
    expect(resolveMirrorWriteDir(env, openDb, target())).toBe("/x/explicit");
    expect(resolveMirrorWriteDir(env, () => liveDb, target())).toBe("/x/explicit");
    expect(openDb).not.toHaveBeenCalled();
  });
  it("vitest branch unchanged: VITEST → the throwaway dir, never the default", () => {
    const env = { VITEST: "true", JARVIS_KB_VITEST_FALLBACK: "/x/vitest" };
    expect(resolveMirrorWriteDir(env, () => liveDb, target())).toBe("/x/vitest");
  });
});

describe("writers outside vitest (real open db, temp target)", () => {
  const seedFile = join("directives", "core.md");

  function resetKb(): void {
    rmSync(kbDir, { recursive: true, force: true });
    mkdirSync(join(kbDir, "directives"), { recursive: true });
    writeFileSync(join(kbDir, seedFile), "ORIGINAL");
  }

  describe("open db = scratch", () => {
    beforeAll(() => {
      closeDatabase();
      initDatabase(scratchDb);
    });
    afterAll(() => closeDatabase());

    it("mirrorToDisk neither overwrites nor creates under the default dir", () => {
      resetKb();
      const target = { defaultDir: kbDir, liveDbPath: liveDb };
      outsideVitest(() => {
        mirrorToDisk(seedFile, "SEED TEXT", target);
        mirrorToDisk("INDEX.md", "349-byte index", target);
      });
      expect(readFileSync(join(kbDir, seedFile), "utf8")).toBe("ORIGINAL");
      expect(existsSync(join(kbDir, "INDEX.md"))).toBe(false);
    });

    it("syncDeleteFromKbMirror deletes nothing under the default dir", () => {
      resetKb();
      const target = { defaultDir: kbDir, liveDbPath: liveDb };
      outsideVitest(() => syncDeleteFromKbMirror(seedFile, target));
      expect(existsSync(join(kbDir, seedFile))).toBe(true);
    });

    it("the production wrapper (live target) resolves to disabled", () => {
      expect(outsideVitest(() => getKbMirrorWriteDir())).toBeNull();
    });
  });

  describe("open db = the live db", () => {
    beforeAll(() => {
      closeDatabase();
      initDatabase(scratchDb);
    });
    afterAll(() => closeDatabase());

    it("mirrorToDisk writes and syncDeleteFromKbMirror deletes", () => {
      resetKb();
      // The open db IS the target's live db.
      const target = { defaultDir: kbDir, liveDbPath: scratchDb };
      outsideVitest(() => mirrorToDisk(seedFile, "UPDATED", target));
      expect(readFileSync(join(kbDir, seedFile), "utf8")).toBe("UPDATED");
      outsideVitest(() => syncDeleteFromKbMirror(seedFile, target));
      expect(existsSync(join(kbDir, seedFile))).toBe(false);
    });

    it("live db reached through a symlink still mirrors", () => {
      resetKb();
      const link = join(root, "link-to-open.db");
      if (!existsSync(link)) symlinkSync(scratchDb, link);
      const target = { defaultDir: kbDir, liveDbPath: link };
      outsideVitest(() => mirrorToDisk(seedFile, "VIA LINK", target));
      expect(readFileSync(join(kbDir, seedFile), "utf8")).toBe("VIA LINK");
    });
  });
});

describe("disabled notice", () => {
  it("logs one line per process, however many writes are refused", async () => {
    vi.resetModules();
    // Fresh module graph: no db open there → not the live db.
    const fresh = await import("./jarvis-fs.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetKbOnce();
      const target = { defaultDir: kbDir, liveDbPath: liveDb };
      outsideVitest(() => {
        fresh.mirrorToDisk("a.md", "x", target);
        fresh.mirrorToDisk("b.md", "y", target);
        fresh.syncDeleteFromKbMirror("c.md", target);
      });
      const lines = warn.mock.calls.filter((c) =>
        String(c[0]).includes("KB mirror DISABLED"),
      );
      expect(lines).toHaveLength(1);
      expect(existsSync(join(kbDir, "a.md"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  function resetKbOnce(): void {
    rmSync(kbDir, { recursive: true, force: true });
    mkdirSync(kbDir, { recursive: true });
  }
});
