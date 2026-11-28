/**
 * Lock test: shell-check.ts, the shell tool's command text check, loads only a
 * fixed list of four files and the node builtins fs, path and os, and shell.ts
 * re-exports exactly its exported names. Text only: no scanned file is loaded.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildImportGraph, type ImportGraph } from "../../test-utils/import-graph.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHECK = "src/tools/builtin/shell-check.ts";
const SHELL = "src/tools/builtin/shell.ts";
const ALLOWED_FILES = [
  CHECK,
  "src/db/kb-root.ts",
  "src/tools/builtin/immutable-core.ts",
  "src/tools/builtin/write-boundary.ts",
  "src/tools/builtin/write-guard.ts",
].sort();
const ALLOWED_PACKAGES = new Set(["fs", "node:fs", "path", "node:path", "os", "node:os"]);

const parse = (root: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Files reached from `start` over runtime and literal dynamic edges, `start` included, sorted. */
function closureOf(g: ImportGraph, start: string): string[] {
  const seen = new Set([start]);
  const todo = [start];
  while (todo.length > 0) {
    const from = todo.pop()!;
    for (const e of g.edges) {
      if (e.from === from && (e.kind === "runtime" || e.kind === "dynamic") && !seen.has(e.to)) {
        seen.add(e.to);
        todo.push(e.to);
      }
    }
  }
  return [...seen].sort();
}

