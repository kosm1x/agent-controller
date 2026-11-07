import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FILLER_SPEC_V1, generateFiller } from "./filler.js";
import {
  BASELINE_CAVEATS,
  EXTRACTED_NOTE,
  EXTRACTION_LIMITS,
  FetchMeter,
  PROVISIONAL,
  capsOf,
  embedBudgetRefusal,
  embedPlan,
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
import { DEFAULT_SWITCHES, dayWindowExchanges, exchangeContent, nextConsolidationT } from "./adapter-jarvis.js";
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
    for (const leg of ["raw", "ideal"]) {
      const r = parseArgs(["node", "run.ts", "--leg", leg]);
      expect(r.mode === "run" && r.corpus.endsWith("benchmarks/continuity/corpus-v1.json"), leg).toBe(true);
    }
    const base = { commit: "abc1234", embeddings: "off", suffix: "-v2", switchTag: "", dryRun: false };
    expect(resultFileName({ ...base, leg: "extracted", classes: ["C6"], window: "day" })).toBe("jarvis-abc1234-extracted-emb-off-v2-c6-day.json");
    expect(resultFileName({ ...base, leg: "extracted", classes: ["C2", "C8"], window: "clean", dryRun: true })).toBe("jarvis-abc1234-extracted-emb-off-v2-c2c8-clean-dry-run.json");
    expect(resultFileName({ ...base, leg: "raw", classes: null, window: "day" })).toBe("jarvis-abc1234-raw-emb-off-v2.json");
    expect(resultFileName({ ...base, leg: "ideal", classes: ["C6"], window: "day", switchTag: "-tombstones" })).toBe("jarvis-abc1234-ideal-emb-off-v2-tombstones.json");
    expect(windowLabel("clean")).toMatch(/upper bound/);
    expect(windowLabel("day")).toMatch(/seeded ordinary exchanges/);
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
    expect(r.extraction).toEqual([
      { scenarioId: "C6-01-s50", class: "C6", fillerSize: 50, calls: 1, turns: 2, inserted: 1, caught: true, failedCalls: 0, facts: [VINETAS.factText] },
      { scenarioId: "C6-02-s50", class: "C6", fillerSize: 50, calls: 1, turns: 2, inserted: 1, caught: false, failedCalls: 0, facts: [BULLETS.factText] },
    ]);
    expect(r.probes.map((p) => p.scenarioId)).toEqual(["C6-01-s50", "C6-01-s50", "C6-02-s50", "C6-02-s50"]);
    expect(ritualFailureMock).not.toHaveBeenCalled();
  });

  it("--run --window day (the default): each night's stated turns sit among its ordinary exchanges, in timeline order", async () => {
    inferMock.mockResolvedValueOnce(reply([VINETAS])).mockResolvedValueOnce(reply([BULLETS]));
    expect(await run(["--run"], "day.json")).toBe(0);
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

  it("a crowded night (300 filler items) is cut to CONSOLIDATOR_MAX_TURNS: the stated turns kept, the oldest ordinary ones dropped", async () => {
    const base = pick[0];
    const standing = base.events.find((e) => e.kind === "standing")!;
    const night = nextConsolidationT(standing.t);
    const s: Scenario = { ...base, fillerSize: 300, fillerFromT: night - 86_400, fillerToT: night - 1800 };
    const crowded = join(dir, "crowded.json");
    writeFileSync(crowded, JSON.stringify({ ...V2, scenarios: [s] } as Corpus));
    inferMock.mockResolvedValue(reply([VINETAS]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["node", "run.ts", "--leg", "extracted", "--run", "--sizes", "300", "--corpus", crowded, "--out", join(dir, "crowded-out.json")], PROVIDER)).toBe(0);
    log.mockRestore();
    const [req] = inferMock.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    const lines = req.messages[1].content.split("\n\n---\n")[0].split("\n");
    expect(lines.length).toBe(400);
    expect(lines).toContain(`Fede: ${standing.asUser}`);
    const ordinary = dayWindowExchanges(s, V2.fillerSpec, night, generateFiller(V2.fillerSpec, { seed: s.fillerSeed, size: 300, fromT: s.fillerFromT, toT: s.fillerToT })).sort((a, b) => a.t - b.t);
    expect(lines.filter((l) => l.startsWith("Fede: ")).length).toBe(1 + 199);
    expect(lines).toContain(`Fede: ${ordinary.at(-1)!.user}`);
    const kept = new Set(ordinary.slice(-199).map((o) => o.user));
    for (const o of ordinary.slice(0, -199)) if (!kept.has(o.user)) expect(lines).not.toContain(`Fede: ${o.user}`);
    expect(JSON.parse(readFileSync(join(dir, "crowded-out.json"), "utf8")).extraction[0]).toMatchObject({ turns: 400, failedCalls: 0 });
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
    expect(r.extraction!.map((e) => [e.scenarioId, e.calls, e.turns, e.inserted, e.caught, e.failedCalls, e.facts])).toEqual([
      ["C6-01-s50", 1, 2, 0, false, 0, []],
      ["C6-02-s50", 1, 2, 0, false, 0, []],
    ]);
    const day = load("dry-day.json");
    expect(day.meta.extraction).toMatchObject({ mode: "dry-run", calls: 2, window: "day" });
    for (const e of day.extraction!) expect(e.turns, e.scenarioId).toBeGreaterThan(60);
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

  it("renders the extraction table (PROVISIONAL) and the ideal / extracted gap; main --compare picks it", async () => {
    inferMock.mockResolvedValueOnce(reply([VINETAS])).mockResolvedValueOnce(reply([BULLETS]));
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
