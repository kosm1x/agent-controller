import { describe, expect, it } from "vitest";
import {
  aggregate,
  aggregateAuthor,
  aggregateByGap,
  attribute,
  authorAt,
  authorMarked,
  fold,
  median,
  scoreProbe,
  scoreProbeWith,
  scoreSurface,
  withScenarioMeta,
  type AuthorMarkerSpec,
} from "./score.js";
import type { Corpus, Probe, ProbeRun, SurfaceComponent } from "./types.js";

const comp = (name: string, items: string[], queryDriven = true): SurfaceComponent => ({
  name,
  queryDriven,
  text: items.join("\n"),
  items,
});

function run(probe: Partial<Probe>, proactive: SurfaceComponent[], asked: SurfaceComponent[] = [], extra: Partial<ProbeRun> = {}): ProbeRun {
  return {
    scenarioId: "X-01-s50",
    class: "C1",
    fillerSize: 50,
    probeIndex: 0,
    probe: { day: 1, t: 1, session: "d1", text: "q", expect: [], forbid: [], surface: "both", ...probe },
    proactive: { measurable: true, components: proactive, ms: 3 },
    asked: { measurable: true, components: asked, ms: 1 },
    ingestedRows: 10,
    ingestMs: 2,
    ...extra,
  };
}

describe("scoreSurface", () => {
  it("hit needs every expect needle, case-insensitive", () => {
    const r = run({ expect: ["Corvalino", "perro"] }, [comp("thread", ["User: mi PERRO se llama corvalino"])]);
    expect(scoreSurface(r, "proactive").hit).toBe(true);
    const miss = run({ expect: ["Corvalino", "gato"] }, [comp("thread", ["User: mi perro se llama Corvalino"])]);
    expect(scoreSurface(miss, "proactive").hit).toBe(false);
  });

  it("staleHit when any forbid needle is present, independent of hit", () => {
    const r = run({ expect: ["Fermindo"], forbid: ["Corvalino"] }, [comp("a", ["Corvalino"]), comp("b", ["fermindo"])]);
    const s = scoreSurface(r, "proactive");
    expect(s.hit).toBe(true);
    expect(s.staleHit).toBe(true);
  });

  it("chars = component texts joined by a blank line", () => {
    const r = run({ expect: ["x"] }, [comp("a", ["abc"]), comp("b", ["de"])]);
    expect(scoreSurface(r, "proactive").chars).toBe("abc\n\nde".length);
  });

  it("C7 (no expect): hit only when query-driven components are empty; ambient items do not count", () => {
    const clean = run({}, [comp("thread", ["User: hola"], false)], [comp("memory_search", [])]);
    expect(scoreSurface(clean, "proactive")).toMatchObject({ hit: true, irrelevantCount: 0 });
    expect(scoreSurface(clean, "asked")).toMatchObject({ hit: true, irrelevantCount: 0 });
    const noisy = run({}, [comp("enrichment", ["- a", "- b"])], [comp("memory_search", ["1. a"]), comp("jme", ["[x] y"])]);
    expect(scoreSurface(noisy, "proactive")).toMatchObject({ hit: false, irrelevantCount: 2 });
    expect(scoreSurface(noisy, "asked")).toMatchObject({ hit: false, irrelevantCount: 2 });
  });

  it("only the probe's declared surface is scored; an unmeasurable surface is never scored", () => {
    const r = run({ expect: ["x"], surface: "proactive" }, [comp("a", ["x"])], [comp("b", ["x"])]);
    expect(scoreSurface(r, "proactive").scored).toBe(true);
    expect(scoreSurface(r, "asked").scored).toBe(false);
    const u = run({ expect: ["x"] }, [comp("a", ["x"])]);
    u.proactive.measurable = false;
    expect(scoreSurface(u, "proactive").scored).toBe(false);
  });
});

