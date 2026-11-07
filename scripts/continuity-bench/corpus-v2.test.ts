import { createHash } from "node:crypto";
import { extractContentTokens } from "../../src/memory/recall-utility.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOSER_GAP_ROWS, GAP_ROWS, HANDOFF_GAP_ROWS, buildCorpusV2 } from "./corpus-v2.js";
import { FILLER_SPEC_V1 } from "./filler.js";
import { OPEN_WORK, buildCorpus, outputsFor, serialize, validateCorpus } from "./generate.js";
import type { Corpus, Scenario } from "./types.js";
import { contentTokens, wordingOf } from "./wording.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("corpus-v2.json", () => {
  const committed = read("benchmarks/continuity/corpus-v2.json");
  const corpus = JSON.parse(committed) as Corpus;
  const at50 = corpus.scenarios.filter((s) => s.fillerSize === 50);

  it("is byte-identical to a fresh generation and leaves v1 + the golden alone", async () => {
    expect(serialize(buildCorpusV2())).toBe(committed);
    expect(corpus.fillerSpec).toEqual(FILLER_SPEC_V1);
    const v1 = await outputsFor("continuity-v1");
    expect(v1.map(([, s]) => s)).toEqual([read("benchmarks/continuity/corpus-v1.json"), read("benchmarks/continuity/filler-golden.json")]);
    const v2 = await outputsFor("continuity-v2");
    expect(v2).toHaveLength(1);
    expect(v2[0][0]).toMatch(/corpus-v2\.json$/);
  });

  it("passes validateCorpus (needles, forbid, gaps, author cases, wording labels)", () => {
    expect(() => validateCorpus(corpus)).not.toThrow();
  });

  it("C1 asks the same four phrasings at days 1, 7, 30 and 90", () => {
    for (const s of at50.filter((x) => x.class === "C1")) {
      const byDay = new Map<number, string[]>();
      for (const p of s.probes) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p.text]);
      expect([...byDay.keys()]).toEqual([1, 7, 30, 90]);
      const sets = [...byDay.values()].map((v) => JSON.stringify(v));
      expect(new Set(sets).size, s.id).toBe(1);
    }
  });

  it("every probe has a wording label and each class is roughly half shared, half disjoint", () => {
    for (const cls of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]) {
      const probes = at50.filter((s) => s.class === cls).flatMap((s) => s.probes);
      expect(probes.every((p) => p.wording === "shared" || p.wording === "disjoint"), cls).toBe(true);
      const shared = probes.filter((p) => p.wording === "shared").length / probes.length;
      expect(shared, cls).toBeGreaterThanOrEqual(0.4);
      expect(shared, cls).toBeLessThanOrEqual(0.6);
    }
  });

  it("C3/C4 put K primary exchanges between the session end and the probe; K straddles the 15-row thread", () => {
    const c3 = at50.filter((s) => s.class === "C3");
    const c4 = at50.filter((s) => s.class === "C4");
    expect(new Set(c3.filter((s) => s.variant === "hydrate").map((s) => s.gapRows))).toEqual(new Set(GAP_ROWS));
    expect(new Set(c4.map((s) => s.gapRows))).toEqual(new Set(GAP_ROWS));
    expect(c3.some((s) => s.variant === "live")).toBe(true);
    expect(c4.every((s) => s.variant === "restart")).toBe(true);
    for (const s of [...c3, ...c4]) {
      const end = s.events.map((e) => e.kind).lastIndexOf("session_end");
      const primaryAfter = s.events.slice(end + 1).filter((e) => e.kind === "exchange" && (e.channel ?? "primary") === "primary");
      expect(primaryAfter.length, s.id).toBe(s.gapRows);
      expect(s.events.slice(end + 1).every((e) => e.t < s.probes[0].t), s.id).toBe(true);
    }
    expect(GAP_ROWS).toContain(15); // the first K the 15-row buffer cannot hold
    const inter = c3.filter((s) => s.variant === "interleave");
    expect(inter.length).toBe(6);
    for (const s of inter) {
      const end = s.events.findIndex((e) => e.kind === "session_end");
      const secondary = s.events.flatMap((e, i) => (e.channel === "secondary" ? [{ e, i }] : []));
      expect(secondary.length).toBe(20);
      // every other-channel row sits AFTER the session end, in index and in time, and before the probe
      for (const { e, i } of secondary) {
        expect(i, s.id).toBeGreaterThan(end);
        expect(e.t, s.id).toBeGreaterThan(s.events[end].t);
        expect(e.t, s.id).toBeLessThan(s.probes[0].t);
      }
    }
  });

  it("Port 1 is additive: the 444 original scenarios are byte-identical (hash of the pre-Port-1 list) and come first", () => {
    const PORT1 = new Set(["handoff", "crowded", "closer", "single", "longcloser"]);
    const original = corpus.scenarios.filter((s) => !PORT1.has(s.variant ?? ""));
    expect(original).toHaveLength(444);
    expect(original.flatMap((s) => s.probes)).toHaveLength(1140);
    expect(createHash("sha256").update(JSON.stringify(original)).digest("hex")).toBe(
      "ea3402f379e6b96b24b5001f43dd7b17339657277fa225516c10b92a1eab04b1",
    );
    // per size, the additions follow every original scenario
    for (const size of corpus.fillerSizes) {
      const ids = corpus.scenarios.filter((s) => s.fillerSize === size);
      const firstNew = ids.findIndex((s) => PORT1.has(s.variant ?? ""));
      expect(ids.slice(firstNew).every((s) => PORT1.has(s.variant ?? "")), String(size)).toBe(true);
    }
    expect(corpus.scenarios).toHaveLength(570);
    expect(corpus.scenarios.flatMap((s) => s.probes)).toHaveLength(1392);
  });

  it("the Port 1 fold is additive too: the 534 scenarios before single / longcloser are byte-identical (second hash) and come first", () => {
    const FOLD = new Set(["single", "longcloser"]);
    const before = corpus.scenarios.filter((s) => !FOLD.has(s.variant ?? ""));
    expect(before).toHaveLength(534);
    expect(before.flatMap((s) => s.probes)).toHaveLength(1320);
    expect(createHash("sha256").update(JSON.stringify(before)).digest("hex")).toBe(
      "e1ee251dc1057a33e47eaf1b3ebf60e5accae85574c7fbbdef0fbf454f6c15f5",
    );
    for (const size of corpus.fillerSizes) {
      const ids = corpus.scenarios.filter((s) => s.fillerSize === size);
      const firstNew = ids.findIndex((s) => FOLD.has(s.variant ?? ""));
      expect(ids.slice(firstNew).every((s) => FOLD.has(s.variant ?? "")), String(size)).toBe(true);
      expect(ids.length - firstNew, String(size)).toBe(12);
    }
  });

  it("known-limit rows: single = the open work alone in a one-exchange session; longcloser = a closer of 8+ content tokens in the same session", () => {
    const of = (v: string) => at50.filter((s) => s.variant === v);
    for (const s of of("single")) {
      expect(s.gapRows, s.id).toBe(CLOSER_GAP_ROWS);
      expect(s.events[0].kind, s.id).toBe("session_end");
      expect(s.events[0].day, s.id).toBe(0);
      expect(s.events.slice(1).every((e) => e.kind === "exchange" && e.day === 1), s.id).toBe(true);
    }
    for (const s of of("longcloser")) {
      expect(s.gapRows, s.id).toBe(CLOSER_GAP_ROWS);
      const end = s.events.findIndex((e) => e.kind === "session_end");
      const closer = s.events[end + 1];
      expect(closer.kind === "exchange" && closer.day === 0, s.id).toBe(true);
      expect(closer.t - s.events[end].t, s.id).toBeLessThan(20 * 60);
      if (closer.kind !== "exchange") continue;
      expect(extractContentTokens(`${closer.user}\n${closer.assistant}`).size, s.id).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(closer).toLowerCase().includes(s.probes[0].expect[0].toLowerCase()), s.id).toBe(false);
    }
    expect(of("single")).toHaveLength(6);
    expect(of("longcloser")).toHaveLength(6);
  });

  it("Port 1 variants: handoff / crowded put 1 / 3 complete sessions between the open work and K gap rows; closer adds one short exchange after the open-work row", () => {
    const of = (v: string) => at50.filter((s) => s.variant === v);
    for (const v of ["handoff", "crowded"]) {
      expect(of(v), v).toHaveLength(12);
      expect(new Set(of(v).map((s) => s.gapRows)), v).toEqual(new Set(HANDOFF_GAP_ROWS));
    }
    expect(of("closer").map((s) => s.gapRows)).toEqual(Array(6).fill(CLOSER_GAP_ROWS));
    const day = 86_400;
    for (const v of ["handoff", "crowded"]) {
      for (const s of of(v)) {
        const ends = s.events.flatMap((e, i) => (e.kind === "session_end" ? [i] : []));
        expect(ends.length, s.id).toBe(v === "handoff" ? 2 : 4);
        const a = s.events[ends[0]];
        expect(a.kind === "session_end" && a.openWork, s.id).toBe(OPEN_WORK[s.base - 1].openWork);
        // the open work is over 72 h old at the probe; later sessions are complete (no needle)
        expect(s.probes[0].t - a.t, s.id).toBeGreaterThan(3 * day);
        const later = s.events.slice(ends[0] + 1, ends[ends.length - 1] + 1);
        expect(later.some((e) => JSON.stringify(e).toLowerCase().includes(s.probes[0].expect[0].toLowerCase())), s.id).toBe(false);
        expect(s.probes.every((p) => p.day === 5), s.id).toBe(true);
      }
    }
    for (const s of of("closer")) {
      const end = s.events.findIndex((e) => e.kind === "session_end");
      const closer = s.events[end + 1];
      expect(closer.kind, s.id).toBe("exchange");
      expect(closer.day, s.id).toBe(0);
      expect(closer.t - s.events[end].t, s.id).toBeLessThan(20 * 60); // same session
      expect(s.events[end + 2].day, s.id).toBe(1);
    }
  });

  it("C5 covers assistant-stated, person-stated and both echo orders, with expectAuthor = who stated first", () => {
    const c5 = at50.filter((s) => s.class === "C5").flatMap((s) => s.probes);
    const count = (c: string) => c5.filter((p) => p.authorCase === c).length;
    expect([count("assistant"), count("person"), count("echo-person-first"), count("echo-assistant-first")]).toEqual([12, 12, 4, 4]);
    for (const p of c5) {
      expect(p.expectAuthor).toBe(p.authorCase === "person" || p.authorCase === "echo-person-first" ? "person" : "assistant");
      expect(p.statedBy).toEqual(p.authorCase === "person" ? ["person"] : p.authorCase === "assistant" ? ["assistant"] : ["person", "assistant"]);
    }
    // at least half the C5 probes share no content word with the person's own question
    const own = at50
      .filter((s) => s.class === "C5")
      .flatMap((s) => s.probes.map((p) => ({ p, q: s.events.flatMap((e) => (e.kind === "exchange" ? [e.user] : [])).join(" ") })));
    const noOverlap = own.filter(({ p, q }) => ![...contentTokens(p.text)].some((t) => contentTokens(q).has(t))).length;
    expect(noOverlap / own.length).toBeGreaterThanOrEqual(0.5);
  });

  it("the header's wording audit is the measured one: no disjoint probe shares any 3+ token with its target", () => {
    expect(corpus.wordingAudit).toEqual(validateCorpus(corpus));
    expect(corpus.wordingAudit!.disjointProbes).toBe(corpus.scenarios.flatMap((s) => s.probes).filter((p) => p.wording === "disjoint").length);
    expect(corpus.wordingAudit!.disjointSharingAnyToken3).toBe(0);
  });

  it("v1 is unchanged by the v2 builders (no v2 fields leak into it)", () => {
    const v1 = buildCorpus();
    expect(v1.scenarios.some((s) => s.gapRows !== undefined || s.variant !== undefined)).toBe(false);
    expect(v1.scenarios.flatMap((s) => s.probes).some((p) => p.wording !== undefined)).toBe(false);
  });
});

