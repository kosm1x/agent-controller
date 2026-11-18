/**
 * Parse-only import graph of the production TypeScript files under
 * `<root>/src`, for the import-cycle lock test. Each file is read with
 * `ts.createSourceFile` alone: no program, no type checker, nothing of the
 * scanned code is imported or run.
 *
 * Files in the graph: every `.ts` file under `<root>/src`, except `*.test.ts`,
 * `*.d.ts`, everything under `src/test-utils/`, any `__fixtures__` folder and
 * any `node_modules` folder. File ids are paths relative to `<root>`, with `/`.
 *
 * Edge kinds, one per import statement or `import()` call:
 * - runtime: a static import or re-export that survives compilation. A
 *   side-effect import (`import "./x.js"`), `export * from`, `export * as n
 *   from`, `export { x } from` with at least one binding not marked `type`,
 *   and an import with a default, namespace or unmarked named binding when at
 *   least one of those names appears in a value position of the file.
 * - type: `import type`, `export type { … } from`, and an import or re-export
 *   whose every named binding is marked `type`. The compiler drops them.
 * - elided: an import with unmarked bindings none of whose names appears in a
 *   value position (only in types, `typeof` queries included). The compiler
 *   drops it as well. Without a type checker "appears" is by name, so a
 *   local that shadows an imported name keeps the import runtime: the error
 *   leans towards reporting an edge, never towards hiding one.
 * - dynamic: `import("…")` with a literal argument. A call with any other
 *   argument has no target; it is counted in `nonLiteralDynamic`.
 *
 * Only relative specifiers (starting with `.`) are edges; a package specifier
 * (`node:fs`, a dependency) is ignored. `./x.js` resolves to `x.ts`, else to
 * `x.d.ts`; a specifier without `.js` resolves to `x.ts`, else `x.d.ts`, else
 * `x/index.ts`. A relative
 * specifier that resolves to no `.ts` file is reported in `unresolved` (a
 * relative import of a JSON or `.mjs` file lands there too). One that resolves
 * to a test-utility or `__fixtures__` file is reported in `outsideGraph`: the
 * build ships those files, but the scan does not read them, so a cycle routed
 * through one would be invisible. One that resolves to a `*.test.ts` or
 * `*.d.ts` file is no edge: neither is part of the shipped runtime graph (the
 * build leaves tests out, and a declaration file emits no JavaScript).
 *
 * Cycles: strongly connected components of two or more files over the chosen
 * edge kinds (a file importing itself is no cycle). Mutual directory pairs:
 * two directories with a runtime edge from a file of each into a file of the
 * other; the directory of a file is its full directory path (`src` for files
 * directly under it, `src/lib/v8-3` for `src/lib/v8-3/x.ts`), so a nested
 * directory is its own directory.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import ts from "typescript";

export type EdgeKind = "runtime" | "type" | "elided" | "dynamic";

export interface ImportEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  line: number;
}

export interface ImportGraph {
  files: string[];
  edges: ImportEdge[];
  unresolved: Array<{ from: string; line: number; specifier: string }>;
  nonLiteralDynamic: Array<{ from: string; line: number }>;
  outsideGraph: Array<{ from: string; line: number; specifier: string; to: string }>;
}

/** What the lock test pins: the coupling of the tree, sorted and stable. */
export interface CouplingFacts {
  /** Runtime cycles, members sorted; larger cycles first, then by first member. */
  runtimeCycles: string[][];
  /** Sizes of the cycles when dynamic imports count as edges too, largest first. */
  runtimeWithDynamicCycleSizes: number[];
  /** `a <-> b` with a < b, sorted. */
  mutualDirectoryPairs: string[];
}

const isGraphFile = (id: string): boolean =>
  id.endsWith(".ts") &&
  !id.endsWith(".test.ts") &&
  !id.endsWith(".d.ts") &&
  !id.startsWith("src/test-utils/") &&
  !id.split("/").includes("__fixtures__");

/** Every `.ts` file under `<root>/src` (graph or not), as ids relative to `root`. */
function tsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

