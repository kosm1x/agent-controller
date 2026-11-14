/**
 * Second removal script: copies of remembered mailbox passwords outside the service's
 * own stores. Synthetic only: a local database file in this test's temp folder (the
 * three tables the script reads), mocked search-database and drive clients, a synthetic
 * git repository for the activity log and the build check, made-up values. No network:
 * `fetch` is replaced by a function that fails the test, or by an in-process fake of
 * the search database's REST interface; every drive call goes to a mocked `googleFetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { PASSWORD_WITHHELD_PLACEHOLDER as PH, passwordFingerprint } from "../src/lib/v8-4/password-gate.js";
import { SCHEMA_MIGRATION_HEAD, closeDatabase, openDatabaseReadOnly } from "../src/db/index.js";
import { isLiveDatabaseFile } from "../src/db/live-db.js";
import { Refusal } from "./prune-mailbox-passwords.js";
import {
  DELETE_BOUND,
  LIB_LINE_CAP,
  WRAPPER_MARKER,
  evolutionLogHistory,
  gitEnv,
  historyArgv,
  historyLinesHit,
  listTable,
  main,
  pairHit,
  parseArgs,
  rangeTotal,
  readDriveDone,
  realDeps,
  reuploadExact,
  runOutside,
  statusArgv,
  type LocalRow,
  type OutsideDeps,
  type OutsideOptions,
  type RemoteRow,
  type RemoteTable,
} from "./prune-mailbox-passwords-outside.js";

// The drive module reads its folder id at import time; every drive call is mocked, and
// the live-file guard answers "live" so the real re-upload path runs on the synthetic file.
const g = vi.hoisted(() => {
  delete process.env.COMMIT_DB_KEY;
  process.env.DRIVE_KB_FOLDER_ID = "kb-root-test";
  return { googleFetch: vi.fn() };
});
vi.mock("../src/google/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/google/client.js")>()),
  googleFetch: g.googleFetch,
}));
vi.mock("../src/db/live-db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/live-db.js")>()),
  isLiveDatabaseFile: vi.fn(() => true),
}));

const TAG = "[prune-mailbox-passwords-outside]";

// Made-up values (16–20 letters and digits, the shape the reply check looks for).
const V_SYNC = "Qx7Lm2Vp9Rt4Wz8K";
const V_ORPH = "aB3cD4eF5gH6iJ7kL8mN9";
const V_SPLIT_A = "Pq8Rs7Tu6";
const V_SPLIT_B = "Vw5Xy4Za3";
const V_SPLIT = V_SPLIT_A + V_SPLIT_B;
const V_BACK = "Hk2Jm3Ln4Po5Qr6St7";
const V_LOG_OLD = "Wd9Xe8Yf7Zg6Ah5Bi4";
const V_LOG_NOW = "Cj4Dk5El6Fm7Gn8Ho9Ip";
const V_MEM = "Ue2Vf3Wg4Xh5Yi6Zj7";
const V_DIRTY = "Rt1Sy2Tu3Uv4Vw5Wx6";
const NOT_SEEN = "Lm3Nn4Oo5Pp6Qq7Rr8Ss"; // value-shaped, not in the fingerprint table
const VALUES = [V_SYNC, V_ORPH, V_SPLIT, V_SPLIT_A, V_SPLIT_B, V_BACK, V_LOG_OLD, V_LOG_NOW, V_MEM, V_DIRTY];
const SEEN = [V_SYNC, V_ORPH, V_SPLIT, V_BACK, V_LOG_OLD, V_LOG_NOW, V_MEM, V_DIRTY];

const P_SYNC = "notes/sintetica-resync.md";
const P_SPLIT = "notes/sintetica-split.md";
const P_PH = "notes/sintetica-placeholder.md";
const P_CLEAN = "notes/sintetica-clean.md";
const P_ORPH = "extracted/sintetico-hecho.md";
const P_BACK_ORPH = "lessons/sintetica-leccion.md";
const MEM_FILE = "sintetica-memoria.md";
const PATHS = [P_SYNC, P_SPLIT, P_PH, P_CLEAN, P_ORPH, P_BACK_ORPH, MEM_FILE, "sintetica", "extracted", "lessons"];

// ── the wrapper's count-line filter (filter_count_lines in /root/mc-prune-mailbox-passwords.sh) ──
const COUNT_LINE_RE = /^[A-Za-z0-9_=.,:;() +-]*$/;
function looksLikeValue(s: string): boolean {
  return (s.match(/[A-Za-z0-9]{16,}/g) ?? []).some((m) => /[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m));
}
function passesFilter(raw: string): boolean {
  const line = raw.replaceAll("—", "-");
  if (!line.startsWith(`${TAG} `)) return false;
  const rest = line.slice(TAG.length + 1);
  return COUNT_LINE_RE.test(rest) && !looksLikeValue(rest);
}
function assertSafe(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) {
    expect(passesFilter(l), l).toBe(true);
    for (const v of VALUES) expect(l.includes(v), l).toBe(false);
    for (const p of PATHS) expect(l.includes(p), l).toBe(false);
  }
}

let root = "";
let dbPath = "";
let repo = "";
let memDir = "";
let decDir = "";
let fetchCalls = 0;
const realFetch = globalThis.fetch;
let handles: BetterSqlite3.Database[] = [];

/** A read-only handle on the synthetic file, as the script gets from openDatabaseReadOnly. */
function ro(): BetterSqlite3.Database {
  const h = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  handles.push(h);
  return h;
}
/** A separate writer on the synthetic file: the running service changing a row. */
function rw(fn: (db: BetterSqlite3.Database) => void): void {
  const db = new BetterSqlite3(dbPath);
  fn(db);
  db.close();
}
const fingerprint = (p: string): [string, number] => [
  createHash("sha256").update(readFileSync(p)).digest("hex"),
  statSync(p).mtimeMs,
];

