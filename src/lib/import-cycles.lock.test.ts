/**
 * Lock test: the import cycles among the production files under src/ and the
 * pairs of directories that import each other may change only together with
 * import-cycles.baseline.json. A cycle makes load order matter and lets one
 * module see another half-initialised; a pair of directories that import each
 * other cannot be understood, tested or moved one without the other. Every new
 * one must be a visible choice, and every cut must lower the baseline in the
 * same commit, so the ground gained cannot be given back silently.
 *
 * The comparison runs in both directions and has no switch that turns it off:
 * - NEW: a cycle, a cycle member or a mutual directory pair that the baseline
 *   does not hold (something was coupled);
 * - GONE: a baseline cycle, member or pair that the tree no longer has (a cut
 *   was made: lower the baseline);
 * - the cycle sizes with dynamic `import()` counted as edges must match too.
 * After that the baseline text must equal the canonical text of the current
 * facts byte for byte. The failure message prints that text, ready to copy.
 * So that nothing slips past the scan, every relative import must resolve,
 * none may lead into a shipped file the scan does not read (src/test-utils/,
 * a __fixtures__ folder), and every dynamic import() must have a literal
 * argument.
 *
 * Which files form the graph, what a runtime edge is (an `import type` is not)
 * and what a directory is: see src/test-utils/import-graph.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImportGraph,
  compareFacts,
  couplingFacts,
  cycles,
  lockMessage,
  mutualDirectoryPairs,
  serializeFacts,
  type CouplingFacts,
  type ImportGraph,
} from "../test-utils/import-graph.js";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SELF_DIR, "..", "..");
const BASELINE_PATH = join(SELF_DIR, "import-cycles.baseline.json");

const fixtureRoots: string[] = [];
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway tree: keys are paths relative to its root (all under src/). */
function fixture(files: Record<string, string>): ImportGraph {
  const root = mkdtempSync(join(tmpdir(), "import-graph-"));
  fixtureRoots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return buildImportGraph(root);
}

const kindByTarget = (g: ImportGraph): Record<string, string> =>
  Object.fromEntries(g.edges.map((e) => [e.to, e.kind]));

