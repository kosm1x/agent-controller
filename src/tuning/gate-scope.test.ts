/**
 * S6 WS3a (deliverable 6): the eval gate scores the record-derived scope
 * groups the live process wires at boot — and, with no declaring record,
 * HEAD's classifier prompt byte for byte. Fresh modules per test (the
 * registrations are boot-once module state).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
// The gate inherits the live service env, so getConfig() loads there; here only
// the MCP config path matters (never the repo's mcp-servers.json).
const cfg = vi.hoisted(() => ({ path: "" }));
vi.mock("../config.js", () => ({ getConfig: () => ({ mcpConfigPath: cfg.path }) }));
/** Same pin as src/projects/scope-groups.test.ts (HEAD's classifier prompt). */
const HEAD_PROMPT_SHA256 = "328362a26a46747df0a2227a27ee135bfda41f2a8cb2176b8124531d40945281";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-gate-scope-"));
  writeFileSync(join(dir, "mcp-servers.json"), "{}"); // never the repo's file
  cfg.path = join(dir, "mcp-servers.json");
  vi.resetModules();
});

afterEach(async () => {
  const { closeDatabase } = await import("../db/index.js");
  closeDatabase();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function setup(rows: Array<[string, Record<string, unknown>]>) {
  const { initDatabase } = await import("../db/index.js");
  initDatabase(join(dir, "mc.db"));
  const { createProject } = await import("../db/projects.js");
  for (const [slug, config] of rows) createProject(slug, slug, { status: "active", config });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { ToolRegistry } = await import("../tools/registry.js");
  const { wireEvalGateProjectScopeGroups } = await import("./gate-tools.js");
  const wired = await wireEvalGateProjectScopeGroups(new ToolRegistry());
  return {
    names: wired.names,
    overrides: wired.scopePatternOverrides,
    classifier: await import("../messaging/scope-classifier.js"),
    scope: await import("../messaging/scope.js"),
  };
}

describe("wireEvalGateProjectScopeGroups", () => {
  it("a synthetic active row with routing.summary: the gate's prompt carries the line and the regex sees the group", async () => {
    const { names, classifier, scope } = await setup([
      ["syn-radar", { aliases: ["Synradar"], routing: { summary: "Synthetic radar runs" } }],
    ]);
    expect(names).toEqual(["syn-radar"]);
    expect(classifier.classifierSystemPrompt()).toContain("- syn-radar: Synthetic radar runs\n\nRULES:");
    expect(scope.detectActiveGroups("qué pasó con synradar", [], scope.DEFAULT_SCOPE_PATTERNS).has("syn-radar")).toBe(true);
  });

  it("the derived regex group is SCORED through runEvaluation (C1): alias case hits only with the gate's overrides", async () => {
    const { overrides, scope } = await setup([
      ["syn-radar", { aliases: ["Synradar"], routing: { summary: "Synthetic radar runs" } }],
    ]);
    expect(overrides).toHaveLength(scope.CODE_SCOPE_PATTERNS.length + 1);
    const { ensureTuningTables, insertTestCase } = await import("./schema.js");
    ensureTuningTables();
    insertTestCase({
      case_id: "sc-syn-radar",
      category: "scope_accuracy",
      input: { message: "qué pasó con synradar ayer" },
      expected: { scope_groups: ["syn-radar"] },
      weight: 1,
      source: "manual",
      active: true,
    });
    const { runEvaluation } = await import("./eval-runner.js");
    const scored = await runEvaluation({ scopePatternOverrides: overrides }, { category: "scope_accuracy" });
    expect(scored.perCase.map((c) => [c.caseId, c.score])).toEqual([["sc-syn-radar", 1]]);
    // HEAD's frozen code patterns alone never see the derived group
    const head = await runEvaluation({}, { category: "scope_accuracy" });
    expect(head.perCase.map((c) => [c.caseId, c.score])).toEqual([["sc-syn-radar", 0]]);
  });

  it("scripts/eval-gate.ts hands the wired overrides to the sandbox before any case runs", () => {
    const src = readFileSync(join(process.cwd(), "scripts", "eval-gate.ts"), "utf-8");
    const wire = src.indexOf("await wireEvalGateProjectScopeGroups(toolRegistry)");
    const assign = src.indexOf("sandbox.scopePatternOverrides = derivedScope.scopePatternOverrides;");
    const firstRun = src.indexOf("await runEvaluation(");
    expect(wire).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(wire);
    expect(firstRun).toBeGreaterThan(assign);
  });

  it("zero declaring records: the classifier prompt stays byte-identical to HEAD's", async () => {
    const { names, overrides, classifier } = await setup([["syn-plain", { aliases: ["Synplain"] }]]);
    expect(names).toEqual([]);
    expect(overrides).toBeUndefined(); // the gate runs exactly as before
    expect(classifier.classifierSystemPrompt()).toBe(classifier.CLASSIFIER_SYSTEM_PROMPT);
    expect(createHash("sha256").update(classifier.classifierSystemPrompt()).digest("hex")).toBe(HEAD_PROMPT_SHA256);
  });

  it("an MCP-only trusted record gets its group from the loaded config (no server spawned)", async () => {
    const { names, scope } = await setup([
      ["syn-mcp", { trusted: true, repos: [{ path: dir, role: "primary" }], capabilities: { mcp: [{ id: "synmcp", command: "/nonexistent" }] } }],
    ]);
    expect(names).toEqual(["syn-mcp"]);
    expect(scope.detectActiveGroups("run synmcp__digest", [], scope.DEFAULT_SCOPE_PATTERNS).has("syn-mcp")).toBe(true);
  });
});
