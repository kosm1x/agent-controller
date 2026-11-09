import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FILLER_SPEC_V1, generateFiller } from "./filler.js";
import {
  BASELINE_CAVEATS,
  CONSOLIDATOR_TURN_CAP,
  CORPUS_FILES,
  DAY_TURNS_ARCHIVED,
  DEFAULT_CORPUS,
  EXTRACTED_NOTE,
  EXTRACTION_COST_PER_CALL,
  EXTRACTION_PROMPT_TOKENS,
  EXTRACTION_LIMITS,
  FetchMeter,
  MEASURED_DAY_TURNS,
  MEASURED_DAY_TURN_TOKENS,
  MEASURED_NIGHTLY_INPUT_TOKENS,
  DAY_TURN_TOKENS_MAX,
  UNPADDED_TURN_TOKENS,
  PROVISIONAL,
  capsOf,
  embedBudgetRefusal,
  dayText,
  embedPlan,
  extractionCostLine,
  extractionCostPerCall,
  extractionRefusal,
  main,
  parseArgs,
  refuseReason,
  renderBaseline,
  renderCompare,
  renderExtractionCompare,
  renderRecallFloorCompare,
  renderTombstoneCompare,
  resultFileName,
  switchSuffix,
  windowLabel,
  type EmbedPlan,
  type RunResult,
} from "./run.js";
import { DAY_WINDOW_EXCHANGES, DEFAULT_SWITCHES, dayPool, dayWindowExchanges, exchangeContent, nextConsolidationT } from "./adapter-jarvis.js";
import { CONSOLIDATOR_MAX_TURNS } from "../../src/memory/jme.js";
import { buildCorpusV2 } from "./corpus-v2.js";
import type { Corpus, ProbeRun, Scenario } from "./types.js";

// main() is gated to an operator context; the gate itself has its own lock test.
vi.mock("../../src/lib/operator-gate.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/operator-gate.js")>()),
  requireOperatorContext: () => {},
}));

// The extracted leg's model call: the production consolidator's infer(), never the network.
const { inferMock, ritualFailureMock } = vi.hoisted(() => ({ inferMock: vi.fn(), ritualFailureMock: vi.fn() }));
vi.mock("../../src/inference/adapter.js", async (orig) => ({
  ...(await orig<typeof import("../../src/inference/adapter.js")>()),
  infer: inferMock,
}));
// consolidateAll reports a failed window through the scheduler (dynamic import); keep the cron graph out.
vi.mock("../../src/rituals/scheduler.js", () => ({ recordRitualFailure: ritualFailureMock }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAY = 86_400;
const TINY: Scenario = {
  id: "C2-tiny-s4",
  class: "C2",
  base: 1,
  lang: "es",
  fillerSize: 4,
  fillerSeed: 11,
  fillerFromT: -2 * DAY,
  fillerToT: 10 * DAY,
  events: [
    { day: 0, t: 32_400, session: "d0", kind: "person_fact", text: "El presupuesto es de 3.847.215 pesos.", durable: true, asUser: "Son 3.847.215 pesos.", asAssistant: "Anotado." },
    { day: 5, t: 5 * DAY + 32_520, session: "d5", kind: "correction", targetEventIndex: 0, text: "El presupuesto es de 2.960.400 pesos.", asUser: "Ahora 2.960.400 pesos.", asAssistant: "Ajustado." },
  ],
  probes: [{ day: 10, t: 10 * DAY + 64_800, session: "d10", text: "¿Cuál es el presupuesto?", expect: ["2.960.400"], forbid: ["3.847.215"], surface: "both" }],
};

describe("run.ts", () => {
  it("refuses keys unless --allow-embeddings, and COMMIT_DB_KEY always", () => {
    expect(refuseReason({}, false)).toBeNull();
    expect(refuseReason({ GEMINI_API_KEY: "k" }, false)).toMatch(/GEMINI_API_KEY/);
    expect(refuseReason({ HINDSIGHT_ENABLED: "true" }, false)).toMatch(/HINDSIGHT/);
    expect(refuseReason({ GEMINI_API_KEY: "k" }, true)).toBeNull();
    expect(refuseReason({ COMMIT_DB_KEY: "k" }, true)).toMatch(/refused even/);
  });

  it("parses run and report modes; embeddings default to 50,500 and a 3000-call cap", () => {
    const a = parseArgs(["node", "run.ts", "--leg", "ideal", "--allow-embeddings"]);
    expect(a).toMatchObject({ mode: "run", leg: "ideal", sizes: [50, 500], allowEmbeddings: true, maxEmbedCalls: 3000, embedCache: null });
    expect(parseArgs(["node", "run.ts", "--max-embed-calls", "9000", "--sizes", "50"])).toMatchObject({ maxEmbedCalls: 9000, sizes: [50] });
    expect(parseArgs(["node", "run.ts", "--report", "a.json,b.json", "--md", "x.md"])).toEqual({ mode: "report", report: ["a.json", "b.json"], md: "x.md" });
    expect(() => parseArgs(["node", "run.ts", "--leg", "both"])).toThrow(/--leg/);
    expect(() => parseArgs(["node", "run.ts", "--report", "a.json"])).toThrow(/--md/);
  });

  it("parses --switch (repeatable, NAME=value, none by default) and --compare pairs with an optional --reference", () => {
    expect(parseArgs(["node", "run.ts"])).toMatchObject({ mode: "run", switches: {} });
    expect(parseArgs(["node", "run.ts", "--switch", "MEMORY_OPEN_WORK=on"])).toMatchObject({ switches: { MEMORY_OPEN_WORK: "on" } });
    expect(() => parseArgs(["node", "run.ts", "--switch", "MEMORY_OPEN_WORK"])).toThrow(/NAME=value/);
    expect(() => parseArgs(["node", "run.ts", "--switch"])).toThrow(/NAME=value/);
    expect(parseArgs(["node", "run.ts", "--compare", "a.json,b.json", "--md", "x.md"])).toEqual({ mode: "compare", compare: ["a.json", "b.json"], reference: [], md: "x.md" });
    expect(parseArgs(["node", "run.ts", "--compare", "a,b,c,d", "--reference", "r", "--md", "x.md"])).toEqual({ mode: "compare", compare: ["a", "b", "c", "d"], reference: ["r"], md: "x.md" });
    expect(() => parseArgs(["node", "run.ts", "--compare", "a,b,c", "--md", "x.md"])).toThrow(/pairs/);
    expect(() => parseArgs(["node", "run.ts", "--compare", "a,b"])).toThrow(/--md/);
  });

  it("the baseline carries every caveat and prints an unmeasurable row as 'not scored'", () => {
    const r: RunResult = {
      meta: { system: "jarvis", commit: "abc", leg: "raw", embeddings: "off", corpusVersion: "continuity-v2", sizes: [50], startedAt: "t", durationMs: 1, notes: [] },
      ingest: [],
      aggregates: [
        { class: "C1", label: "old-fact", fillerSize: 50, surface: "asked", n: 0, notScored: 4, hitPct: null, staleHitPct: null, medianChars: null, medianMs: null, meanIrrelevant: null, authorMarkedPct: null },
        { class: "C7", label: "nothing-to-recall", fillerSize: 50, surface: "asked", n: 2, hitPct: 100, staleHitPct: 0, medianChars: 1, medianMs: 1, meanIrrelevant: 0, authorMarkedPct: null },
      ],
      probes: [],
      gapAggregates: [],
      authorAggregates: [],
      caps: { memory_search: 5, jme_query: 8 },
    };
    const md = renderBaseline([r]);
    for (const c of BASELINE_CAVEATS) expect(md).toContain(c);
    expect(md).toMatch(/\| C1 old-fact \| 50 \| asked \| 0 \| not scored \(4\)/);
    expect(md).toMatch(/memory_search 5, jme_query 8/);
    expect(md).toContain("empty or broken adapter also scores 100 %");
  });

  it("capsOf lists each query-driven component's cap (null = no count cap)", () => {
    const run = {
      proactive: { measurable: true, ms: 0, components: [{ name: "relevant_facts", queryDriven: true, text: "", items: [] }] },
      asked: { measurable: true, ms: 0, components: [{ name: "memory_search", queryDriven: true, cap: 5, text: "", items: [] }] },
    } as unknown as ProbeRun;
    expect(capsOf([run])).toEqual({ relevant_facts: null, memory_search: 5 });
  });
});

describe("embedding budget (operator pays for this leg)", () => {
  const plan = (p: Partial<EmbedPlan>): EmbedPlan => ({ rowTexts: 0, otherTexts: 0, unique: 0, probeCalls: 0, upsertCalls: 0, upperBound: 0, ...p });

  it("refuses on the UPPER BOUND, not the unique count", () => {
    expect(embedBudgetRefusal(plan({ unique: 10, upperBound: 40 }), 39)).toMatch(/upper bound 40/);
    expect(embedBudgetRefusal(plan({ unique: 10, upperBound: 40 }), 40)).toBeNull();
  });

  it("main() refuses before any call when the bound exceeds --max-embed-calls (unique alone would fit)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-main-"));
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const corpus = { version: "continuity-v2", seed: 1, fillerSizes: [4], fillerSpec: FILLER_SPEC_V1, scenarios: [TINY] } as Corpus;
      const path = join(dir, "tiny.json");
      writeFileSync(path, JSON.stringify(corpus));
      const p = embedPlan(corpus, [4], "ideal", exchangeContent);
      expect(p.unique).toBeLessThan(p.upperBound);
      const argv = ["node", "run.ts", "--leg", "ideal", "--sizes", "4", "--corpus", path, "--allow-embeddings", "--max-embed-calls", String(p.unique), "--out", join(dir, "o.json")];
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const code = await main(argv, { GEMINI_API_KEY: "not-a-real-key" });
      expect(code).toBe(2);
      expect(err.mock.calls.flat().join(" ")).toMatch(/refusing: upper bound/);
      expect(fetchSpy).not.toHaveBeenCalled();
      // COMMIT_DB_KEY is refused even with --allow-embeddings
      expect(await main(argv, { GEMINI_API_KEY: "x", COMMIT_DB_KEY: "y" })).toBe(2);
      err.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fetch meter passes calls under the cap through and refuses (without sending) past it", async () => {
    const sent = vi.fn(async () => new Response("ok"));
    const target = { fetch: sent as unknown as typeof fetch };
    const meter = new FetchMeter(2);
    meter.install(target);
    await target.fetch("http://example.invalid/a");
    await target.fetch("http://example.invalid/b");
    await expect(target.fetch("http://example.invalid/c")).rejects.toThrow(/cap 2/);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(meter).toMatchObject({ calls: 2, refused: 1, exceeded: true });
    meter.restore(target);
    expect(target.fetch).toBe(sent);
  });
});

