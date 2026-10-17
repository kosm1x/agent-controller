import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  runEvaluation,
  summarizeReachability,
  defaultInferFunction,
  type InferFunction,
} from "./eval-runner.js";
import { initDatabase, closeDatabase } from "../db/index.js";
import { ensureTuningTables, insertTestCase } from "./schema.js";
import { toolRegistry } from "../tools/registry.js";
import type { TestCase, CaseScore } from "./types.js";

// Only `infer` is replaced (defaultInferFunction's link to the adapter);
// every other adapter export stays real.
const { adapterInfer } = vi.hoisted(() => ({ adapterInfer: vi.fn() }));
vi.mock("../inference/adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../inference/adapter.js")>()),
  infer: adapterInfer,
}));

// Synthetic stand-ins for registered tools. web_search + user_fact_set are
// core-scope (always offered); wp_publish is registered but scoped out of a
// message with no WordPress keyword. "zz_never_registered" is never registered.
beforeAll(() => {
  for (const name of ["web_search", "user_fact_set", "wp_publish"]) {
    toolRegistry.register({
      name,
      definition: {
        type: "function",
        function: {
          name,
          description: "t",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => "",
    } as never);
  }
});

// Use in-memory database for tests
beforeEach(() => {
  initDatabase(":memory:");
  ensureTuningTables();
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

function makeScopeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    case_id: "sc-test-01",
    category: "scope_accuracy",
    input: { message: "Revisa el código del proyecto" },
    expected: { scope_groups: ["coding"] },
    weight: 1.0,
    source: "manual",
    active: true,
    ...overrides,
  };
}

function makeClassificationCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    case_id: "cl-test-01",
    category: "classification",
    input: { message: "Busca el clima" },
    expected: { agent_type: "fast" },
    weight: 1.0,
    source: "manual",
    active: true,
    ...overrides,
  };
}

function makeToolSelectionCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    case_id: "ts-test-01",
    category: "tool_selection",
    input: { message: "Busca cuánto cuesta un vuelo" },
    expected: { tools: ["web_search"] },
    weight: 1.0,
    source: "manual",
    active: true,
    ...overrides,
  };
}

