/**
 * S6 WS3 — record-derived scope groups: the pure derivation, the deferred-head
 * rule, and the one boot wiring (fresh module state per test via resetModules).
 * Synthetic records only.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDeferredHeadRule, deriveProjectScopeGroups } from "./scope-groups.js";

/** sha256 of HEAD 6d3104c's CLASSIFIER_SYSTEM_PROMPT (11,759 chars) — the paid-eval baseline text. */
const HEAD_PROMPT_SHA256 = "328362a26a46747df0a2227a27ee135bfda41f2a8cb2176b8124531d40945281";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ACME = {
  slug: "acme-radar",
  aliases: ["Acme", "radar ácme"],
  routing: { summary: "Acme radar: widget\nsightings and weekly runs" },
  serverIds: ["acme"],
};

describe("deriveProjectScopeGroups (pure)", () => {
  it("one group per record with a loaded server or a routing summary; others none", () => {
    const d = deriveProjectScopeGroups(
      [
        ACME,
        { slug: "summary-only", routing: { summary: "Summary only" }, serverIds: [] },
        { slug: "plain", aliases: ["plain"], serverIds: [] },
      ],
      new Set(["coding"]),
    );
    expect(d.groups).toEqual([
      { name: "acme-radar", prefixes: ["acme__"] },
      { name: "summary-only", prefixes: [] },
    ]);
    expect(d.promptLines).toEqual([
      "- acme-radar: Acme radar: widget sightings and weekly runs",
      "- summary-only: Summary only",
    ]);
    expect(d.regexes.map((r) => r.group)).toEqual(["acme-radar", "summary-only"]);
  });

  it("zero declaring records → nothing at all", () => {
    expect(deriveProjectScopeGroups([{ slug: "plain", serverIds: [] }], new Set())).toEqual({
      groups: [],
      promptLines: [],
      regexes: [],
      skipped: [],
      shortAliases: [],
    });
  });

  it("aliases shorter than 4 characters never enter the regex; counted per slug (audit R1 W6)", () => {
    const d = deriveProjectScopeGroups(
      [{ slug: "acme-radar", aliases: ["a", "de", "ñu ", "Acme"], serverIds: ["acme"] }],
      new Set(),
    );
    expect(d.shortAliases).toEqual([{ slug: "acme-radar", dropped: 3 }]);
    const re = d.regexes[0]!.pattern;
    for (const miss of ["dame la lista de tareas", "a ver", "el ñu"]) expect(re.test(miss), miss).toBe(false);
    expect(re.test("qué pasa con acme")).toBe(true);
    expect(re.test("lo de acme-radar")).toBe(true);
  });

  it("a slug equal to an existing group is skipped, never merged into it", () => {
    const d = deriveProjectScopeGroups([{ ...ACME, slug: "coding" }], new Set(["coding"]));
    expect(d.groups).toEqual([]);
    expect(d.skipped).toEqual(["coding"]);
  });

  it("alias regex: slug, aliases (accent-safe edges) and `<id>__tool`; no substring hits", () => {
    const re = deriveProjectScopeGroups([ACME], new Set()).regexes[0]!.pattern;
    for (const hit of ["dame el status de acme", "corre ACME-RADAR", "lo del radar ácme.", "usa acme__trigger_run"]) {
      expect(re.test(hit), hit).toBe(true);
    }
    for (const miss of ["acmeco", "superacme", "radar ácmex", "acme_x", "acme__"]) {
      expect(re.test(miss), miss).toBe(false);
    }
  });

  it("regex specials in an alias are literal", () => {
    const re = deriveProjectScopeGroups([{ slug: "c-plus", aliases: ["c++ (lab)"], serverIds: ["cp"] }], new Set())
      .regexes[0]!.pattern;
    expect(re.test("el c++ (lab) de hoy")).toBe(true);
    expect(re.test("cccc lab")).toBe(false);
  });
});

describe("deferred-head rule", () => {
  it("never defers every tool: the first stays eager; a partial list is kept as written", () => {
    expect([...applyDeferredHeadRule(["a", "b"], new Set(["a", "b"]))]).toEqual(["b"]);
    expect([...applyDeferredHeadRule(["a", "b"], new Set(["b"]))]).toEqual(["b"]);
    expect([...applyDeferredHeadRule([], new Set(["x"]))]).toEqual(["x"]);
  });
});

