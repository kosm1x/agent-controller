/**
 * Small, fast check of the Jarvis adapter on an inline corpus (the full
 * scorecard is scripts/continuity-bench/run.ts, not a vitest test). Real
 * production modules on a scratch SQLite file under os.tmpdir().
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDatabase } from "../../src/db/index.js";
import { CONSOLIDATOR_JARVIS_TURN_MAX_CHARS } from "../../src/memory/jme.js";
import {
  JARVIS_MARKERS,
  JME_HEADER,
  DEFAULT_SWITCHES,
  JME_INJECTION_BUDGET_TOKENS,
  JarvisAdapter,
  ModelCallBudget,
  ModelCallCapError,
  SWITCHES,
  assertScratchDbPath,
  assertUpsertStatus,
  enrichmentComponents,
  exchangeContent,
  nextConsolidationT,
  promptBudget,
  resolveSwitches,
  scratchDbPath,
  splitMemorySearch,
  sqliteUtc,
  DAY_WINDOW_EXCHANGES,
  DAY_MIX_SHARES,
  dayPool,
  dayWindowExchanges,
  factCatches,
  foldAccents,
  padTurn,
} from "./adapter-jarvis.js";
import { buildCorpusV2 } from "./corpus-v2.js";
import { FILLER_SPEC_V1, fill, generateFiller, xorshift32 } from "./filler.js";
import { scoreProbe, scoreProbeWith } from "./score.js";
import type { ProbeRun, Scenario } from "./types.js";

// No key may reach the memory stack from the developer's shell: words-only, local only.
beforeAll(() => {
  vi.stubEnv("GEMINI_API_KEY", undefined);
  vi.stubEnv("EMBEDDING_KEY", undefined);
  vi.stubEnv("COMMIT_DB_KEY", undefined);
  vi.stubEnv("HINDSIGHT_ENABLED", "false");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const V2 = buildCorpusV2();
const v2 = (id: string): Scenario => {
  const s = V2.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

const DAY = 86_400;
const base = { base: 1, lang: "es" as const, fillerSize: 3, fillerSeed: 7, fillerFromT: -2 * DAY };

const C1: Scenario = {
  ...base,
  id: "C1-t",
  class: "C1",
  fillerToT: DAY + 64_800,
  events: [
    { day: 0, t: 32_400, session: "d0", kind: "person_fact", text: "El perro de la persona se llama Corvalino.", durable: true, asUser: "A mi perro le puse Corvalino.", asAssistant: "Lo anoto." },
  ],
  probes: [{ day: 1, t: DAY + 64_800, session: "d1", text: "¿Cómo se llama mi perro?", expect: ["Corvalino"], forbid: [], surface: "both" }],
};

const C4: Scenario = {
  ...base,
  id: "C4-t",
  class: "C4",
  fillerToT: 0,
  events: [
    { day: 0, t: 32_400, session: "d0", kind: "exchange", user: "Sigamos con el informe de Valdoria.", assistant: "Va, tengo la estructura." },
    { day: 0, t: 32_520, session: "d0", kind: "session_end", openWork: "falta el anexo de proveedores", asUser: "Lo dejamos aquí.", asAssistant: "Queda pendiente: falta el anexo de proveedores." },
    { day: 0, t: 32_640, session: "d0", kind: "restart", asUser: "", asAssistant: "" },
  ],
  probes: [{ day: 0, t: 64_800, session: "d0", text: "Ya volví, ¿seguimos?", expect: ["anexo de proveedores"], forbid: [], surface: "proactive" }],
};

const C7: Scenario = {
  ...base,
  id: "C7-t",
  class: "C7",
  fillerToT: 14 * DAY + 64_800,
  events: [{ day: 0, t: 32_400, session: "d0", kind: "exchange", user: "¿Me recomiendas una serie?", assistant: "Una de misterio corta." }],
  probes: [{ day: 14, t: 14 * DAY + 64_800, session: "d14", text: "¿Qué te conté sobre el viaje de mi sobrino al torneo de ajedrez?", expect: [], forbid: [], surface: "both" }],
};

const C8: Scenario = {
  ...base,
  id: "C8-t",
  class: "C8",
  fillerToT: 120 * DAY + 64_800,
  events: [
    { day: 0, t: 32_400, session: "d0", kind: "person_fact", text: "El tipo de sangre de la persona es AB negativo.", durable: true, asUser: "Mi tipo de sangre es AB negativo.", asAssistant: "Anotado." },
    { day: 0, t: 32_520, session: "d0", kind: "person_fact", text: "Esta semana la persona trabaja desde Cuernavaca.", durable: false, asUser: "Esta semana nada más trabajo desde Cuernavaca.", asAssistant: "Va." },
    { day: 0, t: 32_640, session: "d0", kind: "standing", text: "Responder siempre en viñetas cortas.", asUser: "Respóndeme en viñetas.", asAssistant: "Entendido." },
  ],
  probes: [{ day: 120, t: 120 * DAY + 64_800, session: "d120", text: "¿Qué tipo de sangre tengo y desde dónde trabajo?", expect: ["AB negativo"], forbid: ["Cuernavaca"], surface: "both" }],
};

const names = (r: ProbeRun, s: "proactive" | "asked") => r[s].components.map((c) => c.name);
const comp = (r: ProbeRun, s: "proactive" | "asked", name: string) => r[s].components.find((c) => c.name === name);

describe("assertScratchDbPath", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  it("refuses the live db, anything in data/, a path outside tmpdir, an existing file", () => {
    expect(() => assertScratchDbPath(join(repo, "data/mc.db"), repo)).toThrow(/mc\.db/);
    expect(() => assertScratchDbPath(join(repo, "data/other.db"), repo)).toThrow(/data/);
    expect(() => assertScratchDbPath(join(tmpdir(), "x-mc.db"), repo)).toThrow(/mc\.db/);
    expect(() => assertScratchDbPath(join(repo, "scratch.db"), repo)).toThrow(/tmpdir|under/);
    const dir = mkdtempSync(join(tmpdir(), "cb-assert-"));
    try {
      expect(assertScratchDbPath(join(dir, "fresh.db"), repo)).toBe(join(dir, "fresh.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realpaths the final component: a symlink to a db named mc.db, or a dangling one, is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-assert-"));
    try {
      writeFileSync(join(dir, "fake-mc.db"), "");
      symlinkSync(join(dir, "fake-mc.db"), join(dir, "innocent.db"));
      expect(() => assertScratchDbPath(join(dir, "innocent.db"), repo)).toThrow(/mc\.db/);
      symlinkSync(join(dir, "missing.db"), join(dir, "dangling.db"));
      expect(() => assertScratchDbPath(join(dir, "dangling.db"), repo)).toThrow(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fidelity pins", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../src/runners/fast-runner.ts"), "utf8");

  it("the JME header and line template are the production strings (fast-runner.ts)", () => {
    expect(src).toContain("content: `" + JME_HEADER.replaceAll("\n", "\\n") + "${block}`");
    expect(src).toContain(".map((f, i) => `${i + 1}. [${f.category}] ${f.factText}`)");
    expect(src).toContain(`const JME_INJECTION_BUDGET_TOKENS = ${JME_INJECTION_BUDGET_TOKENS};`);
  });

  it("the production prompt budget keeps small blocks and drops an oversized P4 block first", () => {
    expect(promptBudget("\n\n## Perfil del usuario (hechos confirmados)\n- **a**: b", "", "")).toEqual({ profile: true, relevant: true, enrichment: true });
    const huge = "\n\n## Contexto relevante del usuario\n" + "- User: x\nJarvis: y\n".repeat(4000);
    const kept = promptBudget("\n\n## Perfil del usuario (hechos confirmados)\n- **a**: b", "\n\n## Hechos del usuario relacionados con este mensaje\n- **c**: d", huge);
    expect(kept.enrichment).toBe(false);
    expect(kept.profile).toBe(true);
  });

  it("upsertFact statuses: only inserted without vectors; superseded/skipped accepted for a correction with vectors", () => {
    expect(() => assertUpsertStatus("x", "correction", "inserted", false)).not.toThrow();
    expect(() => assertUpsertStatus("x", "correction", "superseded", false)).toThrow(/superseded/);
    expect(() => assertUpsertStatus("x", "correction", "superseded", true)).not.toThrow();
    expect(() => assertUpsertStatus("x", "correction", "skipped", true)).not.toThrow();
    expect(() => assertUpsertStatus("x", "person_fact", "skipped", true)).toThrow();
    expect(() => assertUpsertStatus("x", "correction", "dropped", true)).toThrow(/dropped/);
  });
});

describe("helpers", () => {
  it("stores events as the router does and renders restart as nothing", () => {
    expect(exchangeContent(C4.events[0])).toBe("User: Sigamos con el informe de Valdoria.\nJarvis: Va, tengo la estructura.");
    expect(exchangeContent(C4.events[1])).toBe("User: Lo dejamos aquí.\nJarvis: Queda pendiente: falta el anexo de proveedores.");
    expect(exchangeContent(C4.events[2])).toBeNull();
    expect(sqliteUtc(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05");
  });

  it("splits enrichment into query-driven memory sections and the rest", () => {
    const block = "\n\n## Contexto relevante del usuario\n- User: a\nJarvis: b\n- User: c\nJarvis: d\n\n## Herramientas más efectivas\nx";
    const c = enrichmentComponents(block);
    expect(c.map((x) => [x.name, x.queryDriven, x.items.length])).toEqual([
      ["enrichment:Contexto relevante del usuario", true, 2],
      ["enrichment:other", false, 1],
    ]);
    expect(c[0]).toMatchObject({ kind: "recall", cap: 5 });
  });

  it("splits memory_search output on item boundaries, not on a numbered line inside a stored row", () => {
    const row1 = "User: los pasos son\n2. lavar\n3. secar\nJarvis: ok";
    const text = `1. ${row1} (relevance: 0.81)\n2. User: otra\nJarvis: cosa (relevance: 0.40)`;
    expect(splitMemorySearch(text)).toEqual([`1. ${row1} (relevance: 0.81)`, "2. User: otra\nJarvis: cosa (relevance: 0.40)"]);
    expect(splitMemorySearch("1. a\n2. b")).toEqual(["1. a", "2. b"]);
    expect(splitMemorySearch("No relevant memories found.")).toEqual([]);
  });
});

describe.each(["raw", "ideal"] as const)("JarvisAdapter leg=%s", (leg) => {
  let dir: string;
  let adapter: JarvisAdapter;
  const runs: Record<string, ProbeRun> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-adapter-"));
    adapter = new JarvisAdapter(scratchDbPath(dir), leg);
    adapter.open();
    for (const s of [C1, C4, C7, C8]) runs[s.id] = (await adapter.runScenario(s, FILLER_SPEC_V1))[0];
  });
  afterAll(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("C1: the fact reaches the hydrated thread and an explicit search", () => {
    const r = runs["C1-t"];
    expect(names(r, "proactive")).toEqual(expect.arrayContaining(["thread", "essentials"]));
    expect(comp(r, "proactive", "thread")!.text).toContain("Corvalino");
    const s = scoreProbe(r);
    expect(s.proactive.hit).toBe(true);
    expect(s.asked.hit).toBe(true);
    expect(r.ingestedRows).toBe(leg === "raw" ? 4 : 5); // 3 filler + 1 fact row (+1 jme fact)
  });

  it("C4: after a real restart the thread hydrates the open work from the db", () => {
    const r = runs["C4-t"];
    expect(comp(r, "proactive", "thread")!.text).toContain("anexo de proveedores");
    expect(scoreProbe(r).proactive.hit).toBe(true);
    // the restart reopened the same file: the store is still there
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it("C7: a never-mentioned topic still returns rows (keyword noise / recent-rows fallback)", () => {
    const s = scoreProbe(runs["C7-t"]);
    expect(s.asked.irrelevantCount).toBeGreaterThan(0);
    expect(s.asked.hit).toBe(false);
  });

  it("C8: ideal extraction keeps the durable fact and lets the temporary one expire in JME", () => {
    const r = runs["C8-t"];
    const jme = comp(r, "asked", "jme_query")!;
    if (leg === "raw") {
      expect(jme.items).toEqual([]);
      expect(comp(r, "proactive", "profile")).toBeUndefined();
    } else {
      expect(jme.text).toContain("AB negativo");
      expect(jme.text).not.toContain("Cuernavaca");
      expect(comp(r, "proactive", "profile")!.text).toContain("viñetas");
    }
  });
});

describe.each(["raw", "ideal"] as const)("JarvisAdapter v2 thread paths leg=%s", (leg) => {
  let dir: string;
  let adapter: JarvisAdapter;
  const runs: Record<string, ProbeRun[]> = {};
  const ids = ["C3-01-h5-s50", "C3-02-h5-s50", "C3-01-h14-s50", "C3-01-h15-s50", "C3-01-h16-s50", "C3-01-l5-s50", "C3-01-l16-s50", "C3-01-i5x20-s50", "C4-01-r5-s50", "C4-02-r5-s50", "C5-07-s50"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-adapter-v2-"));
    adapter = new JarvisAdapter(scratchDbPath(dir), leg);
    adapter.open();
    for (const id of ids) runs[id] = await adapter.runScenario(v2(id), FILLER_SPEC_V1);
  });
  afterAll(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const thread = (id: string, i = 0) => comp(runs[id][i], "proactive", "thread")!;
  const needle = (id: string) => v2(id).probes[0].expect[0];

  it("hydrate: K = 14 keeps the open work in the 15-row thread, K = 15 is the first K that drops it", () => {
    expect(thread("C3-01-h14-s50").text).toContain(needle("C3-01-h14-s50"));
    expect(thread("C3-01-h15-s50").text).not.toContain(needle("C3-01-h15-s50"));
    expect(thread("C3-01-h16-s50").text).not.toContain(needle("C3-01-h16-s50"));
    expect(thread("C3-01-h16-s50").items.length).toBe(30); // 15 rows × (user + assistant)
  });

  it("each hydrate probe gets its own thread key (fails if the key is hard-coded)", () => {
    expect(thread("C3-02-h5-s50").text).toContain(needle("C3-02-h5-s50"));
    expect(thread("C3-02-h5-s50").text).not.toContain(needle("C3-01-h5-s50"));
    expect(new Set(adapter.threadKeys).size).toBeGreaterThan(2);
  });

  it("live: the timeline pushed through the router seam, capped at 15 entries, no reload", () => {
    expect(thread("C3-01-l5-s50").text).toContain(needle("C3-01-l5-s50"));
    expect(thread("C3-01-l16-s50").text).not.toContain(needle("C3-01-l16-s50"));
    expect(thread("C3-01-l16-s50").items.length).toBe(30);
  });

  it("interleave: 20 rows of another channel are stored under it and do not push the open work out", () => {
    expect(thread("C3-01-i5x20-s50").text).toContain(needle("C3-01-i5x20-s50"));
    expect(runs["C3-01-i5x20-s50"][0].otherChannelRows).toBe(20);
  });

  it("restart: called for a restart event, and the fresh process hydrates THIS scenario's thread (fails without restart)", () => {
    expect(adapter.restartCount).toBe(4); // 2 C4 scenarios × 2 probes
    expect(thread("C4-02-r5-s50").text).toContain(needle("C4-02-r5-s50"));
    expect(thread("C4-02-r5-s50").text).not.toContain(needle("C4-01-r5-s50"));
    expect(runs["C4-02-r5-s50"][0]).toMatchObject({ gapRows: 5, variant: "restart" });
  });

  it("JARVIS_MARKERS: no heading claims authorship (attributionConflict is 0 by construction)", () => {
    expect(JARVIS_MARKERS.headings ?? []).toEqual([]);
    expect(scoreProbeWith(runs["C5-07-s50"][0], JARVIS_MARKERS).proactive.attributionConflict).toBe(false);
  });

  it("C5 person-stated: the strict rule attributes the figure to the person on its User line", () => {
    const s = scoreProbeWith(runs["C5-07-s50"][0], JARVIS_MARKERS).proactive;
    expect(s.hit).toBe(true);
    expect(s.authorMarked).toBe(true);
    expect(s.carriedBy).toContain("thread");
  });
});

describe("production switches", () => {
  it("resolveSwitches: every known switch defaults off, a given value wins, unknown names and values throw", () => {
    expect(SWITCHES).toEqual({
      MEMORY_OPEN_WORK: ["off", "shadow", "on"],
      MEMORY_RECALL_FLOOR: ["off", "shadow", "on"],
      MEMORY_TOMBSTONES: ["off", "record", "on"],
    });
    const OFF = { MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "off", MEMORY_TOMBSTONES: "off" };
    expect(DEFAULT_SWITCHES).toEqual(OFF);
    expect(resolveSwitches()).toEqual(OFF);
    expect(resolveSwitches({ MEMORY_OPEN_WORK: "on" })).toEqual({ ...OFF, MEMORY_OPEN_WORK: "on" });
    expect(resolveSwitches({ MEMORY_RECALL_FLOOR: "shadow" })).toEqual({ ...OFF, MEMORY_RECALL_FLOOR: "shadow" });
    expect(resolveSwitches({ MEMORY_TOMBSTONES: "record" })).toEqual({ ...OFF, MEMORY_TOMBSTONES: "record" });
    expect(() => resolveSwitches({ MEMORY_RECALL_FLOOR: "true" })).toThrow(/off\|shadow\|on/);
    expect(() => resolveSwitches({ MEMORY_TOMBSTONES: "shadow" })).toThrow(/off\|record\|on/);
    expect(() => resolveSwitches({ MEMORY_OPEN_WORKS: "on" })).toThrow(/unknown switch/);
    expect(() => resolveSwitches({ MEMORY_OPEN_WORK: "yes" })).toThrow(/off\|shadow\|on/);
  });
});

const C2: Scenario = {
  ...base,
  id: "C2-t",
  class: "C2",
  fillerToT: 10 * DAY + 64_800,
  events: [
    { day: 0, t: 32_400, session: "d0", kind: "person_fact", text: "The gate code of the person is 5821.", durable: true, asUser: "El código del portón es 5821.", asAssistant: "Anotado." },
    { day: 5, t: 5 * DAY + 32_400, session: "d5", kind: "correction", targetEventIndex: 0, text: "The gate code of the person is 7394.", asUser: "Cambió el código del portón: ahora es 7394.", asAssistant: "Actualizado." },
  ],
  probes: [{ day: 10, t: 10 * DAY + 64_800, session: "d10", text: "¿Cuál es el código del portón?", expect: ["7394"], forbid: ["5821"], surface: "both" }],
};

describe.each(["off", "on"] as const)("JarvisAdapter ideal leg, embeddings off, MEMORY_TOMBSTONES=%s", (mode) => {
  let dir: string;
  let adapter: JarvisAdapter;
  const runs: Record<string, ProbeRun> = {};
  const facts: Record<string, string[]> = {};
  const tombs: Record<string, Array<{ reason: string; terms: string }>> = {};
  /** Seconds from the C2 correction row to its tombstone. */
  let tombAfterCorrectionS: number | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-adapter-ts-"));
    adapter = new JarvisAdapter(scratchDbPath(dir), "ideal", { switches: { MEMORY_TOMBSTONES: mode } });
    adapter.open();
    for (const s of [C2, C8]) {
      runs[s.id] = (await adapter.runScenario(s, FILLER_SPEC_V1))[0];
      const db = getDatabase();
      facts[s.id] = (db.prepare("SELECT fact_text FROM jme_facts ORDER BY id").all() as Array<{ fact_text: string }>).map((r) => r.fact_text);
      tombs[s.id] = db.prepare("SELECT reason, terms FROM memory_tombstones ORDER BY id").all() as Array<{ reason: string; terms: string }>;
      if (s.id === "C2-t" && mode === "on") {
        const utc = (x: string) => Date.parse(`${x.replace(" ", "T")}Z`) / 1000;
        const row = db.prepare("SELECT created_at FROM conversations WHERE content LIKE '%7394%' ORDER BY id LIMIT 1").get() as { created_at: string };
        const tomb = db.prepare("SELECT created_at FROM memory_tombstones").get() as { created_at: string };
        tombAfterCorrectionS = utc(tomb.created_at) - utc(row.created_at);
      }
    }
  });
  afterAll(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEMORY_TOMBSTONES;
  });

  it("C2: the correction supersedes its target through jme.ts supersedeCluster; the prune deletes the old row", () => {
    expect(facts["C2-t"]).toEqual(["The gate code of the person is 7394."]);
  });

  it("C8: the prune deletes the expired temporary fact", () => {
    expect(facts["C8-t"]).toEqual(["El tipo de sangre de la persona es AB negativo."]);
  });

  it(mode === "on" ? "on: the supersede and the expiry each leave a tombstone" : "off: no tombstone is written", () => {
    if (mode === "off") {
      expect(tombs).toEqual({ "C2-t": [], "C8-t": [] });
    } else {
      expect(tombs["C2-t"]).toEqual([{ reason: "superseded", terms: '["5821"]' }]);
      // A word is never a term (qa R1 W1): "Cuernavaca" leaves nothing to silence.
      expect(tombs["C8-t"]).toEqual([]);
    }
  });

  if (mode === "on")
    it("on: the supersede is dated at the next nightly consolidation, not at the correction row (qa R1 W4)", () => {
      // Correction at day 5 09:00, consolidated at day 6 02:45.
      expect(tombAfterCorrectionS).toBe(6 * DAY + 9900 - (5 * DAY + 32_400));
    });

  it(mode === "on" ? "on: the C2 old value no longer reaches the explicit search" : "off: the C2 old value still reaches the explicit search", () => {
    const text = comp(runs["C2-t"], "asked", "memory_search")?.text ?? "";
    if (mode === "on") expect(text).not.toContain("5821");
    else expect(text).toContain("5821");
  });
});

