/**
 * Operator script: trash stale Drive copies of INDEX.md. Synthetic fixtures only:
 * a fake Drive behind the injected fetch, drive_file_map rows from an in-memory
 * sqlite db. googleFetch and the operator gate are mocked to throw, so importing
 * the script must not run it and no test reaches Google.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/operator-gate.js", () => ({
  requireOperatorContext: () => {
    gate.calls++;
    throw new Error("trash-drive-index-copies main ran on import");
  },
}));
vi.mock("../src/google/client.js", () => ({
  googleFetch: () => {
    throw new Error("real googleFetch called from a test");
  },
}));

import {
  MAX_CONSECUTIVE_FAILURES,
  PAUSE_MS,
  main,
  parseFlags,
  readMapRows,
  run,
  selectStale,
  trashAll,
  type Flags,
  type Located,
  type RunDeps,
} from "./trash-drive-index-copies.js";
import { DRIVE_FILES, OUTSIDE, type DriveFile } from "./lib/drive-index-lookup.js";

const ROOT = "kb-root";
const NOW = Date.parse("2026-11-05T00:00:00Z");
const DAY = 86_400_000;
const OLD = "2026-06-01T00:00:00Z";
const iso = (ms: number) => new Date(ms).toISOString();

/** Folder id → node; a missing id is a 404, `err-folder` is a 500. */
const FOLDERS: Record<string, { id: string; name: string; parents?: string[] }> = {
  "ns-folder": { id: "ns-folder", name: "NorthStar", parents: [ROOT] },
  "knowledge-folder": { id: "knowledge-folder", name: "knowledge", parents: [ROOT] },
  "rumi-folder": { id: "rumi-folder", name: "Rumi", parents: ["knowledge-folder"] },
};

const file = (id: string, parent: string, modifiedTime = OLD, extra: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name: "INDEX.md",
  mimeType: "text/markdown",
  createdTime: modifiedTime,
  modifiedTime,
  size: "673",
  parents: [parent],
  ...extra,
});

function fixtureFiles(): DriveFile[] {
  return [
    file("live-root", ROOT),
    file("live-rumi", "rumi-folder"),
    file("stale-1", ROOT, "2026-05-23T00:00:00Z"),
    file("stale-2", ROOT, "2026-09-23T00:00:00Z"),
    file("stale-ns", "ns-folder", "2026-04-03T00:00:00Z"),
    file("elsewhere", "rumi-folder"),
    file("outside", "outside-folder"),
    file("unknown", "err-folder"),
    file("recent", ROOT, iso(NOW - DAY)),
  ];
}

const MAP_ROWS = [
  { path: "INDEX.md", drive_id: "live-root" },
  { path: "knowledge/Rumi/INDEX.md", drive_id: "live-rumi" },
  { path: "knowledge/other.md", drive_id: "unrelated" },
];

interface Call {
  url: string;
  init?: { method?: string; body?: unknown };
}

/** Fake Drive. `failPatch(id)` decides which PATCH calls fail. */
function fakeDrive(opts: {
  files?: DriveFile[];
  pages?: number;
  /** 0-based pages that carry `incompleteSearch: true`. */
  incompletePages?: number[];
  listError?: boolean;
  failPatch?: (id: string) => boolean;
}) {
  const calls: Call[] = [];
  const files = opts.files ?? fixtureFiles();
  const pages = opts.pages ?? 1;
  const per = Math.ceil(files.length / pages);
  const fetch = async <T,>(url: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    calls.push({ url, init });
    if (init?.method && init.method !== "GET") {
      const id = decodeURIComponent(url.slice(`${DRIVE_FILES}/`.length));
      if (opts.failPatch?.(id)) throw new Error(`Google API 403: rate limit for ${id}`);
      return { id } as T;
    }
    if (url.startsWith(`${DRIVE_FILES}?q=`)) {
      if (opts.listError) throw new Error("Google API 500: backend error");
      const tok = /pageToken=(\d+)/.exec(url)?.[1];
      const page = tok ? Number(tok) : 0;
      return {
        files: files.slice(page * per, (page + 1) * per),
        nextPageToken: page + 1 < pages ? String(page + 1) : undefined,
        incompleteSearch: opts.incompletePages?.includes(page) ? true : undefined,
      } as T;
    }
    const id = url.slice(`${DRIVE_FILES}/`.length).split("?")[0]!;
    if (id === "err-folder") throw new Error("Google API 500: oops");
    const node = FOLDERS[id];
    if (!node) throw new Error("Google API 404: not found");
    return node as T;
  };
  return { fetch, calls };
}