describe("runEvaluation", () => {
  it("evaluates scope_accuracy cases without LLM calls", async () => {
    insertTestCase(makeScopeCase());

    const result = await runEvaluation({}, { category: "scope_accuracy" });

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].category).toBe("scope_accuracy");
    expect(result.perCase[0].score).toBe(1.0); // "código" matches coding
    expect(result.totalTokens).toBe(0);
    expect(result.subscores.scopeAccuracy).toBe(100);
  });

  it("evaluates classification cases without LLM calls", async () => {
    insertTestCase(makeClassificationCase());

    const result = await runEvaluation({}, { category: "classification" });

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].score).toBe(1.0); // short message → fast
    expect(result.subscores.classification).toBe(100);
  });

  it("evaluates tool_selection cases with mock inference", async () => {
    insertTestCase(makeToolSelectionCase());

    const mockInfer: InferFunction = async () => ({
      toolsCalled: ["web_search"],
      tokensUsed: 150,
    });

    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].score).toBe(1.0);
    expect(result.totalTokens).toBe(150);
  });

  it("returns 0 composite for empty test suite", async () => {
    const result = await runEvaluation();
    expect(result.compositeScore).toBe(0);
    expect(result.perCase).toHaveLength(0);
  });

  it("computes composite score across mixed categories", async () => {
    insertTestCase(makeScopeCase());
    insertTestCase(makeClassificationCase());
    insertTestCase(makeToolSelectionCase());

    const mockInfer: InferFunction = async () => ({
      toolsCalled: ["web_search"],
      tokensUsed: 100,
    });

    const result = await runEvaluation({}, undefined, mockInfer);

    expect(result.perCase).toHaveLength(3);
    // All pass → composite should be 100
    expect(result.compositeScore).toBe(100);
  });

  it("filters by caseIds", async () => {
    insertTestCase(makeScopeCase({ case_id: "sc-a" }));
    insertTestCase(makeScopeCase({ case_id: "sc-b" }));

    const result = await runEvaluation({}, { caseIds: ["sc-a"] });

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].caseId).toBe("sc-a");
  });

  it("handles scope pattern overrides in sandbox", async () => {
    // Test case expects "coding" group for "Kubernetes pods". (Was "Docker
    // containers" until 2026-09-18, when bare `docker` joined the coding
    // regex — the fixture must be a word the default patterns truly miss.)
    insertTestCase(
      makeScopeCase({
        case_id: "sc-kubernetes",
        input: { message: "Lista los pods de Kubernetes" },
        expected: { scope_groups: ["coding"] },
      }),
    );

    // Default patterns don't include "kubernetes" → should fail
    const resultDefault = await runEvaluation(
      {},
      { category: "scope_accuracy" },
    );
    expect(resultDefault.perCase[0].score).toBe(0); // "kubernetes" not in coding regex

    // Override with pattern that includes kubernetes → should pass
    const resultOverride = await runEvaluation(
      {
        scopePatternOverrides: [
          { pattern: /\b(kubernetes|code|archivos?)/i, group: "coding" },
        ],
      },
      { category: "scope_accuracy" },
    );
    expect(resultOverride.perCase[0].score).toBe(1.0);
  });

  it("records error as 0 score when case evaluation throws", async () => {
    insertTestCase(makeToolSelectionCase());

    const failingInfer: InferFunction = async () => {
      throw new Error("API unavailable");
    };

    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      failingInfer,
    );

    expect(result.perCase).toHaveLength(1);
    expect(result.perCase[0].score).toBe(0);
    expect(result.perCase[0].details.error).toContain("API unavailable");
  });

  it("scores only offered expected tools and splits unreachable into notRegistered / scopedOut (2026-10-04)", async () => {
    insertTestCase(
      makeToolSelectionCase({
        expected: { tools: ["web_search", "wp_publish", "zz_never_registered"] },
      }),
    );
    const mockInfer: InferFunction = async () => ({
      toolsCalled: ["web_search"],
      tokensUsed: 10,
    });

    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );

    expect(result.perCase).toHaveLength(1);
    const d = result.perCase[0].details;
    expect(result.perCase[0].score).toBe(1);
    expect(result.perCase[0].excluded).toBeUndefined();
    expect(d.offered).toEqual(["web_search"]);
    expect(d.notRegistered).toEqual(["zz_never_registered"]);
    expect(d.scopedOut).toEqual(["wp_publish"]);
    expect(d.maxPoints).toBe(1);
    expect(result.reachability).toEqual({
      casesExcluded: 0,
      excludedCases: [],
      slotsOffered: 1,
      slotsNotRegistered: 1,
      slotsScopedOut: 1,
    });
  });

  it("excludes a case with none of its expected tools offered — no call, not averaged, counted", async () => {
    insertTestCase(
      makeToolSelectionCase({
        case_id: "ts-unreachable",
        expected: { tools: ["wp_publish", "zz_never_registered"] },
      }),
    );
    insertTestCase(
      makeToolSelectionCase({
        case_id: "ts-reachable",
        expected: { tools: ["web_search"] },
      }),
    );
    const mockInfer = vi.fn<InferFunction>(async () => ({
      toolsCalled: [],
      tokensUsed: 5,
    }));

    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );

    // One probe only: the reachable case. It missed → subscore 0, and the
    // excluded case did NOT enter the average as a 0 or a 1.
    expect(mockInfer).toHaveBeenCalledTimes(1);
    expect(result.perCase.map((c) => c.caseId)).toEqual(["ts-reachable"]);
    expect(result.subscores.toolSelection).toBe(0);
    expect(result.estimatedCostUsd).toBeCloseTo(0.03);
    expect(result.reachability.casesExcluded).toBe(1);
    const ex = result.reachability.excludedCases[0];
    expect(ex.caseId).toBe("ts-unreachable");
    expect(ex.excluded).toBe(true);
    expect(ex.details.notRegistered).toEqual(["zz_never_registered"]);
    expect(ex.details.scopedOut).toEqual(["wp_publish"]);
    expect(ex.details.tokensUsed).toBe(0);
    expect(result.reachability.slotsOffered).toBe(1);
    expect(result.reachability.slotsNotRegistered).toBe(1);
    expect(result.reachability.slotsScopedOut).toBe(1);
  });

  it("an all-excluded tool_selection population scores 0 and says so in reachability", async () => {
    insertTestCase(
      makeToolSelectionCase({ expected: { tools: ["zz_never_registered"] } }),
    );
    const mockInfer = vi.fn<InferFunction>();
    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );
    expect(mockInfer).not.toHaveBeenCalled();
    expect(result.perCase).toHaveLength(0);
    expect(result.reachability.casesExcluded).toBe(1);
  });

  it("multi-tool case scores any-hit through the runner", async () => {
    insertTestCase(
      makeToolSelectionCase({
        expected: { tools: ["web_search", "user_fact_set"] },
      }),
    );
    const mockInfer: InferFunction = async () => ({
      toolsCalled: ["user_fact_set"],
      tokensUsed: 1,
    });
    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );
    expect(result.perCase[0].score).toBe(1);
    expect(result.perCase[0].details.proportionalScore).toBe(0.5);
  });

  it("sends no system message by default; probeSystemPrompt adds one built from the offered tools", async () => {
    insertTestCase(makeToolSelectionCase());
    const seen: Array<{ role: string; content: unknown }[]> = [];
    const mockInfer: InferFunction = async (messages) => {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return { toolsCalled: ["web_search"], tokensUsed: 1 };
    };

    await runEvaluation({}, { category: "tool_selection" }, mockInfer);
    expect(seen[0].map((m) => m.role)).toEqual(["user"]);

    const builder = vi.fn((tools: string[]) => `SYS ${tools.length}`);
    await runEvaluation(
      { probeSystemPrompt: builder },
      { category: "tool_selection" },
      mockInfer,
    );
    expect(seen[1].map((m) => m.role)).toEqual(["system", "user"]);
    const offered = builder.mock.calls[0][0];
    expect(offered).toContain("web_search");
    expect(offered).not.toContain("wp_publish");
    expect(seen[1][0].content).toBe(`SYS ${offered.length}`);
  });
});