describe("switches and --compare (Port 1)", () => {
  const V2 = buildCorpusV2();
  const pick = ["C3-01-ho15-s50", "C3-01-cr15-s50", "C4-01-r16-s50", "C2-01-s50"].map((id) => V2.scenarios.find((x) => x.id === id)!);
  let dir: string;
  let off: RunResult;
  let on: RunResult;

  const run = async (switches: string[], out: string): Promise<RunResult> => {
    const corpus = { ...V2, scenarios: pick } as Corpus;
    const path = join(dir, "corpus.json");
    writeFileSync(path, JSON.stringify(corpus));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["node", "run.ts", "--leg", "raw", "--sizes", "50", "--corpus", path, "--out", join(dir, out), ...switches], {});
    log.mockRestore();
    expect(code).toBe(0);
    return JSON.parse(readFileSync(join(dir, out), "utf8")) as RunResult;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-compare-"));
    off = await run([], "off.json");
    on = await run(["--switch", "MEMORY_OPEN_WORK=on"], "on.json");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEMORY_OPEN_WORK;
  });

  it("a run records every switch state; the open_work note lifts handoff and leaves crowded / C4 alone", () => {
    expect(off.meta.switches).toEqual({ MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "off", MEMORY_TOMBSTONES: "off" });
    expect(on.meta.switches).toEqual({ MEMORY_OPEN_WORK: "on", MEMORY_RECALL_FLOOR: "off", MEMORY_TOMBSTONES: "off" });
    const hit = (r: RunResult, id: string) => r.probes.filter((p) => p.scenarioId === id).map((p) => p.proactive.hit);
    expect(hit(off, "C3-01-ho15-s50")).toEqual([false, true]); // disjoint greeting lost, shared topical probe through recall
    expect(hit(on, "C3-01-ho15-s50")).toEqual([true, true]);
    expect(hit(on, "C3-01-cr15-s50")).toEqual(hit(off, "C3-01-cr15-s50"));
    expect(on.probes.find((p) => p.scenarioId === "C3-01-ho15-s50")!.components.proactive.some((c) => c.startsWith("open_work:"))).toBe(true);
    expect(off.probes.every((p) => p.components.proactive.every((c) => !c.startsWith("open_work:")))).toBe(true);

    const md = renderCompare([[off, on]], [off]);
    expect(md).toContain("switches MEMORY_OPEN_WORK=off");
    expect(md).toContain("switches MEMORY_OPEN_WORK=on");
    expect(md).toMatch(/\| C3 \| handoff \| 15 \| 0 \| 2 \| 50 \(100 \/ 0\) \| 100 \(100 \/ 100\) \| 100 \|/);
    expect(md).toMatch(/\| C3 \| crowded \| 15 \| 0 \| 2 \| 50 \(100 \/ 0\) \| 50 \(100 \/ 0\) \| 0 \|/);
    expect(md).toContain("| variant | K | other-channel rows | size 50 |");
    expect(md).toContain("| handoff | 15 | 0 | 50 → 100 |");
    expect(md).toContain("| crowded | 15 | 0 | 50 → 50 |");
    expect(md).toMatch(/^1\. \*\*PASS\*\* — before reproduces reference commit .* on its 8 probes: 0 differ, 0 missing/m);
    expect(md).toMatch(/^2\. \*\*PASS\*\* — C4 .* 1 of 1 rows identical/m);
    expect(md).toMatch(/^3\. \*\*PASS\*\* — C1, C2, C5, C6, C7, C8: 0 changed cells/m);
    expect(md).toMatch(/probes carry the open_work block; 0 changed without it or shrank \(PASS\)/);
  });

  it("switchSuffix names only the switches that differ from their defaults", () => {
    expect(switchSuffix(DEFAULT_SWITCHES, DEFAULT_SWITCHES)).toBe("");
    expect(switchSuffix({ MEMORY_OPEN_WORK: "on" }, DEFAULT_SWITCHES)).toBe("-memory-open-work-on");
    expect(switchSuffix({ MEMORY_OPEN_WORK: "shadow" }, DEFAULT_SWITCHES)).toBe("-memory-open-work-shadow");
    expect(switchSuffix({ ...DEFAULT_SWITCHES, MEMORY_RECALL_FLOOR: "on" }, DEFAULT_SWITCHES)).toBe("-memory-recall-floor-on");
    expect(switchSuffix({ A_B: "x", C: "y" }, { A_B: "x", C: "z" })).toBe("-c-y");
  });

  it("each null test fails when its condition breaks (reference drift, a C4 change, a C2 flip, a payload change without the note)", () => {
    const clone = (r: RunResult) => JSON.parse(JSON.stringify(r)) as RunResult;
    const ref = clone(off);
    ref.probes[0].proactive.chars += 1;
    expect(renderCompare([[off, on]], [ref])).toMatch(/^1\. \*\*FAIL\*\* .* 1 differ/m);
    const missing = clone(off);
    missing.meta.leg = "ideal";
    expect(renderCompare([[off, on]], [missing])).toContain("1. Reproduction: no reference run for this leg — not checked.");

    const c4 = clone(on);
    const g = c4.gapAggregates!.find((x) => x.class === "C4" && x.surface === "proactive")!;
    g.hitPct = g.hitPct === 100 ? 50 : 100;
    expect(renderCompare([[off, c4]])).toMatch(/^2\. \*\*FAIL\*\* .* changed K: 16/m);

    const c2 = clone(on);
    const p = c2.probes.find((x) => x.class === "C2")!;
    p.proactive.hit = !p.proactive.hit;
    expect(renderCompare([[off, c2]])).toMatch(/^3\. \*\*FAIL\*\* .* 1 probes with a hit or stale-hit flip/m);

    const size = clone(on);
    size.probes.find((x) => x.class === "C2")!.proactive.chars += 7;
    expect(renderCompare([[off, size]])).toMatch(/1 changed without it or shrank \(FAIL\)/);
  });
});