/** Every non-relative specifier of an import, export-from or literal `import()` in `files`, outside ALLOWED_PACKAGES. */
function packageFindings(root: string, files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const sf = parse(root, file);
    const note = (spec: string, node: ts.Node): void => {
      if (!spec.startsWith(".") && !ALLOWED_PACKAGES.has(spec))
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${spec}`);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        note(node.moduleSpecifier.text, node);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) note(arg.text, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Imports in `files` whose target the graph cannot see. */
function blindSpots(g: ImportGraph, files: string[]): string[] {
  const inside = new Set(files);
  return [
    ...g.unresolved.filter((u) => inside.has(u.from)).map((u) => `unresolved ${u.from}:${u.line} ${u.specifier}`),
    ...g.outsideGraph.filter((u) => inside.has(u.from)).map((u) => `outside the graph ${u.from}:${u.line} ${u.to}`),
    ...g.nonLiteralDynamic.filter((u) => inside.has(u.from)).map((u) => `non-literal import() ${u.from}:${u.line}`),
  ];
}

/** Names a file exports by declaration or by a local `export { … }`. */
function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    } else if (
      exported &&
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      names.push(st.name.text);
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const e of st.exportClause.elements) names.push(e.name.text);
    }
  }
  return names.sort();
}

/** Names a file declares at its top level. */
function topLevelNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    } else if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      names.add(st.name.text);
    }
  }
  return names;
}

describe("shell-check.ts loads without the rest of the shell tool", () => {
  let scanned: ImportGraph | undefined;
  // Every real-tree case that reads the graph comes through here, so each one fails when the start file is missing.
  const repo = (): ImportGraph => {
    scanned ??= buildImportGraph(REPO);
    expect(scanned.files, "the lock's start file is not in the graph").toContain(CHECK);
    return scanned;
  };

  // This case pays for reading and parsing the whole tree; the later ones reuse the scan.
  it("(a) its closure over runtime and literal dynamic imports is exactly the allow-list", { timeout: 60_000 }, () => {
    const g = repo();
    expect(g.files, "the lock's start file is not in the graph").toContain(CHECK);
    expect(closureOf(g, CHECK)).toEqual(ALLOWED_FILES);
  });

  it("(b) every package specifier in the closure is fs, path or os", () => {
    expect(packageFindings(REPO, closureOf(repo(), CHECK))).toEqual([]);
  });

  it("(c) no unresolved, out-of-graph or non-literal import in the closure", () => {
    expect(blindSpots(repo(), closureOf(repo(), CHECK))).toEqual([]);
  });

  it("(d) shell-check.ts has no import of shell.ts of any kind", () => {
    expect(repo().edges.filter((e) => e.from === CHECK && e.to === SHELL)).toEqual([]);
  });

  it("(e) shell.ts re-exports from shell-check.ts in one statement exactly the names it exports, and declares none of them", () => {
    const shell = parse(REPO, SHELL);
    const reexports = shell.statements.filter(
      (st): st is ts.ExportDeclaration =>
        ts.isExportDeclaration(st) && !!st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "./shell-check.js",
    );
    expect(reexports).toHaveLength(1);
    const clause = reexports[0].exportClause;
    expect(clause && ts.isNamedExports(clause)).toBe(true);
    const elements = (clause as ts.NamedExports).elements;
    expect(elements.filter((e) => e.propertyName !== undefined || e.isTypeOnly).map((e) => e.name.text)).toEqual([]);
    const wanted = exportedNames(parse(REPO, CHECK));
    expect(wanted).toContain("validateShellCommand");
    expect(elements.map((e) => e.name.text).sort()).toEqual(wanted);
    const local = topLevelNames(shell);
    expect(wanted.filter((n) => local.has(n))).toEqual([]);
  });
});

describe("the lock's checks, on a temporary tree", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const BASE: Record<string, string> = {
    [CHECK]: [
      'import { existsSync } from "fs";',
      'import { a } from "./immutable-core.js";',
      'import { resolve } from "path";',
      'import { k } from "../../db/kb-root.js";',
      'import { w } from "./write-guard.js";',
      'import { b } from "./write-boundary.js";',
      "export const check = () => [existsSync, a, resolve, k, w, b];",
    ].join("\n"),
    "src/tools/builtin/immutable-core.ts": 'import { w } from "./write-guard.js";\nexport const a = () => w;\n',
    "src/tools/builtin/write-guard.ts": 'import { join } from "node:path";\nexport const w = () => join;\n',
    "src/tools/builtin/write-boundary.ts": 'import { a } from "./immutable-core.js";\nexport const b = () => a;\n',
    "src/db/kb-root.ts": 'import { tmpdir } from "node:os";\nexport const k = () => tmpdir;\n',
    "src/db/index.ts": "export const db = 1;\n",
    [SHELL]: 'export { check } from "./shell-check.js";\n',
  };

  /** A throwaway tree: BASE with `change` applied; keys are paths relative to its root. */
  function fixture(change: Record<string, string>): { root: string; g: ImportGraph } {
    const root = mkdtempSync(join(tmpdir(), "shell-check-graph-"));
    roots.push(root);
    for (const [path, text] of Object.entries({ ...BASE, ...change })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return { root, g: buildImportGraph(root) };
  }

  it("the unchanged tree passes every check", () => {
    const { root, g } = fixture({});
    const files = closureOf(g, CHECK);
    expect(files).toEqual(ALLOWED_FILES);
    expect(packageFindings(root, files)).toEqual([]);
    expect(blindSpots(g, files)).toEqual([]);
  });

  it("a relative import of a module outside the allow-list widens the closure", () => {
    const { g } = fixture({ "src/db/kb-root.ts": 'import { db } from "./index.js";\nexport const k = () => db;\n' });
    expect(closureOf(g, CHECK)).toEqual([...ALLOWED_FILES, "src/db/index.ts"].sort());
  });

  it("a package specifier other than fs, path or os is reported", () => {
    const { root, g } = fixture({ "src/tools/builtin/write-guard.ts": 'import { spawn } from "child_process";\nexport const w = () => spawn;\n' });
    expect(packageFindings(root, closureOf(g, CHECK))).toEqual(["src/tools/builtin/write-guard.ts:1 child_process"]);
  });

  it("a non-literal dynamic import is reported", () => {
    const { g } = fixture({
      "src/tools/builtin/write-boundary.ts": 'import { a } from "./immutable-core.js";\nexport const b = (n: string) => [a, import(n)];\n',
    });
    expect(blindSpots(g, closureOf(g, CHECK))).toEqual(["non-literal import() src/tools/builtin/write-boundary.ts:2"]);
  });
});