describe("author markers (C5)", () => {
  it("nearest marker before the needle decides the role", () => {
    const item = "User: ¿cuánto cuesta?\nJarvis: calculo 18.450 al mes";
    expect(authorAt(item, item.indexOf("18.450"))).toBe("assistant");
    expect(authorAt(item, item.indexOf("cuánto"))).toBe("person");
    expect(authorAt("[assistant] 42", 12)).toBe("assistant");
    expect(authorAt("1. User: 42", 9)).toBe("person");
    expect(authorAt("- jarvis : 42", 11)).toBe("assistant");
  });

  it("no marker → not attributed; a marker in another item does not count", () => {
    expect(authorMarked(["[event] la renta ronda 18.450"], ["18.450"], "assistant")).toBe(false);
    expect(authorMarked(["Jarvis: hola", "renta 18.450"], ["18.450"], "assistant")).toBe(false);
    expect(authorMarked(["User: renta 18.450"], ["18.450"], "assistant")).toBe(false);
    expect(authorMarked(["User: ¿renta?\nJarvis: unos 18.450"], ["18.450"], "assistant")).toBe(true);
  });

  it("a mid-line 'user:' is not a marker (markers open a line)", () => {
    expect(authorAt("Jarvis: the user: said 7", 23)).toBe("assistant");
  });

  it("scoreSurface fills authorMarked only for probes with expectAuthor", () => {
    const items = ["User: ¿renta?\nJarvis: unos 18.450"];
    expect(scoreSurface(run({ expect: ["18.450"], expectAuthor: "assistant" }, [comp("t", items)]), "proactive").authorMarked).toBe(true);
    expect(scoreSurface(run({ expect: ["18.450"] }, [comp("t", items)]), "proactive").authorMarked).toBeNull();
  });
});

describe("aggregate", () => {
  it("median handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("one row per class × size × scored surface with hit / stale percentages", () => {
    const scores = [
      scoreProbe(run({ expect: ["a"] }, [comp("t", ["a"])], [comp("m", [])])),
      scoreProbe(run({ expect: ["a"], forbid: ["b"] }, [comp("t", ["b"])], [comp("m", ["a"])])),
      scoreProbe({ ...run({}, [comp("e", ["- x"])], [comp("m", [])]), class: "C7" }),
    ];
    const rows = aggregate(scores);
    const c1p = rows.find((r) => r.class === "C1" && r.surface === "proactive")!;
    expect(c1p).toMatchObject({ n: 2, hitPct: 50, staleHitPct: 50, meanIrrelevant: null });
    const c1a = rows.find((r) => r.class === "C1" && r.surface === "asked")!;
    expect(c1a).toMatchObject({ n: 2, hitPct: 50, staleHitPct: 0 });
    const c7p = rows.find((r) => r.class === "C7" && r.surface === "proactive")!;
    expect(c7p).toMatchObject({ n: 1, hitPct: 0, meanIrrelevant: 1 });
    expect(rows.find((r) => r.class === "C7" && r.surface === "asked")).toMatchObject({ hitPct: 100, meanIrrelevant: 0 });
  });
});

describe("v2: text matching", () => {
  it("NFC + case folding on both sides; diacritics stay significant", () => {
    const decomposed = "líquida"; // "líquida" with a combining accent
    const r = run({ expect: ["LÍQUIDA"] }, [comp("t", [`dieta ${decomposed}`])]);
    expect(scoreSurface(r, "proactive").hit).toBe(true);
    expect(scoreSurface(run({ expect: ["líquida"] }, [comp("t", ["dieta liquida"])]), "proactive").hit).toBe(false);
    expect(fold("ÁRBOL")).toBe("árbol");
  });

  it("staleHit with two forbid needles: SOME is enough, EVERY is not required", () => {
    const one = run({ expect: ["x"], forbid: ["Lumbrella", "Corvalino"] }, [comp("t", ["x Corvalino"])]);
    expect(scoreSurface(one, "proactive").staleHit).toBe(true);
    const both = run({ expect: ["x"], forbid: ["Lumbrella", "Corvalino"] }, [comp("t", ["x Corvalino Lumbrella"])]);
    expect(scoreSurface(both, "proactive").staleHit).toBe(true);
    const none = run({ expect: ["x"], forbid: ["Lumbrella", "Corvalino"] }, [comp("t", ["x"])]);
    expect(scoreSurface(none, "proactive").staleHit).toBe(false);
  });
});

