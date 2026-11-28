/**
 * The KB root leaf: the knowledge-base module re-exports its helper, the
 * environment function's three branches, and the leaf's imports.
 * The environment cases touch no file; the last case reads the source tree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DEFAULT_MIRROR_DIR, explicitMirrorDir, getJarvisKbRoot } from "./kb-root.js";
import { getJarvisKbRoot as kbModuleHelper } from "./jarvis-fs.js";
import { buildImportGraph } from "../test-utils/import-graph.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEAF = "src/db/kb-root.ts";
const SCRATCH = join(tmpdir(), "kb-root-test");

describe("kb-root", () => {
  it("the knowledge-base module's helper is the leaf's function", () => {
    expect(kbModuleHelper).toBe(getJarvisKbRoot);
  });

  it("an explicit JARVIS_KB_MIRROR_DIR wins over the test-runner fallback", () => {
    const env = {
      JARVIS_KB_MIRROR_DIR: join(SCRATCH, "explicit"),
      VITEST: "true",
      JARVIS_KB_VITEST_FALLBACK: join(SCRATCH, "fallback"),
    };
    expect(explicitMirrorDir(env)).toBe(join(SCRATCH, "explicit"));
  });

  it("under the test runner: the provided fallback, else a per-process dir in the temp folder", () => {
    expect(explicitMirrorDir({ VITEST: "true", JARVIS_KB_VITEST_FALLBACK: join(SCRATCH, "fallback") })).toBe(
      join(SCRATCH, "fallback"),
    );
    expect(explicitMirrorDir({ VITEST: "true" })).toBe(join(tmpdir(), `jarvis-kb-vitest-${process.pid}`));
  });

  it("with neither setting there is no env-chosen dir", () => {
    expect(explicitMirrorDir({})).toBeUndefined();
    expect(explicitMirrorDir({ VITEST: "" })).toBeUndefined();
  });

  it("with no env-chosen dir the helper returns the default directory", () => {
    const saved = { JARVIS_KB_MIRROR_DIR: process.env.JARVIS_KB_MIRROR_DIR, VITEST: process.env.VITEST };
    delete process.env.JARVIS_KB_MIRROR_DIR;
    delete process.env.VITEST;
    try {
      expect(getJarvisKbRoot()).toBe(DEFAULT_MIRROR_DIR);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the helper under the test runner returns the env-chosen dir, not the default", () => {
    expect(getJarvisKbRoot()).toBe(explicitMirrorDir(process.env));
    expect(getJarvisKbRoot()).not.toBe(DEFAULT_MIRROR_DIR);
  });

  it("the leaf imports node builtins and no module of this repository", () => {
    const g = buildImportGraph(ROOT);
    expect(g.files).toContain(LEAF);
    expect(g.edges.filter((e) => e.from === LEAF)).toEqual([]);
    expect(g.unresolved.filter((u) => u.from === LEAF)).toEqual([]);
    expect(g.outsideGraph.filter((o) => o.from === LEAF)).toEqual([]);
    expect(g.nonLiteralDynamic.filter((d) => d.from === LEAF)).toEqual([]);
    const sf = ts.createSourceFile(LEAF, readFileSync(join(ROOT, LEAF), "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const specifiers = sf.statements
      .filter((st): st is ts.ImportDeclaration | ts.ExportDeclaration => ts.isImportDeclaration(st) || ts.isExportDeclaration(st))
      .flatMap((st) => (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? [st.moduleSpecifier.text] : []));
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });
});
