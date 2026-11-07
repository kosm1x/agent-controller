/**
 * SqliteMemoryBackend recall-instrumentation tests (V8.1 Phase A —
 * bundle V8.1-PA-recall-logging).
 *
 * Scope: the `instrument` constructor flag and the `recall()` wrapper that
 * applies outcome bias + writes a recall_audit row when this backend is the
 * top-level memory service. The hybrid retrieval body (`recallHybrid`) and
 * the collaborators (`applyOutcomeBias`, `logRecall`) are covered by their
 * own suites — here we mock them and verify the wiring only.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// getDatabase throws → recallHybrid's outer try/catch returns [] — a
// deterministic empty `raw` so the wrapper assertions don't depend on DB
// state. writeWithRetry is imported by the module but unused on this path.
vi.mock("../db/index.js", () => ({
  getDatabase: vi.fn(() => {
    throw new Error("no db in test");
  }),
  writeWithRetry: vi.fn((fn: () => unknown) => fn()),
}));

const logRecallSpy = vi.fn();
vi.mock("./recall-utility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./recall-utility.js")>()),
  logRecall: (...args: unknown[]) => logRecallSpy(...args),
}));

const traceSpy = vi.fn();
vi.mock("../observability/task-trace.js", () => ({
  emitTraceEvent: (...args: unknown[]) => traceSpy(...args),
}));

const applyOutcomeBiasSpy = vi.fn();
vi.mock("./outcome-bias.js", () => ({
  applyOutcomeBias: (...args: unknown[]) => applyOutcomeBiasSpy(...args),
}));

// Ruling 3c fold F7: one synthetic stored value stands in for the secret
// store; embed is stubbed so retain never reaches a provider.
const SCRUB_SYN = vi.hoisted(() => "syn-" + "m".repeat(14));
vi.mock("../lib/secret-refs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/secret-refs.js")>()),
  scrubSecrets: (t: string) => t.replaceAll(SCRUB_SYN, "[oculto]"),
}));
const embedSpy = vi.fn(async (..._args: unknown[]) => null);
vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  embed: (...a: unknown[]) => embedSpy(...a),
}));

import {
  SqliteMemoryBackend,
  clearVectorCache,
  keywordDocFrequency,
  rareTermCandidates,
  rareDocThreshold,
  recallFloorMode,
} from "./sqlite-backend.js";
import { getDatabase } from "../db/index.js";
import { serializeEmbedding } from "./embeddings.js";
import type { MemoryItem, RecallOptions } from "./types.js";

// Pinned from the pre-floor recall (the off path): the bm25 top five of the
// ten common-word rows; adding "zafiro" to the query returns the same five.
const GOLDEN_COMMON = [
  "Usuario: el proyecto zafiro de la semana arranca el lunes",
  "Usuario: el proyecto de la semana 8 sigue en curso",
  "Usuario: el proyecto de la semana 7 sigue en curso",
  "Usuario: el proyecto de la semana 6 sigue en curso",
  "Usuario: el proyecto de la semana 5 sigue en curso",
];
const GOLDEN_RARE = GOLDEN_COMMON;

const KEPT: MemoryItem[] = [{ content: "biased-result", tags: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  // Controlled bias result so we can prove the wrapper forwards `kept`,
  // `excluded`, and `breakdown` rather than the raw retrieval output.
  applyOutcomeBiasSpy.mockReturnValue({
    kept: KEPT,
    excluded: 2,
    breakdown: { success: 1, concerns: 0, failed: 2, unknown: 0 },
  });
});

const opts = (extra: Partial<RecallOptions> = {}): RecallOptions =>
  ({ bank: "mc-jarvis", ...extra }) as RecallOptions;

describe("SqliteMemoryBackend — recall instrumentation", () => {
  describe("instrument=true (primary service, the default)", () => {
    it("applies outcome bias to the raw retrieval result", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("query text", opts());

      expect(applyOutcomeBiasSpy).toHaveBeenCalledTimes(1);
      // raw is [] because getDatabase throws inside recallHybrid.
      const [rawArg, optsArg] = applyOutcomeBiasSpy.mock.calls[0]!;
      expect(rawArg).toEqual([]);
      expect(optsArg).toMatchObject({ bank: "mc-jarvis" });
    });

    it("writes a recall_audit row tagged source='sqlite-primary'", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("query text", opts());

      expect(logRecallSpy).toHaveBeenCalledTimes(1);
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.source).toBe("sqlite-primary");
      expect(row.bank).toBe("mc-jarvis");
      expect(row.query).toBe("query text");
      expect(row.results).toBe(KEPT);
      expect(row.excludedCount).toBe(2);
      expect(row.outcomeBreakdown).toEqual({
        success: 1,
        concerns: 0,
        failed: 2,
        unknown: 0,
      });
      expect(typeof row.latencyMs).toBe("number");
      expect(row.latencyMs as number).toBeGreaterThanOrEqual(0);
    });

    it("returns the biased `kept` set, not the raw retrieval result", async () => {
      const backend = new SqliteMemoryBackend();
      const result = await backend.recall("query text", opts());
      expect(result).toBe(KEPT);
    });

    it("tags the row with the resolved recall mode (default: coherence)", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("q", opts());
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.mode).toBe("coherence");
    });

    it("propagates an explicit recallMode onto the logged row", async () => {
      const backend = new SqliteMemoryBackend();
      await backend.recall("q", opts({ recallMode: "correspondence" }));
      const row = logRecallSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(row.mode).toBe("correspondence");
    });
  });

  describe("instrument=false (nested fallback / A/B tool)", () => {
    it("does NOT write a recall_audit row", async () => {
      const backend = new SqliteMemoryBackend(false);
      await backend.recall("query text", opts());
      expect(logRecallSpy).not.toHaveBeenCalled();
    });

    it("does NOT apply outcome bias — returns raw retrieval", async () => {
      const backend = new SqliteMemoryBackend(false);
      const result = await backend.recall("query text", opts());
      expect(applyOutcomeBiasSpy).not.toHaveBeenCalled();
      // raw recallHybrid output (getDatabase threw → []).
      expect(result).toEqual([]);
    });
  });
});

describe("SqliteMemoryBackend — retain (ruling 3c)", () => {
  it("stores and embeds the content with stored credential values scrubbed", async () => {
    const run = vi.fn(() => ({ lastInsertRowid: 1 }));
    vi.mocked(getDatabase).mockReturnValueOnce({
      prepare: () => ({ run }),
    } as unknown as ReturnType<typeof getDatabase>);
    await new SqliteMemoryBackend().retain(`Usuario: la clave es ${SCRUB_SYN}`, {
      bank: "mc-jarvis",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toContain("Usuario: la clave es [oculto]");
    expect(JSON.stringify(run.mock.calls)).not.toContain(SCRUB_SYN);
    expect(embedSpy).toHaveBeenCalledWith("Usuario: la clave es [oculto]");
  });
});

describe("SqliteMemoryBackend — recall scrub (ruling 3c, audit R3 B1)", () => {
  // A row stored before the write-side scrub (or before the value was saved)
  // comes back from every retrieval layer; FTS hit here, embed stubbed null.
  const row = () => ({
    content: `Usuario: la clave es ${SCRUB_SYN}`,
    created_at: "2026-01-01 00:00:00",
    trust_tier: 2,
    tags: "[]",
    score: -1,
  });
  const fakeDb = () =>
    ({
      prepare: () => ({ all: () => [row()] }),
    }) as unknown as ReturnType<typeof getDatabase>;

  it.each([
    ["instrument=false (the Hindsight fallback)", false],
    ["instrument=true (primary service)", true],
  ])("%s: recalled content carries no stored value", async (_l, instrument) => {
    applyOutcomeBiasSpy.mockImplementation((raw: MemoryItem[]) => ({
      kept: raw,
      excluded: 0,
      breakdown: { success: 0, concerns: 0, failed: 0, unknown: 0 },
    }));
    vi.mocked(getDatabase).mockReturnValue(fakeDb());
    try {
      const out = await new SqliteMemoryBackend(instrument).recall(
        "clave acceso",
        opts(),
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]!.content).toBe("Usuario: la clave es [oculto]");
      expect(JSON.stringify(out)).not.toContain(SCRUB_SYN);
    } finally {
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error("no db in test");
      });
    }
  });
});

describe("SqliteMemoryBackend — recall floor (MEMORY_RECALL_FLOOR)", () => {
  // A real in-memory schema (FTS5 table + sync triggers) behind the mocked
  // getDatabase; embed is stubbed null, so FTS and LIKE are the only layers.
  type Db = ReturnType<typeof getDatabase>;
  let db: Db;
  const BANK = "mc-jarvis";
  const prevMode = process.env.MEMORY_RECALL_FLOOR;

  const seed = (contents: string[], bank = BANK) => {
    const ins = db.prepare(
      "INSERT INTO conversations (bank, tags, content, trust_tier, source, created_at) VALUES (?, '[]', ?, 2, 'agent', ?)",
    );
    db.transaction(() => {
      contents.forEach((c, i) => {
        const t = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString().replace("T", " ").slice(0, 19);
        ins.run(bank, c, t);
      });
    })();
  };
  const recall = (q: string, mode?: "off" | "shadow" | "on") => {
    if (mode === undefined) delete process.env.MEMORY_RECALL_FLOOR;
    else process.env.MEMORY_RECALL_FLOOR = mode;
    return new SqliteMemoryBackend(false).recall(q, opts({ maxResults: 5 }));
  };
  const contents = (items: MemoryItem[]) => items.map((m) => m.content);
  // Decay reads the clock, so `relevance` drifts between two calls.
  const sansRelevance = (items: MemoryItem[]) => items.map(({ relevance: _r, ...m }) => m);
  const floorTraces = () =>
    traceSpy.mock.calls.map((c) => c[0] as { taskId: string; name: string; attrs: Record<string, unknown> });

  // Ten of 30 rows share the common words; one of them also carries "zafiro".
  // (A word in every row scores ~0 in bm25 and the relevance filter drops it
  // before the floor sees it, so the common words stay in a third of the bank.)
  const GOLDEN_BANK = [
    ...Array.from({ length: 9 }, (_, i) => `Usuario: el proyecto de la semana ${i} sigue en curso`),
    "Usuario: el proyecto zafiro de la semana arranca el lunes",
    ...Array.from({ length: 20 }, (_, i) => `Usuario: reunion ${i} con el equipo de ventas`),
  ];

  beforeAll(async () => {
    const real = await vi.importActual<typeof import("../db/index.js")>("../db/index.js");
    db = real.initDatabase(":memory:");
  });
  beforeEach(() => {
    db.exec("DELETE FROM conversation_embeddings");
    db.exec("DELETE FROM conversations");
    clearVectorCache();
    vi.mocked(getDatabase).mockReturnValue(db);
  });
  afterEach(() => {
    vi.mocked(getDatabase).mockImplementation(() => {
      throw new Error("no db in test");
    });
    if (prevMode === undefined) delete process.env.MEMORY_RECALL_FLOOR;
    else process.env.MEMORY_RECALL_FLOOR = prevMode;
  });

  it("recallFloorMode reads off|shadow|on and folds anything else to off", () => {
    expect(recallFloorMode({})).toBe("off");
    expect(recallFloorMode({ MEMORY_RECALL_FLOOR: "shadow" })).toBe("shadow");
    expect(recallFloorMode({ MEMORY_RECALL_FLOOR: "on" })).toBe("on");
    expect(recallFloorMode({ MEMORY_RECALL_FLOOR: "ON" })).toBe("off");
    expect(recallFloorMode({ MEMORY_RECALL_FLOOR: "true" })).toBe("off");
  });

  it("off: golden results unchanged for common-word queries, fallback included, no trace", async () => {
    seed(GOLDEN_BANK);
    const unset = contents(await recall("como va el proyecto esta semana"));
    const off = contents(await recall("como va el proyecto esta semana", "off"));
    expect(off).toEqual(unset);
    expect(off).toEqual(GOLDEN_COMMON);
    // "zafiro" is in one row; off still returns the common-word rows beside it.
    expect(contents(await recall("que paso con el proyecto zafiro esta semana", "off"))).toEqual(GOLDEN_RARE);
    // Nothing matches: the newest rows come back, newest first.
    const fb = contents(await recall("factura pendiente del dentista", "off"));
    expect(fb).toEqual([...GOLDEN_BANK].reverse().slice(0, 5));
    expect(traceSpy).not.toHaveBeenCalled();
  });

  it("on: a query made only of common words returns []", async () => {
    seed(GOLDEN_BANK);
    expect(await recall("como va el proyecto esta semana", "on")).toEqual([]);
    const [t] = floorTraces();
    expect(t).toEqual({
      taskId: "memory-recall",
      name: "memory.recall_floor",
      attrs: { mode: "on", bank: BANK, returned: 0, wouldDrop: 10, rareTerms: 0 },
    });
  });

  it("on: a rare+common query keeps only the row with the rare keyword", async () => {
    seed(GOLDEN_BANK);
    const out = await recall("que paso con el proyecto zafiro esta semana", "on");
    expect(contents(out)).toEqual(["Usuario: el proyecto zafiro de la semana arranca el lunes"]);
    expect(out[0]!.relevance).toBeTypeOf("number");
    expect(floorTraces()[0]!.attrs).toEqual({ mode: "on", bank: BANK, returned: 1, wouldDrop: 9, rareTerms: 1 });
  });

  it("on: the newest-rows fallback never returns", async () => {
    seed(GOLDEN_BANK);
    expect(await recall("factura pendiente del dentista", "on")).toEqual([]);
    expect(floorTraces()[0]!.attrs).toEqual({ mode: "on", bank: BANK, returned: 0, wouldDrop: 0, rareTerms: 0 });
  });

  it("shadow: same results as off, plus a counts-only trace", async () => {
    seed(GOLDEN_BANK);
    const q = "que paso con el proyecto zafiro esta semana";
    const off = await recall(q, "off");
    traceSpy.mockClear();
    const shadow = await recall(q, "shadow");
    expect(sansRelevance(shadow)).toEqual(sansRelevance(off));
    expect(floorTraces()).toHaveLength(1);
    expect(floorTraces()[0]).toEqual({
      taskId: "memory-recall",
      name: "memory.recall_floor",
      attrs: { mode: "shadow", bank: BANK, returned: 5, wouldDrop: 9, rareTerms: 1 },
    });
    // On a common-only query shadow still returns every row and counts them all.
    traceSpy.mockClear();
    const common = "como va el proyecto esta semana";
    expect(contents(await recall(common, "shadow"))).toEqual(contents(await recall(common, "off")));
    expect(floorTraces()[0]!.attrs).toEqual({
      mode: "shadow",
      bank: BANK,
      returned: GOLDEN_COMMON.length,
      wouldDrop: 10,
      rareTerms: 0,
    });
    expect(JSON.stringify(floorTraces())).not.toContain("zafiro");
    // Shadow keeps the fallback and counts every row it returns as a would-drop.
    traceSpy.mockClear();
    const fb = await recall("factura pendiente del dentista", "shadow");
    expect(fb).toHaveLength(5);
    expect(floorTraces()[0]!.attrs).toEqual({ mode: "shadow", bank: BANK, returned: 5, wouldDrop: 5, rareTerms: 0 });
  });

  it("rareDocThreshold is 2 % of the bank, never below 1", () => {
    expect(rareDocThreshold(0)).toBe(1);
    expect(rareDocThreshold(1)).toBe(1);
    expect(rareDocThreshold(50)).toBe(1);
    expect(rareDocThreshold(51)).toBe(2);
    expect(rareDocThreshold(5000)).toBe(100);
  });

  it("bank of 1: its only row's keyword counts as rare (floor = 1)", async () => {
    // bm25 gives a term found in every row a ~0 score, so the merge already
    // drops this row in off mode too; the trace shows the floor counted it rare.
    seed(["Usuario: el proyecto zafiro arranca"]);
    await recall("proyecto", "on");
    expect(floorTraces()[0]!.attrs).toMatchObject({ rareTerms: 1 });
  });

  it("bank of 50: a keyword in 2 rows is common (floor = 1), in 1 row is rare", async () => {
    seed([
      "Usuario: zafiro uno",
      "Usuario: zafiro dos",
      "Usuario: esmeralda tres",
      ...Array.from({ length: 47 }, (_, i) => `Usuario: relleno ${i}`),
    ]);
    expect(await recall("zafiro", "on")).toEqual([]);
    expect(contents(await recall("esmeralda", "on"))).toEqual(["Usuario: esmeralda tres"]);
    expect(floorTraces().map((t) => t.attrs.rareTerms)).toEqual([0, 1]);
  });

  it("bank of 5000: a keyword in 100 rows is rare, in 101 rows is common", async () => {
    seed([
      ...Array.from({ length: 100 }, (_, i) => `Usuario: zafiro ${i}`),
      ...Array.from({ length: 101 }, (_, i) => `Usuario: esmeralda ${i}`),
      ...Array.from({ length: 4799 }, (_, i) => `Usuario: relleno ${i}`),
    ]);
    expect(await recall("zafiro", "on")).toHaveLength(5);
    expect(await recall("esmeralda", "on")).toEqual([]);
    expect(floorTraces().map((t) => t.attrs.rareTerms)).toEqual([1, 0]);
  });

  it("the floor counts rows of the recalled bank only", async () => {
    seed(["Usuario: zafiro en otro banco", "Usuario: zafiro de nuevo"], "mc-operational");
    seed(["Usuario: el zafiro de este banco", ...Array.from({ length: 49 }, (_, i) => `Usuario: relleno ${i}`)]);
    expect(contents(await recall("zafiro", "on"))).toEqual(["Usuario: el zafiro de este banco"]);
  });

  describe("codes, figures and acronyms", () => {
    // 30 rows: the golden common-word rows, three exact rows, and rows that
    // hold the codes' fragments ("482", "847", "215") but not the codes.
    const CODE_BANK = [
      ...GOLDEN_BANK.slice(0, 24),
      "Usuario: el folio KVX-482 quedó pendiente con el proveedor",
      "Usuario: el presupuesto final fue de 3.847.215 pesos",
      "Usuario: este mes toca revisar IVA SAT CFE",
      "Usuario: la ruta 482 del camión cambia el lunes",
      "Usuario: el lote 847 y el lote 215 llegaron",
      "Usuario: mesa 215 reservada",
    ];

    it.each([
      ["KVX-482", "Usuario: el folio KVX-482 quedó pendiente con el proveedor"],
      ["¿cuánto fue 3.847.215?", "Usuario: el presupuesto final fue de 3.847.215 pesos"],
      ["IVA SAT CFE", "Usuario: este mes toca revisar IVA SAT CFE"],
    ])("on: %s keeps its exact row and drops the rows with its fragments only", async (q, row) => {
      seed(CODE_BANK);
      const out = contents(await recall(q, "on"));
      expect(out).toContain(row);
      expect(out.every((c) => c === row)).toBe(true);
      expect(contents(await recall(q, "off"))).toContain(row);
    });

    it("rareTermCandidates keeps a code or figure whole, as its FTS token run", () => {
      expect(rareTermCandidates("KVX-482")).toContain("kvx 482");
      expect(rareTermCandidates("¿cuánto fue 3.847.215?")).toContain("3 847 215");
      expect(rareTermCandidates("IVA SAT CFE")).toEqual(expect.arrayContaining(["iva", "sat", "cfe"]));
      // Not codes: a lower-case 3-letter word, an upper-case stop-word, a 2-digit number.
      expect(rareTermCandidates("sol")).toEqual([]);
      expect(rareTermCandidates("THE PARA")).toEqual([]);
      expect(rareTermCandidates("mesa 12")).toEqual(["mesa"]);
      // Words of 4+ chars keep the content-token rule (stop-words out, accents folded).
      expect(rareTermCandidates("Camión para este informe")).toEqual(["camion", "informe"]);
    });

    it("keywordDocFrequency counts a code as a phrase, not its fragments", () => {
      seed(CODE_BANK);
      expect(keywordDocFrequency("KVX-482", BANK).get("kvx 482")).toBe(1);
      expect(keywordDocFrequency("3.847.215", BANK).get("3 847 215")).toBe(1);
    });

    // Rows that hold both tokens of "KVX-482", but never "kvx" followed by "482".
    const SCRAMBLED = [
      "Usuario: lote 482-KVX en bodega",
      "Usuario: el KVX llegó y la caja 482 también",
      "Usuario: Folio 482. KVX pendiente",
    ];

    it("keywordDocFrequency counts the phrase only, not rows holding both tokens apart", () => {
      seed([...CODE_BANK, ...SCRAMBLED]);
      expect(keywordDocFrequency("KVX-482", BANK).get("kvx 482")).toBe(1);
    });

    it("on: a row with both tokens of a code, not contiguous, is dropped", async () => {
      seed([...CODE_BANK, ...SCRAMBLED]);
      const row = "Usuario: el folio KVX-482 quedó pendiente con el proveedor";
      // Off ranks the scrambled rows by FTS score, so the floor is what removes them.
      expect(contents(await recall("KVX-482", "off"))).toEqual(expect.arrayContaining(SCRAMBLED));
      expect(contents(await recall("KVX-482", "on"))).toEqual([row]);
    });
  });

  it("on: a row found only by embeddings is kept, an FTS-only common-word row is dropped", async () => {
    seed(GOLDEN_BANK);
    const target = "Usuario: reunion 3 con el equipo de ventas";
    const id = (db.prepare("SELECT id FROM conversations WHERE content = ?").get(target) as { id: number }).id;
    const vec = new Float32Array([1, 0, 0]);
    db.prepare("INSERT INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)").run(id, serializeEmbedding(vec));
    embedSpy.mockResolvedValue(vec as never);
    try {
      const out = contents(await recall("como va el proyecto esta semana", "on"));
      expect(out).toEqual([target]);
      // Off returns the same embedding row beside the common-word FTS rows.
      const off = contents(await recall("como va el proyecto esta semana", "off"));
      expect(off).toContain(target);
      expect(off.some((c) => c.includes("proyecto"))).toBe(true);
    } finally {
      embedSpy.mockResolvedValue(null);
    }
  });

  it("the doc-frequency count runs the FTS match as the outer loop, not the bank index", () => {
    seed(GOLDEN_BANK);
    const sqls: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    });
    try {
      keywordDocFrequency("zafiro", BANK, 5);
    } finally {
      spy.mockRestore();
    }
    const sql = sqls.find((q) => q.includes("conversations_fts MATCH"))!;
    // The bundled SQLite plans FTS first either way; 3.45.1 did not without the CROSS JOIN.
    expect(sql).toMatch(/FROM conversations_fts f CROSS JOIN conversations c/);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('"zafiro"', BANK, 5) as Array<{ detail: string }>).map((r) => r.detail);
    const steps = plan.filter((d) => /^(SCAN|SEARCH) /.test(d));
    expect(steps[0]).toMatch(/^SCAN f VIRTUAL TABLE/);
    expect(plan.join("\n")).not.toMatch(/idx_conversations_bank/);
  });

  it("a failed rare-term lookup skips the floor: shadow returns what off returns, traced as an error", async () => {
    seed(GOLDEN_BANK);
    const q = "que paso con el proyecto zafiro esta semana";
    const off = await recall(q, "off");
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("COUNT(*) AS n FROM conversations WHERE bank")) throw new Error("synthetic lookup failure");
      return prepare(sql);
    });
    try {
      traceSpy.mockClear();
      expect(sansRelevance(await recall(q, "shadow"))).toEqual(sansRelevance(off));
      expect(floorTraces()).toEqual([
        { taskId: "memory-recall", name: "memory.recall_floor", attrs: { mode: "shadow", bank: BANK, error: true } },
      ]);
      // On degrades to off for that recall, the newest-rows fallback included.
      expect((await recall("factura pendiente del dentista", "on")).length).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("on: when the floor empties the merged set, the log names the floor, not the relevance filter", async () => {
    seed(GOLDEN_BANK);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recall("como va el proyecto esta semana", "on");
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("[memory] Recall floor dropped all 10 results (no rare query keyword)");
      expect(lines.some((l) => l.includes("Relevance filter discarded"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  describe("keywordDocFrequency", () => {
    beforeEach(() =>
      seed([
        "Usuario: el camión llegó tarde",
        "Usuario: otro CAMION en la ruta",
        "Usuario: la api para este informe",
        "Usuario: este informe",
      ]),
    );

    it("counts the bank rows holding each candidate term", () => {
      expect(keywordDocFrequency("informe", BANK)).toEqual(new Map([["informe", 2]]));
      expect(keywordDocFrequency("informe", "mc-operational")).toEqual(new Map([["informe", 0]]));
    });

    it("drops stop-words and tokens under 4 chars", () => {
      // "para"/"este" are stop-words, "api"/"el" are under 4 chars.
      expect(keywordDocFrequency("el api para este informe", BANK)).toEqual(new Map([["informe", 2]]));
      expect(keywordDocFrequency("para este api", BANK).size).toBe(0);
    });

    it("folds case and accents the way the FTS index tokenises", () => {
      expect(keywordDocFrequency("Camión", BANK)).toEqual(new Map([["camion", 2]]));
      expect(keywordDocFrequency("camion", BANK)).toEqual(new Map([["camion", 2]]));
    });

    it("stops counting at the cap", () => {
      expect(keywordDocFrequency("camion", BANK, 1)).toEqual(new Map([["camion", 1]]));
    });
  });
});
