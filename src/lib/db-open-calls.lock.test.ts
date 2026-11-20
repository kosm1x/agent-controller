/**
 * Lock test: opening the database does schema only, so the programs that need
 * the directive seed or the tuning-variant activation make those calls
 * themselves, right after the open. A program that loses one of them does not
 * fail: the service would boot without its directive rows or with the code
 * scope patterns, a container task would run without the directives in its
 * prompt. So each call site is pinned here, by source text (these files start
 * their program on import and are never imported by a test).
 *
 * Also pinned: the database module's import closure holds no file of the
 * tuning folder, which would bring the tool registry and the scope module
 * back into it.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportGraph } from "../test-utils/import-graph.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Source text with comments removed, so a commented-out call cannot satisfy a pin. */
function code(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("the service entry point", () => {
  it("opens, seeds, activates, regenerates the index, registers the tools, then wires the project scope groups", () => {
    const src = code("src/index.ts");
    const start = src.indexOf("async function main(");
    const end = src.indexOf("\nmain().catch(");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const main = src.slice(start, end);
    const steps = [
      "initDatabase(config.dbPath)",
      "seedDirectives()",
      "activateBestVariant()",
      "regenerateIndex()",
      "sourceManager.initAll(toolRegistry)",
      "wireProjectScopeGroups(",
    ];
    for (const s of steps) expect(count(main, s), s).toBe(1);
    const at = steps.map((s) => main.indexOf(s));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(main).toMatch(/initDatabase\(config\.dbPath\);\s*seedDirectives\(\);\s*activateBestVariant\(\);/);
  });
});

describe("the container workers", () => {
  // Their database is a fresh file inside the container: without the seed the
  // directive rows do not exist and the task prompt goes without them.
  it.each(["src/runners/heavy-worker.ts", "src/runners/nanoclaw-worker.ts"])("%s seeds the directives right after the open", (rel) => {
    const src = code(rel);
    expect(src).toMatch(/import \{ seedDirectives \} from "\.\.\/db\/jarvis-fs\.js";/);
    expect(count(src, "initDatabase(")).toBe(1);
    expect(src).toMatch(/initDatabase\(process\.env\.MC_DB_PATH \?\? "\/tmp\/mc\.db"\);\s*seedDirectives\(\);/);
  });
});

describe("the tuning programs", () => {
  it("the overnight tuning CLI activates the archived variant right after the open", () => {
    const src = code("src/tuning/run.ts");
    expect(src).toMatch(/import \{ activateBestVariant \} from "\.\/activation\.js";/);
    expect(count(src, "initDatabase(")).toBe(1);
    expect(src).toMatch(/initDatabase\(dbPath\);\s*activateBestVariant\(\);/);
  });

  it("the eval gate activates the archived variant right after opening its snapshot", () => {
    const src = code("scripts/eval-gate.ts");
    expect(src).toMatch(/const \{ activateBestVariant \} = await import\("\.\.\/src\/tuning\/activation\.js"\);/);
    expect(count(src, "initDatabase(")).toBe(1);
    expect(src).toMatch(/initDatabase\(snapPath\);\s*activateBestVariant\(\);/);
  });
});

describe("the database module", () => {
  it("neither seeds the directives nor activates a tuning variant", () => {
    const src = code("src/db/index.ts");
    expect(src).toContain("ensureTuningTables(_db);");
    expect(src).not.toContain("seedDirectives");
    expect(src).not.toContain("activateBestVariant");
  });

  it("reaches no file of the tuning folder through its imports", () => {
    const graph = buildImportGraph(REPO);
    const out = new Map<string, string[]>();
    for (const e of graph.edges)
      if (e.kind === "runtime" || e.kind === "dynamic") out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    const seen = new Set(["src/db/index.ts"]);
    const todo = ["src/db/index.ts"];
    while (todo.length > 0) {
      for (const to of out.get(todo.pop()!) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        todo.push(to);
      }
    }
    expect(seen.has("src/db/tuning-schema.ts")).toBe(true);
    expect([...seen].filter((f) => f.startsWith("src/tuning/"))).toEqual([]);
  });
});
