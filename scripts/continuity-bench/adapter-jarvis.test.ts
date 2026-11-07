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
import {
  JARVIS_MARKERS,
  JME_HEADER,
  DEFAULT_SWITCHES,
  JME_INJECTION_BUDGET_TOKENS,
  JarvisAdapter,
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
} from "./adapter-jarvis.js";
import { buildCorpusV2 } from "./corpus-v2.js";
import { FILLER_SPEC_V1 } from "./filler.js";
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