function seedDb(opts: { seen?: boolean; version?: number; extra?: (db: BetterSqlite3.Database) => void } = {}): void {
  const db = new BetterSqlite3(dbPath);
  db.pragma(`user_version = ${opts.version ?? SCHEMA_MIGRATION_HEAD}`);
  db.exec(`
    CREATE TABLE jarvis_files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT DEFAULT '[]', qualifier TEXT DEFAULT 'reference', condition TEXT,
      priority INTEGER DEFAULT 50, related_to TEXT DEFAULT '[]', created_at TEXT, updated_at TEXT);
    CREATE TABLE drive_file_map (path TEXT PRIMARY KEY, drive_id TEXT NOT NULL, updated_at TEXT);
  `);
  if (opts.seen !== false) {
    db.exec("CREATE TABLE mailbox_password_seen (fingerprint TEXT PRIMARY KEY)");
    const ins = db.prepare("INSERT INTO mailbox_password_seen (fingerprint) VALUES (?)");
    for (const v of SEEN) ins.run(passwordFingerprint(v));
  }
  const row = db.prepare(
    "INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  row.run("1", P_SYNC, "Buzón sintético", `La contraseña del buzón era ${PH} según el correo.`, '["mail"]', "workspace", 70, "2026-11-13 01:00:00");
  row.run("2", P_SPLIT, "Nota partida", `Texto ya limpio ${PH} y nada más.`, "[]", "reference", 50, "2026-11-13 01:00:01");
  row.run("3", P_PH, "Otra nota", `Antes había ${PH} aquí.`, "[]", "reference", 50, "2026-11-13 01:00:02");
  row.run("4", P_CLEAN, "Limpia", "Sin nada que quitar en esta nota sintética.", "[]", "reference", 50, "2026-11-13 01:00:03");
  const map = db.prepare("INSERT INTO drive_file_map (path, drive_id) VALUES (?, ?)");
  for (const p of [P_SYNC, P_PH, P_CLEAN]) map.run(p, `drv-${p.length}`);
  opts.extra?.(db);
  db.close();
}

function remoteFixture(): Record<RemoteTable, Map<string, RemoteRow>> {
  const m = (rows: RemoteRow[]): Map<string, RemoteRow> => new Map(rows.map((r) => [r.path, r]));
  return {
    kb_entries: m([
      { path: P_SYNC, title: "Buzón sintético", content: `La contraseña del buzón era ${V_SYNC} según el correo.` },
      { path: P_SPLIT, title: `Nota partida ${V_SPLIT_A}`, content: `${V_SPLIT_B} y nada más.` },
      { path: P_ORPH, title: `Hecho: contraseña ${V_ORPH}`, content: `Hecho extraído: la contraseña es ${V_ORPH}.` },
      { path: P_CLEAN, title: "Limpia", content: `Sin nada que quitar; ${NOT_SEEN} no es un valor visto.` },
    ]),
    jarvis_kb_backup: m([
      { path: P_SYNC, title: "Buzón sintético", content: `La contraseña del buzón era ${V_SYNC} según el correo.` },
      { path: P_BACK_ORPH, title: "Lección", content: `Lección sintética con ${V_BACK} dentro.` },
      { path: P_CLEAN, title: "Limpia", content: "Sin nada que quitar en esta nota sintética." },
    ]),
  };
}

type Mock = OutsideDeps & {
  tables: Record<RemoteTable, Map<string, RemoteRow>>;
  writes: { resync: LocalRow[]; delete: string[]; reupload: string[] };
  failOn: { list?: RemoteTable; resync?: string; delete?: string; reupload?: string; get?: string };
  /** When false, a re-sync does not change the remote row (a rejected upsert). */
  resyncLands: boolean;
  /** Runs on each listing (after the local rows were read, before any write). */
  onList?: () => void;
  /** Runs inside a re-upload call. */
  onReupload?: (path: string) => void;
};

function mockDeps(over: Partial<OutsideDeps["settings"]> = {}): Mock {
  const d: Mock = {
    tables: remoteFixture(),
    writes: { resync: [], delete: [], reupload: [] },
    failOn: {},
    resyncLands: true,
    settings: { searchDb: true, embedding: true, drive: true, ...over },
    async list(t) {
      if (d.failOn.list === t) throw Object.assign(new Error("synthetic"), { code: "ECONNRESET" });
      d.onList?.();
      return [...d.tables[t].values()].map((r) => ({ ...r }));
    },
    async get(t, p) {
      if (d.failOn.get === p) throw new Error("synthetic");
      const r = d.tables[t].get(p);
      return r ? { ...r } : null;
    },
    resync(r) {
      d.writes.resync.push({ ...r });
      if (d.failOn.resync === r.path) throw new Error("synthetic");
      if (d.resyncLands) d.tables.kb_entries.set(r.path, { path: r.path, title: r.title, content: r.content });
    },
    async deleteSearchRow(p) {
      d.writes.delete.push(p);
      if (d.failOn.delete === p) throw new Error("synthetic");
      return d.tables.kb_entries.delete(p) || true; // the real pgDelete is ok also for 0 rows
    },
    async settle() {},
    async reupload(p) {
      d.writes.reupload.push(p);
      d.onReupload?.(p);
      return d.failOn.reupload !== p;
    },
    gitLog: evolutionLogHistory,
  };
  return d;
}

function opts(over: Partial<OutsideOptions> = {}): OutsideOptions & { lines: string[]; records: unknown[][] } {
  const lines: string[] = [];
  const records: unknown[][] = [];
  return {
    db: ro(),
    repo,
    sdkMemory: memDir,
    decisions: decDir,
    apply: false,
    driveDone: new Set(),
    acted: (r) => records.push(r),
    log: (l) => lines.push(l),
    lines,
    records,
    ...over,
  };
}

const writeCount = (d: Mock): number => d.writes.resync.length + d.writes.delete.length + d.writes.reupload.length;
const line = (lines: string[], prefix: string): string => lines.find((l) => l.startsWith(`${TAG} ${prefix}`)) ?? "";
const driveDoneOf = (records: unknown[][]): Set<string> =>
  new Set(records.filter((r) => r[0] === "drive_reuploaded").map((r) => `${String(r[1])}\0${String(r[2])}`));

function git(...args: string[]): void {
  const r = spawnSync("git", ["-C", repo, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.com", ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
}

/** Activity log: a committed value later removed, and a value in the current (uncommitted) file. */
function seedRepo(opts: { current?: boolean; history?: boolean } = {}): void {
  mkdirSync(join(repo, "docs"), { recursive: true });
  git("init", "-q");
  const file = join(repo, "docs", "EVOLUTION-LOG.md");
  writeFileSync(file, opts.history === false ? "# Log\n\nDía uno.\n" : `# Log\n\nDía uno: contraseña ${V_LOG_OLD}\n`);
  git("add", "docs/EVOLUTION-LOG.md");
  git("commit", "-q", "-m", "one");
  writeFileSync(file, "# Log\n\nDía uno: retenida.\n");
  git("commit", "-q", "-am", "two");
  if (opts.current !== false) writeFileSync(file, `# Log\n\nDía uno: retenida.\nDía dos: ${V_LOG_NOW}\n`);
}

/** A fixture with no decision left: clean activity log, empty memory folder. */
function seedCleanOutside(): void {
  seedRepo({ current: false, history: false });
  mkdirSync(memDir);
}

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-pwprune-outside-test-"));
  dbPath = join(root, "mc.db");
  repo = join(root, "repo");
  memDir = join(root, "memory");
  decDir = join(root, "decisions-absent");
  mkdirSync(repo);
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("no network in this test");
  }) as typeof fetch;
  g.googleFetch.mockReset();
  g.googleFetch.mockResolvedValue({});
});

afterEach(() => {
  expect(fetchCalls).toBe(0);
  globalThis.fetch = realFetch;
  for (const h of handles) h.close();
  handles = [];
  closeDatabase();
  delete process.env.COMMIT_DB_KEY;
  vi.mocked(isLiveDatabaseFile).mockReset();
  vi.mocked(isLiveDatabaseFile).mockReturnValue(true);
  rmSync(root, { recursive: true, force: true });
});

