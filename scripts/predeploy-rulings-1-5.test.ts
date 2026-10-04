/**
 * predeploy-rulings-1-5 — key walking (nested credentials), census shaping,
 * reference-name parity with the real secret index, KB-search reproduction
 * parity with the real searchFiles, and the never-print-values property.
 * Synthetic temp DB only (the live mc.db is never opened); every key name and
 * value is assembled at runtime.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real secret index and searchFiles read getDatabase(): point it at the temp DB.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/db/index.js", () => ({
  getDatabase: () => {
    if (!holder.db) throw new Error("Database not initialized");
    return holder.db;
  },
}));

import {
  buildCensus,
  formatCensus,
  walkProjectField,
  safeLabel,
  displayDisagreements,
  FTS_FETCH_CAP,
  reproduceSearch,
  parseQueries,
  toolLessSchedules,
  openReadOnly,
  KB_TOOL_LIMIT,
  type FactRow,
  type ProjectRow,
} from "./predeploy-rulings-1-5.js";
import {
  secretRefName,
  resetSecretRefsForTest,
  factIdentity,
  projectIdentity,
} from "../src/lib/secret-refs.js";
import { isProjectSecret } from "../src/lib/secret-refs.js";
import { searchFiles } from "../src/db/jarvis-fs.js";
import { readFileSync } from "node:fs";

const j = (...p: string[]) => p.join("");
// Credential-ish NAMES and synthetic VALUES, assembled at runtime.
const PW = j("pass", "word");
const KEYS = j("api_", "keys");
const WH = j("webhook_", "sec", "ret");
const SHORT_PW = j("pa", "ss");
// A secret-named PARENT whose children have neutral names (ancestor rule).
const PWS = j("pass", "words");
const V = {
  factPw: j("Qx7", "vR2m", "Lp9w"),
  factShape: j("gh", "p_", "Ab12Cd34".repeat(5)),
  credPw: j("Zt4", "nW8k", "Hy3q"),
  dbPw: j("Mu6", "fJ1s", "Ke5r"),
  key0: j("Rb9", "tG2x", "Vc7n", "Pq4z"),
  key1: j("Wd3", "hS8u", "Ly1m", "Nf6k"),
  whSec: j("Ej5", "cT9p", "Uo2g", "Xa8b"),
  collA: j("Ik4", "yB7e", "Om1v"),
  collB: j("Gs2", "wQ6i", "Fh9d"),
  anc0: j("Hn3", "kRt8", "yWq2"),
  anc1: j("Bv5", "mLx1", "pZe7"),
};
const TOKEN_KEY = j("gh", "p_", "Zz99Yy88".repeat(5));

const FACTS: FactRow[] = [
  { category: "perfil", key: "ciudad", value: "Lugar Ejemplo" },
  { category: "servicio", key: PW, value: V.factPw },
  { category: "nota", key: "referencia", value: V.factShape },
  { category: "alfa", key: j("beta_", SHORT_PW), value: V.collA },
  { category: "alfa_beta", key: SHORT_PW, value: V.collB },
  { category: "otro", key: TOKEN_KEY, value: "visible" },
];
const PROJECTS: ProjectRow[] = [
  {
    slug: "proyecto-uno",
    credentials: JSON.stringify({
      usuario: "persona@example.invalid",
      [PW]: V.credPw,
      db: { host: "db.example.invalid", [PW]: V.dbPw, port: 5432 },
      [KEYS]: [V.key0, V.key1],
      [PWS]: { primario: V.anc0, respaldo: V.anc1 },
    }),
    urls: JSON.stringify({ site: "https://example.invalid" }),
    config: JSON.stringify({ region: "norte", [WH]: V.whSec }),
  },
  { slug: "proyecto-dos", credentials: "not json", urls: "{}", config: null },
];

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "predeploy-r15-"));
  db = new Database(join(dir, "t.db"));
  db.exec(`
    CREATE TABLE user_facts (id INTEGER PRIMARY KEY, category TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(category, key));
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, urls TEXT DEFAULT '{}',
      credentials TEXT DEFAULT '{}', config TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY, schedule_id TEXT NOT NULL, name TEXT NOT NULL,
      tools TEXT DEFAULT '[]', delivery TEXT DEFAULT 'telegram', active INTEGER DEFAULT 1);
    CREATE TABLE jarvis_files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '');
    CREATE VIRTUAL TABLE jarvis_files_fts USING fts5(title, content, path UNINDEXED,
      content='jarvis_files', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER jarvis_files_ai AFTER INSERT ON jarvis_files BEGIN
      INSERT INTO jarvis_files_fts(rowid, title, content, path) VALUES (new.rowid, new.title, new.content, new.path);
    END;
  `);
  const fi = db.prepare("INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)");
  for (const f of FACTS) fi.run(f.category, f.key, f.value);
  const pi = db.prepare("INSERT INTO projects (id, slug, urls, credentials, config) VALUES (?, ?, ?, ?, ?)");
  PROJECTS.forEach((p, i) => pi.run(`p${i}`, p.slug, p.urls, p.credentials, p.config));
  const si = db.prepare("INSERT INTO scheduled_tasks (schedule_id, name, tools, active) VALUES (?, ?, ?, ?)");
  si.run("s-1", "Resumen diario", "[]", 1);
  si.run("s-2", "Con herramientas", '["web_search"]', 1);
  si.run("s-3", "Inactiva", "[]", 0);
  const ki = db.prepare("INSERT INTO jarvis_files (id, path, title, content) VALUES (?, ?, ?, ?)");
  ki.run("k1", "notes/a.md", "Cliente uno", "# Cliente\nla factura del cliente va aqui");
  ki.run("k2", "notes/b.md", "Accesos", `cliente con acceso ${V.credPw} y factura pendiente`);
  ki.run("k3", "notes/c.md", "Otra", `solo el valor ${V.dbPw} aparece`);
  ki.run("k4", "notes/d.md", "Deploy", "pasos del deploy para el cliente");
  holder.db = db;
});

afterAll(() => {
  holder.db = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetSecretRefsForTest());

const rowsOf = () =>
  ({
    facts: db.prepare("SELECT category, key, value FROM user_facts ORDER BY id").all() as FactRow[],
    projects: db.prepare("SELECT slug, urls, credentials, config FROM projects ORDER BY rowid").all() as ProjectRow[],
  });

describe("walkProjectField", () => {
  it("walks nested objects and arrays; credential-named ancestors hide their children", () => {
    const leaves = walkProjectField(JSON.parse(PROJECTS[0]!.credentials as string));
    const byPath = new Map(leaves.map((l) => [l.path.join("."), l]));
    expect([...byPath.keys()].sort()).toEqual(
      [`${KEYS}.0`, `${KEYS}.1`, "db.host", `db.${PW}`, "db.port", PW, "usuario", `${PWS}.primario`, `${PWS}.respaldo`].sort(),
    );
    // Ancestor rule: the children's own key/value say "clear"; the parent's name hides them.
    expect(isProjectSecret("primario", V.anc0)).toBe(false);
    expect(isProjectSecret("respaldo", V.anc1)).toBe(false);
    expect(byPath.get(`${PWS}.primario`)!.secret).toBe(true);
    expect(byPath.get(`${PWS}.respaldo`)!.secret).toBe(true);
    expect(byPath.get("usuario")!.secret).toBe(false);
    expect(byPath.get("db.host")!.secret).toBe(false);
    expect(byPath.get("db.port")!.secret).toBe(false);
    expect(byPath.get(`db.${PW}`)!.secret).toBe(true);
    expect(byPath.get(PW)!.secret).toBe(true);
    expect(byPath.get(`${KEYS}.0`)!.secret).toBe(true);
    expect(byPath.get(`${KEYS}.1`)!.secret).toBe(true);
    expect(leaves.every((l) => !l.byShape)).toBe(true);
  });
});

describe("buildCensus", () => {
  it("lists every fact and every credentials leaf, and only hidden urls/config leaves", () => {
    const { facts, projects } = rowsOf();
    const c = buildCensus(facts, projects);
    expect(c.rows.filter((r) => r.store === "fact")).toHaveLength(FACTS.length);
    expect(c.rows.filter((r) => r.field === "credentials")).toHaveLength(9);
    const other = c.rows.filter((r) => r.store === "project" && r.field !== "credentials");
    expect(other.map((r) => `${r.field}:${r.path.join(".")}`)).toEqual([`config:${WH}`]);
    expect(other.every((r) => r.secret)).toBe(true);
    expect(c.rows.every((r) => r.displayAgrees)).toBe(true);
    expect(displayDisagreements(c.rows)).toBe(0);
  });

  it("marks the by-shape verdict as a boolean", () => {
    const { facts, projects } = rowsOf();
    const c = buildCensus(facts, projects);
    const fact = (cat: string) => c.rows.find((r) => r.store === "fact" && r.scope === cat)!;
    expect(fact("perfil")).toMatchObject({ secret: false, byShape: false, ref: null });
    expect(fact("servicio")).toMatchObject({ secret: true, byShape: false });
    expect(fact("nota")).toMatchObject({ secret: true, byShape: true });
  });

  it("agrees with the real secret index in both directions, on every fact and every leaf", () => {
    const { facts, projects } = rowsOf();
    const c = buildCensus(facts, projects);
    const hidden = c.rows.filter((r) => r.secret);
    expect(hidden.length).toBeGreaterThanOrEqual(11);
    for (const r of hidden) {
      const identity =
        r.store === "fact" ? factIdentity(r.scope, r.path[0]!) : projectIdentity(r.scope, r.field!, r.path);
      expect(r.ref).toBe(secretRefName(identity));
    }
    // Facts listed CLEAR have no reference name in the real index.
    for (const r of c.rows.filter((x) => x.store === "fact" && !x.secret)) {
      expect(secretRefName(factIdentity(r.scope, r.path[0]!))).toBeUndefined();
    }
    // Every leaf of every project field (clear urls/config leaves are not listed by the census).
    const parse = (raw: unknown): Record<string, unknown> => {
      try {
        const v = typeof raw === "string" ? JSON.parse(raw) : null;
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    };
    let leaves = 0;
    for (const p of projects) {
      for (const field of ["credentials", "urls", "config"] as const) {
        for (const leaf of walkProjectField(parse(p[field]))) {
          leaves++;
          const name = secretRefName(projectIdentity(String(p.slug), field, leaf.path));
          if (leaf.secret) {
            const row = c.rows.find(
              (r) => r.store === "project" && r.scope === p.slug && r.field === field && r.path.join("\0") === leaf.path.join("\0"),
            );
            expect(row?.ref).toBe(name);
            expect(name).toBeDefined();
          } else {
            expect(name).toBeUndefined();
          }
        }
      }
    }
    expect(leaves).toBe(12);
  });

  it("reports base-name collisions (production suffixes them)", () => {
    const { facts, projects } = rowsOf();
    const c = buildCensus(facts, projects);
    expect(c.collisions).toEqual([{ base: "SECRET_ALFA_BETA_PASS", members: 2, withheld: false }]);
    expect(c.duplicateNames).toBe(0);
    const refs = c.rows.filter((r) => r.scope.startsWith("alfa")).map((r) => r.ref!);
    expect(refs.every((n) => /^SECRET_ALFA_BETA_PASS_[0-9A-F]{6}$/.test(n))).toBe(true);
    expect(new Set(refs).size).toBe(2);
  });

  it("skips a project field that is not a JSON object", () => {
    const c = buildCensus([], [{ slug: "x", credentials: "not json", urls: "[1]", config: null }]);
    expect(c.rows).toEqual([]);
  });
});

describe("never prints a value", () => {
  it("rows carry no value and the formatted census holds no value, prefix or suffix", () => {
    const { facts, projects } = rowsOf();
    const c = buildCensus(facts, projects);
    const out = formatCensus(c);
    const rowsText = JSON.stringify(c.rows);
    const clearValues = ["Lugar Ejemplo", "persona@example.invalid", "db.example.invalid", "norte"];
    for (const v of [...Object.values(V), ...clearValues]) {
      for (const text of [out, rowsText]) {
        expect(text).not.toContain(v);
        // no 5-character window of a value either (prefix / suffix / slice)
        for (let i = 0; i + 5 <= v.length; i++) expect(text).not.toContain(v.slice(i, i + 5));
      }
    }
    expect(out).toContain("user_facts (6 rows)");
    expect(out).toContain("reference-name collisions: 1");
  });

  it("withholds a key name shaped like a credential value, and its reference name", () => {
    expect(safeLabel("ciudad")).toBe("ciudad");
    expect(safeLabel("x")).toBe("x");
    expect(safeLabel(TOKEN_KEY)).toBeNull();
    const c = buildCensus([{ category: "otro", key: TOKEN_KEY, value: V.factShape }], []);
    const out = formatCensus(c);
    expect(c.rows[0]!.secret).toBe(true); // hidden by its value shape
    expect(out).not.toContain(TOKEN_KEY.slice(4, 14));
    expect(out).toContain("[name withheld: shaped like a credential]");
    expect(out).toContain("ref=(withheld)");
  });
});

describe("reproduceSearch", () => {
  it("returns what the real searchFiles returns, with the stored values' scrub", () => {
    const { facts, projects } = rowsOf();
    const { scrub } = buildCensus(facts, projects);
    for (const q of ["cliente", "factura", "deploy", "aparece", "cliente factura", V.dbPw.slice(0, 6)]) {
      const mine = reproduceSearch(db, q, KB_TOOL_LIMIT, scrub);
      const real = searchFiles(q, KB_TOOL_LIMIT).map((r) => r.path);
      expect(mine.paths).toEqual(real);
    }
    // a hit only inside a stored value is dropped by both
    expect(reproduceSearch(db, V.dbPw.slice(0, 6), KB_TOOL_LIMIT, scrub).paths).toEqual([]);
  });
});

describe("withheld collision base (audit R1 W1)", () => {
  it("never prints a value-shaped key through a colliding base name, in any case form", () => {
    const ak = j("AK", "IA", "Q7RT", "M2XW", "9PLB", "K4ZD");
    expect(safeLabel(ak)).toBeNull();
    const c = buildCensus(
      [{ category: "g", key: ak, value: V.factShape }],
      [{ slug: "g", credentials: JSON.stringify({ [ak]: V.factShape }), urls: "{}", config: "{}" }],
    );
    expect(c.collisions).toHaveLength(1);
    expect(c.collisions[0]!.withheld).toBe(true);
    const out = formatCensus(c).toUpperCase();
    expect(out).not.toContain(ak.toUpperCase());
    for (let i = 0; i + 6 <= ak.length; i++) expect(out).not.toContain(ak.slice(i, i + 6).toUpperCase());
    expect(out).toContain("[NAME WITHHELD: SHAPED LIKE A CREDENTIAL] — 2 ENTRIES");
  });
});

describe("constants pinned to the source (audit R1 W3)", () => {
  it("FTS_FETCH_CAP and the jarvis_file_search default limit match src/", () => {
    const fs = readFileSync(new URL("../src/db/jarvis-fs.ts", import.meta.url), "utf8");
    const cap = /^const FTS_FETCH_CAP = ([\d_]+);$/m.exec(fs);
    expect(cap).not.toBeNull();
    expect(FTS_FETCH_CAP).toBe(Number(cap![1]!.replace(/_/g, "")));
    const tool = readFileSync(new URL("../src/tools/builtin/jarvis-files.ts", import.meta.url), "utf8");
    const lim = /Number\(args\.limit\) \|\| (\d+), 1\), \d+\);\s*const results = searchFiles\(/.exec(tool);
    expect(lim).not.toBeNull();
    expect(KB_TOOL_LIMIT).toBe(Number(lim![1]));
  });
});

describe("parseQueries", () => {
  it("splits on | and refuses none or more than 5", () => {
    expect(parseQueries("cliente| factura |deploy")).toEqual(["cliente", "factura", "deploy"]);
    expect(() => parseQueries(" | ")).toThrow(/no query/);
    expect(() => parseQueries("a|b|c|d|e|f")).toThrow(/maximum 5/);
    expect(parseQueries("a|b|c|d|e")).toHaveLength(5);
  });
});

describe("toolLessSchedules / openReadOnly", () => {
  it("lists only active schedules with tools='[]', on a handle that refuses writes", () => {
    const ro = openReadOnly(join(dir, "t.db"));
    try {
      expect(toolLessSchedules(ro)).toEqual([{ schedule_id: "s-1", name: "Resumen diario", delivery: "telegram" }]);
      expect(() => ro.prepare("DELETE FROM scheduled_tasks").run()).toThrow();
    } finally {
      ro.close();
    }
    expect(() => openReadOnly(join(dir, "missing.db"))).toThrow();
  });
});