describe("per-case output carries no message text (--percase-out)", () => {
  it("scored and excluded case details hold tool names and scores, never the case message", async () => {
    const msg = "Mensaje sintetico unico zq9 para la prueba de salida";
    insertTestCase(
      makeToolSelectionCase({ case_id: "ts-a", input: { message: msg } }),
    );
    insertTestCase(
      makeToolSelectionCase({
        case_id: "ts-b",
        input: { message: msg },
        expected: { tools: ["zz_never_registered"] },
      }),
    );
    const result = await runEvaluation({}, undefined, async () => ({
      toolsCalled: ["web_search"],
      tokensUsed: 1,
    }));
    const out = JSON.stringify([
      ...result.perCase,
      ...result.reachability.excludedCases,
    ]);
    expect(result.perCase).toHaveLength(1);
    expect(result.reachability.excludedCases).toHaveLength(1);
    expect(out).not.toContain("zq9");
  });
});

describe("population needs no inference (eval-gate pre-spend check, R2-N1)", () => {
  it("a mock pass yields the same probed/excluded ids as a run whose probes throw", async () => {
    insertTestCase(makeToolSelectionCase({ case_id: "ts-a" }));
    insertTestCase(
      makeToolSelectionCase({
        case_id: "ts-b",
        expected: { tools: ["zz_never_registered"] },
      }),
    );
    const ids = (r: Awaited<ReturnType<typeof runEvaluation>>) => ({
      probed: r.perCase.filter((c) => c.category === "tool_selection").map((c) => c.caseId),
      excluded: r.reachability.excludedCases.map((c) => c.caseId),
    });
    const free = await runEvaluation({}, undefined, async () => ({
      toolsCalled: [],
      tokensUsed: 0,
    }));
    const outage = await runEvaluation({}, undefined, async () => {
      throw new Error("synthetic outage");
    });
    expect(ids(free)).toEqual({ probed: ["ts-a"], excluded: ["ts-b"] });
    expect(ids(outage)).toEqual(ids(free));
    // the errored probe is recorded with details.error (counted by the gate)
    expect(outage.perCase[0]!.details.error).toBeDefined();
  });
});

describe("summarizeReachability", () => {
  it("sums offered / notRegistered / scopedOut over scored and excluded tool_selection cases only", () => {
    const ts = (id: string, d: Record<string, unknown>, excluded = false) =>
      ({
        caseId: id,
        category: "tool_selection",
        score: 0,
        details: d,
        ...(excluded ? { excluded: true } : {}),
      }) as CaseScore;
    const scope = {
      caseId: "sc",
      category: "scope_accuracy",
      score: 1,
      details: { offered: ["x"] },
    } as CaseScore;
    const ex = ts("b", { offered: [], notRegistered: ["n"], scopedOut: ["s", "t"] }, true);
    const r = summarizeReachability(
      [ts("a", { offered: ["o1", "o2"], notRegistered: [], scopedOut: ["s"] }), scope],
      [ex],
    );
    expect(r).toEqual({
      casesExcluded: 1,
      excludedCases: [ex],
      slotsOffered: 2,
      slotsNotRegistered: 1,
      slotsScopedOut: 3,
    });
  });
});


