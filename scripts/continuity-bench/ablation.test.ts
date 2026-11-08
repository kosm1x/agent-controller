import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ablate, assertExact, FOOTER, GROUPS, renderAblation, type AblationInput, type AblationReport, type Row } from "./ablation.js";
import type { SurfaceScore } from "./types.js";

const CTX = "enrichment:Contexto relevante del usuario";

function surf(o: Partial<SurfaceScore> = {}): SurfaceScore {
  return { scored: true, hit: false, staleHit: false, chars: 0, ms: 0, recallItems: 0, irrelevantCount: null, authorMarked: null, carriedBy: [], staleCarriedBy: [], ...o };
}

type P = AblationInput["probes"][number];
function probe(id: string, cls: P["class"], s: { proactive?: Partial<SurfaceScore>; asked?: Partial<SurfaceScore> }, components: Partial<P["components"]> = {}, extra: Partial<P> = {}): P {
  return {
    scenarioId: id,
    class: cls,
    fillerSize: 50,
    probeIndex: 0,
    day: 1,
    proactive: surf({ scored: !!s.proactive, ...s.proactive }),
    asked: surf({ scored: !!s.asked, ...s.asked }),
    components: { proactive: [], asked: [], ...components },
    ...extra,
  };
}

const run = (probes: P[], caps?: AblationInput["caps"]): AblationInput => ({ meta: { commit: "abc1234", leg: "raw", switches: { MEMORY_TOMBSTONES: "off" } }, probes, ...(caps ? { caps } : {}) });
const row = (r: AblationReport, group: string, cls: string, surface: Row["surface"], size: Row["size"] = "all"): Row | undefined =>
  r.groups.find((g) => g.group === group)?.rows.find((x) => x.cls === cls && x.surface === surface && x.size === size);

