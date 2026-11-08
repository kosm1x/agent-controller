/**
 * Tombstones (MEMORY_TOMBSTONES): term extraction, the write rules and the
 * read-side cache. A real in-memory schema behind the mocked getDatabase; the
 * secret store is one synthetic pair of stored values.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("../db/index.js", () => ({
  getDatabase: vi.fn(),
  writeWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

const traceSpy = vi.fn();
vi.mock("../observability/task-trace.js", () => ({
  emitTraceEvent: (...args: unknown[]) => traceSpy(...args),
}));

// Two stored values stand in for the secret store: a word and a numeric PIN.
const SYN = vi.hoisted(() => ["syn" + "q".repeat(12), "4821" + "3907"]);
vi.mock("../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/secret-refs.js")>()),
  scrubSecrets: (t: string) => SYN.reduce((s, v) => s.replaceAll(v, "[oculto]"), t),
  secretSpans: (t: string) => {
    const spans: Array<[number, number]> = [];
    for (const v of SYN) for (let i = t.indexOf(v); i !== -1; i = t.indexOf(v, i + 1)) spans.push([i, i + v.length]);
    return spans;
  },
}));

import {
  clearTombstoneCache,
  loadTombstones,
  pruneTombstones,
  recordTombstone,
  silencedBy,
  tombstoneMode,
  tombstoneTerms,
  traceTombstoneSkipped,
} from "./tombstones.js";
import { getDatabase } from "../db/index.js";
import { scrubSecrets } from "../lib/secret-refs.js";
import { ftsTokens } from "./fts-terms.js";

type Db = ReturnType<typeof getDatabase>;
let db: Db;
const prevMode = process.env.MEMORY_TOMBSTONES;

const seed = (contents: string[]) => {
  const ins = db.prepare(
    "INSERT INTO conversations (bank, tags, content, trust_tier, source, created_at) VALUES ('mc-jarvis', '[]', ?, 2, 'agent', '2026-01-01 00:00:00')",
  );
  for (const c of contents) ins.run(c);
};
const tombRows = () =>
  db.prepare("SELECT created_at, fact_id, reason, terms, new_terms FROM memory_tombstones ORDER BY id").all() as Array<{
    created_at: string;
    fact_id: number;
    reason: string;
    terms: string;
    new_terms: string;
  }>;
const AT = Date.UTC(2026, 0, 10, 12, 0, 0);

beforeAll(async () => {
  const real = await vi.importActual<typeof import("../db/index.js")>("../db/index.js");
  db = real.initDatabase(":memory:");
});
beforeEach(() => {
  vi.clearAllMocks();
  db.exec("DELETE FROM conversations");
  db.exec("DELETE FROM memory_tombstones");
  db.exec("DELETE FROM jme_facts");
  vi.mocked(getDatabase).mockReturnValue(db);
  clearTombstoneCache();
});
afterEach(() => {
  if (prevMode === undefined) delete process.env.MEMORY_TOMBSTONES;
  else process.env.MEMORY_TOMBSTONES = prevMode;
});

describe("tombstoneMode", () => {
  it("reads off|record|on and folds anything else to off", () => {
    expect(tombstoneMode({})).toBe("off");
    expect(tombstoneMode({ MEMORY_TOMBSTONES: "record" })).toBe("record");
    expect(tombstoneMode({ MEMORY_TOMBSTONES: "on" })).toBe("on");
    expect(tombstoneMode({ MEMORY_TOMBSTONES: "ON" })).toBe("off");
    expect(tombstoneMode({ MEMORY_TOMBSTONES: "shadow" })).toBe("off");
  });
});

describe("tombstoneTerms", () => {
  it("keeps the old text's codes the new text does not hold, and the reverse as new terms", () => {
    expect(tombstoneTerms("The gate code is 5821.", "The gate code is 7394.")).toEqual({
      terms: ["5821"],
      newTerms: ["7394"],
    });
    expect(tombstoneTerms("The branch is ZRT.", "The branch is QLM.")).toEqual({ terms: ["zrt"], newTerms: ["qlm"] });
  });

  it("a word is never a term, on either side (qa R1 W1/W2)", () => {
    expect(tombstoneTerms("The person is allergic to penicillin.", "The person is allergic to sulfonamides.")).toEqual({
      terms: [],
      newTerms: [],
    });
    // The measured case: only "pesos" was absent from the new text, and it silenced 240 rows.
    expect(
      tombstoneTerms("El presupuesto aprobado es 3.847.215 pesos.", "El presupuesto ya no es 3.847.215; el nuevo llega luego."),
    ).toEqual({ terms: [], newTerms: [] });
    // "sigue" / "pendiente" are not the new value.
    expect(tombstoneTerms("El presupuesto aprobado es 3.847.215 pesos.", "El presupuesto sigue pendiente.")).toEqual({
      terms: ["3 847 215"],
      newTerms: [],
    });
  });

  it("keeps a code or figure whole, as its FTS token run", () => {
    const { terms, newTerms } = tombstoneTerms("The account balance is 3.847.215.", "The account balance is 2.960.400.");
    expect(terms).toEqual(["3 847 215"]);
    expect(newTerms).toEqual(["2 960 400"]);
    // A figure sharing a part with the new one is still a term of its own.
    expect(tombstoneTerms("Folio KVX-482.", "Folio KVX-519.").terms).toEqual(["kvx 482"]);
  });

  it("an expiry (no new text) has every code as a term and no new terms", () => {
    expect(tombstoneTerms("This week only, the person uses the spare phone ending in 7781.", null)).toEqual({
      terms: ["7781"],
      newTerms: [],
    });
    expect(tombstoneTerms("The person is in Cuernavaca this week.", null)).toEqual({ terms: [], newTerms: [] });
  });

  it("never holds a stored secret value or a redaction placeholder", () => {
    const old = `The person's vault word is ${SYN[0]} and the PIN is ${SYN[1]}; folio KVX-482, mail [email] and key [OCULTO · API].`;
    const { terms, newTerms } = tombstoneTerms(old, "The vault word changed; the PIN changed too.");
    const all = [...terms, ...newTerms];
    expect(all.length).toBeGreaterThan(0);
    const secretToks = new Set(SYN.flatMap(ftsTokens));
    for (const t of all) {
      expect(scrubSecrets(t)).toBe(t);
      for (const tok of t.split(" ")) expect(secretToks.has(tok)).toBe(false);
      expect(["email", "oculto", "api"]).not.toContain(t);
    }
    // The secret-free code the new text lacks still counts.
    expect(terms).toEqual(["kvx 482"]);
    // A stored value in the new text is never a new term either.
    expect(tombstoneTerms("The PIN is pending.", `The PIN is ${SYN[1]}.`).newTerms).toEqual([]);
  });
});

describe("recordTombstone", () => {
  const old = { id: 7, factText: "The gate code is 5821." };

  it("off: writes nothing, traces nothing, runs no statement", () => {
    delete process.env.MEMORY_TOMBSTONES;
    seed(["Usuario: el codigo del porton es 5821"]);
    const prepare = vi.spyOn(db, "prepare");
    try {
      expect(recordTombstone(old, "The gate code is 7394.", "superseded", AT)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
    expect(tombRows()).toEqual([]);
    expect(traceSpy).not.toHaveBeenCalled();
  });

  it.each(["record", "on"] as const)("%s: writes the row dated `at`", (mode) => {
    process.env.MEMORY_TOMBSTONES = mode;
    seed(["Usuario: el codigo del porton es 5821", "Usuario: ahora es 7394"]);
    expect(recordTombstone(old, "The gate code is 7394.", "superseded", AT)).toBe(true);
    expect(tombRows()).toEqual([
      { created_at: "2026-01-10 12:00:00", fact_id: 7, reason: "superseded", terms: '["5821"]', new_terms: '["7394"]' },
    ]);
    expect(traceSpy).toHaveBeenCalledTimes(1);
    expect(traceSpy.mock.calls[0]![0]).toEqual({
      taskId: "memory-tombstones",
      name: "memory.tombstone",
      attrs: { mode, reason: "superseded", terms: 1, newTerms: 1 },
    });
  });

  it("a term a live jme_facts row still holds is dropped; an expired, rejected or the old row itself does not hold it", () => {
    process.env.MEMORY_TOMBSTONES = "record";
    seed(["Usuario: el codigo es 5821", "Usuario: folio KVX-482", "Usuario: el nuevo es 7394"]);
    const fact = db.prepare(
      "INSERT INTO jme_facts (id, source_task, ts, fact_text, category, expires_at, confidence) VALUES (?, 't', 0, ?, ?, ?, ?)",
    );
    fact.run(8, "The code is 5821.", "event", AT - 1, 0.9); // the old row itself
    fact.run(20, "Old locker code 5821.", "event", AT - 1, 0.9); // expired before `at`
    fact.run(21, "Not code 5821.", "preference", null, 0); // operator-rejected marker
    fact.run(22, "Spare locker 5821 until the move.", "event", AT + 1000, 0.9); // live at `at`, gone at liveAt
    expect(recordTombstone({ id: 8, factText: "The code is 5821." }, null, "expired", AT, AT + 2000)).toBe(true);
    expect(tombRows().map((r) => r.terms)).toEqual(['["5821"]']);
    // Live at liveAt (the default: `at`): the term is held, nothing is written.
    db.exec("DELETE FROM memory_tombstones");
    expect(recordTombstone({ id: 8, factText: "The code is 5821." }, null, "expired", AT)).toBe(false);
    fact.run(23, "The person's locker code is 5821.", "preference", null, 0.9); // durable, live
    expect(recordTombstone({ id: 8, factText: "The code is 5821." }, null, "expired", AT, AT + 2000)).toBe(false);
    expect(tombRows()).toEqual([]);
    // A supersede keeps its marker with the held term dropped.
    expect(recordTombstone({ id: 8, factText: "The code is 5821 or KVX-482." }, "The code is 7394.", "superseded", AT)).toBe(true);
    expect(tombRows().map((r) => [r.terms, r.new_terms])).toEqual([['["kvx 482"]', '["7394"]']]);
  });

  it("a 0-term expiry is not written, and the trace says so", () => {
    process.env.MEMORY_TOMBSTONES = "record";
    seed(["Usuario: nada que ver"]);
    expect(recordTombstone({ id: 7, factText: "The person is in Cuernavaca this week." }, null, "expired", AT)).toBe(false);
    expect(tombRows()).toEqual([]);
    expect(traceSpy.mock.calls.map((c) => (c[0] as { attrs: unknown }).attrs)).toEqual([
      { mode: "record", reason: "expired", terms: 0, newTerms: 0 },
    ]);
  });

  it("a 0-term supersede is written as a marker that loadTombstones does not load", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    seed(["Usuario: nada que ver"]);
    const words = { id: 7, factText: "The person is allergic to penicillin." };
    expect(recordTombstone(words, "The person is allergic to sulfonamides.", "superseded", AT)).toBe(true);
    expect(tombRows()).toEqual([
      { created_at: "2026-01-10 12:00:00", fact_id: 7, reason: "superseded", terms: "[]", new_terms: "[]" },
    ]);
    expect(loadTombstones()).toEqual([]);
  });

  it("an expiry is skipped for a fact that already has a superseded tombstone", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    seed(["Usuario: el codigo del porton es 5821"]);
    expect(recordTombstone(old, "The gate code is 7394.", "superseded", AT)).toBe(true);
    expect(recordTombstone(old, null, "expired", AT + 1000)).toBe(false);
    expect(tombRows().map((r) => r.reason)).toEqual(["superseded"]);
    // Another fact's expiry is written.
    expect(recordTombstone({ id: 9, factText: "Code 5821 for the gate." }, null, "expired", AT)).toBe(true);
  });

  it("a code common in the bank is no term, on either side; a rare one still is (qa R2 W1)", () => {
    process.env.MEMORY_TOMBSTONES = "record";
    // 100 bank rows: rare = held by 1 to 2 of them. The other bank does not count.
    seed([
      ...Array.from({ length: 60 }, (_, i) => `Usuario: el cierre 2026 de la tienda ${i} y el plan 2027`),
      ...Array.from({ length: 38 }, (_, i) => `Usuario: junta ${i} en CDMX`),
      "Usuario: la meta del plan 2026 es 40 tiendas, folio 5821",
      "Usuario: la oficina principal está en GDL",
    ]);
    db.prepare(
      "INSERT INTO conversations (bank, tags, content, trust_tier, source, created_at) VALUES ('mc-operational', '[]', 'nota 9931', 2, 'agent', '2026-01-01 00:00:00')",
    ).run();
    expect(
      recordTombstone({ id: 7, factText: "La meta del plan 2026 es 40 tiendas." }, "La meta del plan 2027 es 40 tiendas.", "superseded", AT),
    ).toBe(true);
    expect(recordTombstone({ id: 8, factText: "La oficina principal está en CDMX." }, "La oficina principal está en GDL.", "superseded", AT)).toBe(true);
    // The rare code is kept; a code held only in another bank is absent here and dropped.
    expect(recordTombstone({ id: 9, factText: "El folio es 5821 y la nota 9931." }, null, "expired", AT)).toBe(true);
    expect(tombRows().map((r) => [r.fact_id, r.terms, r.new_terms])).toEqual([
      [7, "[]", "[]"],
      [8, "[]", '["gdl"]'],
      [9, '["5821"]', "[]"],
    ]);
    expect(loadTombstones().map((t) => t.factId)).toEqual([9]);
  });

  it("a failed write returns false and never throws", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getDatabase).mockImplementation(() => {
      throw new Error("db gone");
    });
    try {
      expect(recordTombstone(old, null, "expired", AT)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("tombstone write failed (fact #7, expired)"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("traceTombstoneSkipped", () => {
  it("off: no trace; record|on: a skipped trace with its reason, no row", () => {
    delete process.env.MEMORY_TOMBSTONES;
    traceTombstoneSkipped("reworded");
    expect(traceSpy).not.toHaveBeenCalled();
    for (const mode of ["record", "on"] as const) {
      process.env.MEMORY_TOMBSTONES = mode;
      traceTombstoneSkipped("reworded");
      traceTombstoneSkipped("expired");
    }
    expect(traceSpy.mock.calls.map((c) => c[0])).toEqual(
      ["record", "on"].flatMap((mode) =>
        (["reworded", "expired"] as const).map((reason) => ({
          taskId: "memory-tombstones",
          name: "memory.tombstone",
          attrs: { mode, reason, skipped: true },
        })),
      ),
    );
    expect(tombRows()).toEqual([]);
  });
});

describe("loadTombstones", () => {
  const insert = (createdAt: string, terms: string[], newTerms: string[] = [], factId = 1) =>
    db
      .prepare("INSERT INTO memory_tombstones (created_at, fact_id, reason, terms, new_terms) VALUES (?, ?, 'expired', ?, ?)")
      .run(createdAt, factId, JSON.stringify(terms), JSON.stringify(newTerms));

  it("returns every field, terms as token runs", () => {
    insert("2026-01-02 00:00:00", ["3 847 215", "penicillin"], ["2 960 400"], 4);
    const [t] = loadTombstones();
    expect(t).toEqual({
      id: expect.any(Number),
      createdAt: "2026-01-02 00:00:00",
      factId: 4,
      reason: "expired",
      terms: [["3", "847", "215"], ["penicillin"]],
      newTerms: [["2", "960", "400"]],
    });
  });

  it("reads every tombstone, newest first: no count cap, the 501st-newest of 600 still silences (queue 4bo (a))", () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const ins = db.transaction(() => {
      for (let i = 0; i < 600; i++) insert(at(i), [`term${i}`]);
    });
    ins();
    const list = loadTombstones();
    expect(list).toHaveLength(600);
    expect(list[0]!.terms).toEqual([["term599"]]);
    expect(list.at(-1)!.terms).toEqual([["term0"]]);
    // A 500 cap dropped the 100 oldest: term99 is the 501st-newest, term0 the oldest.
    const before = "2025-12-31 00:00:00";
    expect(silencedBy({ content: "Usuario: el folio es term99", created_at: before }, list)?.terms).toEqual([["term99"]]);
    expect(silencedBy({ content: "Usuario: el folio es term0", created_at: before }, list)?.terms).toEqual([["term0"]]);
  });

  it("is cached until a write (or clearTombstoneCache), and reloads for another database", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    insert("2026-01-02 00:00:00", ["first"]);
    const a = loadTombstones();
    expect(a).toHaveLength(1);
    insert("2026-01-03 00:00:00", ["second"]);
    expect(loadTombstones()).toBe(a); // no statement: the cache holds
    seed(["Usuario: el codigo del porton es 5821"]);
    expect(recordTombstone({ id: 7, factText: "The gate code is 5821." }, null, "expired", AT)).toBe(true);
    expect(loadTombstones()).toHaveLength(3);
    insert("2026-01-04 00:00:00", ["third"]);
    clearTombstoneCache();
    expect(loadTombstones()).toHaveLength(4);
    const other = new Database(":memory:");
    other.exec(
      "CREATE TABLE memory_tombstones (id INTEGER PRIMARY KEY, created_at TEXT, fact_id INTEGER, reason TEXT, terms TEXT, new_terms TEXT)",
    );
    vi.mocked(getDatabase).mockReturnValue(other);
    expect(loadTombstones()).toEqual([]);
  });
});

describe("pruneTombstones", () => {
  const insert = (createdAt: string, factId: number, terms: string[], newTerms: string[] = [], reason = "expired") =>
    db
      .prepare("INSERT INTO memory_tombstones (created_at, fact_id, reason, terms, new_terms) VALUES (?, ?, ?, ?, ?)")
      .run(createdAt, factId, reason, JSON.stringify(terms), JSON.stringify(newTerms));
  const liveFact = (id: number) =>
    db.prepare("INSERT INTO jme_facts (id, source_task, ts, fact_text, category) VALUES (?, 't', 1, 'x', 'event')").run(id);
  const conv = (bank: string, content: string, createdAt: string) =>
    db
      .prepare("INSERT INTO conversations (bank, tags, content, trust_tier, source, created_at) VALUES (?, '[]', ?, 2, 'agent', ?)")
      .run(bank, content, createdAt);
  const left = () => (db.prepare("SELECT fact_id FROM memory_tombstones ORDER BY fact_id").all() as Array<{ fact_id: number }>).map((r) => r.fact_id);
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("deletes a tombstone once its fact row and every bank row it silences are gone; keeps the rest", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    const T = "2026-01-10 00:00:00";
    liveFact(2);
    liveFact(7);
    insert(T, 1, ["5821"]); // fact gone, nothing left to silence → pruned
    insert(T, 2, ["5822"]); // fact row still exists → kept
    insert(T, 3, ["kvx 482"]); // fact gone, an older bank row holds the term → kept
    insert(T, 4, ["5824"]); // fact gone, the only row holding it is newer → pruned
    insert(T, 5, ["5825"], ["7395"]); // fact gone, the row holds the new term too (the correction) → pruned
    insert(T, 6, ["5826"]); // fact gone, the row holding it is in another bank → pruned
    insert(T, 7, [], [], "superseded"); // 0-term marker, fact row exists → kept
    insert(T, 8, [], [], "superseded"); // 0-term marker, fact gone → pruned
    conv("mc-jarvis", "Usuario: el folio es KVX-482", "2026-01-05 00:00:00");
    conv("mc-jarvis", "Usuario: el codigo es 5824", "2026-01-11 00:00:00");
    conv("mc-jarvis", "Usuario: era 5825, ahora es 7395", "2026-01-05 00:00:00");
    conv("mc-operational", "nota 5826", "2026-01-05 00:00:00");
    expect(loadTombstones()).toHaveLength(6);
    expect(pruneTombstones()).toBe(5);
    expect(left()).toEqual([2, 3, 7]);
    expect(loadTombstones().map((t) => t.factId).sort()).toEqual([2, 3]); // the cache was dropped
    expect(log).toHaveBeenCalledWith("[memory] tombstone prune (on): 5 pruned of 6 whose fact is gone");
    // The kept one goes once its bank row does.
    db.exec("DELETE FROM conversations WHERE content LIKE '%KVX-482%'");
    expect(pruneTombstones()).toBe(1);
    expect(left()).toEqual([2, 7]);
  });

  it("keeps every orphan that silences a row, not only the first; both go with the row", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    insert("2026-01-10 00:00:00", 1, ["5821"]);
    insert("2026-01-11 00:00:00", 2, ["kvx 482"]);
    conv("mc-jarvis", "Usuario: el codigo 5821 y el folio KVX-482", "2026-01-05 00:00:00");
    expect(pruneTombstones()).toBe(0);
    expect(left()).toEqual([1, 2]);
    db.exec("DELETE FROM conversations");
    expect(pruneTombstones()).toBe(2);
    expect(left()).toEqual([]);
  });

  it("record mode prunes too; zero tombstones prunes nothing and still logs the summary", () => {
    process.env.MEMORY_TOMBSTONES = "record";
    expect(pruneTombstones()).toBe(0);
    expect(log).toHaveBeenCalledWith("[memory] tombstone prune (record): 0 pruned of 0 whose fact is gone");
    insert("2026-01-10 00:00:00", 1, ["5821"]);
    expect(pruneTombstones()).toBe(1);
    expect(left()).toEqual([]);
  });

  it("off: deletes nothing and runs no statement", () => {
    delete process.env.MEMORY_TOMBSTONES;
    insert("2026-01-10 00:00:00", 1, ["5821"]);
    const prepare = vi.spyOn(db, "prepare");
    try {
      expect(pruneTombstones()).toBe(0);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
    expect(left()).toEqual([1]);
    expect(log).not.toHaveBeenCalled();
  });

  it("a failed prune returns 0 and never throws", () => {
    process.env.MEMORY_TOMBSTONES = "on";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getDatabase).mockImplementation(() => {
      throw new Error("db gone");
    });
    try {
      expect(pruneTombstones()).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("tombstone prune failed: db gone"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("silencedBy", () => {
  const tomb = {
    id: 1,
    createdAt: "2026-01-10 00:00:00",
    factId: 1,
    reason: "superseded" as const,
    terms: [["5821"], ["kvx", "482"]],
    newTerms: [["7394"]],
  };
  const row = (content: string, created_at = "2026-01-09 00:00:00") => ({ content, created_at });

  it("silences a row created before the tombstone that holds a term and no new term", () => {
    expect(silencedBy(row("Usuario: el codigo es 5821"), [tomb])).toBe(tomb);
    expect(silencedBy(row("Folio KVX-482 pendiente"), [tomb])).toBe(tomb);
  });
  it("keeps a row created at or after the tombstone", () => {
    expect(silencedBy(row("Usuario: el codigo es 5821", "2026-01-10 00:00:00"), [tomb])).toBeUndefined();
    expect(silencedBy(row("Usuario: el codigo es 5821", "2026-01-11 00:00:00"), [tomb])).toBeUndefined();
  });
  it("keeps a row without a term, or with a term's tokens apart", () => {
    expect(silencedBy(row("Usuario: el codigo es otro"), [tomb])).toBeUndefined();
    expect(silencedBy(row("Folio 482. KVX pendiente"), [tomb])).toBeUndefined();
    expect(silencedBy(row("Usuario: 58210 no es"), [tomb])).toBeUndefined();
  });
  it("keeps a row that also holds a new term", () => {
    expect(silencedBy(row("Usuario: cambio de 5821 a 7394"), [tomb])).toBeUndefined();
  });
  it("returns the first silencing tombstone in list order, past ones that do not apply", () => {
    const older = { ...tomb, id: 2, createdAt: "2026-01-05 00:00:00", terms: [["9931"], ["5821"]], newTerms: [] };
    const other = { ...tomb, id: 3, terms: [["4410"]], newTerms: [] };
    const list = [other, tomb, older];
    expect(silencedBy(row("Usuario: 5821 y 9931"), list)).toBe(tomb);
    // Created after `older`, before `tomb`; holds tomb's new term: neither applies.
    expect(silencedBy(row("Usuario: 5821 y 7394", "2026-01-06 00:00:00"), list)).toBeUndefined();
    // Holds tomb's new term but is older than `older`: `older` silences it.
    expect(silencedBy(row("Usuario: 5821 y 7394", "2026-01-04 00:00:00"), list)).toBe(older);
    expect(silencedBy(row("Usuario: 4410 y 5821"), list)).toBe(other);
  });
});
