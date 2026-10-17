/**
 * Operator script: Drive orphan reconcile (queue 3z prerequisite P1).
 * Pure selection + flag validation, the run with injected effects (no Google),
 * and the SQL deps on a throwaway in-memory db. Synthetic paths only.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import {
  APPLY_LIMIT_MAX,
  buildMainDeps,
  dbDeps,
  parseFlags,
  runReconcile,
  selectOrphans,
  validateApplyFlags,
  validateFlags,
  type Orphan,
  type RunDeps,
} from "./reconcile-kb-drive.js";

const rows: Orphan[] = [
  "/tmp/junk-a.md",
  "/tmp/junk-b.md",
  "a/fixture.md",
  "knowledge/execution-patterns/2026-05-01-x.md",
  "knowledge/execution-patterns/2026-05-02-y.md",
  "knowledge/execution-patterns/2026-06-01-z.md",
  "p/fixture.md",
  "root/tmp/junk.md",
  "workspace/a.md",
  "workspace/b.md",
  "workspace/c.md",
  "zz/inner/root/x.md",
].map((path, i) => ({ path, drive_id: `id${i}` }));

const paths = (o: { selected: Orphan[] }) => o.selected.map((r) => r.path);

describe("selectOrphans", () => {
  it("prefix is a case-sensitive startsWith, not a substring", () => {
    expect(paths(selectOrphans(rows, { prefix: "root/" }))).toEqual(["root/tmp/junk.md"]);
    expect(paths(selectOrphans(rows, { prefix: "p/" }))).toEqual(["p/fixture.md"]);
    expect(paths(selectOrphans(rows, { prefix: "a/" }))).toEqual(["a/fixture.md"]);
    expect(selectOrphans(rows, { prefix: "/" }).matched).toBe(2);
    expect(selectOrphans(rows, { prefix: "Workspace/" }).matched).toBe(0);
  });

  it("a month prefix selects only that month", () => {
    expect(paths(selectOrphans(rows, { prefix: "knowledge/execution-patterns/2026-05" }))).toEqual([
      "knowledge/execution-patterns/2026-05-01-x.md",
      "knowledge/execution-patterns/2026-05-02-y.md",
    ]);
  });

  it("limit caps the selection; matched still counts every hit", () => {
    const r = selectOrphans(rows, { prefix: "workspace/", limit: 2 });
    expect(r.matched).toBe(3);
    expect(paths(r)).toEqual(["workspace/a.md", "workspace/b.md"]);
  });

  it("limit above the hit count returns every hit", () => {
    const r = selectOrphans(rows, { prefix: "/", limit: 10 });
    expect(r.matched).toBe(2);
    expect(r.selected).toHaveLength(2);
  });

  it("no prefix or an empty prefix matches all (dry-run overview)", () => {
    expect(selectOrphans(rows, {}).matched).toBe(rows.length);
    expect(selectOrphans(rows, { prefix: "" }).selected).toHaveLength(rows.length);
  });

  it("a prefix with no hits selects nothing", () => {
    expect(selectOrphans(rows, { prefix: "nope/", limit: 10 })).toEqual({ matched: 0, selected: [] });
  });
});

describe("validateApplyFlags", () => {
  it.each([
    ["no prefix", { limit: 10 }],
    ["empty prefix", { prefix: "", limit: 10 }],
    ["no limit", { prefix: "/" }],
    ["limit 301", { prefix: "/", limit: 301 }],
    ["limit 0", { prefix: "/", limit: 0 }],
    ["limit NaN", { prefix: "/", limit: Number.NaN }],
    ["limit -1", { prefix: "/", limit: -1 }],
    ["limit 2.5", { prefix: "/", limit: 2.5 }],
  ])("refuses: %s", (_n, f) => {
    expect(validateApplyFlags(f)).toMatch(/--prefix|--limit/);
  });

  it("says which flag is missing", () => {
    expect(validateApplyFlags({ limit: 10 })).toMatch(/needs a non-empty --prefix/);
    expect(validateApplyFlags({ prefix: "/" })).toMatch(/needs --limit/);
  });

  it("accepts limit 300 with a prefix", () => {
    expect(APPLY_LIMIT_MAX).toBe(300);
    expect(validateApplyFlags({ prefix: "workspace/", limit: 300 })).toBeNull();
    expect(validateApplyFlags({ prefix: "/", limit: 1 })).toBeNull();
  });
});

describe("parseFlags + validateFlags (the CLI gate)", () => {
  const check = (argv: string[]) => validateFlags(parseFlags(argv));

  it("dry run with no flags is allowed (overview)", () => {
    expect(parseFlags([])).toEqual({ apply: false, unknown: [] });
    expect(check([])).toBeNull();
  });

  it("dry run with prefix and limit parses and is allowed", () => {
    expect(parseFlags(["--prefix=/", "--limit=10"])).toEqual({ apply: false, prefix: "/", limit: 10, unknown: [] });
    expect(check(["--prefix=/", "--limit=10"])).toBeNull();
    expect(check(["--prefix=workspace/", "--limit=1000"])).toBeNull(); // cap is apply-only
  });

  it("an empty prefix is allowed only in dry run", () => {
    expect(check(["--prefix="])).toBeNull();
    expect(check(["--prefix=", "--limit=10", "--apply"])).toMatch(/--prefix/);
  });

  it("--apply alone (the old full-Drive run) is refused", () => {
    expect(check(["--apply"])).toMatch(/--prefix/);
  });

  it("--apply refusals by flag", () => {
    expect(check(["--apply", "--limit=10"])).toMatch(/--prefix/);
    expect(check(["--apply", "--prefix=/"])).toMatch(/--limit/);
    expect(check(["--apply", "--prefix=/", "--limit=301"])).toMatch(/--limit/);
    expect(check(["--apply", "--prefix=/", "--limit=0"])).toMatch(/--limit/);
    expect(check(["--apply", "--prefix=/", "--limit=abc"])).toMatch(/--limit/);
    expect(check(["--apply", "--prefix=/", "--limit="])).toMatch(/--limit/);
  });

  it("--apply with prefix and limit ≤ 300 is accepted", () => {
    expect(check(["--prefix=/", "--limit=10", "--apply"])).toBeNull();
    expect(check(["--apply", "--prefix=workspace/", "--limit=300"])).toBeNull();
  });

  it("a malformed limit is refused in dry run too", () => {
    expect(check(["--limit=0"])).toMatch(/--limit/);
    expect(check(["--limit=x"])).toMatch(/--limit/);
  });

  it.each(["1e2", "0x12C", "300.0", " 10 ", "10 ", "+10", "-1", ""])(
    "--limit=%j is not digits-only → refused",
    (v) => {
      expect(Number.isNaN(parseFlags([`--limit=${v}`]).limit)).toBe(true);
      expect(check(["--apply", "--prefix=/", `--limit=${v}`])).toMatch(/--limit/);
    },
  );

  it("--limit digits parse to the number", () => {
    expect(parseFlags(["--limit=300"]).limit).toBe(300);
    expect(parseFlags(["--limit=010"]).limit).toBe(10);
  });

  it("unknown arguments (incl. the space form) are refused", () => {
    expect(check(["--prefix", "/"])).toMatch(/unknown/);
    expect(check(["--limt=10"])).toMatch(/unknown/);
  });
});

// ---------------------------------------------------------------------------
// runReconcile with injected effects: a fake map + KB, a fake Drive.
// ---------------------------------------------------------------------------

interface Fake {
  deps: RunDeps;
  map: Orphan[];
  kb: Set<string>;
  trashedIds: string[];
  dropped: Orphan[];
  lines: string[];
}

function fake(
  opts: {
    live?: boolean;
    kb?: string[];
    failIds?: string[];
    goneIds?: string[];
    revived?: string[];
    /** When trash() starts on `on`, add `path` to the KB synchronously, before its first await. */
    reviveDuring?: { on: string; path: string };
  } = {},
): Fake {
  const map = rows.map((r) => ({ ...r }));
  const kb = new Set(opts.kb ?? []);
  const revived = new Set(opts.revived ?? []);
  const f: Fake = { map, kb, trashedIds: [], dropped: [], lines: [], deps: undefined as unknown as RunDeps };
  f.deps = {
    listOrphans: () => map.filter((o) => !kb.has(o.path)).sort((a, b) => (a.path < b.path ? -1 : 1)),
    isLiveKbPath: (p) => kb.has(p) || revived.has(p),
    isLiveDb: () => opts.live ?? true,
    trash: async (o) => {
      if (opts.reviveDuring?.on === o.path) kb.add(opts.reviveDuring.path);
      await Promise.resolve();
      if (opts.failIds?.includes(o.drive_id)) throw new Error("HTTP 500 synthetic");
      f.trashedIds.push(o.drive_id);
      return opts.goneIds?.includes(o.drive_id) ? "gone" : "trashed";
    },
    drop: (o) => {
      f.dropped.push(o);
      const i = map.findIndex((m) => m.path === o.path && m.drive_id === o.drive_id);
      if (i >= 0) map.splice(i, 1);
    },
    log: (l) => f.lines.push(l),
    warn: (l) => f.lines.push(l),
  };
  return f;
}