describe("v2: strict attribution (C5)", () => {
  const JARVIS: AuthorMarkerSpec = {
    lineLabels: { person: ["user"], assistant: ["jarvis"] },
    headings: [{ pattern: "^## Contexto relevante del usuario", role: "person" }],
  };

  it("EVERY occurrence must sit on the expected role's line; one wrong-author copy fails it", () => {
    const echo = [comp("thread", ["User: sale a las 6:35", "Jarvis: anotado, 6:35"])];
    const a = attribute(echo, ["6:35"], "person", JARVIS);
    expect(a).toMatchObject({ occurrences: 2, marked: false, anyMarked: true, conflict: false });
    const clean = [comp("thread", ["User: ¿renta?", "Jarvis: unos 18.450"])];
    expect(attribute(clean, ["18.450"], "assistant", JARVIS).marked).toBe(true);
    expect(attribute(clean, ["18.450"], "person", JARVIS).marked).toBe(false);
  });

  it("a heading decides only for unmarked items; a marked line under the other role's heading is a conflict", () => {
    const text = "## Contexto relevante del usuario\n- User: ¿renta?\nJarvis: unos 18.450\n- la renta es 21.300";
    const c: SurfaceComponent = { name: "enrichment", queryDriven: true, text, items: ["- User: ¿renta?\nJarvis: unos 18.450", "- la renta es 21.300"] };
    expect(attribute([c], ["18.450"], "assistant", JARVIS)).toMatchObject({ marked: true, conflict: true });
    expect(attribute([c], ["21.300"], "person", JARVIS)).toMatchObject({ marked: true, conflict: false });
    expect(attribute([c], ["21.300"], "person", { lineLabels: JARVIS.lineLabels })).toMatchObject({ marked: false });
  });

  it("echo (statedBy both): passes when every occurrence carries its own author; wrong-only and unmarked fail", () => {
    const both = ["person", "assistant"] as const;
    const echo = [comp("thread", ["User: sale a las 6:35", "Jarvis: anotado, 6:35"])];
    expect(attribute(echo, ["6:35"], "person", JARVIS, both)).toMatchObject({ occurrences: 2, marked: true });
    // shown only under the wrong author: no occurrence on the expected role's line
    expect(attribute([comp("t", ["Jarvis: anotado, 6:35"])], ["6:35"], "person", JARVIS, both).marked).toBe(false);
    // a role that never stated it (person-only figure shown on a Jarvis line too)
    const leak = [comp("t", ["User: 14.780 pesos", "Jarvis: tus 14.780 pesos"])];
    expect(attribute(leak, ["14.780"], "person", JARVIS, ["person"]).marked).toBe(false);
    // an occurrence with no marker fails strict even when another is correct
    const unmarked = [comp("t", ["User: sale a las 6:35", "nota: 6:35"])];
    expect(attribute(unmarked, ["6:35"], "person", JARVIS, both)).toMatchObject({ marked: false, anyMarked: true });
    // scoreSurface passes the probe's statedBy through
    const r = run({ expect: ["6:35"], expectAuthor: "person", statedBy: ["person", "assistant"] }, echo);
    expect(scoreSurface(r, "proactive", JARVIS).authorMarked).toBe(true);
    expect(scoreSurface(run({ expect: ["6:35"], expectAuthor: "person" }, echo), "proactive", JARVIS).authorMarked).toBe(false);
  });

  it("a repeated item takes the heading above its own copy, not the first copy's", () => {
    const item = "- unos 18.450";
    const text = `## Asistente dijo\n${item}\n## Contexto relevante del usuario\n${item}`;
    const spec: AuthorMarkerSpec = {
      lineLabels: JARVIS.lineLabels,
      headings: [...JARVIS.headings!, { pattern: "^## Asistente dijo", role: "assistant" }],
    };
    const c: SurfaceComponent = { name: "e", queryDriven: true, text, items: [item, item] };
    // first copy under the assistant heading, second under the person heading: not all assistant
    expect(attribute([c], ["18.450"], "assistant", spec)).toMatchObject({ occurrences: 2, marked: false, anyMarked: true });
    expect(attribute([c], ["18.450"], "assistant", spec, ["assistant", "person"]).marked).toBe(true);
  });

  it("an item-level pattern attributes a single-author item", () => {
    const spec: AuthorMarkerSpec = { lineLabels: { person: [], assistant: [] }, itemPatterns: { assistant: ["^\\[assistant-said\\]"] } };
    expect(attribute([comp("m", ["[assistant-said] 2.8 miles"])], ["2.8 miles"], "assistant", spec).marked).toBe(true);
  });

  it("no occurrence is not marked; scoreProbeWith reports conflict and the lenient rule", () => {
    expect(attribute([comp("m", ["nada"])], ["4417"], "person", JARVIS)).toMatchObject({ occurrences: 0, marked: false });
    const r = run({ expect: ["4417"], expectAuthor: "person" }, [comp("thread", ["User: ends in 4417", "Jarvis: ok, 4417"], false)]);
    const s = scoreProbeWith(r, JARVIS).proactive;
    expect(s).toMatchObject({ authorMarked: false, authorMarkedAny: true, attributionConflict: false });
    // v1 signature stays usable as a map callback (index must not be read as markers).
    expect([r].map(scoreProbe)[0].proactive.authorMarked).toBe(false);
  });
});