describe("nextConsolidationT", () => {
  it("is the first 02:45 at which the turn is 30 min settled", () => {
    expect(nextConsolidationT(5 * DAY + 32_400)).toBe(6 * DAY + 9900);
    expect(nextConsolidationT(DAY + 9900 - 1800)).toBe(DAY + 9900);
    expect(nextConsolidationT(DAY + 9900 - 1799)).toBe(2 * DAY + 9900);
    expect(nextConsolidationT(0)).toBe(9900);
  });
});

describe("JarvisAdapter MEMORY_RECALL_FLOOR=on", () => {
  let dir: string;
  let adapter: JarvisAdapter;
  const runs: Record<string, ProbeRun> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-adapter-rf-"));
    adapter = new JarvisAdapter(scratchDbPath(dir), "raw", { switches: { MEMORY_RECALL_FLOOR: "on" } });
    adapter.open();
    for (const s of [C1, C7]) runs[s.id] = (await adapter.runScenario(s, FILLER_SPEC_V1))[0];
  });
  afterAll(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEMORY_OPEN_WORK;
    delete process.env.MEMORY_RECALL_FLOOR;
  });

  it("open() sets the switch in this process and the adapter records it", () => {
    expect(adapter.switches).toEqual({ MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "on", MEMORY_TOMBSTONES: "off" });
    expect(process.env.MEMORY_RECALL_FLOOR).toBe("on");
  });

  it("C7: a never-mentioned topic returns no memory item on either surface", () => {
    const s = scoreProbe(runs["C7-t"]);
    expect(s.asked.irrelevantCount).toBe(0);
    expect(s.proactive.irrelevantCount).toBe(0);
  });

  it("C1: a fact named by a rare word still reaches the explicit search", () => {
    expect(comp(runs["C1-t"], "asked", "memory_search")!.text).toContain("Corvalino");
    expect(scoreProbe(runs["C1-t"]).asked.hit).toBe(true);
  });
});

