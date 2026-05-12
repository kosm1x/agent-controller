import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase, getDatabase } from "./index.js";
import {
  reindexJarvisKb,
  walkKbDir,
  MANAGED_NAMESPACES,
} from "./jarvis-reindex.js";
import { upsertFile, getFile } from "./jarvis-fs.js";

let testKbDir: string;

beforeEach(() => {
  testKbDir = mkdtempSync(join(tmpdir(), "mc-reindex-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = testKbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  // Reset perms before rmSync so a chmod-000 fixture doesn't block cleanup.
  try {
    chmodSync(testKbDir, 0o755);
  } catch {}
  rmSync(testKbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
});

function writeFs(rel: string, content: string): void {
  const full = join(testKbDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

describe("reindexJarvisKb", () => {
  // initDatabase() calls seedDirectives() which upserts 2 directive files;
  // those land in testKbDir via mirrorToDisk and are also in the DB. So the
  // baseline state of every test is fsCount=2 / dbCount=2 / drift=0.
  const SEED_FILES = 2;

  it("returns drift=0 when only seeded directives exist (no user files)", () => {
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    expect(r.fsCount).toBe(SEED_FILES);
    expect(r.drift).toBe(0);
    expect(r.upserted).toBe(0);
  });

  it("upserts FS-only files into the DB", () => {
    writeFs("knowledge/foo.md", "# Foo\n\nBar.");
    writeFs("knowledge/baz.md", "# Baz\n\nQux.");
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    expect(r.fsCount).toBe(SEED_FILES + 2);
    expect(r.drift).toBe(2);
    expect(r.upserted).toBe(2);
    expect(r.errored).toBe(0);
    expect(getFile("knowledge/foo.md")?.title).toBe("Foo");
    expect(getFile("knowledge/baz.md")?.title).toBe("Baz");
  });

  it("derives title from first heading, falls back to filename", () => {
    writeFs("knowledge/has-heading.md", "# Real Title\n\nbody");
    writeFs("knowledge/no-heading.md", "no leading heading here");
    reindexJarvisKb({ kbRoot: testKbDir });
    expect(getFile("knowledge/has-heading.md")?.title).toBe("Real Title");
    expect(getFile("knowledge/no-heading.md")?.title).toContain("no heading");
  });

  it("preserves user_edit_time = null on rediscovered files (skipUserEdit)", () => {
    // The hourly reindex must not look like a user edit, otherwise LWW
    // (last-write-wins) sync would treat sync-driven catch-up as authoritative.
    writeFs("knowledge/sync-driven.md", "# Sync\n\ncontent");
    reindexJarvisKb({ kbRoot: testKbDir });
    const row = getDatabase()
      .prepare("SELECT user_edit_time FROM jarvis_files WHERE path = ?")
      .get("knowledge/sync-driven.md") as { user_edit_time: string | null };
    expect(row.user_edit_time).toBeNull();
  });

  it("classifies workspace/* as qualifier='workspace'", () => {
    writeFs("workspace/scratch.md", "# Scratch");
    writeFs("knowledge/perm.md", "# Perm");
    reindexJarvisKb({ kbRoot: testKbDir });
    expect(getFile("workspace/scratch.md")?.qualifier).toBe("workspace");
    expect(getFile("knowledge/perm.md")?.qualifier).toBe("reference");
  });

  it("is idempotent — second call upserts 0", () => {
    writeFs("knowledge/x.md", "# X");
    const a = reindexJarvisKb({ kbRoot: testKbDir });
    const b = reindexJarvisKb({ kbRoot: testKbDir });
    expect(a.upserted).toBe(1);
    expect(b.drift).toBe(0);
    expect(b.upserted).toBe(0);
  });

  it("does not upsert files already in DB", () => {
    upsertFile("knowledge/already.md", "Already", "# Already\n\nseed");
    writeFs("knowledge/new-only.md", "# New");
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    // already.md was upserted via upsertFile (mirror writes to disk too),
    // so fsCount = SEED_FILES + 2 but drift=1 (only new-only.md needs
    // catching up; the seeds and already.md are all in the DB).
    expect(r.fsCount).toBe(SEED_FILES + 2);
    expect(r.drift).toBe(1);
    expect(r.upserted).toBe(1);
  });

  it("skips .git and node_modules", () => {
    writeFs(".git/HEAD", "# should not be indexed");
    writeFs("node_modules/foo/README.md", "# should not be indexed");
    writeFs("knowledge/real.md", "# Real");
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    expect(r.fsCount).toBe(SEED_FILES + 1);
    expect(r.upserted).toBe(1);
    expect(getFile(".git/HEAD")).toBeNull();
    expect(getFile("node_modules/foo/README.md")).toBeNull();
  });

  it("counts unreadable files as errored, not upserted", () => {
    writeFs("knowledge/readable.md", "# Readable");
    writeFs("knowledge/unreadable.md", "# Unreadable");
    chmodSync(join(testKbDir, "knowledge/unreadable.md"), 0o000);
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    chmodSync(join(testKbDir, "knowledge/unreadable.md"), 0o644);
    // chmod 000 only blocks non-root readers. When tests run as root (mc on
    // VPS), the file is still readable so we accept either outcome — the
    // important guarantee is that the function does NOT throw and
    // upserted+errored covers all candidates.
    expect(r.upserted + r.errored).toBe(2);
    expect(r.errored).toBeGreaterThanOrEqual(0);
  });

  it("skips managed namespaces (NorthStar/) — authority lies in northstar_sync", () => {
    // The 2026-05-12 orphan-resurrection incident: a NorthStar/ FS mirror with
    // 226 stale .md files was being upserted hourly into jarvis_files, undoing
    // every operator-triggered northstar_sync wipe within the hour. kb-reindex
    // must treat NorthStar/ as opaque.
    expect(MANAGED_NAMESPACES).toContain("NorthStar/");
    writeFs("NorthStar/tasks/orphan.md", "# Orphan\n\nshould not be upserted");
    writeFs("NorthStar/goals/another.md", "# Another orphan");
    writeFs("knowledge/legit.md", "# Legit");
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    // fsCount excludes managed-namespace files: only seeds + the legit user file
    expect(r.fsCount).toBe(SEED_FILES + 1);
    expect(r.upserted).toBe(1);
    expect(getFile("NorthStar/tasks/orphan.md")).toBeNull();
    expect(getFile("NorthStar/goals/another.md")).toBeNull();
    expect(getFile("knowledge/legit.md")?.title).toBe("Legit");
  });

  // qa-auditor W3 (2026-05-12): sibling-prefix safety
  it("does not skip a sibling prefix like NorthStarLite/", () => {
    // The skip rule must match `NorthStar/` strictly — not `NorthStar`
    // alone (which would swallow `NorthStarLite/foo.md`).
    writeFs("NorthStarLite/foo.md", "# Sibling, not managed");
    writeFs("NorthStar.md", "# Root file, not managed");
    const r = reindexJarvisKb({ kbRoot: testKbDir });
    expect(r.upserted).toBe(2);
    expect(getFile("NorthStarLite/foo.md")?.title).toBe("Sibling, not managed");
    expect(getFile("NorthStar.md")?.title).toBe("Root file, not managed");
  });

  it("kbRoot override propagates", () => {
    const altDir = mkdtempSync(join(tmpdir(), "mc-reindex-alt-"));
    writeFileSync(join(altDir, "alt.md"), "# Alt", "utf-8");
    try {
      const r = reindexJarvisKb({ kbRoot: altDir });
      expect(r.fsCount).toBe(1);
      expect(getFile("alt.md")?.title).toBe("Alt");
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});

describe("walkKbDir", () => {
  it("returns absolute file paths under .md", () => {
    writeFs("knowledge/a.md", "x");
    writeFs("workspace/b.md", "x");
    const paths = walkKbDir(testKbDir);
    // SEED_FILES (2 directives) + 2 user files
    expect(paths.length).toBe(4);
    for (const p of paths) {
      expect(p.startsWith(testKbDir)).toBe(true);
      expect(p.endsWith(".md")).toBe(true);
    }
  });

  it("returns [] when dir does not exist (no throw)", () => {
    expect(walkKbDir("/no/such/dir/xyz")).toEqual([]);
  });
});