describe("validateCorpus guards (each check can fail)", () => {
  const corpus = buildCorpusV2();
  const one = (id: string, edit: (s: Scenario) => void): Corpus => {
    const s = structuredClone(corpus.scenarios.find((x) => x.id === id)!);
    edit(s);
    return { ...corpus, scenarios: [s] };
  };

  it("a probe before the last event", () => {
    expect(() => validateCorpus(one("C1-01-s50", (s) => (s.probes[0].t = s.events[0].t - 1)))).toThrow(/precedes the last event/);
  });

  it("probes out of time order", () => {
    expect(() => validateCorpus(one("C1-01-s50", (s) => s.probes.reverse()))).toThrow(/not in time order/);
  });

  it("a C7 probe whose text appears in its events", () => {
    expect(() =>
      validateCorpus(
        one("C7-01-s50", (s) => {
          const e = s.events[0];
          if (e.kind === "exchange") e.user = s.probes[0].text;
        }),
      ),
    ).toThrow(/C7 probe text appears/);
  });

  it("a wrong wording label", () => {
    expect(() =>
      validateCorpus(one("C1-01-s50", (s) => (s.probes[0].wording = s.probes[0].wording === "shared" ? "disjoint" : "shared"))),
    ).toThrow(/labelled/);
  });

  it("a gap row that carries the needle, or a gap count that does not match", () => {
    expect(() =>
      validateCorpus(
        one("C3-01-h5-s50", (s) => {
          const e = s.events[s.events.length - 1];
          if (e.kind === "exchange") e.assistant += ` ${s.probes[0].expect[0]}`;
        }),
      ),
    ).toThrow(/gap row carries/);
    expect(() => validateCorpus(one("C3-01-h5-s50", (s) => (s.gapRows = 6)))).toThrow(/gapRows 6/);
  });

  it("a statedBy that does not match the events, or a stale wording audit in the header", () => {
    expect(() => validateCorpus(one("C5-13-s50", (s) => (s.probes[0].statedBy = ["person"])))).toThrow(/statedBy person/);
    const { wordingAudit: _full, ...bare } = one("C1-01-s50", () => {});
    expect(validateCorpus(bare)).toMatchObject({ disjointProbes: 8, disjointSharingAnyToken3: 0 });
    expect(() => validateCorpus({ ...bare, wordingAudit: { disjointProbes: 99, disjointSharingAnyToken3: 0, leaks: [] } })).toThrow(/wordingAudit/);
  });

  it("a C5 figure moved to the wrong author", () => {
    expect(() =>
      validateCorpus(
        one("C5-01-s50", (s) => {
          const e = s.events[0];
          if (e.kind === "exchange") [e.user, e.assistant] = [e.assistant, e.user];
        }),
      ),
    ).toThrow(/author case assistant/);
  });
});

describe("wording rule", () => {
  it("content tokens skip stopwords and short runs; NFC-folded", () => {
    expect([...contentTokens("¿Cómo se llama mi PERRO?")]).toEqual(["llama", "perro"]);
    expect([...contentTokens("Rápido")]).toEqual(["rápido"]);
  });

  it("targets the events holding a needle (all events when none)", () => {
    const events = [
      { day: 0, t: 0, session: "d0", kind: "exchange" as const, user: "mi perro Corvalino", assistant: "ok" },
      { day: 0, t: 2, session: "d0", kind: "exchange" as const, user: "la mascota come", assistant: "ok" },
    ];
    expect(wordingOf(events, { expect: ["Corvalino"], text: "¿y la mascota?" })).toBe("disjoint");
    expect(wordingOf(events, { expect: ["Corvalino"], text: "¿y el perro?" })).toBe("shared");
    expect(wordingOf(events, { expect: [], text: "¿y la mascota?" })).toBe("shared");
  });
});