describe("import-graph helper, on a temporary tree", () => {
  it("finds a two-file runtime cycle", () => {
    const g = fixture({
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = () => b;\n',
      "src/b.ts": 'import { a } from "./a.js";\nexport const b = () => a;\n',
    });
    expect(g.edges.map((e) => `${e.from} ${e.kind} ${e.to}`)).toEqual(["src/a.ts runtime src/b.ts", "src/b.ts runtime src/a.ts"]);
    expect(cycles(g, ["runtime"])).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("an `import type` in one direction is no runtime cycle", () => {
    const g = fixture({
      "src/a.ts": 'import { b } from "./b.js";\nexport interface A { n: number }\nexport const a = () => b;\n',
      "src/b.ts": 'import type { A } from "./a.js";\nexport const b = (x: A) => x.n;\n',
    });
    expect(kindByTarget(g)).toEqual({ "src/b.ts": "runtime", "src/a.ts": "type" });
    expect(cycles(g, ["runtime"])).toEqual([]);
  });

  it("type-only forms: `import type`, every binding marked `type`, `export type … from`", () => {
    const g = fixture({
      "src/k.ts": [
        'import type { T1 } from "./t1.js";',
        'import { type A, type B } from "./t2.js";',
        'export type { T3 } from "./t3.js";',
        'export { type T4 } from "./t4.js";',
        "export const k = (a: A, b: B, t: T1) => [a, b, t];",
      ].join("\n"),
      ...Object.fromEntries([1, 2, 3, 4].map((n) => [`src/t${n}.ts`, "export {};\n"])),
    });
    expect(kindByTarget(g)).toEqual({ "src/t1.ts": "type", "src/t2.ts": "type", "src/t3.ts": "type", "src/t4.ts": "type" });
  });

  it("runtime forms: a value binding next to a type one, re-exports, a side-effect import, a base class", () => {
    const g = fixture({
      "src/k.ts": [
        'import { type A, b } from "./r1.js";',
        'export * from "./r2.js";',
        'export { x } from "./r3.js";',
        'export * as ns from "./r4.js";',
        'import "./r5.js";',
        'import D from "./r6.js";',
        "export class C extends D {}",
        "export const k = (a: A) => b(a);",
      ].join("\n"),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`src/r${n}.ts`, "export {};\n"])),
    });
    expect(kindByTarget(g)).toEqual({
      "src/r1.ts": "runtime",
      "src/r2.ts": "runtime",
      "src/r3.ts": "runtime",
      "src/r4.ts": "runtime",
      "src/r5.ts": "runtime",
      "src/r6.ts": "runtime",
    });
  });

  it("a value import used only in types (a `typeof` query, type-only exports, interface extends, implements) is elided: no runtime edge", () => {
    const g = fixture({
      "src/k.ts": [
        'import { V } from "./e1.js";',
        'import { W } from "./e2.js";',
        'import * as N from "./e3.js";',
        'import { T4 } from "./e4.js";',
        'import { T5 } from "./e5.js";',
        'import { Base } from "./e6.js";',
        'import { I } from "./e7.js";',
        "export declare const q: typeof W;",
        "export let v: V | N.T | undefined;",
        "export { type T4 };",
        "export type { T5 };",
        "export interface X extends Base {}",
        "export class K implements I {}",
      ].join("\n"),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`src/e${n}.ts`, "export {};\n"])),
    });
    expect(kindByTarget(g)).toEqual(
      Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`src/e${n}.ts`, "elided"])),
    );
  });

  it("reports a three-file and a separate two-file cycle with sorted members; a self-import and a chain are no cycle", () => {
    const g = fixture({
      // m -> z -> a -> m: discovery order is not the sorted order.
      "src/m.ts": 'import "./z.js";\n',
      "src/z.ts": 'import "./a.js";\n',
      "src/a.ts": 'import "./m.js";\n',
      "src/q.ts": 'import "./p.js";\n',
      "src/p.ts": 'import "./q.js";\n',
      "src/self.ts": 'import "./self.js";\n',
      "src/c1.ts": 'import "./c2.js";\nimport "./a.js";\n',
      "src/c2.ts": 'import "./c3.js";\n',
      "src/c3.ts": "export {};\n",
    });
    expect(cycles(g, ["runtime"])).toEqual([
      ["src/a.ts", "src/m.ts", "src/z.ts"],
      ["src/p.ts", "src/q.ts"],
    ]);
  });

  it("an edge into a cycle that is already complete joins nothing", () => {
    const g = fixture({
      // a <-> b is found first; d -> a then points into that finished cycle.
      "src/a.ts": 'import "./b.js";\n',
      "src/b.ts": 'import "./a.js";\n',
      "src/c.ts": 'import "./d.js";\n',
      "src/d.ts": 'import "./a.js";\nimport "./c.js";\n',
    });
    expect(cycles(g, ["runtime"])).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/c.ts", "src/d.ts"],
    ]);
  });

  it("a dynamic import is no runtime edge, closes a cycle only with dynamic edges counted; a non-literal one is counted", () => {
    const g = fixture({
      "src/p.ts": 'import { q } from "./q.js";\nexport const p = () => q;\n',
      "src/q.ts": [
        'export const q = () => import("./p.js");',
        "export const r = (n: string) => import(n);",
        "export const s = () => import(`./t.js`);",
      ].join("\n"),
      "src/t.ts": "export {};\n",
    });
    expect(kindByTarget(g)).toEqual({ "src/q.ts": "runtime", "src/p.ts": "dynamic", "src/t.ts": "dynamic" });
    expect(cycles(g, ["runtime"])).toEqual([]);
    expect(cycles(g, ["runtime", "dynamic"])).toEqual([["src/p.ts", "src/q.ts"]]);
    expect(g.nonLiteralDynamic).toEqual([{ from: "src/q.ts", line: 2 }]);
    expect(couplingFacts(g)).toEqual({ runtimeCycles: [], runtimeWithDynamicCycleSizes: [2], mutualDirectoryPairs: [] });
  });

  it("resolves `.js` to `.ts` and a folder to its index.ts, reports an unresolved relative specifier, ignores packages", () => {
    const g = fixture({
      "src/main.ts": [
        // An angle-bracket assertion: TypeScript syntax that a JSX parse would misread.
        "export const early = <number>(1 as unknown);",
        'import { readFileSync } from "node:fs";',
        'import ts from "typescript";',
        'import { u } from "./util.js";',
        'import { w } from "./lib";',
        'import { gone } from "./missing.js";',
        'import { both } from "./both";',
        "export const all = [readFileSync, ts, u, w, gone, both];",
      ].join("\n"),
      "src/util.ts": "export const u = 1;\n",
      "src/lib/index.ts": "export const w = 2;\n",
      // A file and a folder of the same name: the file wins, as in the compiler.
      "src/both.ts": "export const both = 3;\n",
      "src/both/index.ts": "export const both = 4;\n",
    });
    expect(g.edges.map((e) => e.to)).toEqual(["src/util.ts", "src/lib/index.ts", "src/both.ts"]);
    expect(g.unresolved).toEqual([{ from: "src/main.ts", line: 6, specifier: "./missing.js" }]);
  });

  it("test files, declaration files, test utilities and fixtures are not part of the graph; an import into a shipped one is reported", () => {
    const g = fixture({
      "src/a.ts": [
        'import { t } from "./a.test.js";',
        'import { u } from "./test-utils/u.js";',
        'import { f } from "./x/__fixtures__/f.js";',
        'import type { G } from "./g.js";',
        "export const a = [t, u, f];",
        "export let g: G | undefined;",
      ].join("\n"),
      "src/a.test.ts": 'import { a } from "./a.js";\nexport const t = a;\n',
      "src/test-utils/u.ts": 'import { a } from "../a.js";\nexport const u = a;\n',
      "src/x/__fixtures__/f.ts": 'import { a } from "../../a.js";\nexport const f = a;\n',
      "src/g.d.ts": "export type G = number;\n",
    });
    expect(g.files).toEqual(["src/a.ts"]);
    expect(g.edges).toEqual([]);
    expect(g.unresolved).toEqual([]);
    expect(cycles(g, ["runtime"])).toEqual([]);
    // A test file and a declaration file are not shipped code: no edge and no report.
    expect(g.outsideGraph).toEqual([
      { from: "src/a.ts", line: 2, specifier: "./test-utils/u.js", to: "src/test-utils/u.ts" },
      { from: "src/a.ts", line: 3, specifier: "./x/__fixtures__/f.js", to: "src/x/__fixtures__/f.ts" },
    ]);
  });

  it("mutual directory pairs: both directions through different files, once, sorted; a nested directory is its own", () => {
    const g = fixture({
      // one direction only: no pair
      "src/a/one.ts": 'import "../b/one.js";\n',
      "src/b/one.ts": "export {};\n",
      // c -> d and d -> c through different files: one pair
      "src/d/y.ts": 'import "../c/y.js";\n',
      "src/c/x.ts": 'import "../d/x.js";\n',
      "src/c/y.ts": "export {};\n",
      "src/d/x.ts": "export {};\n",
      // the same directory never pairs with itself
      "src/e/p.ts": 'import "./q.js";\n',
      "src/e/q.ts": 'import "./p.js";\n',
      // a directory and its subdirectory
      "src/f/m.ts": 'import "./g/n.js";\n',
      "src/f/g/n.ts": 'import "../m2.js";\n',
      "src/f/m2.ts": "export {};\n",
      // the way back is a type edge only: no pair
      "src/h/a.ts": 'import "../i/a.js";\n',
      "src/i/a.ts": 'import type { B } from "../h/b.js";\nexport let b: B | undefined;\n',
      "src/h/b.ts": "export type B = number;\n",
    });
    expect(mutualDirectoryPairs(g)).toEqual(["src/c <-> src/d", "src/f <-> src/f/g"]);
  });

  it("an empty baseline holds a tree without cycles and fails on a tree with one", () => {
    const empty: CouplingFacts = { runtimeCycles: [], runtimeWithDynamicCycleSizes: [], mutualDirectoryPairs: [] };
    const acyclic = couplingFacts(fixture({ "src/a.ts": 'import "./b.js";\n', "src/b.ts": "export {};\n" }));
    expect(compareFacts(empty, acyclic)).toEqual([]);
    expect(serializeFacts(acyclic)).toBe(serializeFacts(empty));
    const cyclic = couplingFacts(fixture({ "src/a.ts": 'import "./b.js";\n', "src/b.ts": 'import "./a.js";\n' }));
    expect(compareFacts(empty, cyclic)).toEqual([
      "NEW cycle (2 files): src/a.ts, src/b.ts",
      "CHANGED cycle sizes with dynamic imports counted: baseline [], now [2]",
    ]);
  });

  describe("compareFacts, both directions", () => {
    const base: CouplingFacts = {
      runtimeCycles: [
        ["src/a.ts", "src/b.ts", "src/c.ts"],
        ["src/d.ts", "src/e.ts"],
      ],
      runtimeWithDynamicCycleSizes: [3, 2],
      mutualDirectoryPairs: ["src <-> src/x", "src/x <-> src/y"],
    };
    const withChange = (change: Partial<CouplingFacts>): CouplingFacts => ({ ...structuredClone(base), ...change });

    it("equal facts give no finding", () => {
      expect(compareFacts(base, structuredClone(base))).toEqual([]);
    });

    it("NEW: a cycle, a member, a pair, two cycles become one", () => {
      expect(compareFacts(base, withChange({ runtimeCycles: [...base.runtimeCycles, ["src/f.ts", "src/g.ts"]] }))).toEqual([
        "NEW cycle (2 files): src/f.ts, src/g.ts",
      ]);
      expect(
        compareFacts(base, withChange({ runtimeCycles: [["src/a.ts", "src/b.ts", "src/c.ts", "src/z.ts"], base.runtimeCycles[1]] })),
      ).toEqual(["NEW cycle member: src/z.ts (in the cycle of src/a.ts)"]);
      expect(compareFacts(base, withChange({ mutualDirectoryPairs: [...base.mutualDirectoryPairs, "src/y <-> src/z"] }))).toEqual([
        "NEW mutual directory pair: src/y <-> src/z",
      ]);
      expect(compareFacts(base, withChange({ runtimeCycles: [["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]] }))).toEqual([
        "NEW: separate cycles of the baseline are now one: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts",
      ]);
    });

    it("GONE: a cycle, a member, a pair, a cycle split in two", () => {
      expect(compareFacts(base, withChange({ runtimeCycles: [base.runtimeCycles[0]] }))).toEqual([
        "GONE cycle (2 files): src/d.ts, src/e.ts",
      ]);
      expect(compareFacts(base, withChange({ runtimeCycles: [["src/a.ts", "src/b.ts"], base.runtimeCycles[1]] }))).toEqual([
        "GONE cycle member: src/c.ts (in the cycle of src/a.ts)",
      ]);
      expect(compareFacts(base, withChange({ mutualDirectoryPairs: ["src/x <-> src/y"] }))).toEqual([
        "GONE mutual directory pair: src <-> src/x",
      ]);
      const joined = withChange({ runtimeCycles: [["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]] });
      expect(compareFacts(joined, base)).toEqual([
        "GONE: a cycle of the baseline is now split: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts",
      ]);
    });

    it("cycle sizes with dynamic edges must match; the message names both directions and the type-only rule", () => {
      const now = withChange({ runtimeWithDynamicCycleSizes: [4, 2] });
      const findings = compareFacts(base, now);
      expect(findings).toEqual(["CHANGED cycle sizes with dynamic imports counted: baseline [3, 2], now [4, 2]"]);
      const message = lockMessage(findings, now);
      expect(message).toContain("  - CHANGED cycle sizes");
      expect(message).toContain("Lower the baseline in the same commit");
      expect(message).toContain("An `import type`");
      expect(message).toContain("is not a runtime edge");
      expect(message.endsWith(serializeFacts(now))).toBe(true);
    });
  });
});

describe("import coupling of src/ may change only together with its baseline", () => {
  let scanned: ImportGraph | undefined;
  const repo = (): ImportGraph => (scanned ??= buildImportGraph(REPO));

  // This case pays for reading and parsing the whole tree; the later ones reuse the scan.
  it("the scan reads the production tree, and only it; every import is visible to it", { timeout: 60_000 }, () => {
    const g = repo();
    expect(g.files.length).toBeGreaterThan(500);
    expect(g.files).toContain("src/index.ts");
    expect(
      g.files.filter((f) => f.endsWith(".test.ts") || f.endsWith(".d.ts") || f.startsWith("src/test-utils/") || f.includes("/__fixtures__/")),
    ).toEqual([]);
    expect(g.edges.filter((e) => e.kind === "runtime").length).toBeGreaterThan(1000);
    expect(
      g.unresolved,
      "a relative specifier that resolves to no .ts file (a relative import of a JSON or .mjs file lands here too): the graph cannot see where it leads",
    ).toEqual([]);
    expect(
      g.outsideGraph,
      "an import from production code into src/test-utils/ or a __fixtures__ folder: the build ships that file, but the scan does not read it, so a cycle through it would be invisible",
    ).toEqual([]);
    expect(
      g.nonLiteralDynamic,
      "a dynamic import() whose argument is not a literal: the graph cannot see where it leads; make it a literal or decide the exception in review",
    ).toEqual([]);
  });

  it("cycles, their members, the dynamic-edge cycle sizes and the mutual directory pairs equal the baseline", () => {
    const text = readFileSync(BASELINE_PATH, "utf8");
    const baseline = JSON.parse(text) as CouplingFacts;
    const current = couplingFacts(repo());
    expect(Object.keys(baseline)).toEqual(Object.keys(current));
    const findings = compareFacts(baseline, current);
    expect(findings, lockMessage(findings, current)).toEqual([]);
    expect(text, lockMessage(["the baseline text is not in canonical form (sorted, two-space JSON)"], current)).toBe(
      serializeFacts(current),
    );
  });

  it("the real facts against the baseline with a synthetic cycle and pair: on the tree's side NEW, on the baseline's side GONE", () => {
    // Synthetic entries keep this case meaningful however many cycles and pairs remain, none included.
    const current = couplingFacts(repo());
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as CouplingFacts;
    const plus = (f: CouplingFacts): CouplingFacts => ({
      ...f,
      runtimeCycles: [...f.runtimeCycles, ["src/no-such-a.ts", "src/no-such-b.ts"]],
      mutualDirectoryPairs: [...f.mutualDirectoryPairs, "src/no-such-a <-> src/no-such-b"],
    });
    expect(compareFacts(baseline, plus(current))).toEqual([
      "NEW cycle (2 files): src/no-such-a.ts, src/no-such-b.ts",
      "NEW mutual directory pair: src/no-such-a <-> src/no-such-b",
    ]);
    expect(compareFacts(plus(baseline), current)).toEqual([
      "GONE cycle (2 files): src/no-such-a.ts, src/no-such-b.ts",
      "GONE mutual directory pair: src/no-such-a <-> src/no-such-b",
    ]);
  });
});