describe("v2: carriers, gap and author aggregates", () => {
  it("carriedBy names the components that hold an expect needle, with their kinds", () => {
    const r = run(
      { expect: ["Corvalino"], forbid: ["Fermindo"] },
      [
        { ...comp("thread", ["User: Corvalino"], false), kind: "thread" },
        { ...comp("jme", ["[preference] Corvalino"]), cap: 8 },
        comp("essentials", ["Fermindo"], false),
      ],
    );
    const s = scoreSurface(r, "proactive");
    expect(s.carriedBy).toEqual(["thread", "jme"]);
    expect(s.carriedKinds).toEqual(["thread", "recall"]);
    expect(s.staleCarriedBy).toEqual(["essentials"]);
    expect(s.recallCap).toBe(8);
  });

  it("a carrier holds EVERY expect needle; a hit split across components has no single carrier", () => {
    const r = run({ expect: ["Corvalino", "Lumbrella"] }, [
      { ...comp("thread", ["User: Corvalino"], false), kind: "thread" },
      comp("jme", ["[x] Corvalino y Lumbrella"]),
      comp("memory_search", ["1. Lumbrella"]),
    ]);
    const s = scoreSurface(r, "proactive");
    expect(s.hit).toBe(true);
    expect(s.carriedBy).toEqual(["jme"]);
    const split = run({ expect: ["Corvalino", "Lumbrella"] }, [comp("a", ["Corvalino"]), comp("b", ["Lumbrella"])]);
    expect(scoreSurface(split, "proactive")).toMatchObject({ hit: true, carriedBy: [] });
    expect(scoreSurface(run({}, [comp("a", ["x"])]), "proactive").carriedBy).toEqual([]);
  });

  it("aggregate splits shared/disjoint and carrier shares; an unmeasurable surface shows as notScored", () => {
    const shared = run({ expect: ["a"], wording: "shared" }, [{ ...comp("thread", ["a"], false), kind: "thread" }]);
    const disjoint = run({ expect: ["a"], wording: "disjoint" }, [comp("m", ["b"])]);
    const rows = aggregate([scoreProbe(shared), scoreProbe(disjoint)]);
    expect(rows.find((x) => x.surface === "proactive")).toMatchObject({
      n: 2,
      hitPct: 50,
      nShared: 1,
      hitPctShared: 100,
      nDisjoint: 1,
      hitPctDisjoint: 0,
      carriedThreadPct: 100,
      threadOnlyPct: 100,
      carriedRecallPct: 0,
    });
    const u = run({ expect: ["a"] }, [comp("t", ["a"])]);
    u.proactive.measurable = false;
    u.asked.measurable = false;
    const ns = aggregate([scoreProbe(u)]);
    expect(ns).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "proactive", n: 0, notScored: 1, hitPct: null })]));
  });

  it("C3/C4 aggregate by variant × K; withScenarioMeta fills K from the corpus", () => {
    const mk = (id: string, hit: boolean) => ({ ...run({ expect: ["x"], surface: "proactive" }, [comp("thread", [hit ? "x" : "y"], false)]), scenarioId: id, class: "C3" as const });
    const corpus = {
      scenarios: [
        { id: "a", gapRows: 14, variant: "hydrate" },
        { id: "b", gapRows: 16, variant: "hydrate" },
      ],
    } as unknown as Corpus;
    const runs = withScenarioMeta([mk("a", true), mk("b", false)], corpus);
    const rows = aggregateByGap(runs.map(scoreProbe));
    expect(rows.map((r) => [r.variant, r.gapRows, r.hitPct])).toEqual([
      ["hydrate", 14, 100],
      ["hydrate", 16, 0],
    ]);
  });

  it("C5 aggregate by author case", () => {
    const r = { ...run({ expect: ["9"], expectAuthor: "person", authorCase: "person" }, [comp("t", ["User: 9"])]), class: "C5" as const };
    const rows = aggregateAuthor([scoreProbe(r)]);
    expect(rows[0]).toMatchObject({ authorCase: "person", n: 1, hitPct: 100, authorMarkedPct: 100, authorMarkedAnyPct: 100, attributionConflictPct: 0 });
    expect(rows[0]).not.toHaveProperty("authorMarkedWithDefaultPct");
  });
});