const dryListed = (lines: string[]) =>
  lines.filter((l) => l.startsWith("  TRASH  ")).map((l) => l.slice("  TRASH  ".length));

describe("runReconcile", () => {
  it("apply trashes exactly the rows the same dry run lists", async () => {
    for (const flags of [
      { prefix: "workspace/", limit: 2 },
      { prefix: "/", limit: 10 },
      { prefix: "knowledge/execution-patterns/2026-05", limit: 300 },
    ]) {
      const dry = fake();
      const d = await runReconcile({ apply: false, unknown: [], ...flags }, dry.deps);
      expect(dry.trashedIds).toEqual([]);
      expect(dry.dropped).toEqual([]);
      const app = fake();
      const a = await runReconcile({ apply: true, unknown: [], ...flags }, app.deps);
      expect(a.exitCode).toBe(0);
      expect(app.dropped.map((o) => o.path).sort()).toEqual(dryListed(dry.lines).sort());
      expect(a.planned).toEqual(d.planned);
      expect(app.lines).toContain(`will trash: ${d.planned.length}`);
    }
  });

  it("a rerun with the same flags takes the next n", async () => {
    const f = fake();
    const flags = { apply: true, prefix: "workspace/", limit: 2, unknown: [] };
    const first = await runReconcile(flags, f.deps);
    expect(first.planned.map((o) => o.path)).toEqual(["workspace/a.md", "workspace/b.md"]);
    const second = await runReconcile(flags, f.deps);
    expect(second.planned.map((o) => o.path)).toEqual(["workspace/c.md"]);
    const third = await runReconcile(flags, f.deps);
    expect(third.planned).toEqual([]);
    expect(f.lines).toContain("will trash: 0");
  });

  it("after a partial apply only trashed + already-gone rows are dropped", async () => {
    const f = fake({ failIds: ["id9"], goneIds: ["id10"] }); // workspace/b.md fails, c.md is gone
    const r = await runReconcile({ apply: true, prefix: "workspace/", limit: 3, unknown: [] }, f.deps);
    expect(r).toMatchObject({ trashed: 1, gone: 1, failed: 1, skippedLive: 0 });
    expect(f.dropped.map((o) => o.path).sort()).toEqual(["workspace/a.md", "workspace/c.md"]);
    expect(f.map.some((o) => o.path === "workspace/b.md")).toBe(true); // the failure stays for a retry
    expect(f.lines.some((l) => l.includes("trashed=1  already-gone=1  skipped-live=0  failed=1"))).toBe(true);
    expect(f.lines.some((l) => l.startsWith("Drive orphans remaining under prefix: 1 "))).toBe(true);
  });

  it("drop gets the exact (path, drive_id) of the trashed row", async () => {
    const f = fake();
    await runReconcile({ apply: true, prefix: "p/", limit: 10, unknown: [] }, f.deps);
    expect(f.dropped).toEqual([{ path: "p/fixture.md", drive_id: "id6" }]);
    expect(f.trashedIds).toEqual(["id6"]);
  });

  it("a path re-created after the listing is skipped: no trash, no drop", async () => {
    const f = fake({ revived: ["workspace/b.md"] });
    const r = await runReconcile({ apply: true, prefix: "workspace/", limit: 10, unknown: [] }, f.deps);
    expect(r).toMatchObject({ trashed: 2, skippedLive: 1, failed: 0 });
    expect(f.trashedIds).not.toContain("id9");
    expect(f.dropped.map((o) => o.path)).not.toContain("workspace/b.md");
    expect(f.lines).toContain("  SKIP-LIVE workspace/b.md");
  });

  it("the live re-check runs per row: a path re-created mid-run is skipped", async () => {
    // workspace/c.md is an orphan at listing time; it is re-created while a.md is being trashed.
    const f = fake({ reviveDuring: { on: "workspace/a.md", path: "workspace/c.md" } });
    const r = await runReconcile({ apply: true, prefix: "workspace/", limit: 10, unknown: [] }, f.deps);
    expect(r.planned.map((o) => o.path)).toContain("workspace/c.md");
    expect(r).toMatchObject({ trashed: 2, skippedLive: 1, failed: 0 });
    expect(f.trashedIds).not.toContain("id10");
    expect(f.dropped.map((o) => o.path)).not.toContain("workspace/c.md");
    expect(f.lines).toContain("  SKIP-LIVE workspace/c.md");
  });

  it("apply refuses (exit 2) before any listing or trash when the db is not the live one", async () => {
    const f = fake({ live: false });
    let listed = 0;
    const list = f.deps.listOrphans;
    f.deps.listOrphans = () => (listed++, list());
    const r = await runReconcile({ apply: true, prefix: "/", limit: 10, unknown: [] }, f.deps);
    expect(r.exitCode).toBe(2);
    expect(listed).toBe(0);
    expect(f.trashedIds).toEqual([]);
    expect(f.dropped).toEqual([]);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toMatch(
      /REFUSED: --apply needs the live db: the open db is not \/root\/claude\/mission-control\/data\/mc\.db \(run from the repo root; leave MC_DB_PATH unset\)/,
    );
  });

  it("the dry run is allowed on a non-live db (read only)", async () => {
    const f = fake({ live: false });
    const r = await runReconcile({ apply: false, prefix: "/", limit: 10, unknown: [] }, f.deps);
    expect(r.exitCode).toBe(0);
    expect(dryListed(f.lines)).toEqual(["/tmp/junk-a.md", "/tmp/junk-b.md"]);
  });

  it("prints prefix, limit, matched before acting; 0 matches exits 0", async () => {
    const f = fake();
    const r = await runReconcile({ apply: true, prefix: "nope/", limit: 10, unknown: [] }, f.deps);
    expect(r.exitCode).toBe(0);
    expect(f.lines).toEqual(expect.arrayContaining(['prefix:  "nope/"', "limit:   10", "matched: 0", "will trash: 0"]));
    expect(f.trashedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dbDeps: the SQL against a throwaway in-memory db (never the live one).
// ---------------------------------------------------------------------------

/** Same shape as ensureMapTable() in src/db/drive-sync.ts. */
const MAP_DDL = `CREATE TABLE IF NOT EXISTS drive_file_map (
  path TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
)`;

describe("dbDeps", () => {
  function mem() {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE jarvis_files (path TEXT PRIMARY KEY); ${MAP_DDL}`);
    const ins = db.prepare("INSERT INTO drive_file_map (path, drive_id) VALUES (?, ?)");
    for (const [p, id] of [["workspace/b.md", "B"], ["workspace/a.md", "A"], ["live.md", "L"]]) ins.run(p, id);
    db.prepare("INSERT INTO jarvis_files VALUES (?)").run("live.md");
    return db;
  }

  it("lists orphans only, in path order", () => {
    const db = mem();
    expect(dbDeps(db).listOrphans()).toEqual([
      { path: "workspace/a.md", drive_id: "A" },
      { path: "workspace/b.md", drive_id: "B" },
    ]);
    db.close();
  });

  it("isLiveKbPath sees a path re-created after the listing", () => {
    const db = mem();
    const d = dbDeps(db);
    expect(d.isLiveKbPath("workspace/a.md")).toBe(false);
    db.prepare("INSERT INTO jarvis_files VALUES (?)").run("workspace/a.md");
    expect(d.isLiveKbPath("workspace/a.md")).toBe(true);
    db.close();
  });

  it("drop deletes only the matching (path, drive_id) row", () => {
    const db = mem();
    const d = dbDeps(db);
    const listed = d.listOrphans()[0]; // { workspace/a.md, A }
    db.prepare("UPDATE drive_file_map SET drive_id = ? WHERE path = ?").run("A2", "workspace/a.md"); // re-synced as a new Drive file
    d.drop(listed);
    expect(db.prepare("SELECT drive_id FROM drive_file_map WHERE path = ?").all("workspace/a.md")).toEqual([
      { drive_id: "A2" },
    ]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// buildMainDeps: the deps main() runs with. initDatabase(":memory:") is the same
// path main() takes (initDatabase(DB_PATH)) with a db that is not the live file.
// ---------------------------------------------------------------------------

describe("buildMainDeps", () => {
  it("isLiveDb is false on an in-memory db, so --apply is refused there", async () => {
    initDatabase(":memory:");
    try {
      getDatabase().exec(MAP_DDL); // drive-sync creates the map table lazily (ensureMapTable)
      const deps = buildMainDeps(getDatabase());
      expect(deps.isLiveDb()).toBe(false);
      const lines: string[] = [];
      const r = await runReconcile(
        { apply: true, prefix: "/", limit: 10, unknown: [] },
        { ...deps, log: (l) => lines.push(l), warn: (l) => lines.push(l) },
      );
      expect(r.exitCode).toBe(2);
      expect(lines).toHaveLength(1);
    } finally {
      closeDatabase();
    }
  });
});