describe("multi-round probe (scoring v3)", () => {
  const [A, B] = ["web_search", "user_fact_set"];

  it("an expected tool called in round 2 scores 1 with hitRound 2", async () => {
    insertTestCase(makeToolSelectionCase({ expected: { tools: [B] } }));
    const seenRounds: Array<number | undefined> = [];
    const mockInfer: InferFunction = async (_m, _t, opts) => {
      seenRounds.push(opts?.probeRounds);
      return { toolsCalled: [A, B], callRounds: [1, 2], tokensUsed: 1 };
    };
    const result = await runEvaluation(
      { probeRounds: 3 },
      { category: "tool_selection" },
      mockInfer,
    );
    const d = result.perCase[0].details;
    expect(seenRounds).toEqual([3]);
    expect(result.perCase[0].score).toBe(1);
    expect(d.rounds).toBe(3);
    expect(d.hitRound).toBe(2);
    expect(d.calledByRound).toEqual([[A], [B], []]);
    expect(d.sourceGroup).toBe("seed");
  });

  it("a forbidden tool called in round 2 is a violation", async () => {
    insertTestCase(
      makeToolSelectionCase({ expected: { tools: [A], not_tools: [B] } }),
    );
    const mockInfer: InferFunction = async () => ({
      toolsCalled: [A, B],
      callRounds: [1, 2],
      tokensUsed: 1,
    });
    const result = await runEvaluation(
      { probeRounds: 3 },
      { category: "tool_selection" },
      mockInfer,
    );
    expect(result.perCase[0].details.violations).toEqual([B]);
    expect(result.perCase[0].score).toBe(0);
    expect(result.perCase[0].details.hitRound).toBe(1);
  });

  it("probeRounds absent = 1 round: same score as the single-round probe", async () => {
    insertTestCase(makeToolSelectionCase());
    const seenRounds: Array<number | undefined> = [];
    const mockInfer: InferFunction = async (_m, _t, opts) => {
      seenRounds.push(opts?.probeRounds);
      return { toolsCalled: [A], tokensUsed: 1 };
    };
    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );
    const d = result.perCase[0].details;
    expect(seenRounds).toEqual([1]);
    expect(result.perCase[0].score).toBe(1);
    expect(d.rounds).toBe(1);
    expect(d.hitRound).toBe(1);
    expect(d.calledByRound).toEqual([[A]]);
  });

  it("hitRound is clamped to the configured rounds like calledByRound", async () => {
    insertTestCase(makeToolSelectionCase());
    const mockInfer: InferFunction = async () => ({
      toolsCalled: [A],
      callRounds: [5],
      tokensUsed: 1,
    });
    const result = await runEvaluation(
      { probeRounds: 3 },
      { category: "tool_selection" },
      mockInfer,
    );
    const d = result.perCase[0].details;
    expect(d.hitRound).toBe(3);
    expect(d.calledByRound).toEqual([[], [], [A]]);
  });

  it("a miss records hitRound null", async () => {
    insertTestCase(makeToolSelectionCase({ expected: { tools: [B] } }));
    const mockInfer: InferFunction = async () => ({
      toolsCalled: [A],
      callRounds: [1],
      tokensUsed: 1,
    });
    const result = await runEvaluation(
      { probeRounds: 3 },
      { category: "tool_selection" },
      mockInfer,
    );
    expect(result.perCase[0].score).toBe(0);
    expect(result.perCase[0].details.hitRound).toBeNull();
  });

  it("tags each case with its source group (seed / mined / flywheel)", async () => {
    const { getDatabase } = await import("../db/index.js");
    insertTestCase(makeToolSelectionCase({ case_id: "ts-seed-01" }));
    const ins = getDatabase().prepare(
      "INSERT INTO mined_test_cases (case_id, category, input, expected, weight, source, active) VALUES (?, 'tool_selection', ?, ?, 1.0, ?, 1)",
    );
    const input = JSON.stringify({ message: "Busca cuánto cuesta un vuelo" });
    const expected = JSON.stringify({ tools: [A] });
    ins.run("ts-mined-01", input, expected, "mined");
    ins.run("ts-fly-01", input, expected, "flywheel");
    const mockInfer: InferFunction = async () => ({
      toolsCalled: [A],
      tokensUsed: 1,
    });
    const result = await runEvaluation(
      {},
      { category: "tool_selection" },
      mockInfer,
    );
    const byId = Object.fromEntries(
      result.perCase.map((c) => [c.caseId, c.details.sourceGroup]),
    );
    expect(byId).toEqual({
      "ts-seed-01": "seed",
      "ts-mined-01": "mined",
      "ts-fly-01": "flywheel",
    });
  });
});

