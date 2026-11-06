import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FILLER_SPEC_V1, canonicalFiller, generateFiller, xorshift32 } from "./filler.js";
import { buildCorpus, buildGolden, serialize, validateCorpus } from "./generate.js";
import type { Corpus, FillerItem } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("filler generator", () => {
  it("xorshift32 is the documented sequence (first values for seed 1)", () => {
    const next = xorshift32(1);
    expect([next(), next(), next()]).toEqual([270369, 67634689, 2647435461]);
  });

  it("seed 0 is replaced, not degenerate", () => {
    const next = xorshift32(0);
    expect(next()).not.toBe(0);
  });

  it("deterministic, sized, sorted, odd timestamps inside the window", () => {
    const p = { seed: 42, size: 500, fromT: -2_592_000, toT: 864_000 };
    const a = generateFiller(FILLER_SPEC_V1, p);
    expect(generateFiller(FILLER_SPEC_V1, p)).toEqual(a);
    expect(a).toHaveLength(500);
    for (const [i, item] of a.entries()) {
      expect(item.t % 2 !== 0).toBe(true);
      expect(item.t).toBeGreaterThanOrEqual(p.fromT);
      expect(item.t).toBeLessThan(p.toT);
      if (i > 0) expect(item.t).toBeGreaterThanOrEqual(a[i - 1].t);
      expect(item.user).not.toMatch(/\{\w+\}/);
      expect(item.assistant).not.toMatch(/\{\w+\}/);
    }
    expect(new Set(a.map((i) => /[¿áéíóñ]/.test(i.user + i.assistant))).size).toBe(2); // both languages
  });

  it("refuses an odd fromT or an empty window", () => {
    expect(() => generateFiller(FILLER_SPEC_V1, { seed: 1, size: 3, fromT: 1, toT: 10 })).toThrow(/even/);
    expect(() => generateFiller(FILLER_SPEC_V1, { seed: 1, size: 3, fromT: 10, toT: 10 })).toThrow(/empty/);
  });

  it("reproduces every committed golden case byte for byte", () => {
    const golden = JSON.parse(read("benchmarks/continuity/filler-golden.json")) as {
      cases: Array<{ seed: number; size: number; fromT: number; toT: number; sha256: string; items: FillerItem[] }>;
    };
    expect(golden.cases.length).toBeGreaterThanOrEqual(5);
    expect(golden.cases.some((c) => c.size === 5000)).toBe(true);
    for (const c of golden.cases) {
      const items = generateFiller(FILLER_SPEC_V1, c);
      expect(sha256(canonicalFiller(items)), `seed ${c.seed}`).toBe(c.sha256);
      expect(items.slice(0, Math.min(3, items.length))).toEqual(c.items.slice(0, Math.min(3, items.length)));
    }
  });
});

describe("corpus-v1.json", () => {
  const committed = read("benchmarks/continuity/corpus-v1.json");
  const corpus = JSON.parse(committed) as Corpus;

  it("is byte-identical to a fresh generation (seeded, reproducible)", () => {
    const fresh = buildCorpus();
    expect(serialize(fresh)).toBe(committed);
    expect(serialize(buildGolden(fresh))).toBe(read("benchmarks/continuity/filler-golden.json"));
  });

  it("embeds the filler spec the generator uses", () => {
    expect(corpus.fillerSpec).toEqual(FILLER_SPEC_V1);
  });

  it("8 classes × ≥ 6 scenarios × sizes 50/500/5000, under 6 MB", () => {
    expect(committed.length).toBeLessThan(6 * 1024 * 1024);
    expect(corpus.fillerSizes).toEqual([50, 500, 5000]);
    for (const cls of ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]) {
      for (const size of corpus.fillerSizes) {
        expect(corpus.scenarios.filter((s) => s.class === cls && s.fillerSize === size).length, `${cls}@${size}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("every needle is reachable from its events, every forbid exists, no filler holds a needle", () => {
    expect(() => validateCorpus(corpus)).not.toThrow();
  });

  it("validateCorpus fails a filler that contains a needle (the check can fail)", () => {
    const s = structuredClone(corpus.scenarios.find((x) => x.id === "C1-01-s50")!);
    const leaked: Corpus = structuredClone(corpus);
    leaked.scenarios = [s];
    leaked.fillerSpec.vocab.es.topic = ["Corvalino"];
    expect(() => validateCorpus(leaked)).toThrow(/filler contains needle/);
  });

  it("every non-exchange event carries an exchange rendering; restart's is empty", () => {
    for (const s of corpus.scenarios) {
      for (const e of s.events) {
        if (e.kind === "exchange") continue;
        expect(typeof e.asUser).toBe("string");
        expect(typeof e.asAssistant).toBe("string");
        if (e.kind === "restart") expect(e.asUser + e.asAssistant).toBe("");
        else expect(e.asUser.length).toBeGreaterThan(0);
      }
    }
  });
});