describe.each(["off", "shadow", "on"] as const)("JarvisAdapter open_work component MEMORY_OPEN_WORK=%s", (mode) => {
  let dir: string;
  let adapter: JarvisAdapter;
  const runs: Record<string, ProbeRun[]> = {};
  const ids = ["C3-01-ho15-s50", "C3-01-cl16-s50", "C3-01-cr15-s50", "C3-01-h5-s50", "C4-01-r16-s50"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-adapter-ow-"));
    adapter = new JarvisAdapter(scratchDbPath(dir), "raw", { switches: { MEMORY_OPEN_WORK: mode } });
    adapter.open();
    for (const id of ids) runs[id] = await adapter.runScenario(v2(id), FILLER_SPEC_V1);
  });
  afterAll(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEMORY_OPEN_WORK;
    delete process.env.MEMORY_RECALL_FLOOR;
  });

  const ow = (id: string) => comp(runs[id][0], "proactive", "open_work");
  const needle = (id: string) => v2(id).probes[0].expect[0];

  it("open() sets the switch in this process and the adapter records it", () => {
    expect(adapter.switches).toEqual({ MEMORY_OPEN_WORK: mode, MEMORY_RECALL_FLOOR: "off", MEMORY_TOMBSTONES: "off" });
    expect(process.env.MEMORY_OPEN_WORK).toBe(mode);
    expect(process.env.MEMORY_RECALL_FLOOR).toBe("off");
  });

  it("the component appears only when the switch is on; shadow computes but injects nothing", () => {
    for (const id of ids) {
      if (mode !== "on") expect(ow(id), id).toBeUndefined();
    }
    if (mode !== "on") return;
    for (const id of ["C3-01-ho15-s50", "C3-01-cl16-s50"]) {
      const c = ow(id)!;
      expect(c).toMatchObject({ name: "open_work", queryDriven: false, kind: "ambient" });
      expect(c.text, id).toContain(needle(id));
      expect(c.items.length, id).toBeGreaterThan(0);
      expect(c.items.length, id).toBeLessThanOrEqual(3);
      expect(scoreProbe(runs[id][0]).proactive.carriedBy, id).toContain("open_work");
    }
  });

  it("crowded: three later sessions fill the cap of 3 and the open work is not among the notes", () => {
    if (mode !== "on") return;
    const c = ow("C3-01-cr15-s50")!;
    expect(c.items).toHaveLength(3);
    expect(c.text).not.toContain(needle("C3-01-cr15-s50"));
    expect(scoreProbe(runs["C3-01-cr15-s50"][0]).proactive.hit).toBe(false);
  });

  it("no gap since the session tail (C3 hydrate K 5, C4 restart K 16): the needle never comes from a note", () => {
    for (const id of ["C3-01-h5-s50", "C4-01-r16-s50"]) {
      expect(ow(id)?.text ?? "", id).not.toContain(needle(id));
    }
  });
});