describe("--compare (Port 2, MEMORY_RECALL_FLOOR)", () => {
  const V2 = buildCorpusV2();
  const pick = ["C1-01-s50", "C7-01-s50", "C2-01-s50"].map((id) => V2.scenarios.find((x) => x.id === id)!);
  let dir: string;
  let off: RunResult;
  let on: RunResult;

  const run = async (switches: string[], out: string): Promise<RunResult> => {
    const path = join(dir, "corpus.json");
    writeFileSync(path, JSON.stringify({ ...V2, scenarios: pick } as Corpus));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["node", "run.ts", "--leg", "raw", "--sizes", "50", "--corpus", path, "--out", join(dir, out), ...switches], {});
    log.mockRestore();
    expect(code).toBe(0);
    return JSON.parse(readFileSync(join(dir, out), "utf8")) as RunResult;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-compare-rf-"));
    off = await run([], "off.json");
    on = await run(["--switch", "MEMORY_RECALL_FLOOR=on"], "on.json");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEMORY_OPEN_WORK;
    delete process.env.MEMORY_RECALL_FLOOR;
  });

  const c7 = (r: RunResult, surface: string) => r.aggregates.find((a) => a.class === "C7" && a.surface === surface)!;

  it("the floor run records its switch and cuts the C7 irrelevant items on both surfaces", () => {
    expect(on.meta.switches).toEqual({ MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "on", MEMORY_TOMBSTONES: "off" });
    for (const s of ["proactive", "asked"]) {
      expect(c7(off, s).meanIrrelevant!, s).toBeGreaterThan(0);
      expect(c7(on, s).meanIrrelevant!, s).toBeLessThan(c7(off, s).meanIrrelevant!);
    }
  });

  it("renders C7 / C1 per size, lost / gained hits, the reproduction test, the other classes and the payload", () => {
    const md = renderRecallFloorCompare([[off, on]], [off]);
    expect(md).toContain("# Port 2 — an honest empty recall: before / after");
    expect(md).toContain("switches MEMORY_OPEN_WORK=off, MEMORY_RECALL_FLOOR=on");
    const row = (s: string) => `| 50 | ${s} | ${c7(on, s).n} | ${c7(off, s).meanIrrelevant} → ${c7(on, s).meanIrrelevant} | ${c7(off, s).hitPct} → ${c7(on, s).hitPct} |`;
    expect(md).toContain(row("proactive"));
    expect(md).toContain(row("asked"));
    expect(md).toContain("| size | surface | lost shared | lost disjoint | gained shared | gained disjoint | first lost |");
    expect(md).toMatch(/^1\. \*\*PASS\*\* — before reproduces reference commit .* 0 differ, 0 missing/m);
    expect(md).toMatch(/^2\. \*\*(unchanged|changed)\*\* — C2, C3, C4, C5, C6, C8: \d+ cells/m);
    expect(md).toMatch(/^\| C7 \| \d+ \| \d+ → \d+ \|/m);
  });

  it("names a changed cell, a flip and a reference drift", () => {
    const clone = (r: RunResult) => JSON.parse(JSON.stringify(r)) as RunResult;
    const c2 = clone(on);
    const p = c2.probes.find((x) => x.class === "C2")!;
    p.proactive.hit = !p.proactive.hit;
    c2.aggregates.find((a) => a.class === "C2" && a.surface === "proactive")!.hitPct = -1;
    const md = renderRecallFloorCompare([[off, c2]]);
    expect(md).toMatch(/^2\. \*\*changed\*\* — .* 1 changed; 1 probes with a hit or stale-hit flip on a scored surface, 0 on an unscored surface only/m);
    expect(md).toMatch(/^\| C2 size 50 proactive \| .* \| \[\d+,-1,/m);
    expect(md).toMatch(/^\| C2 \| proactive \| \+[01] \/ −[01] \|/m);
    // A flip on a surface the class does not score is counted apart and labelled.
    const [u0, u1] = [clone(off), clone(off)];
    for (const r of [u0, u1]) for (const x of r.probes.filter((y) => y.class === "C2")) x.asked.scored = false;
    const q = u1.probes.find((x) => x.class === "C2")!;
    q.asked.hit = !q.asked.hit;
    const umd = renderRecallFloorCompare([[u0, u1]]);
    expect(umd).toMatch(/^2\. \*\*unchanged\*\* — .* 0 changed; 0 probes with a hit or stale-hit flip on a scored surface, 1 on an unscored surface only/m);
    expect(umd).toMatch(/^\| C2 \| asked \(unscored\) \| \+[01] \/ −[01] \|/m);
    const ref = clone(off);
    ref.probes[0].asked.chars += 1;
    expect(renderRecallFloorCompare([[off, on]], [ref])).toMatch(/^1\. \*\*FAIL\*\* .* 1 differ/m);
  });

  it("main --compare picks the Port 2 renderer when the floor switch differs", async () => {
    const md = join(dir, "cmp.md");
    expect(await main(["node", "run.ts", "--compare", `${join(dir, "off.json")},${join(dir, "on.json")}`, "--md", md], {})).toBe(0);
    expect(readFileSync(md, "utf8")).toContain("# Port 2 — an honest empty recall");
  });
});

describe("--compare (Port 3, MEMORY_TOMBSTONES)", () => {
  const V2 = buildCorpusV2();
  // C8-06: the temporary value is a figure (2:40) and stale at HEAD, but its fact is a plain
  // event, not TRANSIENT_FACT_RE: it ages out with no tombstone and stays stale (qa R2 W2).
  const pick = ["C2-01-s500", "C8-06-s500", "C1-01-s500"].map((id) => V2.scenarios.find((x) => x.id === id)!);
  let dir: string;
  let off: RunResult;
  let on: RunResult;

  const run = async (switches: string[], out: string): Promise<RunResult> => {
    const path = join(dir, "corpus.json");
    writeFileSync(path, JSON.stringify({ ...V2, scenarios: pick } as Corpus));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["node", "run.ts", "--leg", "ideal", "--sizes", "500", "--corpus", path, "--out", join(dir, out), ...switches], {});
    log.mockRestore();
    expect(code).toBe(0);
    return JSON.parse(readFileSync(join(dir, out), "utf8")) as RunResult;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-compare-ts-"));
    off = await run([], "off.json");
    on = await run(["--switch", "MEMORY_TOMBSTONES=on"], "on.json");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEMORY_OPEN_WORK;
    delete process.env.MEMORY_RECALL_FLOOR;
    delete process.env.MEMORY_TOMBSTONES;
  });

  const agg = (r: RunResult, cls: string, surface: string) => r.aggregates.find((a) => a.class === cls && a.surface === surface)!;

  it("the tombstone run records its switch, drops the C2 stale hit, leaves the plain-event C8 one and keeps every hit", () => {
    expect(on.meta.switches).toEqual({ MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "off", MEMORY_TOMBSTONES: "on" });
    for (const s of ["proactive", "asked"]) {
      for (const cls of ["C2", "C8"]) expect(agg(off, cls, s).staleHitPct, `${cls} ${s}`).toBeGreaterThan(0);
      expect(agg(on, "C2", s).staleHitPct, `C2 ${s}`).toBe(0);
      expect(agg(on, "C8", s).staleHitPct, `C8 ${s}`).toBe(agg(off, "C8", s).staleHitPct);
      for (const cls of ["C1", "C2", "C8"]) expect(agg(on, cls, s).hitPct, `${cls} ${s}`).toBe(agg(off, cls, s).hitPct);
    }
  });

  it("renders C2 / C8 per size, the stale carriers, the null tests, lost hits and the payload; main picks it", async () => {
    const md = renderTombstoneCompare([[off, on]], [off]);
    expect(md).toContain("# Port 3 — tombstones for corrected and expired facts: before / after");
    const [b2, a2, b8, a8] = [agg(off, "C2", "asked"), agg(on, "C2", "asked"), agg(off, "C8", "asked"), agg(on, "C8", "asked")];
    expect(md).toContain(
      `| 500 | asked | ${a2.n} | ${b2.hitPct} → ${a2.hitPct} | ${b2.staleHitPct} → 0 | ${a8.n} | ${b8.hitPct} → ${a8.hitPct} | ${b8.staleHitPct} → ${b8.staleHitPct} |`,
    );
    expect(md).toMatch(/^\| C2 \| 500 \| asked \| memory_search \| [1-9]\d* → 0 \|$/m);
    expect(md).toMatch(/^\| C8 \| 500 \| asked \| memory_search \| ([1-9]\d*) → \1 \|$/m);
    expect(md).toMatch(/^1\. \*\*PASS\*\* — before reproduces reference commit .* 0 differ, 0 missing/m);
    expect(md).toMatch(/^2\. \*\*unchanged\*\* — C1: \d+ cells .* 0 changed; 0 probes with a hit or stale-hit flip; 0 scored hits lost/m);
    expect(md).toMatch(/^\| C2 \| asked \| 0 \| 0 \| [1-9]\d* \| 0 \| – \|$/m);
    expect(md).toMatch(/^\| C8 \| \d+ \| \d+ → \d+ \|/m);
    // A reference that differs is counted by class and by changed field.
    const ref = JSON.parse(JSON.stringify(off)) as RunResult;
    ref.probes.find((p) => p.class === "C2")!.asked.chars += 1;
    const withRef = renderTombstoneCompare([[off, on]], [ref]);
    expect(withRef).toMatch(/differing probes by class C2 1; 0 with a hit or stale-hit change; fields that changed: asked\.chars 1\./);
    expect(withRef).toMatch(/^ {3}- why: the harness changed in Port 3, not the switch: .*supersedeCluster in every mode/m);
    // A raw leg states its pair (raw writes no tombstones); an ideal leg does not.
    expect(md).not.toContain("- raw pair:");
    const asRaw = (r: RunResult) => ({ ...r, meta: { ...r.meta, leg: "raw" } }) as RunResult;
    expect(renderTombstoneCompare([[asRaw(off), asRaw(on)]])).toContain(
      `- raw pair: 3 scenarios / ${off.probes.length} probes (pre-\`sn\`, run ${off.meta.startedAt}); raw writes no tombstones, so \`on\` = \`off\` there.`,
    );
    const out = join(dir, "cmp.md");
    expect(await main(["node", "run.ts", "--compare", `${join(dir, "off.json")},${join(dir, "on.json")}`, "--md", out], {})).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# Port 3 — tombstones");
  });
});

