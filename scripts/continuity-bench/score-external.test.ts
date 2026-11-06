import { describe, expect, it } from "vitest";
import type { AuthorMarkerSpec } from "./score.js";
import { assertSurfaces, commonSizes, renderComparison, renderReport, scoreExternal, SYSTEM_NOTES, type Comparable, type ExternalSurfaces } from "./score-external.js";
import type { Corpus, Probe, ProbeRun } from "./types.js";

function run(probe: Partial<Probe>, proactiveText: string, askedItems: string[]): ProbeRun {
  return {
    scenarioId: "C2-01-s50",
    class: "C2",
    fillerSize: 50,
    probeIndex: 0,
    probe: { day: 10, t: 864000, session: "d10", text: "budget?", expect: ["2.960.400"], forbid: ["3.847.215"], surface: "both", ...probe },
    proactive: {
      measurable: true,
      components: [{ name: "session_start", queryDriven: false, text: proactiveText, items: [proactiveText] }],
      ms: 40,
    },
    asked: {
      measurable: true,
      components: [{ name: "recall", queryDriven: true, kind: "recall", cap: 10, text: askedItems.join("\n"), items: askedItems }],
      ms: 9,
    },
    ingestedRows: 2,
    ingestMs: 1000,
  };
}

const doc = (): ExternalSurfaces => ({
  meta: { system: "ext", commit: "abc1234", leg: "ideal-full", embeddings: "off", corpusVersion: "continuity-v2", durationMs: 1500 },
  runs: [run({}, "nothing", ["- [words: budget] it is 2.960.400", "- [words: budget] it was 3.847.215"])],
});

describe("scoreExternal", () => {
  it("scores external surfaces with score.ts: hit, stale hit, items", () => {
    const r = scoreExternal(doc());
    expect(r.probes[0].proactive).toMatchObject({ scored: true, hit: false, staleHit: false, recallItems: 0 });
    expect(r.probes[0].asked).toMatchObject({ scored: true, hit: true, staleHit: true, recallItems: 2 });
    expect(r.probes[0].components.asked).toEqual(["recall:2"]);
    expect(r.aggregates.find((a) => a.surface === "asked")).toMatchObject({ class: "C2", hitPct: 100, staleHitPct: 100, n: 1 });
    expect(r.ingest[0]).toMatchObject({ fillerSize: 50, probes: 1, rows: 2, ms: 1000, rowsPerSec: 2 });
    expect(r.surfaces).toHaveLength(1);
    expect(r.meta.system).toBe("ext");
  });

  it("an unmeasurable surface is not scored", () => {
    const d = doc();
    d.runs[0].asked.measurable = false;
    expect(scoreExternal(d).probes[0].asked.scored).toBe(false);
  });
});

describe("assertSurfaces", () => {
  it("accepts the documented shape", () => {
    expect(() => assertSurfaces(doc())).not.toThrow();
  });
  it.each([
    ["no runs", { meta: {} }],
    ["surface without ms", { meta: {}, runs: [{ ...run({}, "x", []), asked: { measurable: true, components: [] } }] }],
    ["component without items", { meta: {}, runs: [{ ...run({}, "x", []), proactive: { measurable: true, ms: 1, components: [{ name: "a", queryDriven: false, text: "" }] } }] }],
    ["probe without forbid", { meta: {}, runs: [{ ...run({}, "x", []), probe: { expect: [] } }] }],
  ])("rejects %s", (_n, bad) => {
    expect(() => assertSurfaces(bad)).toThrow();
  });
});

const MARKERS: AuthorMarkerSpec = {
  lineLabels: { person: [], assistant: [] },
  itemPatterns: { person: ["; in the person's words$"] },
  defaultRole: "assistant",
};

function c5(authorCase: "person" | "assistant", item: string): ProbeRun {
  const r = run({ expect: ["11.75%"], forbid: [], expectAuthor: authorCase, authorCase, statedBy: [authorCase], wording: "shared" }, "", [item]);
  return { ...r, scenarioId: `C5-0${authorCase === "person" ? 1 : 2}-s50`, class: "C5" };
}