function memDbRows(rows: Array<{ path: string; drive_id: string }>) {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE drive_file_map (path TEXT PRIMARY KEY, drive_id TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))",
  );
  const ins = db.prepare("INSERT INTO drive_file_map (path, drive_id) VALUES (?, ?)");
  for (const r of rows) ins.run(r.path, r.drive_id);
  const out = readMapRows(db);
  db.close();
  return out;
}

function makeDeps(drive: ReturnType<typeof fakeDrive>, over: Partial<RunDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const logLines: Array<{ path: string; line: string }> = [];
  const sleeps: number[] = [];
  const rows = memDbRows(MAP_ROWS);
  const deps: RunDeps = {
    fetch: drive.fetch,
    dbPath: "/scratch/mc.db",
    rootFolderId: ROOT,
    mapRows: () => rows,
    appendLog: (path, line) => logLines.push({ path, line }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { deps, out, err, logLines, sleeps };
}

const flags = (f: Partial<Flags> = {}): Flags => ({ apply: false, olderThanDays: 30, ...f });
const patches = (calls: Call[]) => calls.filter((c) => c.init?.method !== undefined && c.init.method !== "GET");
const patchedIds = (calls: Call[]) => patches(calls).map((c) => decodeURIComponent(c.url.slice(`${DRIVE_FILES}/`.length)));

beforeEach(() => {
  gate.calls = 0;
});

describe("module import", () => {
  it("does not run main or the operator gate on import", () => {
    expect(gate.calls).toBe(0);
  });
});

describe("parseFlags", () => {
  it("defaults to a dry run with a 30-day age guard", () => {
    expect(parseFlags([])).toEqual({ apply: false, olderThanDays: 30 });
  });
  it("refuses --apply without --log", () => {
    expect(parseFlags(["--apply"])).toEqual({ error: expect.stringContaining("--log") });
    expect(parseFlags(["--apply", "--log="])).toEqual({ error: expect.stringContaining("--log") });
    expect(parseFlags(["--apply", "--log=/x/run.log", "--limit=3"])).toEqual({
      apply: true,
      log: "/x/run.log",
      limit: 3,
      olderThanDays: 30,
    });
  });
  it("refuses unknown args and non-positive numbers", () => {
    expect(parseFlags(["--force"])).toHaveProperty("error");
    expect(parseFlags(["--limit=0"])).toHaveProperty("error");
    expect(parseFlags(["--limit=-1"])).toHaveProperty("error");
    expect(parseFlags(["--older-than-days=1.5"])).toHaveProperty("error");
    expect(parseFlags(["--older-than-days=7"])).toEqual({ apply: false, olderThanDays: 7 });
  });
});

describe("selectStale", () => {
  const loc = (id: string, location: string, modifiedTime = OLD, extra: Partial<Located> = {}): Located => ({
    ...file(id, "p", modifiedTime),
    location,
    ...extra,
  });
  const sel = (files: Located[], mapped: string[] = [], olderThanDays = 30) =>
    selectStale(files, new Set(mapped), { nowMs: NOW, olderThanDays });
  const reasons = (r: ReturnType<typeof sel>) => Object.fromEntries(r.skipped.map((s) => [s.file.id, s.reason]));

  it("never selects a mapped id, wherever it lives", () => {
    const r = sel([loc("a", "."), loc("b", "NorthStar"), loc("c", ".")], ["a", "b"]);
    expect(r.eligible.map((f) => f.id)).toEqual(["c"]);
    expect(reasons(r)).toEqual({ a: "mapped", b: "mapped" });
  });

  it("allows only the KB root and NorthStar", () => {
    const r = sel([
      loc("root", "."),
      loc("ns", "NorthStar"),
      loc("rumi", "knowledge/Rumi"),
      loc("nested-ns", "knowledge/NorthStar"),
      loc("ns-child", "NorthStar/sub"),
    ]);
    expect(r.eligible.map((f) => f.id)).toEqual(["root", "ns"]);
    expect(reasons(r)).toEqual({ rumi: "location", "nested-ns": "location", "ns-child": "location" });
  });

  it("skips files outside the KB folder or with an unresolved parent", () => {
    const r = sel([loc("out", OUTSIDE), loc("unk", "UNKNOWN (500)")]);
    expect(r.eligible).toEqual([]);
    expect(reasons(r)).toEqual({ out: "outside-kb", unk: "unknown-parent" });
  });

  it("age guard: strictly older than the cutoff is eligible, at or after it is not", () => {
    const cutoff = NOW - 30 * DAY;
    const r = sel([
      loc("older", ".", iso(cutoff - 1)),
      loc("exact", ".", iso(cutoff)),
      loc("newer", ".", iso(cutoff + 1)),
      loc("no-time", ".", OLD, { modifiedTime: undefined }),
      loc("bad-time", ".", "not a date"),
    ]);
    expect(r.eligible.map((f) => f.id)).toEqual(["older"]);
    expect(reasons(r)).toEqual({ exact: "age", newer: "age", "no-time": "age", "bad-time": "age" });
    // a shorter guard moves the boundary
    expect(sel([loc("d10", ".", iso(NOW - 10 * DAY))], [], 7).eligible).toHaveLength(1);
    expect(sel([loc("d10", ".", iso(NOW - 10 * DAY))], [], 30).eligible).toHaveLength(0);
  });

  it("selects only plain files: never a folder, shortcut, Google-native doc or missing mimeType", () => {
    const r = sel([
      loc("folder", ".", OLD, { mimeType: "application/vnd.google-apps.folder" }),
      loc("shortcut", ".", OLD, { mimeType: "application/vnd.google-apps.shortcut" }),
      loc("gdoc", "NorthStar", OLD, { mimeType: "application/vnd.google-apps.document" }),
      loc("no-mime", ".", OLD, { mimeType: undefined }),
      loc("empty-mime", ".", OLD, { mimeType: "" }),
      loc("md", ".", OLD, { mimeType: "text/markdown" }),
      loc("txt", "NorthStar", OLD, { mimeType: "text/plain" }),
    ]);
    expect(r.eligible.map((f) => f.id)).toEqual(["md", "txt"]);
    expect(reasons(r)).toEqual({
      folder: "not-a-file",
      shortcut: "not-a-file",
      gdoc: "not-a-file",
      "no-mime": "not-a-file",
      "empty-mime": "not-a-file",
    });
  });

  it("requires the exact name and a non-trashed file", () => {
    const r = sel([loc("lower", ".", OLD, { name: "index.md" }), loc("tr", ".", OLD, { trashed: true })]);
    expect(r.eligible).toEqual([]);
    expect(reasons(r)).toEqual({ lower: "name", tr: "trashed" });
  });
});

describe("run: refusals (exit 2, zero PATCH)", () => {
  it("refuses with an empty DRIVE_KB_FOLDER_ID before any db or Drive call", async () => {
    const drive = fakeDrive({});
    const mapRows = vi.fn(() => MAP_ROWS);
    const t = makeDeps(drive, { rootFolderId: "", mapRows });
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(2);
    expect(t.err[0]).toMatch(/REFUSED: DRIVE_KB_FOLDER_ID is empty/);
    expect(mapRows).not.toHaveBeenCalled();
    expect(drive.calls).toEqual([]);
  });

  it("refuses when drive_file_map has no row for INDEX.md (wrong or empty db)", async () => {
    for (const rows of [[], MAP_ROWS.filter((r) => r.path !== "INDEX.md")]) {
      const drive = fakeDrive({});
      const t = makeDeps(drive, { mapRows: () => memDbRows(rows) });
      expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(2);
      expect(t.err[0]).toMatch(/no row for path INDEX\.md/);
      expect(drive.calls).toEqual([]);
      expect(t.logLines).toEqual([]);
    }
  });

  it("refuses when the live INDEX.md id is not in the listing", async () => {
    const drive = fakeDrive({ files: fixtureFiles().filter((f) => f.id !== "live-root") });
    const t = makeDeps(drive);
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(2);
    expect(t.err[0]).toMatch(/live INDEX\.md .*\(live-root\) is not in the Drive listing/);
    expect(patches(drive.calls)).toEqual([]);
    expect(t.logLines).toEqual([]);
  });

  it("refuses when the map's INDEX.md id is some other id (db from elsewhere)", async () => {
    const drive = fakeDrive({});
    const t = makeDeps(drive, { mapRows: () => memDbRows([{ path: "INDEX.md", drive_id: "someone-else" }]) });
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(2);
    expect(patches(drive.calls)).toEqual([]);
  });

  it("refuses when the listing errors or Drive flags it incomplete", async () => {
    for (const opt of [{ listError: true }, { incompletePages: [2], pages: 3 }]) {
      const drive = fakeDrive(opt);
      const t = makeDeps(drive);
      expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(2);
      expect(t.err[0]).toMatch(/REFUSED: Drive (listing failed|reported the listing as incomplete)/);
      expect(patches(drive.calls)).toEqual([]);
      expect(t.logLines).toEqual([]);
    }
  });
});

describe("run: listing", () => {
  it("refuses when only page 1 of 3 is flagged incomplete (a later clean page does not clear it)", async () => {
    const drive = fakeDrive({ incompletePages: [0], pages: 3 });
    const t = makeDeps(drive);
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(2);
    expect(drive.calls.filter((c) => c.url.startsWith(`${DRIVE_FILES}?q=`))).toHaveLength(3);
    expect(t.err[0]).toMatch(/REFUSED: Drive reported the listing as incomplete/);
    expect(patches(drive.calls)).toEqual([]);
  });

  it("sends the exact query and fields string on every page", async () => {
    const drive = fakeDrive({ pages: 2 });
    await run(flags(), makeDeps(drive).deps);
    const lists = drive.calls.filter((c) => c.url.startsWith(`${DRIVE_FILES}?q=`));
    expect(lists).toHaveLength(2);
    for (const c of lists) {
      const u = new URL(c.url);
      expect(u.searchParams.get("q")).toBe("name = 'INDEX.md' and trashed = false");
      expect(u.searchParams.get("fields")).toBe(
        "nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,size,parents,trashed)",
      );
      expect(u.searchParams.get("pageSize")).toBe("100");
    }
    expect(new URL(lists[1]!.url).searchParams.get("pageToken")).toBe("1");
  });

  it("never PATCHes a folder, shortcut or Google doc named INDEX.md in the KB root", async () => {
    const extra = [
      file("folder", ROOT, OLD, { mimeType: "application/vnd.google-apps.folder" }),
      file("shortcut", ROOT, OLD, { mimeType: "application/vnd.google-apps.shortcut" }),
      file("gdoc", ROOT, OLD, { mimeType: "application/vnd.google-apps.document" }),
    ];
    const drive = fakeDrive({ files: [...fixtureFiles(), ...extra] });
    const t = makeDeps(drive);
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(0);
    expect(patchedIds(drive.calls)).toEqual(["stale-ns", "stale-1", "stale-2"]);
    expect(t.out.at(-1)).toMatch(/not-a-file=3/);
  });
});

describe("run: dry run", () => {
  it("lists the plan across pages, makes zero PATCH calls and writes no log", async () => {
    const drive = fakeDrive({ pages: 3 });
    const t = makeDeps(drive);
    expect(await run(flags(), t.deps)).toBe(0);
    expect(patches(drive.calls)).toEqual([]);
    expect(drive.calls.every((c) => c.init === undefined)).toBe(true);
    expect(t.logLines).toEqual([]);
    const planned = t.out.filter((l) => l.startsWith("would trash"));
    expect(planned.map((l) => l.split(/\s+/)[2])).toEqual(["stale-ns", "stale-1", "stale-2"]);
    expect(t.out[0]).toBe("database: /scratch/mc.db (3 drive_file_map rows, 3 distinct drive ids)");
    expect(t.out.at(-1)).toBe(
      "DRY RUN, nothing changed. db=/scratch/mc.db mapped-ids=3 listed=9 eligible=3 (by location: .=2 NorthStar=1) this-run=3; skipped: mapped=2 location=1 outside-kb=1 unknown-parent=1 age=1. Re-run with --apply --log=<path> to trash.",
    );
  });

  it("--limit caps the planned batch", async () => {
    const t = makeDeps(fakeDrive({}));
    await run(flags({ limit: 2 }), t.deps);
    expect(t.out.filter((l) => l.startsWith("would trash"))).toHaveLength(2);
    expect(t.out.at(-1)).toMatch(/eligible=3 \(by location: \.=2 NorthStar=1\) this-run=2/);
  });
});

describe("run: --apply", () => {
  it("trashes only the eligible files with PATCH {trashed:true}, logs each, never DELETE", async () => {
    const drive = fakeDrive({});
    const t = makeDeps(drive);
    expect(await run(flags({ apply: true, log: "/scratch/run.log" }), t.deps)).toBe(0);
    const p = patches(drive.calls);
    expect(patchedIds(drive.calls)).toEqual(["stale-ns", "stale-1", "stale-2"]);
    for (const c of p) {
      expect(c.init).toEqual({ method: "PATCH", body: { trashed: true } });
      expect(c.url).toMatch(new RegExp(`^${DRIVE_FILES}/[^?/]+$`));
    }
    expect(drive.calls.some((c) => c.init?.method === "DELETE" || /emptyTrash/.test(c.url))).toBe(false);
    expect(patchedIds(drive.calls)).not.toContain("live-root");
    expect(patchedIds(drive.calls)).not.toContain("live-rumi");
    expect(t.logLines.every((l) => l.path === "/scratch/run.log")).toBe(true);
    expect(t.logLines.map((l) => l.line)).toEqual([
      `# ${iso(NOW)} trash-drive-index-copies start: 3 file(s) to trash`,
      `${iso(NOW)} stale-ns trashed`,
      `${iso(NOW)} stale-1 trashed`,
      `${iso(NOW)} stale-2 trashed`,
    ]);
    expect(t.sleeps).toEqual([PAUSE_MS, PAUSE_MS]);
    expect(t.out.at(-1)).toBe(
      "Summary: db=/scratch/mc.db mapped-ids=3 listed=9 eligible=3 (by location: .=2 NorthStar=1) this-run=3 trashed=3 failed=0; skipped: mapped=2 location=1 outside-kb=1 unknown-parent=1 age=1.",
    );
  });

  it("--limit caps how many are trashed", async () => {
    const drive = fakeDrive({});
    const t = makeDeps(drive);
    await run(flags({ apply: true, log: "/l", limit: 1 }), t.deps);
    expect(patchedIds(drive.calls)).toEqual(["stale-ns"]);
  });

  it("a log that cannot be written refuses before any PATCH", async () => {
    const drive = fakeDrive({});
    const t = makeDeps(drive, {
      appendLog: () => {
        throw new Error("EACCES");
      },
    });
    expect(await run(flags({ apply: true, log: "/nope" }), t.deps)).toBe(2);
    expect(t.err[0]).toBe("[trash-drive-index-copies] REFUSED: cannot write --log=/nope: EACCES");
    expect(patches(drive.calls)).toEqual([]);
  });

  it("a log write failing after a successful PATCH stops at once, names the unlogged id, still prints the summary", async () => {
    const drive = fakeDrive({});
    let n = 0;
    const t = makeDeps(drive, {
      appendLog: () => {
        if (++n === 2) throw new Error("ENOSPC");
      },
    });
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(1);
    expect(patchedIds(drive.calls)).toEqual(["stale-ns"]);
    expect(t.err).toEqual([
      "[trash-drive-index-copies] STOPPED: log write failed (ENOSPC): stale-ns was trashed but is NOT in the log",
    ]);
    expect(t.out.at(-1)).toMatch(/^Summary: .* trashed=1 failed=0; skipped: /);
  });

  it("a log write failing after a failed PATCH stops and says the PATCH failed", async () => {
    const drive = fakeDrive({ failPatch: () => true });
    let n = 0;
    const t = makeDeps(drive, {
      appendLog: () => {
        if (++n === 2) throw new Error("ENOSPC");
      },
    });
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(1);
    expect(patches(drive.calls)).toHaveLength(1);
    expect(t.err[0]).toBe("[trash-drive-index-copies] STOPPED: log write failed (ENOSPC): stale-ns PATCH failed but is NOT in the log");
    expect(t.out.at(-1)).toMatch(/trashed=0 failed=1/);
  });

  it("logs a failure with a short error and exits 1", async () => {
    const drive = fakeDrive({ failPatch: (id) => id === "stale-1" });
    const t = makeDeps(drive);
    expect(await run(flags({ apply: true, log: "/l" }), t.deps)).toBe(1);
    expect(t.logLines.map((l) => l.line)).toContain(`${iso(NOW)} stale-1 FAILED Google API 403: rate limit for stale-1`);
    expect(t.out.at(-1)).toMatch(/trashed=2 failed=1/);
  });
});

describe("trashAll", () => {
  const many = (n: number): Located[] =>
    Array.from({ length: n }, (_, i) => ({ ...file(`f${i}`, ROOT), location: "." }));

  it(`stops after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`, async () => {
    const drive = fakeDrive({ failPatch: () => true });
    const lines: string[] = [];
    const r = await trashAll(many(12), { fetch: drive.fetch, sleep: async () => {}, now: () => NOW, log: (l) => lines.push(l) });
    expect(r).toEqual({ trashed: 0, failed: MAX_CONSECUTIVE_FAILURES, stopped: `${MAX_CONSECUTIVE_FAILURES} consecutive PATCH failures` });
    expect(patches(drive.calls)).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(lines).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });

  it("a success resets the failure streak", async () => {
    // f0-f3 fail, f4 ok, f5-f8 fail, f9 ok: never 5 in a row
    const ok = new Set(["f4", "f9"]);
    const drive = fakeDrive({ failPatch: (id) => !ok.has(id) });
    const r = await trashAll(many(10), { fetch: drive.fetch, sleep: async () => {}, now: () => NOW, log: () => {} });
    expect(r).toEqual({ trashed: 2, failed: 8, stopped: null });
    expect(patches(drive.calls)).toHaveLength(10);
  });

  it("pauses between calls, not before the first", async () => {
    const drive = fakeDrive({});
    const sleeps: number[] = [];
    await trashAll(many(3), {
      fetch: drive.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW,
      log: () => {},
    });
    expect(sleeps).toEqual([PAUSE_MS, PAUSE_MS]);
  });
});

describe("main", () => {
  it("runs the operator gate before any db or Drive call", async () => {
    const drive = fakeDrive({});
    const mapRows = vi.fn(() => MAP_ROWS);
    const t = makeDeps(drive, { mapRows });
    const gateFn = vi.fn(() => {
      throw new Error("refused by gate");
    });
    await expect(main(["--apply", "--log=/l"], { ...t.deps, gate: gateFn })).rejects.toThrow("refused by gate");
    expect(gateFn).toHaveBeenCalledOnce();
    expect(mapRows).not.toHaveBeenCalled();
    expect(drive.calls).toEqual([]);
  });

  it("refuses --apply without --log before any db or Drive call", async () => {
    const drive = fakeDrive({});
    const mapRows = vi.fn(() => MAP_ROWS);
    const t = makeDeps(drive, { mapRows });
    expect(await main(["--apply"], { ...t.deps, gate: () => {} })).toBe(2);
    expect(t.err[0]).toMatch(/REFUSED: --apply needs --log/);
    expect(mapRows).not.toHaveBeenCalled();
    expect(drive.calls).toEqual([]);
  });

  it("passes the parsed --log path to the log writer", async () => {
    const drive = fakeDrive({});
    const t = makeDeps(drive);
    expect(await main(["--apply", "--log=/a.log", "--limit=1"], { ...t.deps, gate: () => {} })).toBe(0);
    expect(new Set(t.logLines.map((l) => l.path))).toEqual(new Set(["/a.log"]));
    expect(patchedIds(drive.calls)).toEqual(["stale-ns"]);
  });
});