describe("v2: defaultRole (a separate, labelled figure)", () => {
  // A system that marks only the person's words and leaves its own unmarked.
  const SPEC: AuthorMarkerSpec = {
    lineLabels: { person: [], assistant: [] },
    itemPatterns: { person: ["; in the person's words$"] },
    defaultRole: "assistant",
  };
  const STRICT: AuthorMarkerSpec = { lineLabels: SPEC.lineLabels, itemPatterns: SPEC.itemPatterns };
  const personRow = "- loan rate 11.75%\n  id=e1 kept 2026-01-05; in the person's words";
  const agentRow = "- loan rate 11.75%\n  id=e2 kept 2026-01-05";

  it("strict ignores defaultRole; markedWithDefault counts an unattributed occurrence as that role", () => {
    const unmarked = [comp("recall", [agentRow])];
    expect(attribute(unmarked, ["11.75%"], "assistant", SPEC)).toMatchObject({ marked: false, anyMarked: false, markedWithDefault: true });
    expect(attribute(unmarked, ["11.75%"], "person", SPEC)).toMatchObject({ marked: false, markedWithDefault: false });
    // an explicit mark wins over the default
    const marked = [comp("recall", [personRow])];
    expect(attribute(marked, ["11.75%"], "person", SPEC)).toMatchObject({ marked: true, markedWithDefault: true });
    expect(attribute(marked, ["11.75%"], "assistant", SPEC)).toMatchObject({ marked: false, markedWithDefault: false });
    // the default still has to be a role that stated it
    const both = [comp("recall", [personRow, agentRow])];
    expect(attribute(both, ["11.75%"], "person", SPEC, ["person"])).toMatchObject({ marked: false, markedWithDefault: false });
    expect(attribute(both, ["11.75%"], "person", SPEC, ["person", "assistant"])).toMatchObject({ marked: false, markedWithDefault: true });
    // no defaultRole: null, and strict is unchanged
    expect(attribute(unmarked, ["11.75%"], "assistant", STRICT)).toMatchObject({ marked: false, markedWithDefault: null });
  });

  it("scoreSurface and aggregateAuthor report it only when the spec sets defaultRole", () => {
    const r = { ...run({ expect: ["11.75%"], expectAuthor: "assistant", authorCase: "assistant" }, [comp("recall", [agentRow])]), class: "C5" as const };
    const withDefault = scoreProbeWith(r, SPEC);
    expect(withDefault.proactive).toMatchObject({ authorMarked: false, authorMarkedWithDefault: true });
    expect(aggregateAuthor([withDefault])[0]).toMatchObject({ authorMarkedPct: 0, authorMarkedWithDefaultPct: 100 });
    const strict = scoreProbeWith(r, STRICT);
    expect(strict.proactive).not.toHaveProperty("authorMarkedWithDefault");
    expect(aggregateAuthor([strict])[0]).not.toHaveProperty("authorMarkedWithDefaultPct");
  });
});