describe("ablate", () => {
  it("(1) a hit carried solely by memory_search is lost under conv-recall and conversations*, kept under jme", () => {
    const r = ablate(run([probe("C1-01-s50", "C1", { asked: { hit: true, carriedBy: ["memory_search"] } })]));
    expect(row(r, "conv-recall", "C1", "asked")).toMatchObject({ n: 1, hits: 1, lost: 1 });
    expect(row(r, "conversations*", "C1", "asked")?.lost).toBe(1);
    expect(row(r, "jme", "C1", "asked")).toMatchObject({ hits: 1, lost: 0 });
    expect(row(r, "conv-recall", "C1", "asked", 50)?.lost).toBe(1);
  });

  it("(2) a hit co-carried by thread and enrichment survives each single ablation, lost under conversations*", () => {
    const r = ablate(run([probe("C3-01-s50", "C3", { proactive: { hit: true, carriedBy: ["thread", CTX] } })]));
    expect(row(r, "thread", "C3", "proactive")?.lost).toBe(0);
    expect(row(r, "conv-recall", "C3", "proactive")?.lost).toBe(0);
    expect(row(r, "conversations*", "C3", "proactive")?.lost).toBe(1);
  });

  it("(3) stale carried by jme_query is cleared under jme only", () => {
    const r = ablate(run([probe("C2-01-s50", "C2", { asked: { staleHit: true, staleCarriedBy: ["jme_query"] } })]));
    for (const g of Object.keys(GROUPS)) expect(row(r, g, "C2", "asked")).toMatchObject({ stale: 1, cleared: g === "jme" ? 1 : 0 });
  });

  it("(4) C7 items sum per group and the disjoint shares add to 100 %", () => {
    const r = ablate(
      run([
        probe("C7-01-s50", "C7", { proactive: { irrelevantCount: 4 }, asked: { irrelevantCount: 3 } }, {
          proactive: ["thread:30", "essentials:8", `${CTX}:3`, "jme:1"],
          asked: ["memory_search:2", "jme_query:1"],
        }),
      ]),
    );
    expect(r.noise).toMatchObject({ probes: 2, proactive: 4, asked: 3 });
    const by = Object.fromEntries(r.noise.rows.map((n) => [n.group, n]));
    expect(by["conv-recall"]).toMatchObject({ proactive: 3, asked: 2 });
    expect(by.jme).toMatchObject({ proactive: 1, asked: 1 });
    expect(by.thread).toMatchObject({ proactive: 0, asked: 0 }); // ambient blocks are not C7 noise
    const disjoint = r.noise.rows.filter((n) => n.group !== "conversations*").reduce((a, n) => a + n.share, 0);
    expect(disjoint).toBeCloseTo(1, 10);
    expect(r.notAttributable.c7).toEqual([]);
  });

  it("(5) an ungrouped component name surfaces in the report", () => {
    const r = ablate(
      run([probe("C1-02-s50", "C1", { proactive: { hit: true, carriedBy: ["enrichment:Aprendizajes previos"] } }, { proactive: ["enrichment:Aprendizajes previos:1", "thread:3"] })]),
    );
    expect(r.ungrouped).toEqual(["enrichment:Aprendizajes previos"]);
    expect(row(r, "conversations*", "C1", "proactive")?.lost).toBe(0);
    expect(renderAblation([r])).toContain("- `enrichment:Aprendizajes previos`");
  });

  it("(6) a split hit (hit, empty carriedBy) is flagged by default and refused under strict", () => {
    const r = ablate(run([probe("C4-07-s500", "C4", { proactive: { hit: true, carriedBy: [] } })]), GROUPS, "x.json");
    expect(r.notAttributable.split).toEqual(["C4-07-s500#0/proactive"]);
    expect(row(r, "conversations*", "C4", "proactive")).toMatchObject({ hits: 1, lost: 0 });
    const md = renderAblation([r]);
    expect(md).toContain("split hit (no single carrier): 1");
    expect(md).toContain("- C4: C4-07-s500#0/proactive");
    expect(() => assertExact([r])).toThrow(/C4-07-s500#0\/proactive/);
    const dropped = ablate(run([probe("C1-03-s50", "C1", { asked: { hit: true, carriedBy: ["memory_search"] } }, {}, { dropped: ["profile"] })]));
    expect(dropped.notAttributable.dropped).toEqual(["C1-03-s50#0"]);
    expect(() => assertExact([dropped])).toThrow(/C1-03-s50#0/);
  });

  it("(7) renderAblation has the source header, pooled rows first and the footer rule", () => {
    const r = ablate(
      run([
        probe("C1-01-s50", "C1", { asked: { hit: true, carriedBy: ["memory_search"] } }),
        { ...probe("C1-01-s500", "C1", { asked: { hit: false } }), fillerSize: 500 },
      ]),
      GROUPS,
      "r.json",
    );
    const md = renderAblation([r], { bySize: true });
    expect(md).toContain("| r.json | abc1234 | raw | MEMORY_TOMBSTONES=off |");
    const pooled = md.indexOf("| C1 | asked | all | 1/2 | 1 | 0 | 0 |");
    expect(pooled).toBeGreaterThan(-1);
    expect(md.indexOf("| C1 | asked | 50 | 1/1 | 1 | 0 | 0 |")).toBeGreaterThan(pooled);
    expect(md).toContain(FOOTER);
    expect(FOOTER).toContain("lost without G iff every component that carried it");
    expect(FOOTER).toContain("not measured by this corpus");
    expect(assertExact([r])).toBeUndefined();
  });

  it("(8) without bySize: pooled rows only, and groups that move nothing are named in the no-effect line", () => {
    const r = ablate(
      run([
        probe("C1-01-s50", "C1", { asked: { hit: true, carriedBy: ["memory_search"] } }),
        { ...probe("C1-01-s500", "C1", { asked: { hit: false } }), fillerSize: 500 },
      ]),
    );
    expect(r.groups.find((g) => g.group === "conv-recall")?.rows.some((x) => x.size === 50)).toBe(true); // the JSON keeps them
    const md = renderAblation([r]);
    expect(md).toContain("| C1 | asked | all | 1/2 | 1 | 0 | 0 |");
    expect(md).not.toMatch(/^\| C\d \| \w+ \| \d+ \|/m);
    expect(md).toContain("Groups with no effect in this file (0 lost, 0 cleared, 0 C7 items): `thread`, `essentials`, `jme`, `user_facts`, `open_work`.");
    expect(md).toContain("### Without conv-recall");
    expect(md).not.toContain("### Without essentials");
    expect(md).not.toContain("| essentials | 0 | 0 |");
  });
});

describe("ablate: audit R1 folds", () => {
  it("(W1) a group whose only effect is in a non-first row is still tabled", () => {
    const r = ablate(
      run([
        probe("C1-01-s50", "C1", { asked: { hit: true, carriedBy: ["memory_search"] } }),
        probe("C6-01-s50", "C6", { proactive: { hit: true, carriedBy: ["profile"] } }),
      ]),
    );
    expect(r.groups.find((g) => g.group === "user_facts")?.rows.filter((x) => x.size === "all").map((x) => [x.cls, x.lost])).toEqual([["C1", 0], ["C6", 1]]);
    const md = renderAblation([r]);
    expect(md).toContain("### Without user_facts");
    expect(md).not.toMatch(/no effect[^\n]*`user_facts`/);
  });

  it("(W2) a C7 probe (nothing expected, hit) never enters the hit/stale tables and is not a split hit", () => {
    const r = ablate(run([probe("C7-01-s50", "C7", { asked: { irrelevantCount: 0, hit: true, carriedBy: [] } }, { asked: ["memory_search:0", "jme_query:0"] })]));
    expect(r.groups.flatMap((g) => g.rows).filter((x) => x.cls === "C7")).toEqual([]);
    expect(r.notAttributable).toEqual({ split: [], dropped: [], c7: [] });
    expect(r.noise.probes).toBe(1);
  });

  it("(W3) a C7 count mismatch is flagged and refused by assertExact", () => {
    const r = ablate(run([probe("C7-02-s50", "C7", { proactive: { irrelevantCount: 5 } }, { proactive: ["thread:30", `${CTX}:4`] })]));
    expect(r.notAttributable.c7).toEqual(["C7-02-s50#0/proactive"]);
    expect(() => assertExact([r])).toThrow(/C7-02-s50#0\/proactive/);
  });

  it("(W4) conversations* is exactly thread ∪ conv-recall ∪ essentials ∪ open_work", () => {
    expect(new Set(GROUPS["conversations*"])).toEqual(new Set([...GROUPS.thread, ...GROUPS["conv-recall"], ...GROUPS.essentials, ...GROUPS.open_work]));
    expect(GROUPS["conversations*"]).toHaveLength(new Set(GROUPS["conversations*"]).size);
  });

  it("(W5) C7 sums the query-driven population the result's caps records (per-surface and flat shapes)", () => {
    const probes = [probe("C7-03-s50", "C7", { proactive: { irrelevantCount: 1 }, asked: { irrelevantCount: 2 } }, { proactive: ["session_start:6", "cue:1"], asked: ["recall:2"] })];
    const ext = ablate(run(probes, { proactive: { cue: 3 }, asked: { recall: 10 } }));
    expect(ext.notAttributable.c7).toEqual([]);
    expect(ext.noise).toMatchObject({ proactive: 1, asked: 2 });
    expect(ext.noise.rows.filter((n) => n.group.startsWith("ungrouped:")).map((n) => [n.group, n.proactive, n.asked])).toEqual([["ungrouped: cue", 1, 0], ["ungrouped: recall", 0, 2]]);
    expect(ablate(run(probes)).notAttributable.c7).toEqual(["C7-03-s50#0/proactive", "C7-03-s50#0/asked"]); // the Jarvis fallback list does not know them
    const flat = ablate(run([probe("C7-04-s50", "C7", { asked: { irrelevantCount: 2 } }, { asked: ["memory_search:2", "jme_query:0"] })], { memory_search: 5, jme_query: 8 }));
    expect(flat.notAttributable.c7).toEqual([]);
    expect(flat.noise.rows.find((n) => n.group === "conv-recall")?.asked).toBe(2);
  });

  it("(R3) a C7 noise table with no rows left prints none", () => {
    const md = renderAblation([ablate(run([probe("C1-01-s50", "C1", { asked: { hit: false } })]))]);
    expect(md).toContain("asked items)\n\nnone\n");
    expect(md).not.toContain("| group | items (proactive) |");
  });
});

describe("local result smoke (results/*.json are gitignored; skipped when absent)", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../../benchmarks/continuity/results/jarvis-acee7f13-raw-emb-off-v2.json");
  it.skipIf(!existsSync(file))("raw acee7f13: C1 asked pooled hits 134, all lost without conv-recall", () => {
    const r = ablate(JSON.parse(readFileSync(file, "utf8")) as AblationInput);
    expect(row(r, "conv-recall", "C1", "asked")).toMatchObject({ n: 288, hits: 134, lost: 134 });
    expect(r.notAttributable).toEqual({ split: [], dropped: [], c7: [] });
  });
});
