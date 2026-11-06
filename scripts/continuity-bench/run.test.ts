import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  type EmbedPlan,
  type RunResult,
} from "./run.js";
import { exchangeContent } from "./adapter-jarvis.js";
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