describe("defaultInferFunction (gate -> infer link)", () => {
  const messages = [{ role: "user" as const, content: "synthetic request" }];
  beforeEach(() => adapterInfer.mockReset());

  it("forwards probeRounds to infer and maps probe_call_rounds into callRounds", async () => {
    adapterInfer.mockResolvedValueOnce({
      content: "",
      tool_calls: [
        { id: "1", type: "function", function: { name: "tool_a", arguments: "{}" } },
        { id: "2", type: "function", function: { name: "tool_b", arguments: "{}" } },
      ],
      probe_call_rounds: [1, 2],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const out = await defaultInferFunction(messages, [], { probeRounds: 3 });
    expect(adapterInfer).toHaveBeenCalledTimes(1);
    expect(adapterInfer.mock.calls[0][0].probeRounds).toBe(3);
    expect(out).toEqual({
      toolsCalled: ["tool_a", "tool_b"],
      callRounds: [1, 2],
      tokensUsed: 7,
    });
  });

  it("omitting the option forwards undefined and yields no callRounds (single round)", async () => {
    adapterInfer.mockResolvedValueOnce({
      content: "",
      tool_calls: [
        { id: "1", type: "function", function: { name: "tool_a", arguments: "{}" } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const out = await defaultInferFunction(messages, []);
    expect(adapterInfer).toHaveBeenCalledTimes(1);
    expect(adapterInfer.mock.calls[0][0].probeRounds).toBeUndefined();
    expect(out.callRounds).toBeUndefined();
    expect(out.toolsCalled).toEqual(["tool_a"]);
  });
});

describe("scope_prompt: scope cases replayed through the LLM classifier (queue 3j)", () => {
  // The REAL classifyScopeGroups, its `infer` = the mocked adapter above.
  // Sonnet path forced: the Jev vendor path must never run in a test.
  beforeEach(() => {
    vi.stubEnv("SCOPE_CLASSIFIER_PROVIDER", "sonnet");
    adapterInfer.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  const reply = (content: string) =>
    adapterInfer.mockResolvedValue({ content, usage: { prompt_tokens: 1, completion_tokens: 1 } });

  async function classifier() {
    return (await import("../messaging/scope-classifier.js")).classifyScopeGroups;
  }

  function seedThree() {
    insertTestCase(makeScopeCase({ case_id: "sc-p-exact", input: { message: "Revisa el código" }, expected: { scope_groups: ["coding"] } }));
    insertTestCase(makeScopeCase({ case_id: "sc-p-partial", input: { message: "Revisa el código y el correo" }, expected: { scope_groups: ["coding", "google"] } }));
    insertTestCase(makeScopeCase({ case_id: "sc-p-wrong", input: { message: "Publica el post" }, expected: { scope_groups: ["wordpress"], not_scope_groups: ["coding"] } }));
  }

  it("scores the classifier's groups against the labels: correct 1, partial 0.5, incorrect 0", async () => {
    seedThree();
    reply('["coding"]');
    const result = await runEvaluation(
      { scopePromptClassifier: await classifier() },
      { category: "scope_accuracy" },
    );
    const prompt = result.perCase.filter((c) => c.category === "scope_prompt");
    expect(prompt.map((c) => [c.caseId, c.score])).toEqual([
      ["sc-p-exact", 1],
      ["sc-p-partial", 0.5],
      ["sc-p-wrong", 0],
    ]);
    expect(prompt[1].details).toMatchObject({
      expectedGroups: ["coding", "google"],
      activeGroups: ["coding"],
      hits: ["coding"],
      misses: ["google"],
      sourceGroup: "seed",
    });
    expect(prompt[2].details).toMatchObject({ misses: ["wordpress"], violations: ["coding"] });
    // queue 4e: every row carries the group names the gate lists
    expect(prompt.map((c) => [c.details.expected_groups, c.details.answered_groups])).toEqual([
      [["coding"], ["coding"]],
      [["coding", "google"], ["coding"]],
      [["wordpress"], ["coding"]],
    ]);
    expect(prompt.every((c) => c.details.error === undefined)).toBe(true);
    // the answering classifier is recorded (Sonnet path: Jev is off here)
    expect(prompt.map((c) => c.details.provider)).toEqual(["sonnet", "sonnet", "sonnet"]);
    // the regex rows are still scored beside them
    expect(result.perCase.filter((c) => c.category === "scope_accuracy")).toHaveLength(3);
    // one classifier call per case, with the LIVE prompt
    expect(adapterInfer).toHaveBeenCalledTimes(3);
    const { classifierSystemPrompt } = await import("../messaging/scope-classifier.js");
    const sent = adapterInfer.mock.calls[0][0].messages;
    expect(sent[0]).toEqual({ role: "system", content: classifierSystemPrompt() });
    expect(sent[1].content).toContain("User message:\nRevisa el código");
  });

  it("the category is in the aggregate (own subscore, 0.15 of the scope weight) and the cost", async () => {
    seedThree();
    reply('["coding"]');
    const r = await runEvaluation(
      { scopePromptClassifier: await classifier() },
      { category: "scope_accuracy" },
    );
    expect(r.subscores.scopePrompt).toBeCloseTo(50, 10);
    expect(r.compositeScore).toBeCloseTo(
      r.subscores.scopeAccuracy * 0.15 + 50 * 0.15,
      10,
    );
    expect(r.estimatedCostUsd).toBeCloseTo(3 * 0.03, 10);
  });

  it("the category is in the population digest", async () => {
    seedThree();
    reply('["coding"]');
    const { populationIds, populationDigests, caseIdDigest } = await import("./gate.js");
    const r = await runEvaluation(
      { scopePromptClassifier: await classifier() },
      { category: "scope_accuracy" },
    );
    const ids = populationIds(r);
    expect(ids.scopePromptIds).toEqual(["sc-p-exact", "sc-p-partial", "sc-p-wrong"]);
    const d = populationDigests(ids.probedIds, ids.excludedIds, ids.scopePromptIds);
    expect(d.scopePromptCaseIds).toEqual(
      ["sc-p-exact", "sc-p-partial", "sc-p-wrong"].map(caseIdDigest).sort(),
    );
  });

  it("an inference error scores the case 0 with an error reason, never a throw", async () => {
    insertTestCase(makeScopeCase({ case_id: "sc-p-neg", input: { message: "hola" }, expected: { not_scope_groups: ["coding"] } }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    adapterInfer.mockRejectedValue(new Error("synthetic outage"));
    const r = await runEvaluation(
      { scopePromptClassifier: await classifier() },
      { category: "scope_accuracy" },
    );
    const row = r.perCase.find((c) => c.category === "scope_prompt")!;
    expect(row.score).toBe(0);
    expect(row.details.error).toMatch(/^classifier returned null/);
    expect(row.details.provider).toBe("none");
    expect([row.details.expected_groups, row.details.answered_groups]).toEqual([[], []]);
    // the regex row is unaffected (forbidden-only case, no coding keyword)
    expect(r.perCase.find((c) => c.category === "scope_accuracy")!.score).toBe(1);

    // an unparseable reply is a null answer too
    reply("no idea");
    const r2 = await runEvaluation(
      { scopePromptClassifier: await classifier() },
      { category: "scope_accuracy" },
    );
    expect(r2.perCase.find((c) => c.category === "scope_prompt")!.details.error).toMatch(/^classifier returned null/);

    // a classifier that throws is recorded, not propagated
    const r3 = await runEvaluation(
      { scopePromptClassifier: async () => { throw new Error("boom"); } },
      { category: "scope_accuracy" },
    );
    const row3 = r3.perCase.find((c) => c.category === "scope_prompt")!;
    expect([row3.score, row3.details.error, row3.details.provider]).toEqual([0, "Error: boom", "none"]);
    expect(row3.details.answered_groups).toEqual([]);
  });

  it("queue 4e: an errored row with labels keeps expected_groups and answers nothing (null and throw)", async () => {
    insertTestCase(makeScopeCase({ case_id: "sc-p-err", expected: { scope_groups: ["coding"] } }));
    const { scopePromptRowLines } = await import("./gate.js");
    for (const scopePromptClassifier of [
      async () => null,
      async () => {
        throw new Error("boom");
      },
    ]) {
      const r = await runEvaluation({ scopePromptClassifier }, { category: "scope_accuracy" });
      const row = r.perCase.find((c) => c.category === "scope_prompt")!;
      expect(row.details.error).toBeDefined();
      expect([row.details.expected_groups, row.details.answered_groups]).toEqual([["coding"], []]);
      expect(scopePromptRowLines(r.perCase)).toEqual([
        "    sc-p-err  errored  expected=coding  answered=-  provider=none",
      ]);
    }
  });

  it("mirrors the router's inputs: normalized message, recentContext = last turn + raw message, wholeTurns", async () => {
    insertTestCase(
      makeScopeCase({
        case_id: "sc-p-hist",
        input: {
          message: "y ahora el otro",
          conversationHistory: [
            { role: "user", content: "primer turno sintetico" },
            { role: "assistant", content: "respuesta sintetica" },
          ],
        },
        expected: { scope_groups: ["coding"] },
      }),
    );
    const seen: unknown[][] = [];
    const r = await runEvaluation(
      { scopePromptClassifier: async (...args) => { seen.push(args); return new Set(["coding"]); } },
      { category: "scope_accuracy" },
    );
    expect(typeof seen[0][3]).toBe("function"); // the provider callback
    expect(seen.map((args) => args.slice(0, 3))).toEqual([
      [
        "y ahora el otro",
        "assistant: respuesta sintetica\nuser: y ahora el otro",
        ["respuesta sintetica", "y ahora el otro"],
      ],
    ]);
    expect(r.perCase.find((c) => c.category === "scope_prompt")!.score).toBe(1);
  });

  it("classifyScopeGroups reports sonnet / none, and a throwing callback never changes the answer", async () => {
    const classify = await classifier();
    reply('["coding"]');
    const told: string[] = [];
    expect(await classify("Revisa el código", undefined, undefined, (p) => told.push(p))).toEqual(new Set(["coding"]));
    const thrower = () => {
      throw new Error("observer bug");
    };
    expect(await classify("Revisa el código", undefined, undefined, thrower)).toEqual(new Set(["coding"]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    adapterInfer.mockRejectedValue(new Error("synthetic outage"));
    expect(await classify("Revisa el código", undefined, undefined, (p) => told.push(p))).toBeNull();
    expect(told).toEqual(["sonnet", "none"]);
  });

  it("records the provider the classifier reports, 'unreported' when it reports none", async () => {
    insertTestCase(makeScopeCase({ case_id: "sc-p-prov" }));
    const jev = await runEvaluation(
      { scopePromptClassifier: async (_m, _c, _w, onAnswer) => { onAnswer?.("jev"); return new Set(["coding"]); } },
      { category: "scope_accuracy" },
    );
    expect(jev.perCase.find((c) => c.category === "scope_prompt")!.details.provider).toBe("jev");
    const silent = await runEvaluation(
      { scopePromptClassifier: async () => new Set(["coding"]) },
      { category: "scope_accuracy" },
    );
    expect(silent.perCase.find((c) => c.category === "scope_prompt")!.details.provider).toBe("unreported");
  });

  it("absent scopePromptClassifier: no scope_prompt rows, no call, composite unchanged (overnight loop / DRY)", async () => {
    seedThree();
    const r = await runEvaluation({}, { category: "scope_accuracy" });
    expect(r.perCase.every((c) => c.category === "scope_accuracy")).toBe(true);
    expect(r.subscores).not.toHaveProperty("scopePrompt");
    expect(r.compositeScore).toBeCloseTo(r.subscores.scopeAccuracy * 0.3, 10);
    expect(adapterInfer).not.toHaveBeenCalled();
  });

  it("scope_prompt rows carry no message text (--percase-out)", async () => {
    const msg = "Mensaje sintetico unico qx7 sobre el código";
    insertTestCase(makeScopeCase({ case_id: "sc-p-msg", input: { message: msg } }));
    reply('["coding"]');
    const r = await runEvaluation(
      { scopePromptClassifier: await classifier() },
      { category: "scope_accuracy" },
    );
    const rows = r.perCase.filter((c) => c.category === "scope_prompt");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("qx7");
  });
});