describe("scoreExternal v2", () => {
  it("applies the adapter's marker spec: strict marks only, defaultRole in its own field", () => {
    const d = doc();
    d.runs = [c5("person", "- rate 11.75%\n  id=e1; in the person's words"), c5("assistant", "- rate 11.75%\n  id=e2")];
    const r = scoreExternal(d, MARKERS);
    expect(r.probes[0].asked).toMatchObject({ authorMarked: true, authorMarkedWithDefault: true });
    expect(r.probes[1].asked).toMatchObject({ authorMarked: false, authorMarkedWithDefault: true });
    const asked = r.authorAggregates.filter((a) => a.surface === "asked");
    expect(asked.map((a) => [a.authorCase, a.authorMarkedPct, a.authorMarkedWithDefaultPct])).toEqual([
      ["person", 100, 100],
      ["assistant", 0, 100],
    ]);
    expect(r.meta.markers).toBe(MARKERS);
    expect(r.caps.asked).toEqual({ recall: 10 });
  });

  it("withScenarioMeta fills gap K and variant from the corpus for the gap aggregates", () => {
    const d = doc();
    d.runs = [{ ...run({ expect: ["anexo"], forbid: [], surface: "proactive" }, "anexo", []), scenarioId: "C3-01-h5-s50", class: "C3" }];
    const corpus = { scenarios: [{ id: "C3-01-h5-s50", gapRows: 5, variant: "hydrate" }] } as unknown as Corpus;
    expect(scoreExternal(d, MARKERS, corpus).gapAggregates[0]).toMatchObject({ class: "C3", variant: "hydrate", gapRows: 5, hitPct: 100 });
  });
});

describe("renderComparison", () => {
  const leg = (system: string, legName: string, sizes: number[], hit: boolean): Comparable => {
    const d = doc();
    d.meta = { ...d.meta, system, leg: legName };
    d.runs = sizes.map((fillerSize) => ({ ...run({ wording: "shared" }, "", [hit ? "2.960.400" : "x"]), fillerSize }));
    return scoreExternal(d);
  };

  it("compares only the sizes every leg has, one column per leg, notes and no verdict", () => {
    const a = leg("jarvis", "raw", [50, 500], true);
    const b = leg("mnemos", "ideal-full", [50], false);
    expect(commonSizes([a, b])).toEqual([50]);
    const md = renderComparison([a, b]);
    expect(md).toContain("| class | size | surface | n | jarvis raw | mnemos ideal-full |");
    expect(md).toContain("| C2 correction-wins | 50 | asked | 1 | 100 | 0 |");
    expect(md).not.toContain("| 500 |");
    expect(md).toContain("Latency is NOT comparable");
    expect(md).toContain("Keyword search only on both sides");
    for (const note of SYSTEM_NOTES.mnemos) expect(md).toContain(`- ${note}`);
    expect(md).toContain("- Not measured for mnemos: filler sizes 500 and 5000, and embeddings");
    expect(md).not.toContain("Not measured for jarvis");
    expect(md).not.toMatch(/\b(better|worse|verdict|winner)\b/i);
  });
});

describe("renderReport", () => {
  it("renders the v2 baseline layout: title, leg header, sections, ingest table", () => {
    const md = renderReport("ext 1.0", [scoreExternal(doc())]);
    expect(md).toContain("# Continuity Scorecard — ext 1.0 baseline (continuity-v2)");
    expect(md).toContain("## leg `ideal-full` · embeddings off · commit abc1234 · corpus continuity-v2");
    expect(md).toContain("### Recall classes (C1, C2, C5, C6, C8)");
    expect(md).toContain("### C3 / C4 by gap K (pooled over filler sizes)");
    expect(md).toContain("| author case | size | surface | n | hit % | author-marked % (strict) | author-marked % (with default role) | author-marked % (any occurrence) | attribution conflict % |");
    expect(md).toContain("| C2 correction-wins | 50 | asked | 1 | 100 | – (0) | – (0) | 100 | 0 / 100 / 0 |");
    expect(md).toContain("| 50 | 1 | 2 | 1000 | 2 | 40.0 | 9.0 |");
    expect(md).not.toContain("Notes:");
  });

  it("adds the system's notes and what was not measured for it", () => {
    const d = doc();
    d.meta = { ...d.meta, system: "mnemos" };
    const md = renderReport("mnemos", [scoreExternal(d)]);
    expect(md).toContain("Notes:");
    for (const note of SYSTEM_NOTES.mnemos) expect(md).toContain(`- ${note}`);
    expect(md).toContain("- Not measured for mnemos: filler sizes 500 and 5000, and embeddings");
    expect(md).toContain("LIVE_HANDOFF_HOURS");
    expect(md).toContain("the corpus has no such case");
    expect(md).not.toMatch(/\b(better|worse|verdict|winner)\b/i);
  });
});