describe("pure helpers", () => {
  const fps = new Set(SEEN.map(passwordFingerprint));
  it("pairHit finds a value in the title, in the content, and cut between the two", () => {
    expect(pairHit(`t ${V_SYNC}`, "c", fps)).toBe(true);
    expect(pairHit("t", `c ${V_SYNC}.`, fps)).toBe(true);
    expect(pairHit(`t ${V_SPLIT_A}`, `${V_SPLIT_B} c`, fps)).toBe(true);
    expect(pairHit(`t ${V_SPLIT_A}`, ` ${V_SPLIT_B} c`, fps)).toBe(false);
    expect(pairHit("t", `c ${NOT_SEEN}`, fps)).toBe(false);
  });
  it("historyLinesHit counts added and removed lines, skips only the real file headers", () => {
    const patch = [
      "--- a/docs/EVOLUTION-LOG.md",
      "+++ b/docs/EVOLUTION-LOG.md",
      "--- /dev/null",
      `+${V_SYNC}`,
      `-${V_SYNC}`,
      ` ${V_SYNC}`,
      "+nada",
      // a removed line that began "-- " and an added one that began "++ ": both scanned
      `--- nota ${V_SYNC}`,
      `+++ nota ${V_SYNC}`,
      `---${V_SYNC}`,
    ].join("\n");
    expect(historyLinesHit(patch, fps)).toBe(5);
  });
  it("the history read's argv: fixed flags, no fsmonitor, no signature check, fixed prefixes", () => {
    expect(historyArgv("/r")).toEqual([
      "-C",
      "/r",
      "-c",
      "core.fsmonitor=",
      "-c",
      "log.showSignature=false",
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "log",
      "-p",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--format=",
      "--",
      "docs/EVOLUTION-LOG.md",
    ]);
  });
  it("the working-tree check's argv: no optional locks, fixed flags, the code paths", () => {
    expect(statusArgv("/r")).toEqual([
      "--no-optional-locks",
      "-C",
      "/r",
      "-c",
      "core.fsmonitor=",
      "-c",
      "log.showSignature=false",
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "status",
      "--porcelain=v1",
      "--",
      "src/",
      "scripts/",
      "package.json",
      "package-lock.json",
      "tsconfig*.json",
    ]);
  });
  it("every git child gets PATH, HOME and LANG only", () => {
    expect(
      gitEnv({ PATH: "/bin", HOME: "/h", LANG: "C", COMMIT_DB_KEY: "k", GIT_DIR: "/x", GIT_CONFIG_GLOBAL: "/y" }),
    ).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C" });
  });
  it("the history read itself sees no GIT_* steering from the process environment", () => {
    seedRepo({ current: false });
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "not-a-repo");
    try {
      expect(historyLinesHit(evolutionLogHistory(repo), fps)).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
  it("rangeTotal reads the total of a Content-Range header", () => {
    expect(rangeTotal("0-499/1234")).toBe(1234);
    expect(rangeTotal("*/0")).toBe(0);
    expect(rangeTotal("0-499/*")).toBeNull();
    expect(rangeTotal(null)).toBeNull();
  });
  it("parseArgs requires every location and ties --confirm-delete to --apply", () => {
    const base = ["--db", "a", "--repo", "b", "--sdk-memory", "c", "--decisions", "d", "--log", "e"];
    expect(parseArgs(base)).toMatchObject({ apply: false, db: "a", log: "e" });
    expect(parseArgs(base.slice(2))).toEqual({ error: "missing --db" });
    expect(parseArgs([...base, "--confirm-delete", "3"])).toEqual({ error: "--confirm-delete needs --apply" });
    expect(parseArgs([...base, "--apply", "--confirm-delete", "x3"])).toEqual({ error: "--confirm-delete needs a whole number" });
    expect(parseArgs([...base, "--apply", "--confirm-delete", "3"])).toMatchObject({ apply: true, confirmDelete: 3 });
    expect(parseArgs([...base, `--secret=${V_SYNC}`])).toEqual({ error: "unexpected argument: --secret" });
    expect(parseArgs([...base, V_SYNC])).toEqual({ error: "unexpected argument at position 11" });
    expect(parseArgs([...base, "--db", "z"])).toEqual({ error: "repeated --db" });
  });
});

describe("runOutside", () => {
  it("dry run: counts every kind, writes nothing, prints only safe lines", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    const o = opts();
    const r = await runOutside(o, d);
    expect(writeCount(d)).toBe(0);
    expect(o.records).toEqual([]);
    expect(r).toEqual({ ok: false, problems: 1, pending: 5 }); // the backup orphan needs a decision
    expect(line(o.lines, "search_copy table=")).toBe(
      `${TAG} search_copy table=kb_entries rows=4 hits=3 with_local_row=2 without_local_row=1 local_row_not_clean=0`,
    );
    expect(line(o.lines, "search_copy would_")).toBe(`${TAG} search_copy would_resync=2 would_delete=1 delete_bound=${DELETE_BOUND}`);
    expect(line(o.lines, "backup_copy")).toContain("rows=3 hits=2 fixed_by_nightly_push=1 local_row_not_clean=0 needs_decision=1");
    expect(line(o.lines, "drive_copy to_")).toBe(`${TAG} drive_copy to_reupload=2 already_reuploaded=0 local_row_not_clean=0`);
    expect(o.lines).toContain(`${TAG} memory_service=not_contacted`);
    expect(o.lines.at(-2)).toBe(`${TAG} finished with failures: problems=1 (see the notes above); fix them and run the same command again`);
    assertSafe(o.lines);
  });

  it("dry run with no decision left ends with the dry-run hint", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts();
    const r = await runOutside(o, d);
    expect(r).toEqual({ ok: true, problems: 0, pending: 5 });
    expect(o.lines.at(-2)).toBe(`${TAG} dry run — nothing written; pass --apply to act`);
    expect(writeCount(d)).toBe(0);
  });

  it("apply: re-syncs from the cleaned row, deletes the orphan, re-uploads the drive heads; the second run is clean", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts({ apply: true });
    const r = await runOutside(o, d);
    expect(r.ok).toBe(true);
    expect(d.writes.resync.map((x) => x.path).sort()).toEqual([P_SYNC, P_SPLIT].sort());
    const sent = d.writes.resync.find((x) => x.path === P_SYNC)!;
    expect(sent.content).toContain(PH);
    for (const v of VALUES) expect(`${sent.title}${sent.content}`).not.toContain(v);
    expect(sent).toMatchObject({ tags: ["mail"], qualifier: "workspace", priority: 70, condition: null });
    expect(d.writes.delete).toEqual([P_ORPH]);
    expect(d.tables.kb_entries.has(P_ORPH)).toBe(false);
    expect(d.writes.reupload.sort()).toEqual([P_PH, P_SYNC]);
    expect(line(o.lines, "search_copy resynced")).toBe(`${TAG} search_copy resynced=2 deleted=1 verified=3 failed=0 not_verified=0`);
    expect(line(o.lines, "drive_copy reuploaded")).toBe(`${TAG} drive_copy reuploaded=2 failed=0 changed_since_listing=0 to_redo=0 already_reuploaded=0 local_row_not_clean=0`);
    expect(o.lines).toContain(`${TAG} drive_copy old revisions stay until the drive expires them or the operator removes them by hand`);
    expect(o.lines.at(-2)).toBe(`${TAG} acted=5: run the same command again; it must find nothing to do`);
    expect(o.records).toContainEqual(["resynced", P_SYNC]);
    expect(o.records).toContainEqual(["deleted", P_ORPH]);
    expect(o.records).toContainEqual(["drive_reuploaded", P_PH, "2026-11-13 01:00:02"]);
    assertSafe(o.lines);

    for (const apply of [true, false]) {
      d.writes = { resync: [], delete: [], reupload: [] };
      const o2 = opts({ apply, driveDone: driveDoneOf(o.records) });
      const r2 = await runOutside(o2, d);
      expect(r2).toEqual({ ok: true, problems: 0, pending: 0 });
      expect(writeCount(d)).toBe(0);
      expect(o2.lines.at(-2)).toBe(`${TAG} nothing to change`);
      expect(line(o2.lines, "drive_copy")).toContain("already_reuploaded=2");
      assertSafe(o2.lines);
    }
  });

  it("over the bound without the confirm flag: refused before any write", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    for (let i = 0; i <= DELETE_BOUND; i++) {
      const p = `extracted/sintetico-${i}.md`;
      d.tables.kb_entries.set(p, { path: p, title: "Hecho", content: `valor ${V_ORPH} extraído` });
    }
    const n = DELETE_BOUND + 2; // the fixture's own orphan too
    const dry = opts();
    await runOutside(dry, d);
    expect(line(dry.lines, "search_copy would_")).toContain(`would_delete=${n}`);
    const o = opts({ apply: true });
    await expect(runOutside(o, d)).rejects.toMatchObject({ code: "DELETE_BOUND" });
    expect(writeCount(d)).toBe(0);
    expect(o.lines).toEqual([
      `${TAG} REFUSED: would_delete=${n} is above the bound of ${DELETE_BOUND}; check the fingerprint table, then repeat the run with --confirm-delete ${n}; nothing written`,
    ]);
    assertSafe(o.lines);

    const ok = opts({ apply: true, confirmDelete: n });
    await runOutside(ok, d);
    expect(d.writes.delete).toHaveLength(n);
  });

  it("a confirm flag with a different number is refused, below and above the bound", async () => {
    seedDb();
    seedCleanOutside();
    for (const [extra, confirm] of [
      [0, 2],
      [DELETE_BOUND + 1, DELETE_BOUND + 1],
    ] as const) {
      const d = mockDeps();
      for (let i = 0; i < extra; i++) {
        const p = `extracted/sintetico-${i}.md`;
        d.tables.kb_entries.set(p, { path: p, title: "Hecho", content: `valor ${V_ORPH}` });
      }
      const o = opts({ apply: true, confirmDelete: confirm });
      const err = await runOutside(o, d).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Refusal);
      expect((err as Refusal).code).toBe("CONFIRM_MISMATCH");
      expect(writeCount(d)).toBe(0);
    }
  });

  it("a client error on one row is a failure; the other rows still proceed", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const p2 = "extracted/sintetico-otro.md";
    d.tables.kb_entries.set(p2, { path: p2, title: "Hecho", content: `valor ${V_ORPH}` });
    d.failOn = { delete: P_ORPH, resync: P_SPLIT, reupload: P_PH };
    const o = opts({ apply: true });
    const r = await runOutside(o, d);
    expect(r.ok).toBe(false);
    expect(r.problems).toBe(3);
    expect(d.writes.delete.sort()).toEqual([P_ORPH, p2].sort());
    expect(d.tables.kb_entries.has(p2)).toBe(false);
    expect(d.writes.reupload.sort()).toEqual([P_PH, P_SYNC]);
    expect(line(o.lines, "search_copy resynced")).toBe(`${TAG} search_copy resynced=1 deleted=1 verified=2 failed=2 not_verified=0`);
    expect(line(o.lines, "drive_copy reuploaded")).toContain("reuploaded=1 failed=1");
    expect(o.lines.at(-2)).toContain("finished with failures: problems=3");
    assertSafe(o.lines);
  });

  it("a re-sync that does not land and a read-back error are not verified", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    d.resyncLands = false;
    d.failOn = { get: P_ORPH };
    const o = opts({ apply: true });
    const r = await runOutside(o, d);
    expect(r.ok).toBe(false);
    expect(line(o.lines, "search_copy resynced")).toBe(`${TAG} search_copy resynced=2 deleted=1 verified=0 failed=0 not_verified=3`);
  });

  it("a listing error is a failure line with its code; the other kinds still run", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    d.failOn = { list: "kb_entries" };
    const o = opts({ apply: true });
    const r = await runOutside(o, d);
    expect(r.ok).toBe(false);
    expect(o.lines).toContain(`${TAG} search_copy table=kb_entries read_failed code=ECONNRESET`);
    expect(d.writes.resync).toEqual([]);
    expect(d.writes.delete).toEqual([]);
    expect(line(o.lines, "backup_copy")).toContain("hits=2");
    expect(d.writes.reupload.sort()).toEqual([P_PH, P_SYNC]); // the placeholder rows still get their heads rewritten
  });

  it("a local row that still holds a value is never pushed: a failure, nothing re-synced or re-uploaded for it", async () => {
    seedDb({
      extra: (db) =>
        db.prepare("UPDATE jarvis_files SET content = ? WHERE path = ?").run(`Sigue aquí ${V_DIRTY} y ${PH}`, P_SYNC),
    });
    seedCleanOutside();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts({ apply: true });
    const r = await runOutside(o, d);
    expect(r.ok).toBe(false);
    expect(d.writes.resync.map((x) => x.path)).toEqual([P_SPLIT]);
    expect(d.writes.reupload).toEqual([P_PH]);
    expect(line(o.lines, "search_copy table=")).toContain("local_row_not_clean=1");
    expect(line(o.lines, "backup_copy")).toContain("local_row_not_clean=1");
    expect(line(o.lines, "drive_copy reuploaded")).toContain("local_row_not_clean=1");
    assertSafe(o.lines);
  });

  describe("drive re-upload: exactly the listed row, clean at that moment", () => {
    const setup = (): Mock => {
      seedDb();
      seedCleanOutside();
      const d = mockDeps();
      d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
      return d;
    };
    const cases: Array<[string, () => void]> = [
      ["updated since the listing", () => rw((db) => db.prepare("UPDATE jarvis_files SET updated_at = '2026-11-13 02:00:00' WHERE path = ?").run(P_PH))],
      ["holds a value again (same updated_at)", () => rw((db) => db.prepare("UPDATE jarvis_files SET content = ? WHERE path = ?").run(`otra vez ${V_DIRTY}`, P_PH))],
      ["gone since the listing", () => rw((db) => db.prepare("DELETE FROM jarvis_files WHERE path = ?").run(P_PH))],
    ];
    for (const [name, change] of cases) {
      it(`a row ${name} is not re-uploaded: changed_since_listing, left for the next run`, async () => {
        const d = setup();
        let once = false;
        d.onList = () => {
          if (!once) change();
          once = true;
        };
        const o = opts({ apply: true });
        const r = await runOutside(o, d);
        expect(d.writes.reupload).toEqual([P_SYNC]);
        expect(line(o.lines, "drive_copy reuploaded")).toBe(
          `${TAG} drive_copy reuploaded=1 failed=0 changed_since_listing=1 to_redo=0 already_reuploaded=0 local_row_not_clean=0`,
        );
        expect(o.records.filter((x) => x[0] === "drive_reuploaded").map((x) => x[1])).toEqual([P_SYNC]);
        expect(r.ok).toBe(false);
        assertSafe(o.lines);
      });
    }

    it("a row updated during the call is not recorded: to_redo", async () => {
      const d = setup();
      d.onReupload = (p) => {
        if (p === P_PH) rw((db) => db.prepare("UPDATE jarvis_files SET updated_at = '2026-11-13 02:00:00' WHERE path = ?").run(P_PH));
      };
      const o = opts({ apply: true });
      const r = await runOutside(o, d);
      expect(d.writes.reupload.sort()).toEqual([P_PH, P_SYNC]);
      expect(line(o.lines, "drive_copy reuploaded")).toContain("reuploaded=1 failed=0 changed_since_listing=0 to_redo=1");
      expect(o.records.filter((x) => x[0] === "drive_reuploaded").map((x) => x[1])).toEqual([P_SYNC]);
      expect(r.ok).toBe(false);
    });

    it("an earlier re-upload counts only with the same updated_at", async () => {
      const d = setup();
      const o = opts({
        apply: true,
        driveDone: new Set([`${P_PH}\u00002026-11-13 00:59:59`, `${P_SYNC}\u00002026-11-13 01:00:00`]),
      });
      await runOutside(o, d);
      expect(d.writes.reupload).toEqual([P_PH]);
      expect(line(o.lines, "drive_copy reuploaded")).toContain("reuploaded=1 failed=0 changed_since_listing=0 to_redo=0 already_reuploaded=1");
    });

    it("the real re-upload: one file rewritten is true; nothing selected, no drive id or a refusal is false", async () => {
      seedDb();
      rw((db) =>
        db
          .prepare("INSERT INTO drive_file_map (path, drive_id) VALUES (?, ?)")
          .run(`${P_PH}.bak`, "drv-neighbour"),
      );
      rw((db) =>
        db
          .prepare("INSERT INTO jarvis_files (id, path, title, content, updated_at) VALUES ('9', ?, 'T', 'vecina', '2026-11-13 01:00:09')")
          .run(`${P_PH}.bak`),
      );
      openDatabaseReadOnly(dbPath);
      expect(await reuploadExact(P_PH)).toBe(true);
      const urls = g.googleFetch.mock.calls.map((c) => String(c[0]));
      expect(urls).toEqual([`https://www.googleapis.com/upload/drive/v3/files/drv-${P_PH.length}?uploadType=media`]);
      expect(await reuploadExact(P_SPLIT)).toBe(false); // a row without a drive id: updated=0
      expect(await reuploadExact("notes/sintetica")).toBe(false); // no such row, never a prefix
      g.googleFetch.mockRejectedValueOnce(new Error("synthetic"));
      expect(await reuploadExact(P_PH)).toBe(false); // failed=1
      vi.mocked(isLiveDatabaseFile).mockReturnValue(false);
      expect(await reuploadExact(P_PH)).toBe(false); // the guard refused
      expect(g.googleFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("missing settings: no search database refuses; no embedding or drive settings skip and fail", async () => {
    seedDb();
    seedCleanOutside();
    await expect(runOutside(opts(), mockDeps({ searchDb: false }))).rejects.toMatchObject({ code: "SETTINGS_ABSENT" });
    const d = mockDeps({ embedding: false, drive: false });
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts({ apply: true });
    const r = await runOutside(o, d);
    expect(r.ok).toBe(false);
    expect(d.writes.resync).toEqual([]);
    expect(d.writes.reupload).toEqual([]);
    expect(d.writes.delete).toEqual([P_ORPH]);
    expect(o.lines).toContain(`${TAG} search_copy resync_skipped=2 (embedding settings absent)`);
    expect(o.lines).toContain(`${TAG} drive_copy reupload_skipped=2 (drive settings absent)`);
    expect(o.lines).toContain(`${TAG} settings search_db=present embedding=absent drive=absent`);
  });

  it("no fingerprint table: refused", async () => {
    seedDb({ seen: false });
    seedCleanOutside();
    await expect(runOutside(opts(), mockDeps())).rejects.toMatchObject({ code: "SEEN_TABLE_ABSENT" });
  });

  it("activity log: counts the current file and the history, never a line or a commit id", async () => {
    seedDb();
    seedRepo();
    mkdirSync(memDir);
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts();
    const r = await runOutside(o, d);
    // history: + then - of the old value; the current value is not committed
    expect(line(o.lines, "evolution_log")).toBe(
      `${TAG} evolution_log current_lines_hit=1 history_lines_hit=2 (count only; the history is public, so a hit needs a decision)`,
    );
    expect(r.problems).toBe(3);
    const ids = spawnSync("git", ["-C", repo, "log", "--format=%H"], { encoding: "utf8" }).stdout.trim().split("\n");
    for (const l of o.lines) for (const id of ids) expect(l).not.toContain(id.slice(0, 7));
    assertSafe(o.lines);
  });

  it("activity log: a git failure is a failure line, not a crash", async () => {
    seedDb();
    mkdirSync(memDir);
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts(); // repo is an empty folder: not a git repository
    const r = await runOutside(o, d);
    expect(r.ok).toBe(false);
    expect(line(o.lines, "evolution_log")).toContain("current_missing history_read_failed code=GIT_EXIT_128");
  });

  it("earlier folders on disk: counted, a hit needs a decision; an absent folder says missing", async () => {
    seedDb();
    seedRepo({ current: false, history: false });
    mkdirSync(memDir);
    writeFileSync(join(memDir, MEM_FILE), `nota con ${V_MEM}\n`);
    writeFileSync(join(memDir, "otra.md"), "nada\n");
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    const o = opts();
    const r = await runOutside(o, d);
    expect(line(o.lines, "sdk_memory")).toBe(`${TAG} sdk_memory files=2 hits=1 (count only; a hit needs a decision)`);
    expect(line(o.lines, "decisions")).toBe(`${TAG} decisions files=0 hits=0 missing (count only; a hit needs a decision)`);
    expect(r.problems).toBe(1);
    assertSafe(o.lines);
  });

  it("the fixed lines for the copies that cannot be cleared here", async () => {
    seedDb();
    seedCleanOutside();
    const o = opts();
    await runOutside(o, mockDeps());
    for (const k of ["journal ages out", "provider_logs", "local_backups age out", "offsite_mirror"]) {
      expect(line(o.lines, k), k).not.toBe("");
    }
    expect(line(o.lines, "journal")).toContain("MaxRetentionSec=30day SystemMaxUse=1G");
    expect(line(o.lines, "local_backups")).toContain("KEEP_BACKUPS=4");
    expect(o.lines.filter((l) => l.includes("memory_service"))).toEqual([`${TAG} memory_service=not_contacted`]);
  });
});

// ── the search database's REST interface, in process (no network) ──
type Seen = { method: string; url: URL };
function fakeRest(
  rows: RemoteRow[],
  o: {
    noTotal?: boolean;
    dropFromLast?: boolean;
    status?: number;
    onRequest?: (i: number) => void;
    /** Replaces the reported total of request i. */
    total?: (i: number, real: number) => number;
  } = {},
): { fetch: typeof fetch; seen: Seen[]; rows: RemoteRow[] } {
  const store = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen: Seen[] = [];
  const f = (async (input: string, init?: { method?: string }) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    o.onRequest?.(seen.length);
    seen.push({ method, url });
    if (o.status) return new Response("{}", { status: o.status });
    const req = seen.length - 1;
    const filter = url.searchParams.get("path");
    const match = (r: RemoteRow): boolean =>
      filter === null ? true : filter.startsWith("eq.") ? r.path === filter.slice(3) : filter.startsWith("gt.") ? r.path > filter.slice(3) : false;
    if (method === "DELETE") {
      for (let i = store.length - 1; i >= 0; i--) if (match(store[i]!)) store.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    const all = store.filter(match);
    const limit = Number(url.searchParams.get("limit") ?? all.length);
    let page = all.slice(0, limit);
    if (o.dropFromLast && page.length < limit && page.length > 0) page = page.slice(1);
    const headers: Record<string, string> = {};
    if (!o.noTotal) headers["content-range"] = `0-${Math.max(page.length - 1, 0)}/${o.total ? o.total(req, all.length) : all.length}`;
    return new Response(JSON.stringify(page), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { fetch: f, seen, rows: store };
}
const five = ["a", "b", "c", "d", "e"].map((x) => ({ path: `notes/${x}.md`, title: x, content: `c ${x}` }));
const HEADERS = { apikey: "synthetic" };

describe("listTable (keyset paging by path)", () => {
  it("reads every row in path order, the cursor after the last path read", async () => {
    const f = fakeRest(five);
    const out = await listTable("kb_entries", f.fetch, HEADERS, { page: 2, maxPages: 10 });
    expect(out.map((r) => r.path)).toEqual(five.map((r) => r.path));
    expect(f.seen).toHaveLength(3);
    for (const s of f.seen) {
      expect(s.url.searchParams.get("order")).toBe("path");
      expect(s.url.searchParams.get("limit")).toBe("2");
      expect(s.url.searchParams.has("offset")).toBe(false);
    }
    expect(f.seen.map((s) => s.url.searchParams.get("path"))).toEqual([null, "gt.notes/b.md", "gt.notes/d.md"]);
  });
  it("a row removed mid-listing skips no other row", async () => {
    let f: ReturnType<typeof fakeRest>;
    f = fakeRest(five, {
      onRequest: (i) => {
        if (i === 1) f.rows.splice(0, 1); // notes/a.md, already read, goes away
      },
    });
    const out = await listTable("kb_entries", f.fetch, HEADERS, { page: 2, maxPages: 10 });
    expect(out.map((r) => r.path)).toEqual(five.map((r) => r.path));
  });
  it("an exact multiple of the page size ends on an empty page", async () => {
    const f = fakeRest(five.slice(0, 4));
    expect(await listTable("kb_entries", f.fetch, HEADERS, { page: 2, maxPages: 10 })).toHaveLength(4);
    expect(f.seen).toHaveLength(3);
  });
  for (const [name, o, limits] of [
    ["no total header", { noTotal: true }, { page: 2, maxPages: 10 }],
    ["a short read (fewer rows than the last total)", { dropFromLast: true }, { page: 2, maxPages: 10 }],
    ["the page cap reached", {}, { page: 2, maxPages: 2 }],
  ] as const) {
    it(`${name} is LISTING_INCOMPLETE`, async () => {
      const f = fakeRest(five, o);
      await expect(listTable("kb_entries", f.fetch, HEADERS, limits)).rejects.toMatchObject({ code: "LISTING_INCOMPLETE" });
    });
  }
  it("a full page with a total smaller than its own rows is LISTING_INCOMPLETE (the later pages being honest)", async () => {
    const f = fakeRest(five, { total: (i, real) => (i === 0 ? 1 : real) });
    await expect(listTable("kb_entries", f.fetch, HEADERS, { page: 2, maxPages: 10 })).rejects.toMatchObject({ code: "LISTING_INCOMPLETE" });
    expect(f.seen).toHaveLength(1);
  });
  it("an HTTP error carries its status as the code", async () => {
    const f = fakeRest(five, { status: 503 });
    await expect(listTable("jarvis_kb_backup", f.fetch, HEADERS)).rejects.toMatchObject({ code: "HTTP_503" });
  });
});

describe("realDeps against an in-process REST fake", () => {
  const ODD = ["notas/a&b.md", "notas/a,b.md", "notas/50%25.md", "notas/50%.md", "notas/con espacio.md", `notas/it's "q".md`, "eq.notas/x.md", "notas/x.md"];
  it("list, single-row read and delete send each path as one exact value", async () => {
    const f = fakeRest(ODD.map((p) => ({ path: p, title: "t", content: "c" })));
    process.env.COMMIT_DB_KEY = "synthetic-test-key";
    globalThis.fetch = f.fetch;
    const deps = await realDeps();
    expect(deps.settings.searchDb).toBe(true);
    expect((await deps.list("kb_entries")).map((r) => r.path).sort()).toEqual([...ODD].sort());
    for (const p of ODD) expect((await deps.get("kb_entries", p))?.path).toBe(p);
    expect(await deps.get("kb_entries", "notas/a")).toBeNull();
    expect(await deps.deleteSearchRow("notas/a&b.md")).toBe(true);
    expect(await deps.deleteSearchRow("eq.notas/x.md")).toBe(true);
    expect(f.rows.map((r) => r.path).sort()).toEqual(ODD.filter((p) => p !== "notas/a&b.md" && p !== "eq.notas/x.md").sort());
    expect(await deps.get("kb_entries", "notas/a&b.md")).toBeNull();
    const deletes = f.seen.filter((s) => s.method === "DELETE");
    expect(deletes.map((s) => [...s.url.searchParams.entries()])).toEqual([
      [["path", "eq.notas/a&b.md"]],
      [["path", "eq.eq.notas/x.md"]],
    ]);
  });
});

describe("runOutside read-back through the real reads", () => {
  it("a delete that left the row is not verified; one that removed it is", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    d.deleteSearchRow = async (p) => {
      d.writes.delete.push(p);
      return true; // reports ok, removes nothing
    };
    const o = opts({ apply: true });
    await runOutside(o, d);
    expect(line(o.lines, "search_copy resynced")).toBe(`${TAG} search_copy resynced=2 deleted=1 verified=2 failed=0 not_verified=1`);
  });
});

describe("main", () => {
  const STAMP_LOG = "mc-prune-mailbox-passwords-20261113T120000Z-outside-acted.log";
  function argv(log: string, ...extra: string[]): string[] {
    return ["--db", dbPath, "--repo", repo, "--sdk-memory", memDir, "--decisions", decDir, "--log", log, ...extra];
  }
  function run(args: string[], deps: Mock, over: { env?: NodeJS.ProcessEnv; codeRoot?: string } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let gate = 0;
    let built = 0;
    const p = main(args, {
      requireOperatorContext: () => {
        gate++;
      },
      deps: async () => {
        built++;
        return deps;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: over.env ?? { [WRAPPER_MARKER]: "1" },
      codeRoot: over.codeRoot ?? repo,
    });
    return { p, out, err, gate: () => gate, built: () => built };
  }
  const head = (): string => spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  function seedBuild(o: { commit?: string; dirty?: boolean } = {}): void {
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(
      join(repo, "dist", "build-info.json"),
      JSON.stringify({ commit: o.commit ?? head(), commitShort: "x", branch: "main", builtAt: "2026-11-13T00:00:00Z", dirty: o.dirty ?? false, dirtyFiles: [] }),
    );
  }
  /** A clean outside fixture whose build matches its HEAD. */
  function ready(): Mock {
    seedDb();
    seedCleanOutside();
    seedBuild();
    const d = mockDeps();
    d.tables.jarvis_kb_backup.delete(P_BACK_ORPH);
    return d;
  }

  it("writes the acted paths and every library line to a 600 log, never to the screen; exit 0", async () => {
    const d = ready();
    const inner = d.deleteSearchRow.bind(d);
    d.deleteSearchRow = async (p) => {
      console.warn(`[pgvector] synthetic line naming ${p}`);
      console.error("x".repeat(LIB_LINE_CAP + 50));
      return inner(p);
    };
    const saved = [console.log, console.info, console.warn, console.error, console.debug];
    const log = join(root, STAMP_LOG);
    const r = run(argv(log, "--apply"), d);
    expect(await r.p).toBe(0);
    expect(r.gate()).toBe(1);
    expect([console.log, console.info, console.warn, console.error, console.debug]).toEqual(saved);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    const body = readFileSync(log, "utf8");
    expect(body).toContain(JSON.stringify(["deleted", P_ORPH]));
    expect(body).toContain(JSON.stringify(["lib", `[pgvector] synthetic line naming ${P_ORPH}`]));
    expect(body).toContain(JSON.stringify(["lib", "x".repeat(LIB_LINE_CAP)]));
    expect(body).not.toContain("x".repeat(LIB_LINE_CAP + 1));
    assertSafe([...r.out, ...r.err]);

    // the second run reads the first log for the drive state, and is clean
    const r2 = run(argv(join(root, STAMP_LOG.replace("120000Z", "120500Z")), "--apply"), d);
    expect(await r2.p).toBe(0);
    expect(r2.out.at(-2)).toBe(`${TAG} nothing to change`);
  });

  it("a full apply with the real drive re-upload leaves the database file's bytes and mtime unchanged", async () => {
    const d = ready();
    d.reupload = reuploadExact;
    const before = fingerprint(dbPath);
    const r = run(argv(join(root, STAMP_LOG), "--apply"), d);
    expect(await r.p).toBe(0);
    expect(g.googleFetch.mock.calls.map((c) => String(c[0])).sort()).toEqual(
      [P_PH, P_SYNC].map((p) => `https://www.googleapis.com/upload/drive/v3/files/drv-${p.length}?uploadType=media`).sort(),
    );
    expect(readFileSync(join(root, STAMP_LOG), "utf8")).toContain(JSON.stringify(["drive_reuploaded", P_PH, "2026-11-13 01:00:02"]));
    expect(fingerprint(dbPath)).toEqual(before);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  });

  it("finished with failures → exit 1; a refusal → exit 2 and nothing written", async () => {
    ready();
    const d = mockDeps(); // the backup orphan needs a decision
    expect(await run(argv(join(root, STAMP_LOG)), d).p).toBe(1);

    const d2 = mockDeps({ searchDb: false });
    const r = run(argv(join(root, STAMP_LOG.replace("12", "13"))), d2);
    expect(await r.p).toBe(2);
    expect(r.err).toEqual([`${TAG} REFUSED code=SETTINGS_ABSENT name=search_db — nothing written`]);
    assertSafe(r.err);
  });

  describe("the code that runs must be the code the service runs", () => {
    const refusals: Array<[string, string, () => { env?: NodeJS.ProcessEnv; codeRoot?: string } | void]> = [
      ["no build-info file", "BUILD_MISMATCH", () => rmSync(join(repo, "dist", "build-info.json"))],
      ["a build commit unknown to the repository", "BUILD_MISMATCH", () => seedBuild({ commit: "0".repeat(40) })],
      ["a short build commit", "BUILD_MISMATCH", () => seedBuild({ commit: head().slice(0, 12) })],
      ...(
        [
          ["src/", "src/a.ts"],
          ["scripts/", "scripts/a.ts"],
          ["package.json", "package.json"],
          ["package-lock.json", "package-lock.json"],
          ["tsconfig*.json", "tsconfig.build.json"],
        ] as const
      ).map(
        ([cls, file]) =>
          [
            `a commit on top touching ${cls}`,
            "BUILD_MISMATCH",
            () => {
              mkdirSync(join(repo, file, ".."), { recursive: true });
              writeFileSync(join(repo, file), "{}\n");
              git("add", file);
              git("commit", "-q", "-m", `code ${cls}`);
            },
          ] as [string, string, () => void],
      ),
      ["a dirty build", "BUILD_MISMATCH", () => seedBuild({ dirty: true })],
      ["a build without the dirty field", "BUILD_MISMATCH", () => writeFileSync(join(repo, "dist", "build-info.json"), JSON.stringify({ commit: head() }))],
      [
        "an untracked file under src/",
        "TREE_NOT_CLEAN",
        () => {
          mkdirSync(join(repo, "src"));
          writeFileSync(join(repo, "src", "nuevo.ts"), "export {};\n");
        },
      ],
      [
        "a changed tracked file under scripts/",
        "TREE_NOT_CLEAN",
        () => {
          mkdirSync(join(repo, "scripts"));
          writeFileSync(join(repo, "scripts", "a.ts"), "export {};\n");
          git("add", "scripts/a.ts");
          git("commit", "-q", "-m", "three");
          seedBuild();
          writeFileSync(join(repo, "scripts", "a.ts"), "export const x = 1;\n");
        },
      ],
      ["a --repo that is not the code's repository", "REPO_MISMATCH", () => ({ codeRoot: root })],
      ["a lower schema version", "SCHEMA_MISMATCH", () => rw((db) => db.pragma(`user_version = ${SCHEMA_MIGRATION_HEAD - 1}`))],
      ["a higher schema version", "SCHEMA_MISMATCH", () => rw((db) => db.pragma(`user_version = ${SCHEMA_MIGRATION_HEAD + 1}`))],
      ["no wrapper marker", "NOT_UNDER_WRAPPER", () => ({ env: { [WRAPPER_MARKER]: "yes" } })],
    ];
    for (const [name, code, change] of refusals) {
      for (const mode of [[], ["--apply"]] as const) {
        it(`${name} → REFUSED code=${code}, exit 2, nothing read or written (${mode.length ? "apply" : "dry run"})`, async () => {
          const d = ready();
          const over = change() ?? {};
          const before = fingerprint(dbPath);
          const log = join(root, STAMP_LOG);
          const r = run(argv(log, ...mode), d, over);
          expect(await r.p).toBe(2);
          const tail = code === "NOT_UNDER_WRAPPER" ? "run it through the operator wrapper; nothing written" : "nothing written";
          expect(r.err).toEqual([`${TAG} REFUSED code=${code} — ${tail}`]);
          expect(r.out).toEqual([]);
          expect(r.built()).toBe(0);
          expect(writeCount(d)).toBe(0);
          if (existsSync(log)) expect(readFileSync(log, "utf8")).toBe("");
          expect(fingerprint(dbPath)).toEqual(before);
        });
      }
    }

    it("a docs-only commit on top of the built commit passes", async () => {
      const d = ready();
      writeFileSync(join(repo, "docs", "NOTAS.md"), "solo documentación\n");
      git("add", "docs/NOTAS.md");
      git("commit", "-q", "-m", "docs");
      const r = run(argv(join(root, STAMP_LOG), "--apply"), d);
      expect(await r.p).toBe(0);
      expect(r.built()).toBe(1);
      expect(r.err).toEqual([]);
    });

    it("a non-hex or option-shaped build commit is refused without reaching git", async () => {
      const d = ready();
      const sha = head();
      const bads = [`--output=${join(root, "pwned")}`, "-q", "A".repeat(40), `${sha} `, `-${sha.slice(1)}`, "HEAD"];
      const shim = join(root, "shim");
      const argvLog = join(root, "git-argv.log");
      mkdirSync(shim);
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      const savedPath = process.env.PATH;
      process.env.PATH = `${shim}:${savedPath ?? ""}`;
      try {
        for (const [i, bad] of bads.entries()) {
          seedBuild({ commit: bad });
          const r = run(argv(join(root, `mc-prune-mailbox-passwords-20261113T12010${i}Z-outside-acted.log`)), d);
          expect(await r.p, bad).toBe(2);
          expect(r.err).toEqual([`${TAG} REFUSED code=BUILD_MISMATCH — nothing written`]);
          expect(r.built()).toBe(0);
        }
        expect(existsSync(argvLog)).toBe(false); // no git child ran for any of them
        expect(existsSync(join(root, "pwned"))).toBe(false);
        // the shim does see the build check's git calls on a valid value
        seedBuild({ commit: sha });
        const ok = run(argv(join(root, STAMP_LOG)), d);
        expect(await ok.p, ok.err.join(" ")).toBe(0);
        expect(readFileSync(argvLog, "utf8")).toContain(`diff --quiet --no-ext-diff --no-textconv ${sha} HEAD --`);
        // the working-tree check the real call makes: no optional locks, as the first argument
        const statusCalls = readFileSync(argvLog, "utf8")
          .split("\n")
          .filter((l) => / status --porcelain=v1 -- /.test(l));
        expect(statusCalls.length).toBeGreaterThan(0);
        for (const l of statusCalls) expect(l.startsWith(`--no-optional-locks -C ${repo} -c core.fsmonitor= `), l).toBe(true);
      } finally {
        process.env.PATH = savedPath;
      }
    });

    it("a database already open in the process keeps its own code", async () => {
      const d = ready();
      openDatabaseReadOnly(dbPath);
      const r = run(argv(join(root, STAMP_LOG)), d);
      expect(await r.p).toBe(2);
      expect(r.err).toEqual([`${TAG} REFUSED code=DB_ALREADY_OPEN — nothing written`]);
      expect(r.built()).toBe(0);
    });

    it("a missing database file is refused and not created", async () => {
      const d = ready();
      rmSync(dbPath);
      const r = run(argv(join(root, STAMP_LOG)), d);
      expect(await r.p).toBe(2);
      expect(r.err).toEqual([`${TAG} REFUSED code=DB_UNREADABLE — nothing written`]);
      expect(existsSync(dbPath)).toBe(false);
      expect(r.built()).toBe(0);
    });
  });

  it("refuses a log name outside the rule, or one that exists, before anything else", async () => {
    seedDb();
    seedCleanOutside();
    const d = mockDeps();
    for (const bad of ["acted.log", "mc-prune-mailbox-passwords-20261113T120000Z-outside-acted.txt"]) {
      const r = run(argv(join(root, bad)), d);
      expect(await r.p).toBe(2);
      expect(r.err).toEqual([`${TAG} REFUSED code=LOG_NAME — nothing written`]);
      expect(existsSync(join(root, bad))).toBe(false);
    }
    writeFileSync(join(root, STAMP_LOG), "");
    const r = run(argv(join(root, STAMP_LOG)), d);
    expect(await r.p).toBe(2);
    expect(r.err).toEqual([`${TAG} REFUSED code=LOG_OPEN_EEXIST — nothing written`]);
    expect(r.out).toEqual([]);
  });

  it("a bad argument is refused with exit 2, naming no value", async () => {
    const r = run(["--db", V_SYNC], mockDeps());
    expect(await r.p).toBe(2);
    expect(r.err).toEqual([`${TAG} missing --repo --sdk-memory --decisions --log`]);
  });
});

describe("readDriveDone", () => {
  it("reads drive re-uploads from the other acted logs only", () => {
    const self = "mc-prune-mailbox-passwords-20261113T120000Z-outside-acted.log";
    const other = "mc-prune-mailbox-passwords-20261112T120000Z-outside-acted.log";
    writeFileSync(join(root, self), `${JSON.stringify(["drive_reuploaded", "a", "1"])}\n`);
    writeFileSync(
      join(root, other),
      [JSON.stringify(["drive_reuploaded", "b", "2"]), JSON.stringify(["deleted", "c"]), "not json", ""].join("\n"),
    );
    writeFileSync(join(root, "unrelated.log"), `${JSON.stringify(["drive_reuploaded", "d", "3"])}\n`);
    expect([...readDriveDone(root, self)]).toEqual(["b\u00002"]);
    expect(readDriveDone(join(root, "absent"), self).size).toBe(0);
  });
});