describe("ModelCallBudget (extracted leg)", () => {
  it("takes calls up to the cap and refuses the next one before counting it", () => {
    const b = new ModelCallBudget(2);
    b.take("s1");
    b.take("s2");
    expect(b.calls).toBe(2);
    let err: unknown;
    try {
      b.take("s3");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelCallCapError);
    expect(err).toMatchObject({ calls: 2, max: 2, scenarioId: "s3", name: "ModelCallCapError" });
    expect(b.calls).toBe(2);
    expect(() => new ModelCallBudget(0).take("s")).toThrow(/cap 0 reached: 0 calls made/);
  });

  it("the extracted leg refuses to build without a budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-x-"));
    expect(() => new JarvisAdapter(scratchDbPath(dir), "extracted")).toThrow(/extraction/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("dayWindowExchanges (extracted leg, --window day)", () => {
  const V2 = buildCorpusV2();
  const STATED = new Set(["standing", "person_fact", "correction"]);
  const fillerOf = (s: Scenario) => generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT });

  it("per stated night of every C2 / C6 / C8 s50 scenario: the seeded block plus the night's own filler, all in that night, no probe needle", () => {
    let nights = 0;
    for (const s of V2.scenarios.filter((x) => ["C2", "C6", "C8"].includes(x.class) && x.fillerSize === 50)) {
      const filler = fillerOf(s);
      const needles = s.probes.flatMap((p) => [...p.expect, ...p.forbid]).map((n) => n.toLowerCase());
      for (const night of new Set(s.events.filter((e) => STATED.has(e.kind)).map((e) => nextConsolidationT(e.t)))) {
        const items = dayWindowExchanges(s, V2.fillerSpec, night, filler);
        const own = filler.filter((f) => nextConsolidationT(f.t) === night).length;
        expect(items.length, s.id).toBe(DAY_WINDOW_EXCHANGES + own);
        for (const x of items) {
          expect(nextConsolidationT(x.t), s.id).toBe(night);
          for (const n of needles) expect(`${x.user}\n${x.assistant}`.toLowerCase().includes(n), `${s.id}: ${n}`).toBe(false);
        }
        expect(dayWindowExchanges(s, V2.fillerSpec, night, filler)).toEqual(items);
        expect(dayWindowExchanges(s, V2.fillerSpec, night + 86_400, filler).slice(0, 3)).not.toEqual(items.slice(0, 3));
        nights++;
      }
    }
    expect(nights).toBe(6 + 2 * 9 + 11);
  });

  it("throws when an ordinary exchange holds a probe needle (expect or forbid)", () => {
    const s = V2.scenarios.find((x) => x.id === "C6-01-s50")!;
    const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
    const word = dayWindowExchanges(s, V2.fillerSpec, night, [])[0].user.match(/\p{L}{6,}/u)![0];
    const probes = s.probes.map((p, i) => (i === 0 ? { ...p, forbid: [word] } : p));
    expect(() => dayWindowExchanges({ ...s, probes }, V2.fillerSpec, night, [])).toThrow(/probe needle/);
    const expectProbes = s.probes.map((p, i) => (i === 1 ? { ...p, expect: [...p.expect, word.toUpperCase()] } : p));
    expect(() => dayWindowExchanges({ ...s, probes: expectProbes }, V2.fillerSpec, night, [])).toThrow(/probe needle/);
  });

  it("the default day spec is the archived window: DAY_WINDOW_EXCHANGES of filler small talk, the same items as an explicit 60-turn smalltalk spec", () => {
    const s = V2.scenarios.find((x) => x.id === "C6-01-s50")!;
    const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
    const filler = fillerOf(s);
    const seed = (s.fillerSeed ^ 0x6a09e667 ^ Math.imul(night, 0x85ebca6b)) >>> 0;
    const archived = generateFiller(V2.fillerSpec, { seed, size: DAY_WINDOW_EXCHANGES, fromT: night - 86_400, toT: night - 30 * 60 });
    const own = filler.filter((f) => nextConsolidationT(f.t) === night);
    expect(dayWindowExchanges(s, V2.fillerSpec, night, filler)).toEqual([...archived, ...own]);
    expect(dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 60, mix: "smalltalk" })).toEqual([...archived, ...own]);
    expect(dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 120, mix: "smalltalk" }).length).toBe(60 + own.length);
    expect(dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 0, mix: "smalltalk" })).toEqual(own);
    for (const turns of [7, -2, 1.5]) expect(() => dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns, mix: "smalltalk" }), String(turns)).toThrow(/non-negative even integer/);
    expect(() => dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 60, mix: "mixed" })).toThrow(/needs the corpus pool/);
  });

  it("dayPool: work = a session's exchanges before its session_end plus that session_end; facts = standing + durable person_fact; deduplicated", () => {
    const pool = dayPool(V2.scenarios);
    const has = (items: Array<{ user: string; assistant: string }>, user: string) => items.some((x) => x.user === user);
    expect(has(pool.work, "Vamos a avanzar con el informe trimestral de Valdoria.")).toBe(true);
    expect(has(pool.work, "Ok, lo dejamos aquí por hoy.")).toBe(true);
    expect(pool.work.length).toBe(32);
    // A C4 gap row (same session id, after the session_end) is not work.
    const c4gap = V2.scenarios.find((x) => x.id === "C4-02-r5-s50")!.events.find((e) => e.kind === "exchange" && e.t > 32_640)!;
    expect(c4gap.kind === "exchange" && has(pool.work, c4gap.user)).toBe(false);
    // A gap row (filler-generated exchange after the session ended) is not work.
    const gap = V2.scenarios.find((x) => x.id === "C3-01-ho15-s50")!.events.find((e) => e.kind === "exchange" && e.session === "d5")!;
    expect(gap.kind === "exchange" && has(pool.work, gap.user)).toBe(false);
    expect(has(pool.facts, "From now on, always give me temperatures in Celsius.")).toBe(true);
    expect(has(pool.facts, "Mi tipo de sangre es AB negativo.")).toBe(true);
    expect(has(pool.facts, "Esta semana nada más estoy trabajando desde Cuernavaca.")).toBe(false); // not durable
    expect(has(pool.facts, "Ojo, el comité recortó el monto: ahora es de 2.960.400 pesos.")).toBe(false); // a correction
    for (const items of [pool.work, pool.facts]) expect(new Set(items.map((x) => `${x.user}\t${x.assistant}`)).size).toBe(items.length);
    const distinct = new Set(V2.scenarios.flatMap((x) => x.events.flatMap((e) => (e.kind === "standing" || (e.kind === "person_fact" && e.durable) ? [`${e.asUser}\t${e.asAssistant}`] : []))));
    expect(pool.facts.length).toBe(distinct.size);
    expect(pool.facts.length).toBe(26);
  });

  it("mixed: turns / 2 seeded exchanges, DAY_MIX_SHARES from the pools (no probe needle), the rest filler; in the night, deterministic, per night", () => {
    const pool = dayPool(V2.scenarios);
    const workKeys = new Set(pool.work.map((x) => `${x.user}\t${x.assistant}`));
    const factKeys = new Set(pool.facts.map((x) => `${x.user}\t${x.assistant}`));
    let nights = 0;
    for (const s of V2.scenarios.filter((x) => ["C2", "C6", "C8"].includes(x.class) && x.fillerSize === 50)) {
      const filler = fillerOf(s);
      const needles = s.probes.flatMap((p) => [...p.expect, ...p.forbid]).map((n) => n.toLowerCase());
      for (const night of new Set(s.events.filter((e) => STATED.has(e.kind)).map((e) => nextConsolidationT(e.t)))) {
        const own = filler.filter((f) => nextConsolidationT(f.t) === night).length;
        const items = dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 120, mix: "mixed", pool });
        expect(items.length, s.id).toBe(60 + own);
        const seeded = items.slice(0, 60);
        const work = seeded.filter((x) => workKeys.has(`${x.user}\t${x.assistant}`)).length;
        const facts = seeded.filter((x) => factKeys.has(`${x.user}\t${x.assistant}`)).length;
        expect(work, s.id).toBe(Math.round(60 * DAY_MIX_SHARES.work));
        expect(facts, s.id).toBe(Math.round(60 * DAY_MIX_SHARES.facts));
        for (const x of items) {
          expect(nextConsolidationT(x.t), s.id).toBe(night);
          for (const n of needles) expect(`${x.user}\n${x.assistant}`.toLowerCase().includes(n), `${s.id}: ${n}`).toBe(false);
        }
        expect(dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 120, mix: "mixed", pool })).toEqual(items);
        expect(dayWindowExchanges(s, V2.fillerSpec, night + 86_400, filler, { turns: 120, mix: "mixed", pool }).slice(0, 5)).not.toEqual(items.slice(0, 5));
        nights++;
      }
    }
    expect(nights).toBe(6 + 2 * 9 + 11);
  });

  it("mixed leaves out a pool item that holds one of the scenario's probe needles (instead of throwing)", () => {
    const s = V2.scenarios.find((x) => x.id === "C6-01-s50")!;
    const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
    const needle = s.probes[0].expect[0];
    const pool = { work: [{ user: `Hoy hablamos de ${needle} otra vez.`, assistant: "Va.", lang: "es" as const }], facts: [{ user: `Me gusta ${needle}.`, assistant: "Anotado.", lang: "es" as const }] };
    const items = dayWindowExchanges(s, V2.fillerSpec, night, [], { turns: 60, mix: "mixed", pool });
    expect(items.length).toBe(30);
    expect(items.some((x) => x.assistant === "Va." || x.assistant === "Anotado.")).toBe(false);
  });

  it("DAY_MIX_SHARES is the documented assumption, literally (audit R1 R2)", () => {
    expect(DAY_MIX_SHARES).toEqual({ work: 0.4, facts: 0.1 });
  });

  it("mixed draws each pool item at most once per night (audit R1 W2): a day larger than the pools gives every eligible item once and fills the rest", () => {
    const pool = dayPool(V2.scenarios);
    const s = V2.scenarios.find((x) => x.id === "C6-01-s50")!;
    const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
    const items = dayWindowExchanges(s, V2.fillerSpec, night, [], { turns: 1190, mix: "mixed", pool });
    expect(items.length).toBe(595);
    const key = (x: { user: string; assistant: string }) => `${x.user}\t${x.assistant}`;
    const poolKeys = new Set([...pool.work, ...pool.facts].map(key));
    const drawn = items.filter((x) => poolKeys.has(key(x)));
    expect(new Set(drawn.map(key)).size).toBe(drawn.length);
    expect(items.filter((x) => pool.work.some((w) => key(w) === key(x))).length).toBe(pool.work.length);
  });

  it("mixed leaves out of the facts pool every fact sharing a content token with the scenario's probed events (audit R1 W3): no rival blood type, no rival birthday", () => {
    const pool = dayPool(V2.scenarios);
    const drawnFacts = (id: string) => {
      const s = V2.scenarios.find((x) => x.id === id)!;
      const out = new Set<string>();
      for (const night of new Set(s.events.filter((e) => STATED.has(e.kind)).map((e) => nextConsolidationT(e.t))))
        for (const x of dayWindowExchanges(s, V2.fillerSpec, night, [], { turns: 1190, mix: "mixed", pool })) if (pool.facts.some((f) => f.user === x.user)) out.add(x.user);
      return out;
    };
    const c801 = drawnFacts("C8-01-s50");
    expect(c801.has("Mi tipo de sangre es B negativo.")).toBe(false);
    expect(c801.has("Mi tipo de sangre es AB negativo.")).toBe(false);
    expect(c801.size).toBeGreaterThan(0);
    expect(drawnFacts("C8-01-sn-s50").has("Mi tipo de sangre es AB negativo.")).toBe(false);
    expect(drawnFacts("C8-06-s50").has("My son's birthday is July 9.")).toBe(false);
    // Unrelated facts still come: C6-01 (short bullet replies) draws the blood types.
    expect(drawnFacts("C6-01-s50").has("Mi tipo de sangre es B negativo.")).toBe(true);
  });

  it("padTurn: whole filler sentences of the turn's language and role, none twice, to about the target; 0 or a long turn unchanged", () => {
    const next = xorshift32(7);
    expect(padTurn("Hola.", "user", 0, V2.fillerSpec, next, "es")).toBe("Hola.");
    expect(padTurn("", "user", 50, V2.fillerSpec, next, "es")).toBe("");
    const long = "x".repeat(400);
    expect(padTurn(long, "assistant", 50, V2.fillerSpec, next, "en")).toBe(long);
    // The language test sorts every filler sentence the way it was generated.
    const es = /[¿¡áéíóúñ]|\b(?:el|la|los|las|de|del|que|mi|es|un|una|para|por|con)\b/i;
    const g = xorshift32(11);
    for (const lang of ["es", "en"] as const)
      for (const role of ["user", "assistant"] as const)
        for (const tpl of V2.fillerSpec.templates[lang][role]) for (let k = 0; k < 20; k++) expect(es.test(fill(tpl, V2.fillerSpec.vocab[lang], g)), `${lang} ${tpl}`).toBe(lang === "es");
    const esc = (x: string) => x.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    const sentences = (lang: "es" | "en", role: "user" | "assistant") => V2.fillerSpec.templates[lang][role].map((t) => new RegExp(`^${t.split(/\{\w+\}/).map(esc).join(".+?")}$`, "u"));
    const items = generateFiller(V2.fillerSpec, { seed: 3, size: 400, fromT: 0, toT: 86_400 });
    let chars = 0;
    for (const x of items) {
      for (const [role, text, label] of [["user", x.user, "Fede: "], ["assistant", x.assistant, "Jarvis: "]] as const) {
        const lang = es.test(text) ? "es" : "en";
        const padded = padTurn(text, role, 50, V2.fillerSpec, next, lang);
        expect(padded.startsWith(text)).toBe(true);
        const added = padded.slice(text.length).trim();
        expect(added.length).toBeGreaterThan(0);
        chars += (label + padded).length;
        // Split where a template of that language and role starts (its text before the first slot).
        const starts = V2.fillerSpec.templates[lang][role].map((t) => t.split("{")[0]);
        const cuts = [...added].flatMap((_c, i) => ((i === 0 || added[i - 1] === " ") && starts.some((st) => added.startsWith(st, i)) ? [i] : []));
        const parts = cuts.map((c, k) => added.slice(c, cuts[k + 1]).trim());
        expect(cuts[0]).toBe(0);
        for (const part of parts) expect(sentences(lang, role).some((re) => re.test(part)), part).toBe(true);
        expect(new Set(parts).size).toBe(parts.length);
        expect(parts.includes(text)).toBe(false);
      }
    }
    const tpt = chars / (2 * items.length) / 4;
    expect(tpt).toBeGreaterThan(47);
    expect(tpt).toBeLessThan(53);
  });

  it("every pool item is padded in its source scenario's language, short Spanish replies included (audit R2 W1); padding never grows a Jarvis turn past CONSOLIDATOR_JARVIS_TURN_MAX_CHARS (R4)", () => {
    const pool = dayPool(V2.scenarios);
    const langsOf = new Map<string, Set<string>>();
    for (const sc of V2.scenarios) for (const x of [...dayPool([sc]).work, ...dayPool([sc]).facts]) langsOf.set(`${x.user}\t${x.assistant}`, (langsOf.get(`${x.user}\t${x.assistant}`) ?? new Set()).add(sc.lang));
    const items = [...pool.work, ...pool.facts];
    for (const x of items) expect([...langsOf.get(`${x.user}\t${x.assistant}`)!], x.user).toEqual([x.lang]);
    expect(items.some((x) => x.assistant === "Anotado." && x.lang === "es")).toBe(true);
    const esc = (x: string) => x.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    const sentences = (lang: "es" | "en", role: "user" | "assistant") => V2.fillerSpec.templates[lang][role].map((t) => new RegExp(`^${t.split(/\{\w+\}/).map(esc).join(".+?")}$`, "u"));
    const next = xorshift32(5);
    let padded = 0;
    for (const x of items)
      for (const [role, text] of [["user", x.user], ["assistant", x.assistant]] as const) {
        if (!text) continue;
        const out = padTurn(text, role, 50, V2.fillerSpec, next, x.lang);
        const added = out.slice(text.length).trim();
        if (!added) continue;
        padded++;
        const starts = V2.fillerSpec.templates[x.lang][role].map((t) => t.split("{")[0]);
        const cuts = [...added].flatMap((_c, i) => ((i === 0 || added[i - 1] === " ") && starts.some((st) => added.startsWith(st, i)) ? [i] : []));
        expect(cuts[0], `${x.lang} ${text}`).toBe(0);
        for (const [k, c] of cuts.entries()) {
          const part = added.slice(c, cuts[k + 1]).trim();
          expect(sentences(x.lang, role).some((re) => re.test(part)), `${x.lang} ${text}: ${part}`).toBe(true);
        }
      }
    expect(padded).toBeGreaterThan(items.length);
    // The same through dayWindowExchanges: a drawn pool item is padded in its own language, whatever its text looks like.
    const byKey = new Map(items.map((x) => [`${x.user}\t${x.assistant}`, x]));
    const inLang = (added: string, lang: "es" | "en", role: "user" | "assistant") => {
      const starts = V2.fillerSpec.templates[lang][role].map((t) => t.split("{")[0]);
      const cuts = [...added].flatMap((_c, i) => ((i === 0 || added[i - 1] === " ") && starts.some((st) => added.startsWith(st, i)) ? [i] : []));
      return cuts[0] === 0 && cuts.every((c, k) => sentences(lang, role).some((re) => re.test(added.slice(c, cuts[k + 1]).trim())));
    };
    let checked = 0;
    let short = 0;
    for (const s of V2.scenarios.filter((x) => x.fillerSize === 50 && ["C2", "C6", "C8"].includes(x.class))) {
      const night = nextConsolidationT(s.events.find((e) => e.kind === "standing" || e.kind === "person_fact")!.t);
      const plain = dayWindowExchanges(s, V2.fillerSpec, night, [], { turns: 400, mix: "mixed", pool });
      const pad = dayWindowExchanges(s, V2.fillerSpec, night, [], { turns: 400, mix: "mixed", pool, turnTokens: 50 });
      for (const [k, x] of plain.entries()) {
        const item = byKey.get(`${x.user}\t${x.assistant}`);
        if (!item) continue;
        for (const role of ["user", "assistant"] as const) {
          const added = pad[k][role].slice(x[role].length).trim();
          if (!added) continue;
          checked++;
          if (role === "assistant" && x.assistant.length < 40 && item.lang === "es") short++;
          expect(inLang(added, item.lang, role), `${s.id} ${item.lang} ${x[role]}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(short).toBeGreaterThan(0);
    const g = xorshift32(9);
    // 120 = run.ts DAY_TURN_TOKENS_MAX; 200 aims past the cut, so only the cap holds the turn under it.
    for (const tokens of [120, 200])
      for (const x of generateFiller(V2.fillerSpec, { seed: 4, size: 300, fromT: 0, toT: 86_400 }))
        for (const lang of ["es", "en"] as const) expect(padTurn(x.assistant, "assistant", tokens, V2.fillerSpec, g, lang).length).toBeLessThanOrEqual(CONSOLIDATOR_JARVIS_TURN_MAX_CHARS);
  });

  it("padding leaves the unpadded draws in place: turnTokens 0 is the unpadded day, item for item; padded turns keep their text as a prefix and the scenario's own filler is not padded", () => {
    const pool = dayPool(V2.scenarios);
    const s = V2.scenarios.find((x) => x.id === "C6-01-s50")!;
    const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
    const filler = fillerOf(s);
    for (const mix of ["smalltalk", "mixed"] as const) {
      const plain = dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 120, mix, pool });
      expect(dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 120, mix, pool, turnTokens: 0 })).toEqual(plain);
      const padded = dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 120, mix, pool, turnTokens: 50 });
      expect(padded.length).toBe(plain.length);
      for (const [i, x] of padded.entries()) {
        expect(x.t).toBe(plain[i].t);
        expect(x.user.startsWith(plain[i].user) && x.assistant.startsWith(plain[i].assistant)).toBe(true);
      }
      expect(padded.slice(60)).toEqual(plain.slice(60));
      expect(padded.slice(0, 60).filter((x, i) => x.user !== plain[i].user).length).toBeGreaterThan(50);
    }
    for (const turnTokens of [-1, 2.5]) expect(() => dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 60, mix: "smalltalk", turnTokens }), String(turnTokens)).toThrow(/turnTokens must be/);
  });

  it("a night past CONSOLIDATOR_MAX_TURNS writes its oldest 400 turns, as consolidateAll reads them, and counts the rest in cutTurns (dry run, 300 filler items in one night)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-day-"));
    const adapter = new JarvisAdapter(scratchDbPath(dir), "extracted", { extraction: { budget: new ModelCallBudget(Number.POSITIVE_INFINITY), dryRun: true, window: "day" } });
    adapter.open();
    try {
      const base = V2.scenarios.find((x) => x.id === "C6-01-s50")!;
      const night = nextConsolidationT(base.events.find((e) => e.kind === "standing")!.t);
      const s: Scenario = { ...base, fillerSize: 300, fillerFromT: night - 86_400, fillerToT: night - 1800 };
      expect(dayWindowExchanges(s, V2.fillerSpec, night, fillerOf(s)).length * 2 + 2).toBe(2 + 2 * (DAY_WINDOW_EXCHANGES + 300));
      await adapter.runScenario(s, V2.fillerSpec);
      expect(adapter.extractions[0]).toMatchObject({ scenarioId: "C6-01-s50", calls: 1, turns: 400, cutTurns: 2 + 2 * (DAY_WINDOW_EXCHANGES + 300) - 400, inserted: 0 });
    } finally {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("factCatches (extracted leg `caught`, queue 4bo i)", () => {
  it("without expectEn it is the scorer's expect match alone", () => {
    expect(factCatches("Fede quiere viñetas cortas.", { expect: ["viñetas"] })).toBe(true);
    expect(factCatches("Fede wants short bullet points.", { expect: ["viñetas"] })).toBe(false);
    expect(factCatches("Fede wants short bullet points.", { expect: ["viñetas"], expectEn: [] })).toBe(false);
  });

  it("an English needle list catches the English fact, accents and case folded on both sides; every needle of a list must hold", () => {
    const p = { expect: ["viñetas", "párrafos"], expectEn: ["bullet", "paragraph"] };
    expect(factCatches("Fede prefers short BULLET points over long paragraphs.", p)).toBe(true);
    expect(factCatches("Fede prefers short bullet points.", p)).toBe(false);
    expect(factCatches("Fede quiere viñetas, nunca párrafos.", p)).toBe(true);
    expect(factCatches("Fede's daughter goes to Colegio Tamarindos in Zacatlan.", { expect: ["Zacatlán"], expectEn: ["zacatlán"] })).toBe(true);
    expect(foldAccents("Ñandú ÁÉÍÓÚ")).toBe("nandu aeiou");
  });
});