/** undefined: not relative (ignored); null: relative but no such file. */
function resolveSpecifier(from: string, spec: string, existing: Set<string>): string | null | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = posix.join(posix.dirname(from), spec);
  const stem = spec.endsWith(".js") ? base.slice(0, -3) : base;
  const candidates = spec.endsWith(".js") ? [`${stem}.ts`, `${stem}.d.ts`] : [`${base}.ts`, `${base}.d.ts`, `${base}/index.ts`];
  return candidates.find((c) => existing.has(c)) ?? null;
}

export function buildImportGraph(root: string): ImportGraph {
  const existing = new Set(tsFiles(root));
  const files = [...existing].filter(isGraphFile);
  const graph: ImportGraph = { files, edges: [], unresolved: [], nonLiteralDynamic: [], outsideGraph: [] };
  const graphFiles = new Set(files);
  for (const from of files) {
    const sf = ts.createSourceFile(from, readFileSync(join(root, from), "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const add = (specifier: string, kind: EdgeKind, node: ts.Node): void => {
      const to = resolveSpecifier(from, specifier, existing);
      if (to === null) graph.unresolved.push({ from, line: lineOf(node), specifier });
      else if (to === undefined) return;
      else if (graphFiles.has(to)) graph.edges.push({ from, to, kind, line: lineOf(node) });
      else if (!to.endsWith(".test.ts") && !to.endsWith(".d.ts")) graph.outsideGraph.push({ from, line: lineOf(node), specifier, to });
    };

    // Names in value positions, and the dynamic imports, in one walk.
    const valueNames = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) return;
      // A class's `extends X<T>` is an expression; every other type node holds no value.
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if ((ts.isExportDeclaration(node) || ts.isExportSpecifier(node)) && node.isTypeOnly) return;
      if (ts.isIdentifier(node)) valueNames.add(node.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) add(arg.text, "dynamic", node);
        else graph.nonLiteralDynamic.push({ from, line: lineOf(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.importClause;
        let kind: EdgeKind;
        if (!clause) kind = "runtime";
        else if (clause.isTypeOnly) kind = "type";
        else {
          const names: string[] = clause.name ? [clause.name.text] : [];
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
          else if (bindings) for (const el of bindings.elements) if (!el.isTypeOnly) names.push(el.name.text);
          kind = names.length === 0 ? "type" : names.some((n) => valueNames.has(n)) ? "runtime" : "elided";
        }
        add(st.moduleSpecifier.text, kind, st);
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const clause = st.exportClause;
        const allTypes = clause !== undefined && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly);
        add(st.moduleSpecifier.text, st.isTypeOnly || allTypes ? "type" : "runtime", st);
      }
    }
  }
  graph.edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line));
  return graph;
}

const byCycleOrder = (a: string[], b: string[]): number => b.length - a.length || (a[0] < b[0] ? -1 : 1);

/** Strongly connected components of size >= 2 over `kinds`; iterative Tarjan. */
export function cycles(graph: ImportGraph, kinds: readonly EdgeKind[]): string[][] {
  const next = new Map<string, string[]>(graph.files.map((f) => [f, []]));
  for (const e of graph.edges) if (kinds.includes(e.kind)) next.get(e.from)!.push(e.to);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const open = (v: string): void => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
  };
  for (const root of graph.files) {
    if (index.has(root)) continue;
    open(root);
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succ = next.get(frame.v)!;
      if (frame.i < succ.length) {
        const w = succ[frame.i++];
        if (!index.has(w)) {
          open(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      const v = frame.v;
      if (work.length > 0) {
        const u = work[work.length - 1].v;
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
      }
      if (low.get(v) !== index.get(v)) continue;
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length >= 2) out.push(component.sort());
    }
  }
  return out.sort(byCycleOrder);
}