describe("extracted leg (Port 4, real consolidateAll with a mocked infer)", () => {
  const V2 = buildCorpusV2();
  const pick = ["C6-01-s50", "C6-02-s50"].map((id) => V2.scenarios.find((x) => x.id === id)!);
  const PROVIDER = { INFERENCE_PRIMARY_PROVIDER: "claude-sdk", MC_API_KEY: "placeholder" };
  const reply = (facts: unknown[]) => ({ content: JSON.stringify(facts) });
  const VINETAS = { factText: "Fede wants every reply in viñetas cortas, never long paragraphs.", category: "preference", confidence: 0.9, inferred: false };
  const BULLETS = { factText: "Fede prefers short bullet points over long paragraphs.", category: "preference", confidence: 0.9, inferred: false };
  let dir: string;
  let corpusPath: string;

  const run = async (flags: string[], out: string, env: NodeJS.ProcessEnv = PROVIDER): Promise<number> => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return await main(["node", "run.ts", "--leg", "extracted", "--corpus", corpusPath, "--out", join(dir, out), ...flags], env);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  };
  const load = (out: string) => JSON.parse(readFileSync(join(dir, out), "utf8")) as RunResult;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-extracted-"));
    corpusPath = join(dir, "corpus.json");
    writeFileSync(corpusPath, JSON.stringify({ ...V2, scenarios: pick } as Corpus));
  });
  afterEach(() => {
    inferMock.mockReset();
    ritualFailureMock.mockReset();
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the leg: defaults --classes C6, --sizes 50, --max-model-calls 6, no consent; other legs keep every class", () => {
    expect(parseArgs(["node", "run.ts", "--leg", "extracted"])).toMatchObject({ leg: "extracted", classes: ["C6"], sizes: [50], maxModelCalls: 6, run: false, dryRun: false });
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--run", "--classes", "C2,C8", "--max-model-calls", "29"])).toMatchObject({ classes: ["C2", "C8"], maxModelCalls: 29, run: true });
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--dry-run"])).toMatchObject({ dryRun: true, run: false });
    expect(parseArgs(["node", "run.ts", "--leg", "raw"])).toMatchObject({ classes: null, sizes: [50, 500] });
    expect(() => parseArgs(["node", "run.ts", "--classes", "C9"])).toThrow(/--classes/);
    expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--max-model-calls", "-1"])).toThrow(/--max-model-calls/);
  });

  it("defaults for the extracted leg: --window day, corpus v2, an --out named after the classes and the window; other legs unchanged", () => {
    const x = parseArgs(["node", "run.ts", "--leg", "extracted"]);
    expect(x).toMatchObject({ window: "day" });
    expect(x.mode === "run" && x.corpus.endsWith("benchmarks/continuity/corpus-v2.json")).toBe(true);
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--window", "clean"])).toMatchObject({ window: "clean" });
    expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--window", "night"])).toThrow(/--window must be day or clean/);
    expect(() => parseArgs(["node", "run.ts", "--leg", "raw", "--window", "day"])).toThrow(/extracted only/);
    const base = { commit: "abc1234", embeddings: "off", suffix: "-v2", switchTag: "", dryRun: false };
    expect(resultFileName({ ...base, leg: "extracted", classes: ["C6"], window: "day" })).toBe("jarvis-abc1234-extracted-emb-off-v2-c6-day.json");
    expect(resultFileName({ ...base, leg: "extracted", classes: ["C2", "C8"], window: "clean", dryRun: true })).toBe("jarvis-abc1234-extracted-emb-off-v2-c2c8-clean-dry-run.json");
    expect(resultFileName({ ...base, leg: "raw", classes: null, window: "day" })).toBe("jarvis-abc1234-raw-emb-off-v2.json");
    expect(resultFileName({ ...base, leg: "ideal", classes: ["C6"], window: "day", switchTag: "-tombstones" })).toBe("jarvis-abc1234-ideal-emb-off-v2-tombstones.json");
    expect(windowLabel("clean")).toMatch(/upper bound/);
    expect(windowLabel("day")).toMatch(/seeded ordinary exchanges/);
  });

  it("every leg shares one default corpus, v2; --corpus v1 / v2 name the committed files (v1 stays reproducible), anything else is a path (queue 4bo g)", () => {
    expect(DEFAULT_CORPUS).toBe("v2");
    const corpusOf = (argv: string[]) => {
      const r = parseArgs(["node", "run.ts", ...argv]);
      return r.mode === "run" ? r.corpus : "";
    };
    const defaults = [[], ["--leg", "raw"], ["--leg", "ideal"], ["--leg", "extracted"]].map(corpusOf);
    expect(new Set(defaults).size).toBe(1);
    expect(defaults[0].endsWith(CORPUS_FILES.v2)).toBe(true);
    for (const leg of ["raw", "ideal", "extracted"]) {
      expect(corpusOf(["--leg", leg, "--corpus", "v1"]).endsWith("benchmarks/continuity/corpus-v1.json"), leg).toBe(true);
      expect(corpusOf(["--leg", leg, "--corpus", "v2"])).toBe(defaults[0]);
    }
    expect(corpusOf(["--corpus", "benchmarks/continuity/corpus-v1.json"])).toBe(corpusOf(["--corpus", "v1"]));
    expect(corpusOf(["--corpus", "/x/y.json"])).toBe("/x/y.json");
  });

  it("--day-turns / --day-mix: default the measured window (MEASURED_DAY_TURNS mixed), the archived one by flag, even integers only, extracted --window day only (queue 4bo h)", () => {
    expect(DAY_TURNS_ARCHIVED).toBe(2 * DAY_WINDOW_EXCHANGES);
    expect(CONSOLIDATOR_TURN_CAP).toBe(CONSOLIDATOR_MAX_TURNS);
    expect(parseArgs(["node", "run.ts", "--leg", "extracted"])).toMatchObject({ dayTurns: MEASURED_DAY_TURNS, dayMix: "mixed", dayTurnTokens: MEASURED_DAY_TURN_TOKENS });
    expect(parseArgs(["node", "run.ts", "--leg", "raw"])).toMatchObject({ dayTurns: MEASURED_DAY_TURNS, dayMix: "mixed", dayTurnTokens: MEASURED_DAY_TURN_TOKENS });
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--day-turns", "60", "--day-mix", "smalltalk", "--day-turn-tokens", "0"])).toMatchObject({ dayTurns: 60, dayMix: "smalltalk", dayTurnTokens: 0 });
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--day-turn-tokens", String(DAY_TURN_TOKENS_MAX)])).toMatchObject({ dayTurnTokens: DAY_TURN_TOKENS_MAX });
    for (const n of ["-1", "2.5", "x", String(DAY_TURN_TOKENS_MAX + 1)]) expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--day-turn-tokens", n]), n).toThrow(/--day-turn-tokens must be an integer from 0 to 120/);
    expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--window", "clean", "--day-turn-tokens", "0"])).toThrow(/extracted --window day only/);
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--day-turns", "240", "--day-mix", "mixed"])).toMatchObject({ dayTurns: 240, dayMix: "mixed" });
    expect(parseArgs(["node", "run.ts", "--leg", "extracted", "--day-turns", "0"])).toMatchObject({ dayTurns: 0 });
    for (const n of ["7", "-2", "1.5", "x", "--run"]) expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--day-turns", n]), n).toThrow(/--day-turns must be/);
    expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--day-mix", "tools"])).toThrow(/--day-mix must be/);
    expect(() => parseArgs(["node", "run.ts", "--leg", "raw", "--day-turns", "120"])).toThrow(/extracted --window day only/);
    expect(() => parseArgs(["node", "run.ts", "--leg", "extracted", "--window", "clean", "--day-mix", "mixed"])).toThrow(/extracted --window day only/);
    const base = { commit: "abc1234", embeddings: "off", suffix: "-v2", switchTag: "", dryRun: false, leg: "extracted", classes: ["C6"], window: "day" as const };
    expect(resultFileName({ ...base, day: { turns: 240, mix: "mixed" } })).toBe("jarvis-abc1234-extracted-emb-off-v2-c6-day-t240-mixed.json");
    expect(resultFileName({ ...base, day: { turns: 240, mix: "smalltalk" } })).toBe("jarvis-abc1234-extracted-emb-off-v2-c6-day-t240.json");
    expect(resultFileName(base)).toBe("jarvis-abc1234-extracted-emb-off-v2-c6-day.json");
    expect(resultFileName({ ...base, day: { turns: 1190, mix: "mixed", turnTokens: 50 } })).toBe("jarvis-abc1234-extracted-emb-off-v2-c6-day-t1190-mixed-p50.json");
    expect(dayText(undefined)).toBe("");
    expect(dayText({ turns: 240, mix: "mixed" })).toBe(", day 240 seeded turns mixed");
    expect(dayText({ turns: 1190, mix: "mixed", turnTokens: 50 })).toBe(", day 1190 seeded turns mixed padded to 50 tokens");
  });

  it("MEASURED_DAY_TURNS is derived from the measured ledger: nearest even of (median input − prompt) / chars-per-4 tokens per seeded mixed turn at that size (MEASURED 2026-11-08)", () => {
    const x = [...MEASURED_NIGHTLY_INPUT_TOKENS];
    expect(x.length).toBe(30);
    expect(x).toEqual([...x].sort((p, q) => p - q));
    const median = (x[14] + x[15]) / 2;
    expect(median).toBe(20951);
    expect(EXTRACTION_PROMPT_TOKENS).toBe(1000);
    const pool = dayPool(V2.scenarios);
    const STATED = new Set(["standing", "person_fact", "correction"]);
    const tokensPerTurn = (turns: number, mix: "mixed" | "smalltalk") => {
      let chars = 0;
      let n = 0;
      for (const s of V2.scenarios.filter((y) => ["C2", "C6", "C8"].includes(y.class) && y.fillerSize === 50))
        for (const night of new Set(s.events.filter((e) => STATED.has(e.kind)).map((e) => nextConsolidationT(e.t))))
          for (const item of dayWindowExchanges(s, V2.fillerSpec, night, [], { turns, mix, pool })) {
            chars += `Fede: ${item.user}\n`.length + `Jarvis: ${item.assistant}\n`.length;
            n += 2;
          }
      return chars / n / 4;
    };
    const tpt = tokensPerTurn(MEASURED_DAY_TURNS, "mixed");
    expect(tpt).toBeGreaterThan(16.7);
    expect(tpt).toBeLessThan(16.85);
    expect(tokensPerTurn(MEASURED_DAY_TURNS, "smalltalk")).toBeGreaterThan(17.0);
    const derived = 2 * Math.round((median - EXTRACTION_PROMPT_TOKENS) / tpt / 2);
    expect(`(${median} - ${EXTRACTION_PROMPT_TOKENS}) / ${tpt.toFixed(2)} -> ${derived}`).toBe(`(20951 - 1000) / 16.77 -> ${MEASURED_DAY_TURNS}`);
    expect(MEASURED_DAY_TURNS).toBe(1190);
  });

  it("MEASURED_DAY_TURN_TOKENS is derived from the measured ledger: (median input − prompt) / the 400-turn cap; a default night's call then carries about the median (ruling A, MEASURED 2026-11-08)", () => {
    const x = [...MEASURED_NIGHTLY_INPUT_TOKENS];
    const median = (x[14] + x[15]) / 2;
    const perTurn = (median - EXTRACTION_PROMPT_TOKENS) / CONSOLIDATOR_TURN_CAP;
    expect(`(${median} - ${EXTRACTION_PROMPT_TOKENS}) / ${CONSOLIDATOR_TURN_CAP} = ${perTurn.toFixed(1)} -> ${Math.round(perTurn)}`).toBe(`(20951 - 1000) / 400 = 49.9 -> ${MEASURED_DAY_TURN_TOKENS}`);
    expect(MEASURED_DAY_TURN_TOKENS).toBe(50);
    expect(DAY_TURN_TOKENS_MAX).toBeLessThan(500 / 4);
    expect(UNPADDED_TURN_TOKENS).toBe(17);
    // Measured on the default (MEASURED_DAY_TURNS mixed turns padded to 50): what the call sees is the night's oldest 400 turns.
    const pool = dayPool(V2.scenarios);
    const STATED = new Set(["standing", "person_fact", "correction"]);
    let seededChars = 0;
    let seededTurns = 0;
    const inputs: number[] = [];
    for (const s of V2.scenarios.filter((y) => ["C2", "C6", "C8"].includes(y.class) && y.fillerSize === 50)) {
      const nights = new Map<number, Array<{ t: number; user: string; assistant: string }>>();
      for (const e of s.events) if (STATED.has(e.kind) && e.kind !== "exchange") nights.set(nextConsolidationT(e.t), [...(nights.get(nextConsolidationT(e.t)) ?? []), { t: e.t, user: e.asUser, assistant: e.asAssistant }]);
      for (const [night, stated] of nights) {
        const seeded = dayWindowExchanges(s, V2.fillerSpec, night, [], { turns: MEASURED_DAY_TURNS, mix: "mixed", pool, turnTokens: MEASURED_DAY_TURN_TOKENS });
        for (const item of seeded) {
          seededChars += `Fede: ${item.user}\n`.length + `Jarvis: ${item.assistant}\n`.length;
          seededTurns += 2;
        }
        const lines = [...stated, ...seeded].sort((a, b) => a.t - b.t).flatMap((i) => [...(i.user ? [`Fede: ${i.user}`] : []), ...(i.assistant ? [`Jarvis: ${i.assistant}`] : [])]);
        inputs.push(EXTRACTION_PROMPT_TOKENS + lines.slice(0, CONSOLIDATOR_TURN_CAP).join("\n").length / 4);
      }
    }
    const tpt = seededChars / seededTurns / 4;
    expect(tpt).toBeGreaterThan(48);
    expect(tpt).toBeLessThan(52);
    const mean = inputs.reduce((a, b) => a + b, 0) / inputs.length;
    expect(Math.abs(mean - median) / median).toBeLessThan(0.05);
  });

  it("the day cost scales the day − clean increment linearly with --day-turns; the archived window and clean are unchanged", () => {
    expect(extractionCostPerCall("day")).toBe(EXTRACTION_COST_PER_CALL.day);
    expect(extractionCostPerCall("day", 60)).toBe(EXTRACTION_COST_PER_CALL.day);
    expect(extractionCostPerCall("clean", 240)).toBe(EXTRACTION_COST_PER_CALL.clean);
    const x = extractionCostPerCall("day", 240);
    expect(x.typical).toBeCloseTo(0.0015 + 4 * 0.0015, 10);
    expect(x.ceiling).toBeCloseTo(0.0063 + 4 * 0.0013, 10);
    expect(extractionCostPerCall("day", 0)).toEqual(EXTRACTION_COST_PER_CALL.clean);
    expect(extractionCostLine("day", 6)).toBe(extractionCostLine("day", 6, 60));
    expect(extractionCostLine("day", 6)).not.toMatch(/--day-turns/);
    expect(extractionCostLine("day", 6, 240)).toMatch(/^6 calls, window day \(--day-turns 240, scaled linearly from 60\): about \$0\.045 typical, \$0\.069 ceiling/);
    // Past the consolidator's cap the call sees at most 400 turns: the cost stops growing and the line says so.
    expect(extractionCostPerCall("day", MEASURED_DAY_TURNS)).toEqual(extractionCostPerCall("day", 400));
    expect(extractionCostLine("day", 6, MEASURED_DAY_TURNS)).toMatch(new RegExp(`^6 calls, window day \\(--day-turns ${MEASURED_DAY_TURNS}, at most 400 reach the call, scaled linearly from 60\\)`));
    expect(extractionCostLine("day", 6, 400)).not.toMatch(/at most 400/);
    const a = { run: false, dryRun: false, maxModelCalls: 6, allowEmbeddings: false, window: "day" as const };
    expect(extractionRefusal({ ...a, dayTurns: 240 }, {})).toContain(extractionCostLine("day", 6, 240));
    // Padding scales the increment by the seeded tokens: 400 turns of 50 against 60 of 17.
    const p = extractionCostPerCall("day", MEASURED_DAY_TURNS, MEASURED_DAY_TURN_TOKENS);
    const f = (400 * 50) / (60 * UNPADDED_TURN_TOKENS);
    expect(p.typical).toBeCloseTo(0.0015 + f * 0.0015, 10);
    expect(p.ceiling).toBeCloseTo(0.0063 + f * 0.0013, 10);
    expect(extractionCostPerCall("day", 60, 0)).toBe(EXTRACTION_COST_PER_CALL.day);
    expect(extractionCostPerCall("day", 240, 10)).toEqual(extractionCostPerCall("day", 240));
    expect(extractionCostLine("day", 6, MEASURED_DAY_TURNS, MEASURED_DAY_TURN_TOKENS)).toMatch(
      /^6 calls, window day \(--day-turns 1190, at most 400 reach the call, --day-turn-tokens 50 against 17 unpadded, scaled linearly from 60\): about \$0\.19 typical, \$0\.19 ceiling/,
    );
    expect(extractionCostLine("day", 6, 60, 50)).toMatch(/\(--day-turns 60, --day-turn-tokens 50 against 17 unpadded, scaled linearly from 60\)/);
    // W4 (audit R1): the refusal's per-call day price is the configured one, not the archived window's.
    const why = extractionRefusal({ ...a, dayTurns: MEASURED_DAY_TURNS, dayTurnTokens: MEASURED_DAY_TURN_TOKENS }, {})!;
    expect(why).toContain(`$0.0015 typical / $0.0063 ceiling with --window clean, $${p.typical.toPrecision(2)} / $${p.ceiling.toPrecision(2)} with --window day`);
    expect(why).toContain(extractionCostLine("day", 6, MEASURED_DAY_TURNS, MEASURED_DAY_TURN_TOKENS));
  });

  it("extractionRefusal names the cost without consent and the provider settings under --run (names only)", () => {
    const a = { run: false, dryRun: false, maxModelCalls: 6, allowEmbeddings: false, window: "day" as const };
    expect(extractionRefusal(a, PROVIDER)).toMatch(
      /REAL model calls.*claude-haiku-4-5.*\$0\.0015 typical \/ \$0\.0063 ceiling with --window clean, \$0\.0030 \/ \$0\.0076 with --window day.*--max-model-calls 6: 6 calls, window day: about \$0\.018 typical, \$0\.046 ceiling, up to 2x billed requests \(Haiku \+ its retry\) so \$0\.091 worst case.*--run.*--dry-run/s,
    );
    expect(extractionRefusal({ ...a, window: "clean", maxModelCalls: 29 }, PROVIDER)).toMatch(/29 calls, window clean: about \$0\.044 typical, \$0\.18 ceiling, up to 2x billed requests \(Haiku \+ its retry\) so \$0\.37 worst case/);
    expect(extractionRefusal({ ...a, run: true, dryRun: true }, PROVIDER)).toMatch(/exclusive/);
    expect(extractionRefusal({ ...a, dryRun: true }, {})).toBeNull();
    expect(extractionRefusal({ ...a, dryRun: true, allowEmbeddings: true }, {})).toMatch(/embeddings off only/);
    const r = { ...a, run: true };
    expect(extractionRefusal(r, PROVIDER)).toBeNull();
    expect(extractionRefusal(r, { MC_API_KEY: "placeholder" })).toMatch(/INFERENCE_PRIMARY_PROVIDER/);
    expect(extractionRefusal(r, { ...PROVIDER, INFERENCE_SDK_LASTLINE_ENABLED: "true" })).toMatch(/INFERENCE_SDK_LASTLINE_ENABLED/);
    expect(extractionRefusal(r, { INFERENCE_PRIMARY_PROVIDER: "claude-sdk" })).toMatch(/MC_API_KEY/);
    const valued = { ...PROVIDER, MC_API_KEY: "secret-value-x", INFERENCE_SDK_LASTLINE_ENABLED: "true" };
    for (const why of [extractionRefusal(r, valued), extractionRefusal(a, valued)]) expect(why).toEqual(expect.not.stringContaining("secret-value-x"));
  });

  it("without --run: exit 2 before any infer call, no result written", async () => {
    expect(await run([], "none.json")).toBe(2);
    expect(await run(["--run", "--dry-run"], "none.json")).toBe(2);
    expect(await run(["--run"], "none.json", { MC_API_KEY: "placeholder" })).toBe(2);
    expect(inferMock).not.toHaveBeenCalled();
    expect(() => readFileSync(join(dir, "none.json"))).toThrow();
  });

  it("--run: one infer per consolidation night through the production consolidator; inserted and caught counted per scenario", async () => {
    inferMock.mockResolvedValueOnce(reply([VINETAS])).mockResolvedValueOnce(reply([BULLETS]));
    expect(await run(["--run", "--window", "clean"], "run.json")).toBe(0);
    expect(inferMock).toHaveBeenCalledTimes(2);
    const [req] = inferMock.mock.calls[0] as [{ messages: Array<{ role: string; content: string }>; model: string }];
    expect(req.model).toBe("claude-haiku-4-5-20251001");
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[1].content).toContain(`Fede: ${pick[0].events.find((e) => e.kind === "standing")!.asUser}`);
    const r = load("run.json");
    expect(r.meta.leg).toBe("extracted");
    expect(r.meta.classes).toEqual(["C6"]);
    expect(r.meta.extraction).toEqual({ mode: "run", calls: 2, maxModelCalls: 6, model: "claude-haiku-4-5-20251001", window: "clean" });
    expect(r.meta.notes).toContain(EXTRACTED_NOTE);
    const counts = { extracted: 1, skipped: 0, superseded: 0, dropped: 0 };
    const factOf = (s: Scenario, text: string) => {
      const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
      return { text, category: "preference", night, ttlMs: null, expiresAtT: null };
    };
    expect(r.extraction).toEqual([
      { scenarioId: "C6-01-s50", class: "C6", fillerSize: 50, calls: 1, turns: 2, cutTurns: 0, inserted: 1, consolidator: counts, caught: true, failedCalls: 0, facts: [factOf(pick[0], VINETAS.factText)] },
      { scenarioId: "C6-02-s50", class: "C6", fillerSize: 50, calls: 1, turns: 2, cutTurns: 0, inserted: 1, consolidator: counts, caught: false, failedCalls: 0, facts: [factOf(pick[1], BULLETS.factText)] },
    ]);
    // The prompt's "today" is the consolidation night's date as the last probe sees it, not the run's date.
    for (const [i, s] of pick.entries()) {
      const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
      const last = Math.max(...s.probes.map((p) => p.t));
      const [call] = inferMock.mock.calls[i] as [{ messages: Array<{ role: string; content: string }> }];
      const today = new Date(Date.now() - (last - night) * 1000).toISOString().slice(0, 10);
      expect(today).not.toBe(new Date().toISOString().slice(0, 10));
      expect(call.messages[0].content).toContain(`Today's date is ${today}.`);
    }
    expect(r.probes.map((p) => p.scenarioId)).toEqual(["C6-01-s50", "C6-01-s50", "C6-02-s50", "C6-02-s50"]);
    expect(ritualFailureMock).not.toHaveBeenCalled();
  });

  it("--run --window day, the archived day settings (60 smalltalk turns, unpadded): each night's stated turns sit among its ordinary exchanges, in timeline order, nothing labelled", async () => {
    inferMock.mockResolvedValueOnce(reply([VINETAS])).mockResolvedValueOnce(reply([BULLETS]));
    expect(await run(["--run", "--day-turns", "60", "--day-mix", "smalltalk", "--day-turn-tokens", "0"], "day.json")).toBe(0);
    expect(inferMock).toHaveBeenCalledTimes(2);
    const r = load("day.json");
    expect(r.meta.extraction).toEqual({ mode: "run", calls: 2, maxModelCalls: 6, model: "claude-haiku-4-5-20251001", window: "day" });
    for (const [i, s] of pick.entries()) {
      const standing = s.events.find((e) => e.kind === "standing")!;
      const filler = generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT });
      const ordinary = dayWindowExchanges(s, V2.fillerSpec, nextConsolidationT(standing.t), filler);
      expect(ordinary.length).toBeGreaterThanOrEqual(30);
      const stat = r.extraction![i];
      expect(stat.turns).toBe(2 + 2 * ordinary.length);
      const [req] = inferMock.mock.calls[i] as [{ messages: Array<{ role: string; content: string }> }];
      const lines = req.messages[1].content.split("\n\n---\n")[0].split("\n");
      expect(lines.length).toBe(stat.turns);
      const at = lines.indexOf(`Fede: ${standing.asUser}`);
      expect(at, s.id).toBeGreaterThan(0);
      expect(at, s.id).toBeLessThan(lines.length - 2);
      const needles = s.probes.flatMap((p) => p.expect.map((n) => n.toLowerCase()));
      const others = lines.filter((_l, k) => k !== at && k !== at + 1);
      for (const n of needles) expect(others.some((l) => l.toLowerCase().includes(n)), `${s.id}: ${n}`).toBe(false);
    }
    expect(r.extraction!.map((e) => [e.inserted, e.caught, e.failedCalls])).toEqual([
      [1, true, 0],
      [1, false, 0],
    ]);
  });

  it("--run with padding (60 smalltalk turns at 50 tokens): the stated turns reach the call byte for byte, every seeded turn is padded (audit R2 W2)", async () => {
    inferMock.mockResolvedValueOnce(reply([VINETAS])).mockResolvedValueOnce(reply([BULLETS]));
    expect(await run(["--run", "--day-turns", "60", "--day-mix", "smalltalk", "--day-turn-tokens", String(MEASURED_DAY_TURN_TOKENS)], "day-padded.json")).toBe(0);
    expect(inferMock).toHaveBeenCalledTimes(2);
    for (const [i, s] of pick.entries()) {
      const standing = s.events.find((e) => e.kind === "standing")!;
      const night = nextConsolidationT(standing.t);
      const filler = generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT });
      const plain = dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 60, mix: "smalltalk" });
      const padded = dayWindowExchanges(s, V2.fillerSpec, night, filler, { turns: 60, mix: "smalltalk", turnTokens: MEASURED_DAY_TURN_TOKENS });
      const [req] = inferMock.mock.calls[i] as [{ messages: Array<{ role: string; content: string }> }];
      const lines = req.messages[1].content.split("\n\n---\n")[0].split("\n");
      const timeline = [{ t: standing.t, user: standing.asUser, assistant: standing.asAssistant }, ...padded].sort((a, b) => a.t - b.t).flatMap((x) => [`Fede: ${x.user}`, `Jarvis: ${x.assistant}`]);
      expect(lines, s.id).toEqual(timeline);
      const at = lines.indexOf(`Fede: ${standing.asUser}`);
      expect(at, s.id).toBeGreaterThan(0);
      expect(lines[at + 1], s.id).toBe(`Jarvis: ${standing.asAssistant}`);
      for (const [k, x] of padded.slice(0, 30).entries()) {
        expect(x.user.length, s.id).toBeGreaterThan(plain[k].user.length);
        expect(lines).toContain(`Fede: ${x.user}`);
      }
    }
  });

  it("a crowded night (300 filler items) is cut as consolidateAll cuts it: the oldest CONSOLIDATOR_MAX_TURNS turns, stated ones not privileged; the rest counted in cutTurns (audit R1 W1)", async () => {
    const base = pick[0];
    const standing = base.events.find((e) => e.kind === "standing")!;
    const night = nextConsolidationT(standing.t);
    const s: Scenario = { ...base, fillerSize: 300, fillerFromT: night - 86_400, fillerToT: night - 1800 };
    const crowded = join(dir, "crowded.json");
    writeFileSync(crowded, JSON.stringify({ ...V2, scenarios: [s] } as Corpus));
    inferMock.mockResolvedValue(reply([VINETAS]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["node", "run.ts", "--leg", "extracted", "--run", "--sizes", "300", "--day-turns", "60", "--day-mix", "smalltalk", "--day-turn-tokens", "0", "--corpus", crowded, "--out", join(dir, "crowded-out.json")], PROVIDER)).toBe(0);
    log.mockRestore();
    const [req] = inferMock.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    const lines = req.messages[1].content.split("\n\n---\n")[0].split("\n");
    const ordinary = dayWindowExchanges(s, V2.fillerSpec, night, generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: 300, fromT: s.fillerFromT, toT: s.fillerToT }));
    const timeline = [{ t: standing.t, user: standing.asUser, assistant: standing.asAssistant }, ...ordinary].sort((a, b) => a.t - b.t).flatMap((x) => [`Fede: ${x.user}`, `Jarvis: ${x.assistant}`]);
    expect(timeline.length).toBe(2 + 2 * (DAY_WINDOW_EXCHANGES + 300));
    expect(lines).toEqual(timeline.slice(0, 400));
    expect(lines).toContain(`Fede: ${standing.asUser}`);
    const newest = timeline.slice(400).filter((l) => !timeline.slice(0, 400).includes(l));
    expect(newest.length).toBeGreaterThan(100);
    for (const l of newest) expect(lines).not.toContain(l);
    expect(JSON.parse(readFileSync(join(dir, "crowded-out.json"), "utf8")).extraction[0]).toMatchObject({ turns: 400, cutTurns: timeline.length - 400, failedCalls: 0 });
  });

  it("an empty model reply keeps the window: failedCalls 1, nothing inserted, the failure reported", async () => {
    inferMock.mockResolvedValue({ content: "" });
    expect(await run(["--run", "--max-model-calls", "2"], "empty.json")).toBe(0);
    const r = load("empty.json");
    expect(r.extraction!.map((e) => [e.inserted, e.failedCalls, e.caught, e.facts.length])).toEqual([
      [0, 1, false, 0],
      [0, 1, false, 0],
    ]);
    await vi.waitFor(() => expect(ritualFailureMock).toHaveBeenCalled());
  });

  it("the cap: exit 3 before the (N+1)th call, N calls made, no result; N = scenarios passes", async () => {
    inferMock.mockResolvedValue(reply([VINETAS]));
    expect(await run(["--run", "--max-model-calls", "1"], "cap.json")).toBe(3);
    expect(inferMock).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(join(dir, "cap.json"))).toThrow();
    inferMock.mockClear();
    expect(await run(["--run", "--max-model-calls", "0"], "cap0.json")).toBe(3);
    expect(inferMock).not.toHaveBeenCalled();
    expect(await run(["--run", "--max-model-calls", "2"], "cap2.json")).toBe(0);
    expect(inferMock).toHaveBeenCalledTimes(2);
    expect(load("cap2.json").meta.extraction!.calls).toBe(2);
  });

  it("--dry-run: 0 infer calls, the turns written and the calls counted (uncapped), 0 inserted, probes as raw", async () => {
    expect(await run(["--dry-run", "--max-model-calls", "1", "--window", "clean"], "dry.json", {})).toBe(0);
    expect(await run(["--dry-run", "--max-model-calls", "1"], "dry-day.json", {})).toBe(0);
    expect(inferMock).not.toHaveBeenCalled();
    const r = load("dry.json");
    expect(r.meta.extraction).toEqual({ mode: "dry-run", calls: 2, maxModelCalls: 1, model: "claude-haiku-4-5-20251001", window: "clean" });
    expect(r.extraction!.map((e) => [e.scenarioId, e.calls, e.turns, e.inserted, e.caught, e.failedCalls, e.facts, e.consolidator])).toEqual([
      ["C6-01-s50", 1, 2, 0, false, 0, [], { extracted: 0, skipped: 0, superseded: 0, dropped: 0 }],
      ["C6-02-s50", 1, 2, 0, false, 0, [], { extracted: 0, skipped: 0, superseded: 0, dropped: 0 }],
    ]);
    // The default day (MEASURED_DAY_TURNS mixed, padded to MEASURED_DAY_TURN_TOKENS) is past the consolidator's cap: every night's call sees its oldest 400 turns, the rest is counted, and the run is labelled.
    const day = load("dry-day.json");
    expect(day.meta.extraction).toMatchObject({ mode: "dry-run", calls: 2, window: "day", day: { turns: MEASURED_DAY_TURNS, mix: "mixed", turnTokens: MEASURED_DAY_TURN_TOKENS } });
    for (const [i, s] of pick.entries()) {
      const e = day.extraction![i];
      const night = nextConsolidationT(s.events.find((x) => x.kind === "standing")!.t);
      const own = generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT }).filter((f) => nextConsolidationT(f.t) === night).length;
      expect(e.turns, s.id).toBe(CONSOLIDATOR_TURN_CAP);
      expect(e.cutTurns, s.id).toBe(2 + MEASURED_DAY_TURNS + 2 * own - CONSOLIDATOR_TURN_CAP);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["node", "run.ts", "--leg", "raw", "--sizes", "50", "--classes", "C6", "--corpus", corpusPath, "--out", join(dir, "raw.json")], {})).toBe(0);
    log.mockRestore();
    const raw = load("raw.json");
    expect(raw.meta.extraction).toBeUndefined();
    expect(raw.extraction).toBeUndefined();
    const fp = (x: RunResult) => x.probes.map((p) => [p.scenarioId, p.proactive.hit, p.proactive.staleHit, p.proactive.chars]);
    expect(fp(r)).toEqual(fp(raw));
    expect(fp(day)).toEqual(fp(raw));
  });

  it("--day-turns 120 --day-mix mixed (dry run): the night holds 120 seeded turns drawn with the other scenario's standing fact; meta and report name the settings", async () => {
    expect(await run(["--dry-run", "--day-turns", "120", "--day-mix", "mixed"], "dry-mixed.json", {})).toBe(0);
    expect(inferMock).not.toHaveBeenCalled();
    const r = load("dry-mixed.json");
    expect(r.meta.extraction).toEqual({ mode: "dry-run", calls: 2, maxModelCalls: 6, model: "claude-haiku-4-5-20251001", window: "day", day: { turns: 120, mix: "mixed", turnTokens: MEASURED_DAY_TURN_TOKENS } });
    for (const [i, s] of pick.entries()) {
      const night = nextConsolidationT(s.events.find((e) => e.kind === "standing")!.t);
      const own = generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: s.fillerSize, fromT: s.fillerFromT, toT: s.fillerToT }).filter((f) => nextConsolidationT(f.t) === night).length;
      expect(r.extraction![i].turns, s.id).toBe(2 + 120 + 2 * own);
    }
    expect(renderBaseline([r])).toContain(`window ${windowLabel("day")}, day 120 seeded turns mixed padded to 50 tokens: 2 model calls counted, none made`);
    expect(await run(["--dry-run", "--day-turns", "120", "--day-mix", "smalltalk", "--day-turn-tokens", "0"], "dry-120.json", {})).toBe(0);
    expect(load("dry-120.json").meta.extraction!.day).toEqual({ turns: 120, mix: "smalltalk" });
    expect(await run(["--dry-run", "--day-turns", "60", "--day-mix", "smalltalk"], "dry-60-padded.json", {})).toBe(0);
    expect(load("dry-60-padded.json").meta.extraction!.day).toEqual({ turns: 60, mix: "smalltalk", turnTokens: MEASURED_DAY_TURN_TOKENS });
    expect(await run(["--dry-run", "--day-turns", "60", "--day-mix", "smalltalk", "--day-turn-tokens", "0"], "dry-archived.json", {})).toBe(0);
    expect(load("dry-archived.json").meta.extraction!.day).toBeUndefined();
  });

  it("--run: corpus v2's expectEn list lets the English fact catch a Spanish-needle probe; the same probes without it are not caught (queue 4bo i, ruling B)", async () => {
    for (const p of pick[0].probes) expect(p.expectEn).toEqual(["bullet"]);
    for (const p of pick[1].probes) expect(p.expectEn).toEqual(p.expect);
    inferMock.mockResolvedValue(reply([BULLETS]));
    expect(await run(["--run", "--window", "clean", "--max-model-calls", "2"], "en.json")).toBe(0);
    expect(load("en.json").extraction!.map((e) => [e.scenarioId, e.caught])).toEqual([
      ["C6-01-s50", true],
      ["C6-02-s50", false],
    ]);
    const noEn = join(dir, "corpus-no-en.json");
    writeFileSync(noEn, JSON.stringify({ ...V2, scenarios: pick.map((s) => ({ ...s, probes: s.probes.map(({ expectEn: _en, ...p }) => p) })) } as Corpus));
    const silent = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    try {
      expect(await main(["node", "run.ts", "--leg", "extracted", "--run", "--window", "clean", "--max-model-calls", "2", "--corpus", noEn, "--out", join(dir, "no-en.json")], PROVIDER)).toBe(0);
    } finally {
      for (const x of silent) x.mockRestore();
    }
    expect(load("no-en.json").extraction!.map((e) => [e.scenarioId, e.caught])).toEqual([
      ["C6-01-s50", false],
      ["C6-02-s50", false],
    ]);
  });

  it("renders the extraction table (PROVISIONAL) and the ideal / extracted gap; main --compare picks it", async () => {
    // C6-02's fact repeats its second probe's words, so the words-only JME recall returns it.
    const askedText = pick[1].probes[1].text;
    inferMock.mockResolvedValueOnce(reply([VINETAS])).mockResolvedValueOnce(reply([{ ...BULLETS, factText: `Fede asked: ${askedText}` }]));
    expect(await run(["--run", "--window", "clean"], "run2.json")).toBe(0);
    const extracted = load("run2.json");
    const md = renderBaseline([extracted]);
    expect(md).toContain(`### Extraction (${PROVISIONAL})\n\n${EXTRACTION_LIMITS}\n`);
    expect(EXTRACTION_LIMITS).toMatch(/English.*Spanish.*`facts`/s);
    expect(EXTRACTION_LIMITS).toMatch(/Embeddings off: no cosine supersede.*C2.*harness/s);
    expect(EXTRACTION_LIMITS).toMatch(/`clean` = .*upper bound.*`day` = .*not the operator's real day/s);
    expect(md).toContain("| C6 | 50 | 2 | 2 | 4 | 2 | 1 / 2 | 0 |");
    expect(md).toContain(
      "Mode run, model claude-haiku-4-5-20251001, window clean (upper bound: the stated turns alone): 2 model calls made, cap 6. Cost estimate: 2 calls, window clean: about $0.0030 typical, $0.013 ceiling, up to 2x billed requests (Haiku + its retry) so $0.025 worst case.",
    );
    const ideal: RunResult = {
      ...extracted,
      meta: { ...extracted.meta, leg: "ideal", extraction: undefined },
      extraction: undefined,
      aggregates: extracted.aggregates.map((a) => ({ ...a, hitPct: 100, staleHitPct: 0 })),
    };
    const cmp = renderExtractionCompare([[ideal, extracted]]);
    const a = extracted.aggregates[0];
    expect(cmp).toContain(`# Port 4 — real extraction of stated facts: ideal / extracted (${PROVISIONAL})`);
    expect(cmp.split(EXTRACTION_LIMITS).length).toBe(2);
    expect(md).toContain("| caught (lexical, live at probe) / total |");
    expect(cmp).toContain("| surfaced n/N (extracted: jme or jme_query > 0) |");
    // surfaced, recomputed from the probe components: proactive reads the `jme` layer, asked the `jme_query` one.
    for (const agg of extracted.aggregates) {
      const ps = extracted.probes.filter((p) => p.class === agg.class && p.fillerSize === agg.fillerSize && p[agg.surface].scored);
      const n = ps.filter((p) => p.components[agg.surface].some((k) => (k.startsWith("jme:") || k.startsWith("jme_query:")) && !k.endsWith(":0"))).length;
      const line = cmp.split("\n").find((l) => l.startsWith(`| ${agg.class} | ${agg.fillerSize} | ${agg.surface} | ${agg.n} | `));
      expect(line?.endsWith(` | ${n}/${ps.length} |`), `${agg.surface}: ${line}`).toBe(true);
    }
    const jmeCells = extracted.probes.flatMap((p) => [...p.components.proactive, ...p.components.asked]).filter((k) => /^jme(_query)?:/.test(k));
    expect(jmeCells.some((k) => !k.endsWith(":0")), JSON.stringify(jmeCells)).toBe(true);
    expect(cmp.indexOf(EXTRACTION_LIMITS)).toBeLessThan(cmp.indexOf("| class | size | surface"));
    expect(cmp).toContain("window clean about $0.0015 typical / $0.0063 ceiling, window day $0.0030 / $0.0076; one call can make up to 2x billed requests");
    expect(cmp).toContain("run, window clean (upper bound: the stated turns alone), 2 model calls");
    expect(cmp).toContain(`| C6 | 50 | ${a.surface} | ${a.n} | 100 → ${a.hitPct} | ${Math.round(10 * (a.hitPct! - 100)) / 10} | 0 → ${a.staleHitPct} |`);
    expect(() => renderExtractionCompare([[extracted, ideal]])).toThrow(/ideal,extracted/);
    writeFileSync(join(dir, "ideal.json"), JSON.stringify(ideal));
    const out = join(dir, "cmp.md");
    expect(await main(["node", "run.ts", "--compare", `${join(dir, "ideal.json")},${join(dir, "run2.json")}`, "--md", out], {})).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# Port 4 — real extraction");
  });
});
