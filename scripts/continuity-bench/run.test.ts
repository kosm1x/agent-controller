import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FILLER_SPEC_V1 } from "./filler.js";
import {
  BASELINE_CAVEATS,
  FetchMeter,
  capsOf,
  embedBudgetRefusal,
  embedPlan,
  main,
  parseArgs,
  refuseReason,
  renderBaseline,
  renderCompare,
  renderRecallFloorCompare,
  switchSuffix,
  type EmbedPlan,
  type RunResult,
} from "./run.js";
import { DEFAULT_SWITCHES, exchangeContent } from "./adapter-jarvis.js";
import { buildCorpusV2 } from "./corpus-v2.js";
import type { Corpus, ProbeRun, Scenario } from "./types.js";

// main() is gated to an operator context; the gate itself has its own lock test.
vi.mock("../../src/lib/operator-gate.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/operator-gate.js")>()),
  requireOperatorContext: () => {},
}));

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
    expect(off.meta.switches).toEqual({ MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "off" });
    expect(on.meta.switches).toEqual({ MEMORY_OPEN_WORK: "on", MEMORY_RECALL_FLOOR: "off" });
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
    expect(on.meta.switches).toEqual({ MEMORY_OPEN_WORK: "off", MEMORY_RECALL_FLOOR: "on" });
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
