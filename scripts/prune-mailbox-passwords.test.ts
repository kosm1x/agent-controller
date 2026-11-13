/**
 * One-off operator script: remove remembered mailbox passwords from the agent's stores.
 * Real schema (initDatabase + the event bus's own initialiser + the two lazily created
 * ritual tables) on a file in this test's temp folder, a scratch KB folder and scratch
 * archives. Synthetic fixtures only (example.com addresses, made-up values).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import BetterSqlite3 from "better-sqlite3";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/index.js";
import { cancelPendingRegeneration } from "../src/db/jarvis-index.js";
import { reindexJarvisKb } from "../src/db/jarvis-reindex.js";
import { PersistentEventBus } from "../src/lib/events/bus.js";
import { ensureRitualControlTables } from "../src/rituals/ritual-controls.js";
import { argsSha256 } from "../src/lib/args-sha256.js";
import {
  PASSWORD_WITHHELD_PLACEHOLDER as PH,
  candidateRuns,
  passwordFingerprint,
  replaceUnprovenValues,
} from "../src/lib/v8-4/password-gate.js";
import { VERIFYING_COMMANDS } from "../src/lib/v8-4/mailbox-passwords.js";
import {
  DB_STORES,
  REACH,
  Refusal,
  SCAN_FILE_CAP,
  collectFromText,
  findDbWriters,
  hasMailboxContext,
  main,
  parseArgs,
  replaceCollected,
  runGroups,
  runPrune,
  type PruneOptions,
  type Stage,
} from "./prune-mailbox-passwords.js";

vi.hoisted(() => {
  delete process.env.COMMIT_DB_KEY;
  delete process.env.DRIVE_KB_FOLDER_ID;
});

/** The operator gate is the first thing main calls; counted so an import never runs main. */
const gate = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/operator-gate.js", () => ({
  requireOperatorContext: () => {
    gate.calls++;
  },
}));

/**
 * Fault injection for fs calls the script makes (`<op>:<exact path>` → error code). As
 * root, permissions cannot make a folder unreadable, so a fault stands in for
 * EACCES/EIO. `wx` opens (the script's temp files) are recorded.
 */
const fsFault = vi.hoisted(() => new Map<string, string>());
const tempOpens = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs")>();
  const fault = (op: string, p: unknown): void => {
    const code = fsFault.get(`${op}:${String(p)}`);
    if (code) throw Object.assign(new Error(`synthetic fault ${String(p)}`), { code });
  };
  const wrap =
    <F extends (...a: never[]) => unknown>(op: string, f: F): F =>
    ((p: unknown, ...rest: unknown[]) => {
      fault(op, p);
      return (f as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as unknown as F;
  const renameSync = ((a: unknown, b: unknown) => {
    fault("rename", b);
    return m.renameSync(a as string, b as string);
  }) as typeof m.renameSync;
  const openSync = ((p: unknown, flags: unknown, ...rest: unknown[]) => {
    if (flags === "wx") tempOpens.push(String(p));
    return (m.openSync as (...a: unknown[]) => number)(p, flags, ...rest);
  }) as typeof m.openSync;
  return {
    ...m,
    readdirSync: wrap("readdir", m.readdirSync),
    readFileSync: wrap("read", m.readFileSync),
    rmSync: wrap("rm", m.rmSync),
    renameSync,
    openSync,
  };
});

// ── fixtures (made up) ─────────────────────────────────────────────────────
const V_CONV = "Qx7Lm2Vp9Rt4Wz8K"; // 16
const V_TASK = "aB3cD4eF5gH6iJ7kL8mN9";
const V_ESC = "Pq8Rs7Tu6Vw5Xy4Za3";
const V_RA = "Hk2Jm3Ln4Po5Qr6St7";
const V_MTC = "Wd9Xe8Yf7Zg6Ah5Bi4";
const V_DAY = "Cj4Dk5El6Fm7Gn8Ho9Ip";
const V_NOTE = "Ue2Vf3Wg4Xh5Yi6Zj7";
const V_DISK = "Rt1Sy2Tu3Uv4Vw5Wx6";
const V_ARCH = "Lm3Nn4Oo5Pp6Qq7Rr8Ss";
const V_TOMB = "Tb6Uc7Vd8We9Xf0Yg1";
const V_APPR = "Ap2Bq3Cr4Ds5Et6Fu7";
const COLLECTED = [V_CONV, V_TASK, V_ESC, V_RA, V_MTC, V_DAY, V_NOTE, V_DISK, V_ARCH, V_TOMB, V_APPR];
const W = "Zr5Ty6Ui7Op8As9Df";
const X = "Hb3Nc4Md5Le6Kf7Jg";
const fp = passwordFingerprint;
/** Every candidate of every collected run: the escape run also gives its `n`-prefixed form. */
const EXPECTED_FPS = new Set([...COLLECTED.map(fp), fp(`n${V_ESC}`)]);
// Look-alikes that must never be collected.
const NO_DIGIT = "AbcdefGhijklMnopQ"; // 17
const SHORT_15 = "Ab1Cd2Ef3Gh4Ij5"; // 15
const LONG_65 = `${"Ab1".repeat(21)}Cd`; // 65
const FAR = "Fa1Gb2Hc3Id4Je5Kf6"; // beyond reach
const NO_CTX = "Nc5Od6Pe7Qf8Rg9Sh0"; // password word, no mailbox context anywhere
const LONGER = `X${V_TASK}`; // the value inside a longer run
const LOOKALIKES = [NO_DIGIT, SHORT_15, LONG_65, FAR, NO_CTX, LONGER];

const CONV_A = `La contraseña del buzón ops@example.com es ${V_CONV}, guárdala bien.`;
const CONV_B = `Recordatorio semanal: ${V_CONV} sigue activo hoy.`; // no context: replaced only
const CONV_C = `Buzón ops@example.com — password: ${NO_DIGIT}, clave ${SHORT_15}, pwd ${LONG_65}.`;
const CONV_D = `correo ops@example.com. password:${" .".repeat(45)} ${FAR} fin.`;
const CONV_E = `password: ${NO_CTX} para el panel.`;
const TASK_DESC = `password ${V_CONV} y otra vez ${V_CONV} al final`;
const TASK_OUT = JSON.stringify({ text: `mailbox: ventas@example.com\npassword: ${V_TASK}` });
const RUN_OUT = JSON.stringify({ text: `resultado ${V_TASK} y token ${LONGER}` });
const EVENT_DATA = JSON.stringify({ msg: `correo soporte@example.com\nclave:\n${V_ESC}` });
const RA_QUERY = `buzón password ${V_RA}`;
const RA_SNIPPETS = JSON.stringify([`snippet uno ${V_RA}`, "otro"]);
const MTC_INPUT = `${VERIFYING_COMMANDS[0]} show --account ops\npassword: ${V_MTC}`;
const TOMB_TERMS = `buzón password ${V_TOMB}`;
const GE_SUMMARY = `Resumen semanal: ${V_CONV} sigue igual.`; // replaced only
const APPR_ARGS = JSON.stringify({ account: "ops@example.com", password: V_APPR });
const DAY_PATH = "logs/day-logs/2026-01-02.md";
const DAY_TEXT = `# Day Log: 2026-01-02\n\n- [10:00:00] **JARVIS**: Buzón info@example.com turnoalfa — contraseña: ${V_DAY}\n`;
const NOTE_PATH = "notes/sintetica-b.md";
const NOTE_TEXT = `# Nota\n\nmailbox x@example.com password: ${V_NOTE} notabeta\n`;
const DISK_ONLY_PATH = "projects/solo-disco.md";
const DISK_ONLY_TEXT = `# Solo disco\n\ncorreo y@example.com contraseña ${V_DISK}\n`;
const TXT_PATH = "notes/no-markdown.txt";
const TXT_TEXT = `copia ${V_NOTE}\n`; // not .md: never listed
const CREDENTIALS = JSON.stringify({ wp_pass: V_CONV });
const ARCH_HIT = "tasks-retention-2026-01-01-10-30-00.jsonl.gz";
const ARCH_MISS = "tasks-retention-2026-01-02-10-30-00.jsonl.gz";
const ARCH_LINES = [
  JSON.stringify({ table: "tasks", row: { description: `correo a@example.com password: ${V_ARCH}` } }),
  JSON.stringify({ table: "runs", row: { output: JSON.stringify({ t: `again ${V_ARCH}` }) } }),
  JSON.stringify({ table: "tasks", row: { description: "sin nada" } }),
];
const FIXTURE_SENTENCES = [CONV_A, CONV_B, CONV_C, CONV_D, CONV_E, TASK_DESC, MTC_INPUT, GE_SUMMARY, "turnoalfa", "notabeta", "guárdala", "Resumen"];
const OLD_STAMP = "2000-01-01 00:00:00";
const TAG = "[prune-mailbox-passwords]";

let root: string;
let dbPath: string;
let kbDir: string;
let arDir: string;
const prevMirror = process.env.JARVIS_KB_MIRROR_DIR;
const quiet = () => {};
const okWriters = () => ({ available: true, pids: [] as number[] });

function writeKb(rel: string, text: string): void {
  const p = join(kbDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/**
 * `scheduled_tasks` is created lazily by src/rituals/dynamic.ts, whose import pulls in
 * the dispatcher and the router; its DDL is taken from that file's own text instead.
 */
function scheduledTasksDdl(): string {
  const src = readFileSync(join(__dirname, "..", "src", "rituals", "dynamic.ts"), "utf8");
  const m = /const CREATE_TABLE_SQL = `([^`]+)`/.exec(src);
  if (!m) throw new Error("scheduled_tasks DDL not found");
  return m[1]!;
}

/** The full schema: initDatabase, the event bus, and the two lazily created ritual tables. */
function initEmpty(): BetterSqlite3.Database {
  initDatabase(dbPath);
  cancelPendingRegeneration();
  const db = getDatabase();
  new PersistentEventBus({ db, cleanupIntervalMs: 0 });
  ensureRitualControlTables();
  db.exec(scheduledTasksDdl());
  return db;
}

/** Every store holds its fixture; the db is closed when this returns. */
function seed(opts: { seenTable?: boolean } = {}): void {
  const db = initEmpty();
  const conv = db.prepare("INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', ?)");
  for (const c of [CONV_A, CONV_B, CONV_C, CONV_D, CONV_E]) conv.run(c);
  db.prepare("INSERT INTO tasks (task_id, title, description, output) VALUES ('t1', 'T', ?, ?)").run(TASK_DESC, TASK_OUT);
  db.prepare("INSERT INTO runs (run_id, task_id, agent_type, input, output) VALUES ('r1', 't1', 'fast', 'in', ?)").run(RUN_OUT);
  db.prepare("INSERT INTO recall_audit (bank, query, source, result_snippets) VALUES ('mc-jarvis', ?, 'sqlite', ?)").run(
    RA_QUERY,
    RA_SNIPPETS,
  );
  db.prepare(
    "INSERT INTO events (id, type, category, timestamp, workspace_id, data) VALUES ('e1', 'x', 'y', '2026-01-01T00:00:00Z', 'default', ?)",
  ).run(EVENT_DATA);
  db.prepare("INSERT INTO mined_test_cases (case_id, category, input, expected) VALUES ('m1', 'c', ?, 'e')").run(MTC_INPUT);
  db.prepare("INSERT INTO memory_tombstones (fact_id, reason, terms, new_terms) VALUES (1, 'superseded', ?, 'x')").run(TOMB_TERMS);
  db.prepare("INSERT INTO general_events (event_id, level, title, summary, start_at) VALUES ('g1', 'general', 'T', ?, '2026-01-01')").run(
    GE_SUMMARY,
  );
  db.prepare("INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, decision) VALUES ('th', 'mail', 'sha', ?, 'expired')").run(
    APPR_ARGS,
  );
  db.prepare("INSERT INTO projects (id, slug, name, credentials) VALUES ('p1', 'syn', 'Syn', ?)").run(CREDENTIALS);
  const kb = db.prepare(
    "INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, priority, related_to, updated_at) VALUES (?, ?, 'T', ?, '[]', 'workspace', 90, '[]', ?)",
  );
  kb.run(DAY_PATH, DAY_PATH, DAY_TEXT, OLD_STAMP);
  kb.run(NOTE_PATH, NOTE_PATH, NOTE_TEXT, OLD_STAMP);
  if (opts.seenTable === false) db.exec("DROP TABLE mailbox_password_seen");
  closeDatabase();
  writeKb(DAY_PATH, DAY_TEXT);
  writeKb(NOTE_PATH, NOTE_TEXT); // disk newer than the row (mtime now), same text
  writeKb(DISK_ONLY_PATH, DISK_ONLY_TEXT);
  writeKb(TXT_PATH, TXT_TEXT);
  writeFileSync(join(arDir, ARCH_HIT), gzipSync(`${ARCH_LINES.join("\n")}\n`));
  writeFileSync(join(arDir, ARCH_MISS), gzipSync(`${JSON.stringify({ table: "tasks", row: { description: "nada" } })}\n`));
  const old = new Date("2026-01-03T00:00:00Z");
  for (const f of [ARCH_HIT, ARCH_MISS]) utimesSync(join(arDir, f), old, old);
}

/** Only conversation rows (and optionally more statements); the db is closed when this returns. */
function seedRows(convs: string[], extra?: (db: BetterSqlite3.Database) => void): void {
  const db = initEmpty();
  for (const c of convs) db.prepare("INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', ?)").run(c);
  extra?.(db);
  closeDatabase();
}

function ro(): BetterSqlite3.Database {
  return new BetterSqlite3(dbPath, { readonly: true });
}
function cell(sql: string, ...args: unknown[]): unknown {
  const db = ro();
  try {
    const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}
function count(sql: string, ...args: unknown[]): number {
  return cell(sql, ...args) as number;
}
function exec(sql: string): void {
  const w = new BetterSqlite3(dbPath);
  try {
    w.exec(sql);
  } finally {
    w.close();
  }
}

/**
 * sha256 over every file under a folder: path, bytes and mtime. SQLite's own side files
 * (`-wal`, `-shm`), which a read-only open of a WAL database may create, are the engine's
 * and are left out; the database file itself is included.
 */
function folderDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (name.endsWith(".db-wal") || name.endsWith(".db-shm")) continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else h.update(`${r}\0${st.mtimeMs}\0`).update(readFileSync(join(dir, r)));
    }
  };
  walk("");
  return h.digest("hex");
}

/** Every row's text in every store (and the credential store), read through a fresh connection. */
function rowSnapshot(): string {
  const db = ro();
  try {
    const parts: unknown[] = [];
    for (const [t, cols] of [
      ...DB_STORES.map((s) => [s.table, s.columns] as const),
      ["projects", ["credentials"]] as const,
      ["mailbox_password_seen", ["fingerprint"]] as const,
    ]) {
      parts.push(db.prepare(`SELECT rowid, ${cols.join(", ")} FROM ${t} ORDER BY rowid`).all());
    }
    return JSON.stringify(parts);
  } finally {
    db.close();
  }
}

/** rowSnapshot over every store but one (a test may replace that table). */
function rowSnapshotWithout(table: string): string {
  const db = ro();
  try {
    return JSON.stringify(
      DB_STORES.filter((s) => s.table !== table).map((s) => db.prepare(`SELECT rowid, ${s.columns.join(", ")} FROM ${s.table} ORDER BY rowid`).all()),
    );
  } finally {
    db.close();
  }
}

function prune(apply: boolean, extra: Partial<PruneOptions> = {}) {
  return runPrune({ dbPath, kbRoot: kbDir, archiveDir: arDir, apply, log: quiet, ...extra });
}
function pruneLogged(apply: boolean, extra: Partial<PruneOptions> = {}) {
  const lines: string[] = [];
  const r = runPrune({ dbPath, kbRoot: kbDir, archiveDir: arDir, apply, log: (l) => lines.push(l), ...extra });
  return { r, lines, nothing: lines.some((l) => l.endsWith("nothing to change")) };
}
/** Throws at the n-th occurrence (1-based) of a stage. */
function crashAt(stage: Stage, nth = 1): Partial<PruneOptions> {
  let k = 0;
  return {
    onStage: (s) => {
      if (s === stage && ++k === nth) throw new Error("synthetic stop");
    },
  };
}
function deps(over: Partial<Parameters<typeof main>[1]> = {}, out: string[] = []) {
  return {
    requireOperatorContext: () => {},
    findDbWriters: okWriters,
    runPrune,
    log: (l: string) => out.push(l),
    error: (l: string) => out.push(l),
    ...over,
  };
}
const ARGV = () => ["--db", dbPath, "--kb", kbDir, "--archive", arDir];
const APPLY = () => [...ARGV(), "--apply", "--i-stopped-the-service"];

function archiveText(name: string): string {
  return gunzipSync(readFileSync(join(arDir, name))).toString("utf8");
}

/** Where any of the values is still stored: db columns, KB `.md` files, archives (counts by place). */
function remaining(values: string[]): string[] {
  const left: string[] = [];
  const db = ro();
  try {
    for (const s of DB_STORES) {
      for (const c of s.columns) {
        for (const v of values) {
          // The longer run that contains V_TASK stays in runs.output by design: blank it out of the probe.
          const n = (
            db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE instr(replace(${c}, '${LONGER}', ''), ?) > 0`).get(v) as {
              n: number;
            }
          ).n;
          if (n > 0) left.push(`${s.table}.${c}#${values.indexOf(v)}`);
        }
      }
    }
  } finally {
    db.close();
  }
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(kbDir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(kbDir, r)).isDirectory()) walk(r);
      else if (name.endsWith(".md")) {
        const t = readFileSync(join(kbDir, r), "utf8");
        values.forEach((v, i) => t.includes(v) && left.push(`kb:${r}#${i}`));
      }
    }
  };
  walk("");
  for (const name of readdirSync(arDir).filter((f) => f.endsWith(".jsonl.gz"))) {
    const t = archiveText(name);
    values.forEach((v, i) => t.includes(v) && left.push(`archive:${name}#${i}`));
  }
  return left;
}

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mc-pwprune-test-"));
  dbPath = join(root, "data", "mc.db");
  kbDir = join(root, "kb");
  arDir = join(root, "data", "archive");
  mkdirSync(kbDir, { recursive: true });
  mkdirSync(arDir, { recursive: true });
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  tempOpens.length = 0;
});