describe("wireProjectScopeGroups (boot wiring)", () => {
  beforeEach(() => vi.resetModules());

  const load = async () => ({
    wiring: await import("./scope-wiring.js"),
    classifier: await import("../messaging/scope-classifier.js"),
    scope: await import("../messaging/scope.js"),
    miss: await import("../messaging/scope-miss.js"),
  });
  const OPTS = { hasGoogle: false, hasWordpress: false, hasMemory: false, hasCrm: false };

  it("ZERO declaring records: the classifier prompt is byte-identical to HEAD's, nothing registered", async () => {
    const { wiring, classifier, scope } = await load();
    const groupsBefore = [...classifier.VALID_GROUPS];
    const patternsBefore = scope.DEFAULT_SCOPE_PATTERNS.length;
    const d = wiring.wireProjectScopeGroups(
      [
        { slug: "plain", status: "active", config: { aliases: ["plain"] } },
        // declares, but not active → no group
        { slug: "paused-proj", status: "paused", config: { routing: { summary: "Paused" } } },
      ],
      new Map(),
      () => [],
    );
    expect(d.groups).toEqual([]);
    expect(sha(classifier.classifierSystemPrompt())).toBe(HEAD_PROMPT_SHA256);
    expect(classifier.classifierSystemPrompt()).toBe(classifier.CLASSIFIER_SYSTEM_PROMPT);
    expect([...classifier.VALID_GROUPS]).toEqual(groupsBefore);
    expect(scope.DEFAULT_SCOPE_PATTERNS.length).toBe(patternsBefore);
  });

  it("boot wiring warns once per slug with dropped short aliases (count only)", async () => {
    const { wiring } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    wiring.wireProjectScopeGroups(
      [{ slug: "acme-radar", status: "active", config: { aliases: ["de", "a"], routing: { summary: "S" } } }],
      new Map(),
      () => [],
    );
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[scope] acme-radar: 2 alias(es) shorter than 4 characters left out of its scope regex",
    ]);
    warn.mockRestore();
  });

  it("ONE declaring record: group valid, prompt line before RULES, regex fallback, tools, scope-miss", async () => {
    const { wiring, classifier, scope, miss } = await load();
    const tools = ["acme__trigger_run", "acme__get_digest", "other__thing"];
    wiring.wireProjectScopeGroups(
      [{ slug: "acme-radar", status: "active", config: { aliases: ["Acme"], routing: { summary: "Acme radar runs" } } }],
      new Map([["acme-radar", ["acme"]]]),
      () => tools,
    );
    expect(classifier.VALID_GROUPS.has("acme-radar")).toBe(true);
    expect(classifier.parseScopeGroups('["acme-radar","coding"]')).toEqual(new Set(["acme-radar", "coding"]));
    const prompt = classifier.classifierSystemPrompt();
    expect(prompt).not.toBe(classifier.CLASSIFIER_SYSTEM_PROMPT);
    expect(prompt).toContain("- acme-radar: Acme radar runs\n\nRULES:");
    expect(prompt.replace("\n- acme-radar: Acme radar runs", "")).toBe(classifier.CLASSIFIER_SYSTEM_PROMPT);
    expect(scope.detectActiveGroups("qué pasó con acme", [], scope.DEFAULT_SCOPE_PATTERNS).has("acme-radar")).toBe(true);
    const scoped = scope.scopeToolsForMessage("x", [], scope.DEFAULT_SCOPE_PATTERNS, OPTS, new Set(["acme-radar"]));
    expect(scoped).toEqual(expect.arrayContaining(["acme__trigger_run", "acme__get_digest"]));
    expect(scoped).not.toContain("other__thing");
    expect(scope.getAllAvailableTools(OPTS).has("acme__get_digest")).toBe(true);
    expect(miss.groupsForTool("acme__trigger_run", OPTS)).toEqual(["acme-radar"]);
    // the tuning fingerprint input stays the code's
    expect(scope.CODE_SCOPE_PATTERNS.some((p) => p.group === "acme-radar")).toBe(false);
  });
});