/** Directory pairs joined by runtime edges in both directions. */
export function mutualDirectoryPairs(graph: ImportGraph): string[] {
  const dirEdges = new Set<string>();
  for (const e of graph.edges) if (e.kind === "runtime") dirEdges.add(`${posix.dirname(e.from)} -> ${posix.dirname(e.to)}`);
  const pairs: string[] = [];
  for (const key of dirEdges) {
    const [a, b] = key.split(" -> ");
    if (a < b && dirEdges.has(`${b} -> ${a}`)) pairs.push(`${a} <-> ${b}`);
  }
  return pairs.sort();
}

export function couplingFacts(graph: ImportGraph): CouplingFacts {
  return {
    runtimeCycles: cycles(graph, ["runtime"]),
    runtimeWithDynamicCycleSizes: cycles(graph, ["runtime", "dynamic"]).map((c) => c.length),
    mutualDirectoryPairs: mutualDirectoryPairs(graph),
  };
}

/** The exact text of a baseline file holding `facts`. */
export const serializeFacts = (facts: CouplingFacts): string => `${JSON.stringify(facts, null, 2)}\n`;

/**
 * Differences between a baseline and the current facts, both directions. NEW:
 * coupling the baseline does not hold. GONE: coupling the baseline holds that
 * the tree no longer has. An empty list means equal.
 */
export function compareFacts(baseline: CouplingFacts, current: CouplingFacts): string[] {
  const out: string[] = [];
  const cycleDiff = (from: string[][], other: string[][], word: string, joined: string): void => {
    const cycleOf = new Map<string, number>();
    other.forEach((c, i) => c.forEach((m) => cycleOf.set(m, i)));
    for (const c of from) {
      const known = c.filter((m) => cycleOf.has(m));
      if (known.length === 0) {
        out.push(`${word} cycle (${c.length} files): ${c.join(", ")}`);
        continue;
      }
      for (const m of c) if (!cycleOf.has(m)) out.push(`${word} cycle member: ${m} (in the cycle of ${known[0]})`);
      if (new Set(known.map((m) => cycleOf.get(m))).size > 1) out.push(`${word}: ${joined}: ${c.join(", ")}`);
    }
  };
  cycleDiff(current.runtimeCycles, baseline.runtimeCycles, "NEW", "separate cycles of the baseline are now one");
  cycleDiff(baseline.runtimeCycles, current.runtimeCycles, "GONE", "a cycle of the baseline is now split");
  const basePairs = new Set(baseline.mutualDirectoryPairs);
  const curPairs = new Set(current.mutualDirectoryPairs);
  for (const p of current.mutualDirectoryPairs) if (!basePairs.has(p)) out.push(`NEW mutual directory pair: ${p}`);
  for (const p of baseline.mutualDirectoryPairs) if (!curPairs.has(p)) out.push(`GONE mutual directory pair: ${p}`);
  const sizes = (s: number[]): string => `[${s.join(", ")}]`;
  if (sizes(baseline.runtimeWithDynamicCycleSizes) !== sizes(current.runtimeWithDynamicCycleSizes))
    out.push(
      `CHANGED cycle sizes with dynamic imports counted: baseline ${sizes(baseline.runtimeWithDynamicCycleSizes)}, now ${sizes(current.runtimeWithDynamicCycleSizes)}`,
    );
  return out;
}

/** The lock test's failure text: what differs, what each direction asks for, and the facts to copy. */
export function lockMessage(findings: string[], current: CouplingFacts): string {
  return [
    "The import coupling of src/ differs from src/lib/import-cycles.baseline.json:",
    ...findings.map((f) => `  - ${f}`),
    "NEW: something was coupled that the baseline does not hold. Cut it, or, if it is a deliberate choice, record it in the baseline in the same commit.",
    "GONE: a cut was made. Lower the baseline in the same commit, so the ground gained cannot be given back.",
    "An `import type` (also `export type { … } from`, or an import whose every binding is marked `type`) is not a runtime edge: an import needed only for types stops counting once it is written that way.",
    "The facts of the tree as it is now (the baseline file must hold exactly this text):",
    serializeFacts(current),
  ].join("\n");
}