afterEach(() => {
  fsFault.clear();
  closeDatabase();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  if (prevMirror === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
  else process.env.JARVIS_KB_MIRROR_DIR = prevMirror;
});

// ── pure rules ─────────────────────────────────────────────────────────────

describe("collection rule", () => {
  const got = (text: string): Set<string> => {
    const s = new Set<string>();
    collectFromText(text, s);
    return s;
  };

  it("main never runs on import", () => {
    expect(gate.calls).toBe(0);
  });

  it("collects a mixed 16–64 run after a password word in a mailbox text", () => {
    expect(got(CONV_A)).toEqual(new Set([fp(V_CONV)]));
    expect(got(`PASSWORD: ${V_CONV} a@example.com`)).toEqual(new Set([fp(V_CONV)]));
    expect(got(`CONTRASEÑA ${V_CONV} en el BUZÓN`)).toEqual(new Set([fp(V_CONV)]));
    expect(got(MTC_INPUT)).toEqual(new Set([fp(V_MTC)])); // command name as the only context
    expect(got(APPR_ARGS)).toEqual(new Set([fp(V_APPR)])); // JSON key as the password word
    for (const w of ["contrasena", "clave", "passwd", "pwd"]) {
      expect(got(`${w} ${V_CONV} mailbox`)).toEqual(new Set([fp(V_CONV)]));
    }
  });

  it("never collects the look-alikes", () => {
    expect(got(CONV_C).size).toBe(0); // no digit, 15 chars, 65 chars
    expect(got(CONV_D).size).toBe(0); // beyond reach
    expect(got(CONV_E).size).toBe(0); // no mailbox context
    expect(got(`correo password ${V_CONV.toLowerCase()}`).size).toBe(0); // no uppercase
    expect(got(`a@example password ${V_CONV}`).size).toBe(0); // not a domain
    expect(got(`password ${V_CONV} a@example.c`).size).toBe(0); // one-letter top label
    expect(got(`${V_CONV} password mailbox`).size).toBe(0); // value before the word
    // ensure_ascii text: `\u00f1` inside contrase\u00f1a does not make a password word.
    expect(got(JSON.stringify({ m: "x" }).replace("x", `buz\\u00f3n a@example.com contrase\\u00f1a: ${W}`)).size).toBe(0);
  });

  it("a password word never starts after a letter; an escape letter is not a letter of the word", () => {
    expect(got(`enclave ops@example.com id ${V_CONV}`).size).toBe(0);
    expect(got(`superpwd ops@example.com ${V_CONV}`).size).toBe(0);
    expect(got(`Ñclave ops@example.com ${V_CONV}`).size).toBe(0);
    expect(got(`x\\npassword: ${V_CONV} ops@example.com`)).toEqual(new Set([fp(V_CONV)]));
    expect(got(`(clave) ops@example.com ${V_CONV}`)).toEqual(new Set([fp(V_CONV)]));
  });

  it("reach: a value starting 79 units after the word is collected, 80 is not", () => {
    const at = (gap: number) => `mailbox password${".".repeat(gap)}${V_CONV}`;
    expect(REACH).toBe(80);
    expect(got(at(79)).size).toBe(1);
    expect(got(at(80)).size).toBe(0);
  });

  it("runs come from the reply check's candidateRuns, grouped per run, longest first", () => {
    const text = `a ${V_CONV} b \\n${V_TASK} c \\u001b${V_CONV} d ${LONG_65} e ${SHORT_15}`;
    const groups = runGroups(text).map((g) => g.candidates.map((c) => text.slice(c.start, c.end)));
    expect(groups).toEqual([[V_CONV], [`n${V_TASK}`, V_TASK], [`u001b${V_CONV}`, `001b${V_CONV}`, V_CONV]]);
    expect(groups.flat()).toEqual(candidateRuns(text).map((c) => text.slice(c.start, c.end)));
  });

  it("a run after a backslash registers every candidate; the replacement keeps the escape in JSON", () => {
    expect(got(EVENT_DATA)).toEqual(new Set([fp(V_ESC), fp(`n${V_ESC}`)]));
    for (const fps of [new Set([fp(V_ESC)]), got(EVENT_DATA)]) {
      const r = replaceCollected(EVENT_DATA, fps);
      expect(r.replaced).toBe(1);
      expect(JSON.parse(r.text)).toEqual({ msg: `correo soporte@example.com\nclave:\n${PH}` });
    }
  });

  it("P2 shape: a value glued after a JSON \\u escape ends as valid JSON with the placeholder", () => {
    const ev = JSON.stringify({ m: `mailbox a@example.com password:\u001b${V_CONV}` });
    expect(ev).toContain("\\u001b");
    const s = got(ev);
    expect(s).toEqual(new Set([fp(`u001b${V_CONV}`), fp(`001b${V_CONV}`), fp(V_CONV)]));
    const r = replaceCollected(ev, s);
    expect(r.unsafe).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ m: `mailbox a@example.com password:\u001b${PH}` });
    expect(r.text.includes(V_CONV)).toBe(false);
  });

  it("P5 shape: a literal backslash before the value in plain text leaves no character of it", () => {
    const val = `${V_CONV}ab`; // 18
    const s = got(`mailbox ops@example.com password: C:\\${val}`);
    expect(s.has(fp(val))).toBe(true); // what the reply check computes for the true value
    const g = replaceUnprovenValues(`es ${val}`, { isSeen: (f) => s.has(f), isProven: () => false });
    expect(g.withheld).toBe(1);
    expect(replaceCollected(`password: C:\\${val}`, s).text).toBe(`password: C:\\${PH}`);
    expect(replaceCollected(`x \\${val}`, s).text).toBe(`x \\${PH}`);
  });

  it("the reply check withholds what the script registers", () => {
    const s = got(`buzón ops@example.com — password: ${V_CONV}`);
    const reply = `Claro, es ${V_CONV}. Y en JSON: "x\\n${V_CONV}"`;
    const g = replaceUnprovenValues(reply, { isSeen: (f) => s.has(f), isProven: () => false });
    expect(g.withheld).toBe(2);
    expect(g.text).toBe(replaceCollected(reply, s).text);
  });

  describe("agreement with the reply check on the seen set the script leaves", () => {
    const S = new Set<string>();
    collectFromText(`mailbox a@example.com password: ${V_CONV}`, S);
    collectFromText(JSON.stringify({ m: `correo a@example.com clave:\n${V_CONV}` }), S);
    collectFromText(JSON.stringify({ m: `correo a@example.com clave:\u00e9${V_CONV}` }), S);
    const check = (t: string) => replaceUnprovenValues(t, { isSeen: (f) => S.has(f), isProven: () => false }).text;
    const V = V_CONV;
    const plain: Array<[string, string, string]> = [
      ["start of text", `${V} es la clave`, `${PH} es la clave`],
      ["two values with a space", `${V} ${V}`, `${PH} ${PH}`],
      ["value then placeholder", `${V}${PH}`, `${PH}${PH}`],
      ["markdown", `**${V}** \`${V}\``, `**${PH}** \`${PH}\``],
      ["in a URL", `https://x.example/?p=${V}&y=1`, `https://x.example/?p=${PH}&y=1`],
      ["glued pair (one 32-run): neither", `${V}${V}`, `${V}${V}`],
      ["split by a line wrap: neither", `${V.slice(0, 8)}\n${V.slice(8)}`, `${V.slice(0, 8)}\n${V.slice(8)}`],
      ["literal `\\n` before the value: the escape letter goes too", `log: x\\n${V} fin`, `log: x\\${PH} fin`],
    ];
    for (const [name, t, want] of plain) {
      it(`plain: ${name}`, () => {
        expect(replaceCollected(t, S).text).toBe(want);
        expect(check(t)).toBe(want);
      });
    }
    const json: Array<[string, unknown]> = [
      ["after \\n", { m: `a\n${V}` }],
      ["after \\u001b", { m: `a\u001b${V}` }],
      ["after a quote", { m: `"${V}"` }],
      ["literal backslash then value", { m: `C:\\${V}` }],
      ["as a JSON key", { [V]: 1, k: `mailbox ${V}` }],
    ];
    for (const [name, obj] of json) {
      it(`json: ${name} — valid, value gone, every other byte equal`, () => {
        const t = JSON.stringify(obj);
        const r = replaceCollected(t, S);
        expect(r.unsafe).toBe(false);
        expect(r.text).toBe(t.split(V).join(PH));
        expect(JSON.stringify(JSON.parse(r.text)).includes(V)).toBe(false);
      });
    }
  });

  it("replaces whole runs only, every occurrence, nothing else", () => {
    const fps = new Set([fp(V_CONV), fp(V_TASK)]);
    expect(replaceCollected(TASK_DESC, fps)).toEqual({
      text: `password ${PH} y otra vez ${PH} al final`,
      replaced: 2,
      unsafe: false,
    });
    const r = replaceCollected(RUN_OUT, fps);
    expect(r.replaced).toBe(1);
    expect(r.text).toBe(JSON.stringify({ text: `resultado ${PH} y token ${LONGER}` }));
    expect(replaceCollected(CONV_C, fps)).toEqual({ text: CONV_C, replaced: 0, unsafe: false });
  });

  it("JSON guard: a JSON text no collected candidate keeps parsing is left as it was (unsafe)", () => {
    // Only the full run `u001b…` is known (collected from a plain text); inside JSON its
    // replacement would break the escape and no shorter candidate is known.
    const known = got(`mailbox a@example.com password: u001b${V_CONV}`);
    expect(known).toEqual(new Set([fp(`u001b${V_CONV}`)]));
    const ev = JSON.stringify({ m: `x\u001b${V_CONV}` });
    expect(replaceCollected(ev, known)).toEqual({ text: ev, replaced: 0, unsafe: true });
    // Plain text is not guarded: the value goes.
    expect(replaceCollected(`a \\u001b${V_CONV}`, known).text).toBe(`a \\${PH}`);
  });

  it("nested JSON: the longest candidate breaking an inner payload gives way to a shorter one that fits", () => {
    const inner = JSON.stringify({ t: `a\n${V_CONV}` });
    const outer = JSON.stringify({ output: inner, deeper: JSON.stringify({ x: inner }) });
    const both = new Set([fp(`n${V_CONV}`), fp(V_CONV)]);
    const r = replaceCollected(outer, both);
    expect(r.unsafe).toBe(false);
    expect(r.text.includes(V_CONV)).toBe(false);
    const o = JSON.parse(r.text) as { output: string; deeper: string };
    expect(JSON.parse(o.output)).toEqual({ t: `a\n${PH}` });
    expect(JSON.parse(JSON.parse(o.deeper).x)).toEqual({ t: `a\n${PH}` });
  });

  it("nested JSON: when no candidate keeps an inner payload parsing, the text is unsafe and left", () => {
    const outer = JSON.stringify({ output: JSON.stringify({ t: `a\n${V_CONV}` }) });
    const onlyLong = new Set([fp(`n${V_CONV}`)]); // the outer would still parse, the inner not
    expect(replaceCollected(outer, onlyLong)).toEqual({ text: outer, replaced: 0, unsafe: true });
    // A string that is not a JSON payload is not held to the rule.
    const notPayload = JSON.stringify({ output: `texto a\\n${V_CONV}` });
    expect(replaceCollected(notPayload, onlyLong).unsafe).toBe(false);
  });

  it("idempotent: the placeholder never brings a run into reach or adds a password word", () => {
    // 91 characters but 32 units after the word: a run counts as one unit, so the later
    // run is collected now, not only after the long value has shrunk to the placeholder.
    const long = `Ab1${"x".repeat(55)}Z9`; // 60, mixed
    const later = "Gt5Hy6Ju7Ki8Lo9Mp0";
    const text = `mailbox password ${long}${" ".repeat(30)}${later}`;
    const first = new Set<string>();
    collectFromText(text, first);
    expect(first).toEqual(new Set([fp(long), fp(later)]));
    const after = replaceCollected(text, first).text;
    const second = new Set<string>();
    expect(collectFromText(after, second)).toBe(0);
    // The placeholder's own password word is not a password word.
    expect(got(`mailbox ${PH} ${later}`).size).toBe(0);
  });

  it("mailbox context: domain token, command name, words", () => {
    expect(hasMailboxContext("write to a@b.example.com.")).toBe(true);
    expect(hasMailboxContext("write to a@localhost")).toBe(false);
    expect(hasMailboxContext(`run ${VERIFYING_COMMANDS[0]} now`)).toBe(true);
    expect(hasMailboxContext("el BUZON")).toBe(true);
    expect(hasMailboxContext("nothing here @ all")).toBe(false);
  });

  it("linear on long texts", () => {
    const hostile = `${"@a-".repeat(200_000)}${"password ".repeat(100_000)}${"\\nAb1".repeat(100_000)}${`pwd \\n${V_CONV} `.repeat(50_000)}a@example.com`;
    const t = Date.now();
    const s = new Set<string>();
    expect(collectFromText(hostile, s)).toBe(50_000);
    expect(replaceCollected(hostile, s).replaced).toBe(50_000);
    hasMailboxContext(hostile);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("timing: a 5 MB JSON text with 200 escaped hits on the fallback path, flat and nested", () => {
    const parts: string[] = [];
    for (let i = 0; i < 200; i++) parts.push(`x\u001b${V_CONV} ${"y".repeat(25_000)}`);
    const big = JSON.stringify({ m: parts.join(" ") });
    expect(big.length).toBeGreaterThan(5_000_000);
    const fits = new Set([fp(`u001b${V_CONV}`), fp(V_CONV)]); // longest breaks, shortest fits: 2 checks per run
    let t = Date.now();
    expect(replaceCollected(big, fits)).toMatchObject({ replaced: 200, unsafe: false });
    const flatMs = Date.now() - t;
    const none = new Set([fp(`u001b${V_CONV}`), fp(`001b${V_CONV}`)]); // nothing fits: stops at the first run
    t = Date.now();
    expect(replaceCollected(big, none).unsafe).toBe(true);
    const noneMs = Date.now() - t;
    // The same payload one level down (a JSON string holding JSON): each check also parses the inner text.
    const nested = JSON.stringify({ output: big });
    t = Date.now();
    expect(replaceCollected(nested, new Set([fp(`nu001b${V_CONV}`), fp(`u001b${V_CONV}`), fp(V_CONV)])).unsafe).toBe(false);
    const nestedMs = Date.now() - t;
    console.log(`PERF json-fallback 5MB/200 hits: flat_ms=${flatMs} none_fits_ms=${noneMs} nested_ms=${nestedMs}`);
  }, 300_000);
});

// ── stores ─────────────────────────────────────────────────────────────────

describe("stores", () => {
  it("dry run changes nothing: db file, KB folder and archives are byte- and mtime-identical", () => {
    seed();
    const before = folderDigest(root);
    const rowsBefore = rowSnapshot();
    const r = prune(false);
    expect(folderDigest(root)).toBe(before);
    expect(rowSnapshot()).toBe(rowsBefore);
    expect(r.distinct).toBe(EXPECTED_FPS.size);
    expect(r.fingerprintsAdded).toBe(EXPECTED_FPS.size); // would add
    expect(r.stores.every((s) => s.changed === 0)).toBe(true);
    expect(r.stores.find((s) => s.store === "conversations")!.hit).toBe(2);
  });

  it("dry-run report: per store the rows/files/lines with a hit and the distinct fingerprints with context, plus totals", () => {
    seed();
    const { r, lines } = pruneLogged(false);
    expect(r.ok).toBe(true);
    const line = (store: string) => lines.find((l) => l.startsWith(`${TAG} store=${store} `));
    expect(line("conversations")).toBe(`${TAG} store=conversations sources=1 collected=1 hit=2 changed=0`);
    expect(line("tasks")).toBe(`${TAG} store=tasks sources=1 collected=1 hit=1 changed=0`);
    expect(line("events")).toBe(`${TAG} store=events sources=1 collected=2 hit=1 changed=0`);
    expect(line("general_events")).toBe(`${TAG} store=general_events sources=0 collected=0 hit=1 changed=0`);
    expect(line("kb-files")).toBe(`${TAG} store=kb-files sources=3 collected=3 hit=3 changed=0`);
    expect(line("archives")).toBe(`${TAG} store=archives sources=1 collected=1 hit=1 changed=0 lines=2`);
    expect(lines).toContain(`${TAG} collected_fingerprints=${EXPECTED_FPS.size}`);
    expect(lines).toContain(`${TAG} fingerprints_known=0 fingerprints_to_add=${EXPECTED_FPS.size}`);
    expect(lines).toContain(`${TAG} uncovered_hits=0`);
    expect(lines.some((l) => /timing collect_ms=\d+ rest_ms=\d+ sweep_ms=\d+$/.test(l))).toBe(true);
  });

  it("apply replaces exactly the collected values in every store; credentials untouched", () => {
    seed();
    const r = prune(true);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.stores.map((s) => [s.store, s]));
    expect(by.conversations).toMatchObject({ hit: 2, changed: 2 });
    expect(by.tasks).toMatchObject({ hit: 1, changed: 1 });
    expect(by.runs).toMatchObject({ hit: 1, changed: 1 });
    expect(by.recall_audit).toMatchObject({ hit: 1, changed: 1 });
    expect(by.events).toMatchObject({ hit: 1, changed: 1 });
    expect(by.mined_test_cases).toMatchObject({ hit: 1, changed: 1 });
    expect(by.memory_tombstones).toMatchObject({ hit: 1, changed: 1, sources: 1 });
    expect(by.general_events).toMatchObject({ hit: 1, changed: 1, sources: 0 });
    expect(by.tool_approvals).toMatchObject({ hit: 1, changed: 1, sources: 1 });
    expect(by.jarvis_files).toMatchObject({ hit: 2, changed: 2 });
    expect(by["kb-files"]).toMatchObject({ hit: 3, changed: 3 });
    expect(by.archives).toMatchObject({ hit: 1, changed: 1 });

    const conv = (id: number) => cell("SELECT content FROM conversations WHERE id = ?", id);
    expect(conv(1)).toBe(CONV_A.replace(V_CONV, PH)); // collected here
    expect(conv(2)).toBe(CONV_B.replace(V_CONV, PH)); // no context: replaced only
    expect(conv(3)).toBe(CONV_C);
    expect(conv(4)).toBe(CONV_D);
    expect(conv(5)).toBe(CONV_E);
    expect(cell("SELECT description FROM tasks")).toBe(`password ${PH} y otra vez ${PH} al final`);
    expect(JSON.parse(cell("SELECT output FROM tasks") as string)).toEqual({
      text: `mailbox: ventas@example.com\npassword: ${PH}`,
    });
    expect(JSON.parse(cell("SELECT output FROM runs") as string)).toEqual({ text: `resultado ${PH} y token ${LONGER}` });
    expect(cell("SELECT query FROM recall_audit")).toBe(`buzón password ${PH}`);
    expect(JSON.parse(cell("SELECT result_snippets FROM recall_audit") as string)).toEqual([`snippet uno ${PH}`, "otro"]);
    expect(JSON.parse(cell("SELECT data FROM events") as string)).toEqual({ msg: `correo soporte@example.com\nclave:\n${PH}` });
    expect(cell("SELECT input FROM mined_test_cases")).toBe(MTC_INPUT.replace(V_MTC, PH));
    expect(cell("SELECT terms FROM memory_tombstones")).toBe(`buzón password ${PH}`);
    expect(cell("SELECT summary FROM general_events")).toBe(GE_SUMMARY.replace(V_CONV, PH));
    expect(JSON.parse(cell("SELECT args_json FROM tool_approvals") as string)).toEqual({ account: "ops@example.com", password: PH });
    expect(cell("SELECT credentials FROM projects")).toBe(CREDENTIALS);

    // Row and disk file change together; the disk-only file too; a non-.md file never.
    expect(cell("SELECT content FROM jarvis_files WHERE path = ?", DAY_PATH)).toBe(DAY_TEXT.replace(V_DAY, PH));
    expect(readFileSync(join(kbDir, DAY_PATH), "utf8")).toBe(DAY_TEXT.replace(V_DAY, PH));
    expect(readFileSync(join(kbDir, NOTE_PATH), "utf8")).toBe(NOTE_TEXT.replace(V_NOTE, PH));
    expect(readFileSync(join(kbDir, DISK_ONLY_PATH), "utf8")).toBe(DISK_ONLY_TEXT.replace(V_DISK, PH));
    expect(readFileSync(join(kbDir, TXT_PATH), "utf8")).toBe(TXT_TEXT);
    // Changed KB rows are newer than any old disk copy; user_edit_time stays.
    expect(cell("SELECT updated_at FROM jarvis_files WHERE path = ?", DAY_PATH)).not.toBe(OLD_STAMP);
    expect(cell("SELECT user_edit_time FROM jarvis_files WHERE path = ?", DAY_PATH)).toBeNull();

    // No collected value is left anywhere it was stored, except the credential store.
    expect(remaining(COLLECTED)).toEqual([]);
    // Look-alikes and the value inside a longer run are still where they were.
    const db = ro();
    try {
      for (const v of LOOKALIKES) {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE instr(content, ?) > 0").get(v) as { n: number }).n;
        const m = (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE instr(output, ?) > 0").get(v) as { n: number }).n;
        expect(n + m).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it("full-text indexes follow (all three are trigger-maintained): the old value finds nothing, a neighbouring word still finds the row", () => {
    seed();
    exec(`INSERT INTO jme_facts (source_task, ts, fact_text, category) VALUES ('t1', 1, 'jmefacto buzón password ${W}', 'event')`);
    expect(count("SELECT COUNT(*) FROM conversations_fts WHERE conversations_fts MATCH ?", `"${V_CONV}"`)).toBe(2);
    expect(count("SELECT COUNT(*) FROM jarvis_files_fts WHERE jarvis_files_fts MATCH ?", `"${V_DAY}"`)).toBe(1);
    expect(count("SELECT COUNT(*) FROM jme_facts_fts WHERE jme_facts_fts MATCH ?", `"${W}"`)).toBe(1);
    const r = prune(true);
    expect(r.ok).toBe(true);
    expect(count("SELECT COUNT(*) FROM conversations_fts WHERE conversations_fts MATCH ?", `"${V_CONV}"`)).toBe(0);
    expect(count("SELECT COUNT(*) FROM conversations_fts WHERE conversations_fts MATCH ?", "Recordatorio")).toBe(1);
    expect(count("SELECT COUNT(*) FROM jarvis_files_fts WHERE jarvis_files_fts MATCH ?", `"${V_DAY}"`)).toBe(0);
    expect(count("SELECT COUNT(*) FROM jarvis_files_fts WHERE jarvis_files_fts MATCH ?", "turnoalfa")).toBe(1);
    expect(count("SELECT COUNT(*) FROM jme_facts_fts WHERE jme_facts_fts MATCH ?", `"${W}"`)).toBe(0);
    expect(count("SELECT COUNT(*) FROM jme_facts_fts WHERE jme_facts_fts MATCH ?", "jmefacto")).toBe(1);
    // The external-content indexes still agree with their tables (rank 1 = compare with the content table).
    const db = new BetterSqlite3(dbPath);
    try {
      for (const t of ["conversations_fts", "jarvis_files_fts", "jme_facts_fts"]) {
        expect(() => db.exec(`INSERT INTO ${t}(${t}, rank) VALUES('integrity-check', 1)`)).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it("archives: a hit is rewritten (lines still JSON, mtime kept); a file with no hit keeps bytes and mtime", () => {
    seed();
    const missBytes = readFileSync(join(arDir, ARCH_MISS));
    const missMtime = statSync(join(arDir, ARCH_MISS)).mtimeMs;
    const hitMtime = statSync(join(arDir, ARCH_HIT)).mtimeMs;
    prune(true);
    expect(readFileSync(join(arDir, ARCH_MISS)).equals(missBytes)).toBe(true);
    expect(statSync(join(arDir, ARCH_MISS)).mtimeMs).toBe(missMtime);
    expect(statSync(join(arDir, ARCH_HIT)).mtimeMs).toBe(hitMtime);
    const text = archiveText(ARCH_HIT);
    expect(text).toBe(`${ARCH_LINES.map((l) => l.split(V_ARCH).join(PH)).join("\n")}\n`);
    for (const line of text.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    expect(readdirSync(arDir).sort()).toEqual([ARCH_HIT, ARCH_MISS]); // no temp left
  });

  it("idempotent: a second run finds nothing, changes nothing and says so", () => {
    seed();
    prune(true);
    const before = folderDigest(root);
    const { r, nothing } = pruneLogged(true);
    expect(r.distinct).toBe(0);
    expect(r.known).toBe(EXPECTED_FPS.size);
    expect(r.stores.every((s) => s.hit === 0 && s.changed === 0)).toBe(true);
    expect(nothing).toBe(true);
    expect(folderDigest(root)).toBe(before);
  });

  it("fingerprints: every candidate is added once, and the known ones are pruned too", () => {
    seed();
    expect(prune(true).fingerprintsAdded).toBe(EXPECTED_FPS.size);
    const db = ro();
    try {
      const got = (db.prepare("SELECT fingerprint FROM mailbox_password_seen").all() as Array<{ fingerprint: string }>).map(
        (r) => r.fingerprint,
      );
      expect(new Set(got)).toEqual(EXPECTED_FPS);
    } finally {
      db.close();
    }
    // A value the mailbox tool printed (only its fingerprint is known) is removed from the stores.
    exec(`INSERT INTO mailbox_password_seen (fingerprint) VALUES ('${fp(W)}')`);
    exec(`INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', 'la herramienta dijo ${W}')`);
    const r = prune(true);
    expect(r.fingerprintsAdded).toBe(0);
    expect(r.stores.find((s) => s.store === "conversations")).toMatchObject({ hit: 1, changed: 1 });
    expect(remaining([W])).toEqual([]);
  });

  it("a run collected near a password word (a false positive included) is replaced everywhere, even without context", () => {
    // The seen table holds values the mailbox tool printed and every candidate this script
    // collected (a document id after "clave" too); each one goes wherever it appears.
    const docId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    seedRows([`Punto clave para ops@example.com: el documento es ${docId}`, `abre https://docs.example/d/${docId}/edit`]);
    expect(prune(true).ok).toBe(true);
    expect(remaining([docId])).toEqual([]);
  });

  it("known fingerprints that appear nowhere: a no-op (database file unchanged), not a failure", () => {
    seedRows(["nada aqui"], (db) => {
      const ins = db.prepare("INSERT INTO mailbox_password_seen (fingerprint) VALUES (?)");
      for (let i = 0; i < 50; i++) ins.run(fp(`Zz${i}Yy${i}Xx${i}Ww${i}Vv`));
    });
    writeKb("n.md", "texto sin nada\n");
    const before = readFileSync(dbPath);
    const r = pruneLogged(true);
    expect(r.r.ok).toBe(true);
    expect(r.r.known).toBe(50);
    expect(r.nothing).toBe(true);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("without the seen table: --apply refuses and writes nothing; the dry run says the table is absent", () => {
    seed({ seenTable: false });
    const before = folderDigest(root);
    expect(() => prune(true)).toThrow(Refusal);
    expect(() => prune(true)).toThrow("SEEN_TABLE_ABSENT");
    expect(folderDigest(root)).toBe(before);
    const { r, lines } = pruneLogged(false);
    expect(r.seenTable).toBe(false);
    expect(lines.some((l) => l.includes("mailbox_password_seen is absent"))).toBe(true);
    const out: string[] = [];
    expect(main(APPLY(), deps({}, out))).toBe(2);
    expect(out.join("\n")).toContain("REFUSED code=SEEN_TABLE_ABSENT");
    expect(folderDigest(root)).toBe(before);
  });

  it("store table vs schema: an absent table is skipped and counted; a listed column missing from a present table refuses", () => {
    seed();
    exec("DROP TABLE ritual_deferrals");
    const { r, lines } = pruneLogged(false);
    expect(r.tablesAbsent).toBe(1);
    expect(lines).toContain(`${TAG} tables_absent=1`);
    exec("ALTER TABLE memory_tombstones DROP COLUMN new_terms");
    const before = folderDigest(root);
    for (const apply of [false, true]) expect(() => prune(apply)).toThrow("STORE_COLUMN_ABSENT");
    const out: string[] = [];
    expect(main(APPLY(), deps({}, out))).toBe(2);
    expect(out).toEqual([`${TAG} REFUSED code=STORE_COLUMN_ABSENT column=memory_tombstones.new_terms — nothing written`]);
    expect(folderDigest(root)).toBe(before);
  });

  it("a failure in the fingerprint transaction changes nothing in any store", () => {
    seed();
    exec("CREATE TRIGGER syn_fail BEFORE INSERT ON mailbox_password_seen BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    const before = folderDigest(kbDir) + folderDigest(arDir);
    const rows = rowSnapshot();
    const out: string[] = [];
    expect(main(APPLY(), deps({}, out))).toBe(1);
    expect(out.join("\n")).toContain("store=fingerprints code=SQLITE_CONSTRAINT_TRIGGER — nothing changed in the stores");
    expect(rowSnapshot()).toBe(rows);
    expect(folderDigest(kbDir) + folderDigest(arDir)).toBe(before);
  });

  it("a failure in the row transaction rolls back every row, says to run again, and a re-run finishes", () => {
    seed();
    exec("CREATE TRIGGER syn_fail BEFORE UPDATE ON mined_test_cases BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    const out: string[] = [];
    expect(main(APPLY(), deps({}, out))).toBe(1);
    expect(out.join("\n")).toContain(
      "ERROR store=mined_test_cases code=SQLITE_CONSTRAINT_TRIGGER — fingerprints recorded, some stores not finished — run the same command again to finish",
    );
    expect(readFileSync(join(kbDir, NOTE_PATH), "utf8")).toBe(NOTE_TEXT.replace(V_NOTE, PH)); // files were rewritten
    expect(cell("SELECT content FROM conversations WHERE id = 1")).toBe(CONV_A);
    expect(cell("SELECT description FROM tasks")).toBe(TASK_DESC);
    expect(cell("SELECT content FROM jarvis_files WHERE path = ?", DAY_PATH)).toBe(DAY_TEXT);
    expect(count("SELECT COUNT(*) FROM mailbox_password_seen")).toBe(EXPECTED_FPS.size); // durable first
    exec("DROP TRIGGER syn_fail");
    expect(prune(true).ok).toBe(true);
    expect(remaining(COLLECTED)).toEqual([]);
  });

  it("compare-and-set: a row changed after it was read fails the row transaction with ROW_CHANGED; a re-run finishes", () => {
    seed();
    const touch = (s: Stage) => {
      if (s === "files") exec(`UPDATE conversations SET content = content || ' editado' WHERE id = 2`);
    };
    expect(() => prune(true, { onStage: touch })).toThrow("conversations:ROW_CHANGED");
    expect(cell("SELECT content FROM conversations WHERE id = 1")).toBe(CONV_A); // rolled back
    const r = prune(true);
    expect(r.ok).toBe(true);
    expect(cell("SELECT content FROM conversations WHERE id = 2")).toBe(`${CONV_B.replace(V_CONV, PH)} editado`);
    expect(remaining(COLLECTED)).toEqual([]);
  });

  it("compare-and-set covers every pruned column of the row: a change in the second written column is ROW_CHANGED", () => {
    seed();
    // tasks.description and tasks.output both change; only output (written second) is edited meanwhile.
    const touch = (s: Stage) => {
      if (s === "files") exec(`UPDATE tasks SET output = '${TASK_OUT.replace("ventas", "compras")}'`);
    };
    expect(() => prune(true, { onStage: touch })).toThrow("tasks:ROW_CHANGED");
    expect(cell("SELECT description FROM tasks")).toBe(TASK_DESC);
    // A pruned column the update does not write is covered too.
    const touch2 = (s: Stage) => {
      if (s === "files") exec(`UPDATE tasks SET error = 'nuevo'`);
    };
    expect(() => prune(true, { onStage: touch2 })).toThrow("tasks:ROW_CHANGED");
    expect(prune(true).ok).toBe(true);
    expect(cell("SELECT description FROM tasks")).toBe(`password ${PH} y otra vez ${PH} al final`);
  });

  it("JSON guard: a row and an archive line that cannot keep their JSON are skipped, counted and fail the run", () => {
    const db = initEmpty();
    db.prepare("INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', ?)").run(`mailbox a@example.com password: u001b${V_CONV}`);
    const ev = JSON.stringify({ m: `x\u001b${V_CONV}` });
    db.prepare(
      "INSERT INTO events (id, type, category, timestamp, workspace_id, data) VALUES ('e1', 'x', 'y', '2026-01-01T00:00:00Z', 'default', ?)",
    ).run(ev);
    db.prepare("INSERT INTO tasks (task_id, title, description, output) VALUES ('t1', 'T', ?, ?)").run(`otra u001b${V_CONV}`, ev);
    closeDatabase();
    const okLine = JSON.stringify({ row: { output: `again u001b${V_CONV}` } });
    writeFileSync(join(arDir, ARCH_HIT), gzipSync(`${ev}\n${okLine}\n`));
    const r = prune(true);
    expect(r.ok).toBe(false);
    const by = Object.fromEntries(r.stores.map((s) => [s.store, s]));
    expect(by.events).toMatchObject({ hit: 0, changed: 0, note: "skipped_json=1" });
    expect(by.tasks).toMatchObject({ hit: 0, changed: 0, note: "skipped_json=1" }); // the whole row waits
    expect(by.conversations).toMatchObject({ hit: 1, changed: 1 }); // unrelated rows are not blocked
    expect(by.archives).toMatchObject({ hit: 1, changed: 1, note: "lines=1 skipped_json=1" });
    expect(cell("SELECT data FROM events")).toBe(ev);
    expect(cell("SELECT output FROM tasks")).toBe(ev);
    expect(archiveText(ARCH_HIT)).toBe(`${ev}\n${JSON.stringify({ row: { output: `again ${PH}` } })}\n`);
    for (const line of archiveText(ARCH_HIT).split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("nested JSON in a row: an inner payload no candidate keeps valid is skipped and fails the run; one that fits is pruned", () => {
    const db = initEmpty();
    // V_CONV: only the escape-bearing form is known (collected from a plain text); W: both forms.
    db.prepare("INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', ?)").run(`mailbox a@example.com password: n${V_CONV}`);
    db.prepare("INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', ?)").run(
      JSON.stringify({ m: `mailbox b@example.com password:\n${W}` }),
    );
    const stuck = JSON.stringify({ output: JSON.stringify({ t: `a\n${V_CONV}` }) });
    const fits = JSON.stringify({ output: JSON.stringify({ t: `a\n${W}` }) });
    db.prepare("INSERT INTO tasks (task_id, title, description, output) VALUES ('t1', 'T', '', ?)").run(stuck);
    db.prepare("INSERT INTO tasks (task_id, title, description, output) VALUES ('t2', 'T', '', ?)").run(fits);
    closeDatabase();
    const r = prune(true);
    expect(r.ok).toBe(false);
    expect(r.stores.find((s) => s.store === "tasks")).toMatchObject({ hit: 1, changed: 1, note: "skipped_json=1" });
    expect(cell("SELECT output FROM tasks WHERE task_id = 't1'")).toBe(stuck);
    const out = JSON.parse(cell("SELECT output FROM tasks WHERE task_id = 't2'") as string) as { output: string };
    expect(JSON.parse(out.output)).toEqual({ t: `a\n${PH}` });
  });

  it("P2: an escaped JSON value is pruned to valid JSON and an unrelated row is pruned too", () => {
    const db = initEmpty();
    const ev = JSON.stringify({ m: `mailbox a@example.com password:\u001b${V_CONV}` });
    db.prepare(
      "INSERT INTO events (id, type, category, timestamp, workspace_id, data) VALUES ('e1', 'x', 'y', '2026-01-01T00:00:00Z', 'default', ?)",
    ).run(ev);
    db.prepare("INSERT INTO conversations (bank, content) VALUES ('mc-jarvis', ?)").run(`mailbox ops@example.com password: ${W}`);
    closeDatabase();
    expect(prune(true).ok).toBe(true);
    const data = cell("SELECT data FROM events") as string;
    expect(JSON.parse(data)).toEqual({ m: `mailbox a@example.com password:\u001b${PH}` });
    expect(data.includes(V_CONV)).toBe(false);
    expect(cell("SELECT content FROM conversations")).toBe(`mailbox ops@example.com password: ${PH}`);
  });

  it("P8: a symlinked archive and a hard-linked one, each with a hit, are not written, are counted and fail the run", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const line = `${JSON.stringify({ t: `again ${V_CONV}` })}\n`;
    writeFileSync(join(arDir, ARCH_HIT), gzipSync(line));
    linkSync(join(arDir, ARCH_HIT), join(root, "other-link.gz"));
    const outside = join(root, "outside.gz");
    writeFileSync(outside, gzipSync(line));
    symlinkSync(outside, join(arDir, ARCH_MISS));
    const r = prune(true);
    expect(r.ok).toBe(false);
    expect(r.stores.find((s) => s.store === "archives")).toMatchObject({
      hit: 2,
      changed: 0,
      note: "lines=2 symlinked_with_hit_not_written=1 hard_linked_with_hit_not_written=1",
    });
    expect(gunzipSync(readFileSync(join(root, "other-link.gz"))).toString()).toBe(line);
    expect(gunzipSync(readFileSync(outside)).toString()).toBe(line);
    expect(readdirSync(arDir).sort()).toEqual([ARCH_HIT, ARCH_MISS]);
  });

  it("a hard-linked KB file with a hit is not written and fails the run", () => {
    seed();
    linkSync(join(kbDir, NOTE_PATH), join(root, "outside-link.md"));
    const r = prune(true);
    expect(r.ok).toBe(false);
    expect(r.stores.find((s) => s.store === "kb-files")!.note).toContain("hard_linked_with_hit_not_written=1");
    expect(readFileSync(join(root, "outside-link.md"), "utf8")).toBe(NOTE_TEXT);
  });

  it("symlinks under the KB root are not followed", () => {
    seed();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "x.md"), DISK_ONLY_TEXT);
    symlinkSync(outside, join(kbDir, "linked"));
    prune(true);
    expect(readFileSync(join(outside, "x.md"), "utf8")).toBe(DISK_ONLY_TEXT);
  });

  it("P3: a missing or non-folder --kb / --archive is a refusal and nothing is written", () => {
    seed();
    const before = folderDigest(root) + rowSnapshot();
    const notFolder = join(root, "a-file");
    writeFileSync(notFolder, "x");
    for (const [kb, ar, code] of [
      [join(root, "typo-kb"), arDir, "KB_NOT_A_FOLDER"],
      [kbDir, join(root, "typo-ar"), "ARCHIVE_NOT_A_FOLDER"],
      [notFolder, arDir, "KB_NOT_A_FOLDER"],
      [kbDir, notFolder, "ARCHIVE_NOT_A_FOLDER"],
    ] as const) {
      for (const apply of [false, true]) {
        expect(() => runPrune({ dbPath, kbRoot: kb, archiveDir: ar, apply, log: quiet })).toThrow(code);
      }
      const out: string[] = [];
      expect(main(["--db", dbPath, "--kb", kb, "--archive", ar, "--apply", "--i-stopped-the-service"], deps({}, out))).toBe(2);
      expect(out.join("\n")).toBe(`${TAG} REFUSED code=${code} — nothing written`);
    }
    rmSync(notFolder);
    expect(folderDigest(root) + rowSnapshot()).toBe(before);
  });

  it("a folder refusal comes before the database is opened (a missing database file is never reached)", () => {
    seed();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const st = statSync(dbPath).mtimeMs;
    const noDb = join(root, "no-such.db");
    for (const apply of [false, true]) {
      expect(() => runPrune({ dbPath: noDb, kbRoot: join(root, "nope"), archiveDir: arDir, apply, log: quiet })).toThrow(Refusal);
      expect(() => runPrune({ dbPath, kbRoot: join(root, "nope"), archiveDir: arDir, apply, log: quiet })).toThrow("KB_NOT_A_FOLDER");
    }
    // The same missing database with good folders fails at the open, which is what the refusal preceded.
    expect(() => runPrune({ dbPath: noDb, kbRoot: kbDir, archiveDir: arDir, apply: false, log: quiet })).not.toThrow(Refusal);
    expect(existsSync(noDb)).toBe(false);
    expect(existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)).toBe(false);
    expect(statSync(dbPath).mtimeMs).toBe(st);
  });

  it("a KB folder or archive folder that cannot be read is a counted failure, never silence", () => {
    seed();
    fsFault.set(`readdir:${join(kbDir, "notes")}`, "EACCES");
    const r = prune(true);
    expect(r.ok).toBe(false);
    expect(r.stores.find((s) => s.store === "kb-files")!.note).toContain("unreadable_folders=1");
    expect(readFileSync(join(kbDir, NOTE_PATH), "utf8")).toBe(NOTE_TEXT); // not reached
    fsFault.clear();
    fsFault.set(`readdir:${arDir}`, "EACCES");
    const r2 = prune(false);
    expect(r2.ok).toBe(false);
    expect(r2.stores.find((s) => s.store === "archives")!.note).toContain("failed=1");
  });

  it("a KB file or archive that cannot be read while collecting fails the run and says to run again; the re-run finishes", () => {
    // W's only context is in the KB file, X's only in the archive; both repeat in rows.
    seedRows([`sin contexto ${W} ${X}`]);
    writeKb("notes/a-ctx.md", `# a\n\ncorreo a@example.com clave: ${W}\n`);
    writeFileSync(join(arDir, ARCH_HIT), gzipSync(`${JSON.stringify({ o: `mailbox b@example.com password: ${X}` })}\n`));
    fsFault.set(`read:${join(kbDir, "notes/a-ctx.md")}`, "EIO");
    fsFault.set(`read:${join(arDir, ARCH_HIT)}`, "EIO");
    const { r, lines } = pruneLogged(true);
    expect(r.ok).toBe(false);
    expect(r.stores.find((s) => s.store === "kb-files")!.note).toBe("read_failed=1");
    expect(r.stores.find((s) => s.store === "archives")!.note).toBe("read_failed=1");
    expect(lines.some((l) => l.includes("run the same command again"))).toBe(true);
    expect(cell("SELECT content FROM conversations")).toBe(`sin contexto ${W} ${X}`); // not collected yet
    fsFault.clear();
    expect(prune(true).ok).toBe(true);
    expect(cell("SELECT content FROM conversations")).toBe(`sin contexto ${PH} ${PH}`);
    expect(remaining([W, X])).toEqual([]);
  });

  it("leftover temp files of an earlier run are counted by the dry run and removed by --apply", () => {
    seed();
    const kbTmp = join(kbDir, "notes", ".sintetica-b.md.prune-tmp-123-abcdef012345");
    const arTmp = join(arDir, `.${ARCH_HIT}.prune-tmp-123-abcdef012345`);
    writeFileSync(kbTmp, NOTE_TEXT.replace(V_NOTE, PH));
    writeFileSync(arTmp, "x");
    const dry = pruneLogged(false);
    expect(dry.lines).toContain(`${TAG} leftover temp files found=2 (removed by --apply)`);
    expect(existsSync(kbTmp) && existsSync(arTmp)).toBe(true);
    const run = pruneLogged(true);
    expect(run.lines).toContain(`${TAG} leftover temp files removed=2`);
    expect(existsSync(kbTmp) || existsSync(arTmp)).toBe(false);
    expect(readdirSync(arDir).sort()).toEqual([ARCH_HIT, ARCH_MISS]);
  });

  it("a leftover temp file that cannot be removed is counted and fails the run", () => {
    seed();
    const kbTmp = join(kbDir, "notes", ".sintetica-b.md.prune-tmp-123-abcdef012345");
    writeFileSync(kbTmp, "x");
    fsFault.set(`rm:${kbTmp}`, "EBUSY");
    const { r, lines } = pruneLogged(true);
    expect(r.ok).toBe(false);
    expect(lines).toContain(`${TAG} leftover temp files removed=0 failed=1`);
  });

  it("temp cleanup never touches a look-alike name", () => {
    seedRows(["x"]);
    const keep = [".notes.md.prune-tmp-12-zz", "notes.prune-tmp-1-ab.md", ".n.md.prune-tmp-1-ab.bak", "prune-tmp-1-ab", ".n.md.prune-tmp--ab"];
    for (const k of keep) writeFileSync(join(kbDir, k), "keep");
    writeFileSync(join(arDir, ".tasks-retention-x.jsonl.gz.prune-tmp-1-ab"), "x");
    prune(true);
    for (const k of keep) expect(existsSync(join(kbDir, k))).toBe(true);
    expect(existsSync(join(arDir, ".tasks-retention-x.jsonl.gz.prune-tmp-1-ab"))).toBe(false);
  });

  it("every write uses its own temp name (pid + 12 random hex)", () => {
    seed();
    prune(true);
    expect(tempOpens.length).toBe(4); // three KB files and one archive
    const suffixes = tempOpens.map((p) => {
      const m = /\.prune-tmp-(\d+)-([0-9a-f]+)$/.exec(basename(p));
      expect(m?.[1]).toBe(String(process.pid));
      return m![2]!;
    });
    for (const s of suffixes) expect(s).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });
});

// ── rulings 7–10: every listed store, the safety net, derived blobs, approvals, scan-only ──

describe("store table and safety net", () => {
  /** One row per table of the real schema with every listed column holding a repeat of V. */
  function seedEveryStore(): void {
    initEmpty();
    closeDatabase();
    const db = new BetterSqlite3(dbPath);
    try {
      db.pragma("foreign_keys = OFF");
      db.pragma("ignore_check_constraints = ON");
      for (const s of DB_STORES) {
        const info = db.prepare(`PRAGMA table_info("${s.table}")`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }>;
        const vals: Record<string, unknown> = {};
        for (const c of info) {
          if (s.columns.includes(c.name)) {
            vals[c.name] = s.table === "conversations" ? `mailbox ops@example.com password: ${V_CONV}` : `again ${V_CONV}`;
          } else if ((c.notnull || c.pk) && c.dflt_value === null && !(c.pk && /INT/i.test(c.type))) {
            const t = c.type.toUpperCase();
            vals[c.name] = /INT/.test(t) ? 1 : /REAL|FLOA|DOUB|NUM/.test(t) ? 1.5 : /BLOB/.test(t) ? Buffer.from([0]) : `k-${s.table}`;
          }
        }
        const cols = Object.keys(vals);
        db.prepare(`INSERT INTO "${s.table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
          ...cols.map((c) => vals[c]),
        );
      }
    } finally {
      db.close();
    }
  }

  it("the store table holds exactly the ruled columns; the credential column is never one of them", () => {
    const ruled = [
      "conversations.content",
      "tasks.title tasks.description tasks.input tasks.output tasks.error tasks.metadata",
      "runs.input runs.output runs.trace runs.error runs.goal_graph",
      "task_outcomes.concern_detail",
      "recall_audit.query recall_audit.result_snippets",
      "events.data",
      "mined_test_cases.input",
      "memory_tombstones.terms memory_tombstones.new_terms",
      "general_events.title general_events.summary",
      "tool_approvals.args_json tool_approvals.summary",
      "jme_turns.content jme_facts.fact_text jme_signals.snippet",
      "user_facts.value learnings.content strategy_bullets.content project_log.details",
      "scope_telemetry.message task_provenance.snippet",
      "prometheus_snapshots.goal_results prometheus_snapshots.execution_state prometheus_snapshots.task_description",
      "schedule_runs.result_summary scheduled_tasks.description ritual_deferrals.text task_gates.evidence",
      "skill_test_runs.actual_output_json skill_failures.input_json skill_failures.error_detail",
      "attributed_claims.claim_text attributed_claims.evidence_excerpt",
      "judgments.prose judgments.triggering_evidence_text sycophancy_probes.triggering_evidence_text",
      "triage_report.anomalies_json task_trace_events.attrs knowledge_nodes.summary knowledge_triples.object",
      "signals.value_text decisions.payload_json decision_events.payload_json reports.report_json",
      "proposed_briefings.briefing_json commit_events.changes jarvis_files.content",
    ].flatMap((l) => l.split(" "));
    const listed = DB_STORES.flatMap((s) => s.columns.map((c) => `${s.table}.${c}`));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ruled].sort());
    expect(listed).not.toContain("projects.credentials");
    expect(listed.some((c) => c.startsWith("mailbox_password_seen."))).toBe(false);
  });

  it("every listed column exists as TEXT in the real schema, and each one is pruned", () => {
    seedEveryStore();
    const db = ro();
    try {
      for (const s of DB_STORES) {
        const info = db.prepare(`PRAGMA table_info("${s.table}")`).all() as Array<{ name: string; type: string }>;
        expect(info.length, s.table).toBeGreaterThan(0);
        for (const c of s.columns) expect([s.table, c, info.find((i) => i.name === c)?.type]).toEqual([s.table, c, "TEXT"]);
        expect(s.key).toEqual(["rowid"]); // no listed table is WITHOUT ROWID
      }
    } finally {
      db.close();
    }
    const { r, lines } = pruneLogged(true);
    expect(r.tablesAbsent).toBe(0);
    expect(r.uncovered.size).toBe(0);
    expect(r.ok).toBe(true);
    for (const s of DB_STORES) {
      expect([s.table, r.stores.find((x) => x.store === s.table)]).toMatchObject([s.table, { hit: 1, changed: 1 }]);
      for (const c of s.columns) {
        const v = cell(`SELECT "${c}" FROM "${s.table}" ORDER BY rowid DESC LIMIT 1`) as string; // initDatabase seeds some tables
        expect([s.table, c, v.includes(V_CONV), v.includes(PH)]).toEqual([s.table, c, false, true]);
      }
    }
    expect(lines).toContain(`${TAG} uncovered_hits=0`);
  });

  it("safety net: a value in a column outside the list is reported by name, never rewritten, and fails the run", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`], (db) => {
      db.prepare("INSERT INTO conversations (bank, content) VALUES (?, 'nada')").run(`banco ${V_CONV}`);
      db.prepare("INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, priority, related_to) VALUES ('a', 'a.md', ?, 'c', '[]', 'workspace', 90, '[]')").run(
        `titulo ${V_CONV}`,
      );
    });
    for (const apply of [false, true]) {
      const { r, lines } = pruneLogged(apply);
      expect(r.ok).toBe(false);
      expect([...r.uncovered]).toEqual([
        ["conversations.bank", 1],
        ["jarvis_files.title", 1],
      ]);
      expect(lines).toContain(`${TAG} uncovered_hits=2`);
      expect(lines).toContain(`${TAG} uncovered column=conversations.bank cells=1 (not rewritten)`);
      expect(lines).toContain(`${TAG} uncovered column=jarvis_files.title cells=1 (not rewritten)`);
    }
    expect(cell("SELECT bank FROM conversations WHERE content = 'nada'")).toBe(`banco ${V_CONV}`);
    expect(cell("SELECT title FROM jarvis_files WHERE id = 'a'")).toBe(`titulo ${V_CONV}`);
    expect(cell("SELECT content FROM conversations WHERE id = 1")).toBe(`mailbox ops@example.com password: ${PH}`);
  });

  it("safety net skips the credential store, the fingerprint table and the full-text tables", () => {
    seed();
    const r = prune(true);
    expect(r.ok).toBe(true); // CREDENTIALS holds V_CONV, the seen table holds its fingerprints
    expect(r.uncovered.size).toBe(0);
  });

  it("derived embeddings of pruned rows are counted per table and left", () => {
    seed();
    exec(`UPDATE general_events SET summary_embedding = x'0102'`);
    exec(`INSERT INTO jme_facts (source_task, ts, fact_text, category, embedding) VALUES ('t1', 1, 'buzón password ${W}', 'event', x'01')`);
    exec(`INSERT INTO jme_facts (source_task, ts, fact_text, category, embedding) VALUES ('t1', 1, 'sin nada', 'event', x'01')`);
    exec(`INSERT INTO conversation_embeddings (conversation_id, embedding) VALUES (1, x'01'), (3, x'01')`);
    const dry = pruneLogged(false);
    const { r, lines } = pruneLogged(true);
    for (const x of [dry.r, r]) {
      expect([...x.derived]).toEqual([
        ["general_events.summary_embedding", 1],
        ["jme_facts.embedding", 1],
        ["conversation_embeddings.embedding", 1],
      ]);
    }
    expect(lines).toContain(`${TAG} derived_blob=conversation_embeddings.embedding pruned_rows_with_blob=1 (left as they are)`);
    expect(count("SELECT COUNT(*) FROM general_events WHERE summary_embedding = x'0102'")).toBe(1);
    expect(count("SELECT COUNT(*) FROM conversation_embeddings")).toBe(2);
  });

  it("a pending approval whose arguments were pruned no longer hashes to its sha: it is voided, never executable", async () => {
    initEmpty();
    const db = getDatabase();
    const args = { to: "ops@example.com", body: `mailbox password: ${V_CONV}` };
    const clean = { to: "ops@example.com", body: "hola" };
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary, requested_at, decision) VALUES (?, 'gmail_send', ?, ?, 's', ?, 'pending')",
    );
    ins.run("th-hit", argsSha256(args), JSON.stringify(args), now);
    ins.run("th-clean", argsSha256(clean), JSON.stringify(clean), now);
    closeDatabase();
    expect(prune(true).ok).toBe(true);
    expect(JSON.parse(cell("SELECT args_json FROM tool_approvals WHERE thread_key = 'th-hit'") as string).body).toBe(`mailbox password: ${PH}`);
    const conf = await import("../src/messaging/confirmations.js");
    initDatabase(dbPath);
    cancelPendingRegeneration();
    try {
      conf._resetPendingConfirmationsForTests();
      expect(conf.getPendingConfirmation("th-clean")).not.toBeNull(); // the path works for an untouched card
      expect(conf.getPendingConfirmation("th-hit")).toBeNull();
      expect(cell("SELECT decision FROM tool_approvals WHERE thread_key = 'th-hit'")).toBe("superseded");
    } finally {
      conf._resetPendingConfirmationsForTests();
    }
  });

  it("--scan-only: hits counted by position, nothing written there, no name printed, links not followed, missing marked", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const spill = join(root, "spill");
    mkdirSync(join(spill, "sub"), { recursive: true });
    writeFileSync(join(spill, `${V_CONV}-a.txt`), `copia ${V_CONV}\n`);
    writeFileSync(join(spill, "sub", "b.json"), JSON.stringify({ t: `x\n${V_CONV}` }));
    writeFileSync(join(spill, "c.txt"), "nada\n");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, `copia ${V_CONV}\n`);
    symlinkSync(outside, join(spill, "link.txt"));
    const before = folderDigest(spill);
    const out: string[] = [];
    const argv = [...APPLY(), "--scan-only", spill, "--scan-only", join(root, "no-dumps")];
    expect(main(argv, deps({}, out))).toBe(1);
    expect(out).toContain(`${TAG} scan_only=1 files=3 scan_only_hits=2 symlinks_not_followed=1`);
    expect(out).toContain(`${TAG} scan_only=2 files=0 scan_only_hits=0 missing`);
    expect(folderDigest(spill)).toBe(before);
    expect(readFileSync(outside, "utf8")).toBe(`copia ${V_CONV}\n`);
    const text = out.join("\n");
    for (const s of [V_CONV.slice(0, 6), root, "spill", "no-dumps", "-a.txt"]) expect(text).not.toContain(s);
    expect(SCAN_FILE_CAP).toBe(32 * 1024 * 1024);
  });

  it("safety net: a cell above 100 kB and a table late in the alphabet are swept too", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`], (db) => {
      db.prepare("INSERT INTO conversations (bank, content) VALUES (?, 'nada')").run(`${"x ".repeat(75_000)}${V_CONV}`);
      db.prepare("INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr) VALUES ('s1', ?, 'd', '0 * * * *')").run(
        `nombre ${V_CONV}`,
      );
    });
    expect((cell("SELECT bank FROM conversations WHERE content = 'nada'") as string).length).toBeGreaterThan(100_000);
    const { r, lines } = pruneLogged(false);
    expect(r.ok).toBe(false);
    expect([...r.uncovered]).toEqual([
      ["conversations.bank", 1],
      ["scheduled_tasks.name", 1],
    ]);
    expect(lines).toContain(`${TAG} uncovered_hits=2`);
  });

  it("nested JSON three payloads deep with an escape before the value: every level still parses after the prune", () => {
    const l3 = JSON.stringify({ t: `a\n${V_CONV}` });
    const l2 = JSON.stringify({ p: l3 });
    const l1 = JSON.stringify({ q: l2 });
    const outer = JSON.stringify({ r: l1 });
    const r = replaceCollected(outer, new Set([fp(`n${V_CONV}`), fp(V_CONV)]));
    expect(r.unsafe).toBe(false);
    expect(r.text.includes(V_CONV)).toBe(false);
    const got1 = JSON.parse(JSON.parse(r.text).r).q as string;
    const got3 = JSON.parse(JSON.parse(got1).p) as { t: string };
    expect(got3).toEqual({ t: `a\n${PH}` });
  });

  it("--scan-only: a file just over the cap is counted over_cap (not read) and fails the run", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const dir = join(root, "big");
    mkdirSync(dir);
    const head = Buffer.from(`copia ${V_CONV}\n`);
    const big = Buffer.alloc(SCAN_FILE_CAP + 1, 0x2e); // dots: no run of their own
    head.copy(big);
    writeFileSync(join(dir, "b.txt"), big);
    const { r, lines } = pruneLogged(false, { scanOnly: [dir] });
    expect(r.scans).toEqual([{ position: 1, missing: false, files: 1, hits: 0, overCap: 1, unreadable: 0, symlinks: 0 }]);
    expect(lines).toContain(`${TAG} scan_only=1 files=1 scan_only_hits=0 over_cap=1`);
    expect(r.ok).toBe(false);
  });

  it("--scan-only: a file that cannot be read is counted and fails the run", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const dir = join(root, "spill");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "nada\n");
    fsFault.set(`read:${join(dir, "a.txt")}`, "EACCES");
    const { r, lines } = pruneLogged(false, { scanOnly: [dir] });
    expect(lines).toContain(`${TAG} scan_only=1 files=1 scan_only_hits=0 unreadable=1`);
    expect(r.ok).toBe(false);
  });

  it("--scan-only: a missing folder alone is marked missing and leaves the run ok", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const out: string[] = [];
    expect(main([...APPLY(), "--scan-only", join(root, "no-such")], deps({}, out))).toBe(0);
    expect(out).toContain(`${TAG} scan_only=1 files=0 scan_only_hits=0 missing`);
  });

  it("timing: collection over a pruned column and the safety-net sweep, on a synthetic database", () => {
    const ROWS = 100_000;
    const filler = `${"palabra ".repeat(40)} ${"Aa1Bb2Cc3Dd4Ee5Ff6"} fin`; // ~350 chars, one mixed 18-run per cell
    seedRows([`mailbox ops@example.com password: ${V_CONV}`], (db) => {
      db.exec("CREATE TABLE zz_bulk (t TEXT)");
      const a = db.prepare("INSERT INTO zz_bulk (t) VALUES (?)");
      const b = db.prepare("INSERT INTO learnings (task_id, content) VALUES ('t', ?)");
      db.transaction(() => {
        for (let i = 0; i < ROWS; i++) {
          a.run(filler);
          b.run(filler);
        }
      })();
    });
    const { lines } = pruneLogged(false);
    const m = /timing collect_ms=(\d+) rest_ms=(\d+) sweep_ms=(\d+)/.exec(lines.find((l) => l.includes("timing"))!)!;
    const mb = (ROWS * filler.length) / 1e6;
    console.log(
      `PERF ${ROWS} rows x ${filler.length} chars (${mb.toFixed(1)} MB) per column: collect_ms=${m[1]} (all stores) rest_ms=${m[2]} sweep_ms=${m[3]} (every unlisted column)`,
    );
  }, 300_000);
});

// ── a re-run after any interruption finishes the job ───────────────────────

describe("re-run after an interruption", () => {
  const V = V_CONV; // context only in a row
  const CTX_FILE = "notes/a-context.md";
  const REPEAT_FILE = "notes/b-repeat.md";

  /** P1 shape, both ways round. */
  function seedP1(): void {
    seedRows([`mailbox ops@example.com password: ${V}`, `nota sin contexto: ${W}`]);
    writeKb(CTX_FILE, `# a\n\nmailbox ops@example.com password: ${W}\n`);
    writeKb(REPEAT_FILE, `# b\n\nrepeat ${V} y ${W}\n`);
    writeFileSync(
      join(arDir, ARCH_HIT),
      gzipSync(`${JSON.stringify({ table: "runs", row: { output: `repeat ${V}` } })}\n${JSON.stringify({ table: "runs", row: { output: `again ${W}` } })}\n`),
    );
  }

  for (const stage of ["fingerprints", "file", "files"] as const) {
    it(`P1: dies after "${stage}", the re-run removes every copy and only then says nothing to change`, () => {
      seedP1();
      expect(() => prune(true, crashAt(stage))).toThrow("files:UNKNOWN");
      expect(remaining([V, W]).length).toBeGreaterThan(0);
      if (stage !== "fingerprints") {
        // The only copy that gave W its context is already rewritten.
        expect(readFileSync(join(kbDir, CTX_FILE), "utf8").includes(W)).toBe(false);
      }
      const second = pruneLogged(true);
      expect(second.r.ok).toBe(true);
      expect(second.nothing).toBe(false);
      expect(remaining([V, W])).toEqual([]);
      const third = pruneLogged(true);
      expect(third.nothing).toBe(true);
    });
  }

  /** V: context only in a row. W: only in the first KB file. X: only in the first archive line. */
  function seedThree(): void {
    seedRows([`mailbox ops@example.com password: ${V}`, `sin contexto ${W} ${X}`]);
    writeKb("notes/a-ctx.md", `# a\n\ncorreo a@example.com clave: ${W}\n`);
    writeKb("notes/b-rep.md", `# b\n\nrepeat ${V} ${W} ${X}\n`);
    const arch = (name: string, lines: string[]) => writeFileSync(join(arDir, name), gzipSync(`${lines.join("\n")}\n`));
    arch("tasks-retention-2026-01-01-00-00-00.jsonl.gz", [
      JSON.stringify({ o: `mailbox b@example.com password: ${X}` }),
      JSON.stringify({ o: `again ${V} ${W}` }),
    ]);
    arch("tasks-retention-2026-01-02-00-00-00.jsonl.gz", [JSON.stringify({ o: `again ${V} ${W} ${X}` })]);
  }

  it("dies inside the archive pass (one archive rewritten, one not): the re-run finishes", () => {
    seedThree();
    expect(() => prune(true, crashAt("file", 3))).toThrow();
    const archives = readdirSync(arDir).filter((n) => n.endsWith(".gz")).sort();
    expect(archiveText(archives[0]!).includes(X)).toBe(false);
    expect(archiveText(archives[1]!).includes(X)).toBe(true);
    expect(pruneLogged(true).r.ok).toBe(true);
    expect(remaining([V, W, X])).toEqual([]);
    expect(readdirSync(arDir).filter((n) => n.includes("prune-tmp"))).toEqual([]);
    const third = pruneLogged(true);
    expect(third.nothing).toBe(true);
    expect(third.r.fingerprintsAdded).toBe(0);
  });

  it("a dry run in the interrupted state counts what the apply run then does", () => {
    seedThree();
    expect(() => prune(true, crashAt("file", 1))).toThrow();
    const dry = prune(false);
    const ap = prune(true);
    for (const s of ap.stores) expect([s.store, dry.stores.find((x) => x.store === s.store)!.hit]).toEqual([s.store, s.hit]);
  });

  it("the interruption message says to run again, and it is true", () => {
    seedP1();
    const out: string[] = [];
    const d = deps({ runPrune: (o: PruneOptions) => runPrune({ ...o, ...crashAt("file") }) }, out);
    expect(main(APPLY(), d)).toBe(1);
    expect(out.join("\n")).toContain("run the same command again to finish");
    expect(main(APPLY(), { ...d, runPrune })).toBe(0);
    expect(remaining([V, W])).toEqual([]);
  });

  it("reindex between the file rewrites and the row update brings only pruned text in; day-logs wait for the re-run", () => {
    seed();
    expect(() => prune(true, crashAt("files"))).toThrow();
    // Files pruned, rows not yet.
    expect(readFileSync(join(kbDir, NOTE_PATH), "utf8")).toBe(NOTE_TEXT.replace(V_NOTE, PH));
    expect(cell("SELECT content FROM jarvis_files WHERE path = ?", NOTE_PATH)).toBe(NOTE_TEXT);
    // The hourly reindex: the disk copy is newer and differs → the row takes the pruned text.
    initDatabase(dbPath);
    cancelPendingRegeneration();
    reindexJarvisKb({ kbRoot: kbDir });
    cancelPendingRegeneration();
    closeDatabase();
    expect(cell("SELECT content FROM jarvis_files WHERE path = ?", NOTE_PATH)).toBe(NOTE_TEXT.replace(V_NOTE, PH));
    expect(cell("SELECT content FROM jarvis_files WHERE path = ?", DAY_PATH)).toBe(DAY_TEXT); // exempt from refresh
    const r = prune(true);
    expect(r.ok).toBe(true);
    expect(remaining(COLLECTED)).toEqual([]);
    expect(cell("SELECT updated_at FROM jarvis_files WHERE path = ?", DAY_PATH)).not.toBe(OLD_STAMP);
    // After the full run the rows are the newer copy and equal to disk: the reindex changes nothing.
    const rows = rowSnapshot();
    initDatabase(dbPath);
    cancelPendingRegeneration();
    reindexJarvisKb({ kbRoot: kbDir });
    cancelPendingRegeneration();
    closeDatabase();
    expect(rowSnapshot()).toBe(rows);
  });
});

// ── entry, output rule, open-for-writing check ─────────────────────────────

describe("entry", () => {
  function capture(): { text: () => string } {
    const parts: string[] = [];
    const push = (...a: unknown[]) => {
      parts.push(a.map(String).join(" "));
    };
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(push);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      parts.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      parts.push(String(chunk));
      return true;
    });
    return { text: () => parts.join("\n") };
  }
  const leakFree = (text: string): void => {
    for (const s of [...COLLECTED, ...LOOKALIKES, ...FIXTURE_SENTENCES, W]) expect(text).not.toContain(s);
    for (const s of ["projects/", "solo-disco", "2026-01-02.md", "sintetica", "example.com", root]) expect(text).not.toContain(s);
    for (const v of [...COLLECTED, W]) expect(text).not.toContain(v.slice(0, 6));
  };
  /**
   * The console-printing deps of the real entry, with the open-for-writing check answering
   * "no writers". On the real /proc that check depends on the host: as an unprivileged user
   * (CI) other users' fd folders cannot be read and it refuses (unknown = writer). The
   * fault below makes this host look the same, so a test that drops the stub fails here too.
   */
  const consoleDeps = () => {
    fsFault.set("readdir:/proc/1/fd", "EACCES");
    return {
      requireOperatorContext: () => {},
      findDbWriters: okWriters,
      runPrune,
      log: (l: string) => console.log(l),
      error: (l: string) => console.error(l),
    };
  };

  it("output carries counts only: no value, no fixture sentence, no path or KB file name", () => {
    seed();
    const out = capture();
    const d = consoleDeps();
    expect(main(ARGV(), d)).toBe(0);
    expect(main(APPLY(), d)).toBe(0);
    expect(main(APPLY(), d)).toBe(0);
    const text = out.text();
    vi.restoreAllMocks();
    expect(text).toContain("collected_fingerprints=");
    expect(text).toContain("mode=dry-run");
    expect(text).toContain("mode=apply");
    leakFree(text);
  });

  it("P7: a driver error whose message holds a value and a path prints the error code only", () => {
    seed();
    exec(`CREATE TRIGGER zz BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, '${V_CONV} ${dbPath} ${CONV_A.slice(0, 20)}'); END`);
    const out = capture();
    expect(main(APPLY(), consoleDeps())).toBe(1);
    const text = out.text();
    vi.restoreAllMocks();
    expect(text).toContain("store=conversations code=SQLITE_CONSTRAINT_TRIGGER");
    leakFree(text);
  });

  it("a non-store error after the fingerprints are recorded says to run again; before them, nothing changed", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const out: string[] = [];
    const throwingLog = (l: string) => {
      if (l.includes("mode=")) throw new Error(`falla ${V_CONV}`);
    };
    const d = deps({ runPrune: (o: PruneOptions) => runPrune({ ...o, log: throwingLog }) }, out);
    expect(main(ARGV(), d)).toBe(1);
    expect(main(APPLY(), d)).toBe(1);
    expect(out).toEqual([
      `${TAG} ERROR store=run code=UNKNOWN — nothing changed in the stores`,
      `${TAG} ERROR store=run code=UNKNOWN — fingerprints recorded, some stores not finished — run the same command again to finish`,
    ]);
  });

  it("a failure while collecting (before any fingerprint is recorded) says nothing changed, under --apply too", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    // A view under a listed name passes the column check but has no rowid: the collection read fails.
    exec("DROP TABLE ritual_deferrals; CREATE VIEW ritual_deferrals AS SELECT 'x' AS text");
    const before = rowSnapshotWithout("ritual_deferrals");
    const out: string[] = [];
    expect(main(APPLY(), deps({}, out))).toBe(1);
    expect(out).toEqual([`${TAG} ERROR store=run code=SQLITE_ERROR — nothing changed in the stores`]);
    expect(count("SELECT COUNT(*) FROM mailbox_password_seen")).toBe(0);
    expect(rowSnapshotWithout("ritual_deferrals")).toBe(before);
  });

  it("an error outside the stores prints its code only, never its message", () => {
    const out: string[] = [];
    const boom = () => {
      throw Object.assign(new Error(`falla ${V_CONV} en ${root}/projects/x.md`), { code: "EIO" });
    };
    expect(main(ARGV(), deps({ runPrune: boom }, out))).toBe(1);
    const bare = () => {
      throw new Error(`falla ${V_CONV} en ${root}`);
    };
    expect(main(ARGV(), deps({ runPrune: bare }, out))).toBe(1);
    expect(out).toEqual([
      `${TAG} ERROR store=run code=EIO — nothing changed in the stores`,
      `${TAG} ERROR store=run code=UNKNOWN — nothing changed in the stores`,
    ]);
  });

  it("a file error under projects/ prints the error code only, never the file name", () => {
    seed();
    fsFault.set(`rename:${join(kbDir, DISK_ONLY_PATH)}`, "EIO");
    const out = capture();
    expect(main(APPLY(), consoleDeps())).toBe(1);
    const text = out.text();
    vi.restoreAllMocks();
    expect(text).toContain("ERROR store=kb-files code=EIO");
    expect(text).toContain("failed=1");
    expect(readdirSync(join(kbDir, "projects"))).toEqual(["solo-disco.md"]); // temp removed
    leakFree(text);
  });

  it("an archive whose name holds a value: a write error prints the code only and leaves no temp", () => {
    seedRows([`mailbox ops@example.com password: ${V_CONV}`]);
    const name = `tasks-retention-${V_CONV}.jsonl.gz`;
    writeFileSync(join(arDir, name), gzipSync(`${JSON.stringify({ o: `again ${V_CONV}` })}\n`));
    writeKb(`projects/${W}.md`, `copia ${V_CONV}\n`);
    fsFault.set(`rename:${join(arDir, name)}`, "EXDEV");
    const out: string[] = [];
    expect(main(APPLY(), deps({}, out))).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("ERROR store=archives code=EXDEV");
    expect(readdirSync(arDir)).toEqual([name]);
    leakFree(text);
  });

  it("--apply refuses without --i-stopped-the-service even when no process holds the database", () => {
    const run = vi.fn();
    const writers = vi.fn(okWriters);
    const out: string[] = [];
    const base = ["--db", "x.db", "--kb", "k", "--archive", "a"];
    expect(main([...base, "--apply"], deps({ runPrune: run, findDbWriters: writers }, out))).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(writers).not.toHaveBeenCalled();
    expect(out).toEqual([`${TAG} REFUSED: --apply needs --i-stopped-the-service (stop the service first)`]);
  });

  it("--apply refuses when a process cannot be inspected (as an unprivileged user sees others), and writes nothing", () => {
    seed();
    const proc = join(root, "proc");
    mkdirSync(join(proc, "4242", "fd"), { recursive: true });
    fsFault.set(`readdir:${join(proc, "4242", "fd")}`, "EACCES");
    const stores = () => folderDigest(join(root, "data")) + folderDigest(kbDir); // not the proc stub
    const before = stores();
    const run = vi.fn(runPrune);
    const out: string[] = [];
    expect(main(APPLY(), deps({ findDbWriters: (p: string) => findDbWriters(p, proc, 1), runPrune: run }, out))).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(out).toEqual([`${TAG} REFUSED: 1 process(es) hold the database open for writing or cannot be inspected: pid 4242`]);
    expect(stores()).toBe(before);
  });

  it("--apply refuses when a writer holds the db; the dry run never checks", () => {
    const run = vi.fn();
    const out: string[] = [];
    const d = deps({ findDbWriters: () => ({ available: true, pids: [4242] }), runPrune: run }, out);
    const base = ["--db", "x.db", "--kb", "k", "--archive", "a"];
    expect(main([...base, "--apply", "--i-stopped-the-service"], d)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(out[0]).toContain("pid 4242");
    run.mockReturnValue({ ok: true });
    expect(main([...base, "--apply", "--i-stopped-the-service"], { ...d, findDbWriters: () => ({ available: false, pids: [] }) })).toBe(0);
    expect(out[1]).toContain("WARNING");
    expect(main(base, { ...d, findDbWriters: () => ({ available: true, pids: [1] }) })).toBe(0); // dry run never checks
  });

  it("parseArgs: the three locations are required with no fallback, and an error never echoes a value", () => {
    const prevDb = process.env.MC_DB_PATH;
    process.env.MC_DB_PATH = "/env/x.db";
    try {
      expect(parseArgs([])).toEqual({ error: "missing --db --kb --archive" });
      expect(parseArgs(["--db", "/x/y.db"])).toEqual({ error: "missing --kb --archive" });
      expect(parseArgs(["--kb", "/k", "--archive", "/a"])).toEqual({ error: "missing --db" });
      expect(parseArgs(["--db", "/x/y.db", "--kb", "/k", "--archive", "/a", "--scan-only", "/s1", "--scan-only", "/s2"])).toEqual({
        apply: false,
        stopped: false,
        db: "/x/y.db",
        kb: "/k",
        archive: "/a",
        scanOnly: ["/s1", "/s2"],
      });
      expect(parseArgs(["--kb"])).toEqual({ error: "missing value for --kb" });
      expect(parseArgs(["--db", "a", "--db", "b"])).toEqual({ error: "repeated --db" });
      expect(parseArgs(["--kb=/x/projects/secret"])).toEqual({ error: "unexpected argument: --kb" });
      expect(parseArgs(["--db", "a", `--${V_CONV}`])).toEqual({ error: "unexpected argument at position 3" });
      expect(parseArgs(["--dry"])).toEqual({ error: "unexpected argument: --dry" });
      expect(parseArgs([V_CONV])).toEqual({ error: "unexpected argument at position 1" });
    } finally {
      if (prevDb === undefined) delete process.env.MC_DB_PATH;
      else process.env.MC_DB_PATH = prevDb;
    }
    const out: string[] = [];
    const run = vi.fn();
    expect(main(["--kb", "/k", "--archive", "/a"], deps({ runPrune: run }, out))).toBe(2);
    expect(main([], deps({ runPrune: run }, out))).toBe(2);
    expect(main([`--kb=${V_CONV}`], deps({ runPrune: run }, out))).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(out).toEqual([`${TAG} missing --db`, `${TAG} missing --db --kb --archive`, `${TAG} unexpected argument: --kb`]);
  });

  it("findDbWriters: read-write holders are writers, read-only ones are not, unreadable ones count, vanished ones do not", () => {
    seed();
    const proc = join(root, "proc");
    const fdEntry = (pid: number, fd: number, target: string, flags: string | null) => {
      mkdirSync(join(proc, String(pid), "fd"), { recursive: true });
      mkdirSync(join(proc, String(pid), "fdinfo"), { recursive: true });
      symlinkSync(target, join(proc, String(pid), "fd", String(fd)));
      if (flags !== null) writeFileSync(join(proc, String(pid), "fdinfo", String(fd)), `pos:\t0\nflags:\t${flags}\nmnt_id:\t1\n`);
    };
    fdEntry(100, 3, dbPath, "0100000"); // O_RDONLY
    fdEntry(101, 5, dbPath, "02100002"); // O_RDWR
    fdEntry(102, 7, `${dbPath}-wal`, "0100001"); // O_WRONLY
    fdEntry(103, 4, join(root, "other.db"), "0100002");
    expect(findDbWriters(dbPath, proc, 1).pids.sort()).toEqual([101, 102]);
    expect(findDbWriters(dbPath, proc, 101).pids).toEqual([102]);
    expect(findDbWriters(dbPath, join(root, "no-proc"), 1)).toEqual({ available: false, pids: [] });
    // fdinfo missing or unreadable for a matching link: unknown = writer.
    fdEntry(104, 3, dbPath, null);
    fdEntry(105, 3, dbPath, "0100000");
    fsFault.set(`read:${join(proc, "105", "fdinfo", "3")}`, "EACCES");
    // An fd folder that cannot be read: unknown = writer; one that vanished: skipped.
    fdEntry(106, 3, join(root, "other.db"), "0100000");
    fsFault.set(`readdir:${join(proc, "106", "fd")}`, "EACCES");
    mkdirSync(join(proc, "107")); // no fd folder: the process ended mid-walk
    fdEntry(108, 3, join(root, "other.db"), "0100000");
    fsFault.set(`readdir:${join(proc, "108", "fd")}`, "ESRCH");
    expect(findDbWriters(dbPath, proc, 1).pids.sort()).toEqual([101, 102, 104, 105, 106]);
  });

  it("findDbWriters: on the real /proc this process's own read-write handle is seen", () => {
    seed();
    const w = new BetterSqlite3(dbPath);
    try {
      expect(findDbWriters(dbPath, "/proc", -1).pids).toContain(process.pid);
      expect(findDbWriters(dbPath, "/proc", process.pid).pids).not.toContain(process.pid);
    } finally {
      w.close();
    }
  });
});
