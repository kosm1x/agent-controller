/**
 * Planner tests — mock infer() to return canned goal graphs.
 * Tests JSON parsing, fence-stripping, error handling, dependency resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoalStatus } from "./types.js";

// Mock the inference adapter before importing planner
vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

// Force openai path — SDK path covered by claude-sdk.test.ts.
vi.mock("../config.js", () => ({
  getConfig: () => ({ inferencePrimaryProvider: "openai" }),
}));

vi.mock("../db/knowledge-maps.js", () => ({
  searchMaps: vi.fn(() => []),
  getNodes: vi.fn(() => []),
}));

// kb-injection reads from jarvis_files via getFilesByQualifier — mock to make
// the planner KB-injection regression deterministic.
vi.mock("../db/jarvis-fs.js", () => ({
  getFilesByQualifier: vi.fn(),
  getFile: vi.fn(),
}));

import { plan, replan, splitCriteria } from "./planner.js";
import { infer } from "../inference/adapter.js";
import { searchMaps, getNodes } from "../db/knowledge-maps.js";
import { getFilesByQualifier } from "../db/jarvis-fs.js";

const mockInfer = vi.mocked(infer);
const mockSearchMaps = vi.mocked(searchMaps);
const mockGetNodes = vi.mocked(getNodes);
const mockGetFilesByQualifier = vi.mocked(getFilesByQualifier);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("plan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("should parse a simple goal graph from LLM", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "First goal",
            completion_criteria: ["criterion 1"],
            parent_id: null,
            depends_on: [],
          },
          {
            id: "g-2",
            description: "Second goal",
            completion_criteria: ["criterion 2"],
            parent_id: null,
            depends_on: ["g-1"],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 100,
    });

    const { graph, usage } = await plan("Test task");
    expect(graph.size).toBe(2);
    expect(graph.getGoal("g-1").description).toBe("First goal");
    expect(graph.getGoal("g-2").dependsOn).toEqual(["g-1"]);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
  });

  it("system prompt carries the workload-sizing rules (2026-07-27: split large tasks across rounds)", async () => {
    // Task 588389e9: "analiza cada slide" planned monolithic per-item goals
    // that blew the 120s per-goal round twice and hit the orchestrator
    // ceiling with the user-facing goals unfinished. The planner must size
    // goals to one round and batch enumerable workloads.
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Goal",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      provider: "test",
      latency_ms: 10,
    });

    await plan("Analyze each slide of the deck");

    const sysMsg = mockInfer.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === "system",
    );
    // Regex over exact prose (qa-audit I2): pin the load-bearing tokens,
    // survive wording polish.
    expect(sysMsg!.content).toContain("Workload sizing");
    expect(sysMsg!.content).toContain("ONE execution round");
    expect(sysMsg!.content).toMatch(/batch goals of \d-\d items/i);
    expect(sysMsg!.content).toMatch(/quantify over ALL items/i);
    expect(sysMsg!.content).toMatch(/independent \(depends_on=\[\]\)/i);
    expect(sysMsg!.content).toMatch(/never silently drop items/i);
  });

  // V8.4 (2026-08-16): object-form criteria carry a runnable proof; the prose
  // contract (`completionCriteria: string[]`) is unchanged and the specs land on
  // `metadata.gates` for the ledger. Malformed shapes are dropped, never thrown.
  it("splits object-form completion criteria into prose + metadata.gates", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Ship it",
            completion_criteria: [
              "reads well",
              { criterion: "typecheck passes", check: "npx tsc --noEmit", expect: "/^$/" },
              { criterion: "no proof, prose only" },
              { check: "orphan check without criterion" },
              42,
            ],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      provider: "test",
      latency_ms: 1,
    });
    const { graph } = await plan("Test task");
    const g = graph.getGoal("g-1");
    expect(g.completionCriteria).toEqual(["reads well", "typecheck passes", "no proof, prose only"]);
    expect(g.metadata.gates).toEqual([
      { criterion: "typecheck passes", check: "npx tsc --noEmit", expect: "/^$/" },
    ]);
  });

  it("splitCriteria: strings only → no metadata.gates key", () => {
    expect(splitCriteria(["a", "b"])).toEqual({ completionCriteria: ["a", "b"], gates: [] });
    expect(splitCriteria(undefined)).toEqual({ completionCriteria: [], gates: [] });
  });

  it("system prompt tells the planner when to use the object form", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({ goals: [] }),
      tool_calls: undefined,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      provider: "test",
      latency_ms: 1,
    });
    await plan("x").catch(() => undefined);
    const sysMsg = mockInfer.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === "system",
    );
    expect(sysMsg!.content).toContain('"check": "shell command that proves it"');
    expect(sysMsg!.content).toMatch(
      /object form of a completion criterion whenever a shell command can prove it/,
    );
  });

  it("should strip markdown fences from LLM output", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        '```json\n{"goals": [{"id": "g-1", "description": "Fenced goal", "completion_criteria": [], "parent_id": null, "depends_on": []}]}\n```',
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph } = await plan("Fenced test");
    expect(graph.size).toBe(1);
    expect(graph.getGoal("g-1").description).toBe("Fenced goal");
  });

  it("should handle parent-child relationships", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Parent",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
          {
            id: "g-2",
            description: "Child",
            completion_criteria: [],
            parent_id: "g-1",
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph } = await plan("Parent-child test");
    expect(graph.getGoal("g-2").parentId).toBe("g-1");
    expect(graph.getGoal("g-1").children).toContain("g-2");
  });

  it("should drop unresolvable dependency references", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Goal with bad dep",
            completion_criteria: [],
            parent_id: null,
            depends_on: ["g-999"], // doesn't exist
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph } = await plan("Bad dep test");
    expect(graph.size).toBe(1);
    // The unresolvable dep should be dropped
    expect(graph.getGoal("g-1").dependsOn).toEqual([]);
  });

  it("should throw a typed LLMJsonParseError on invalid JSON from LLM", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "This is not JSON at all",
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    await expect(plan("Invalid JSON test")).rejects.toThrow(
      "LLM returned unparseable JSON",
    );
  });

  // v7.6 Spine 1 G8 — the planner's "Planning failed: ..." wrapper must NOT
  // carry raw LLM content into the user-visible error.message. The wrapper
  // is built in orchestrator.ts:129 from `err.message`. By contract, the
  // typed LLMJsonParseError keeps `.message` generic; the rawSample lives
  // on a separate field accessible only to operators (journalctl).
  // Failure case: a regression that re-introduces raw content into the
  // message would surface in router.ts:2321 (background-agent failure
  // reply) and rituals/dynamic.ts:574 (scheduled-task failure broadcast).
  it("error.message does NOT leak raw LLM content (Spine 1 G8 invariant)", async () => {
    const sentinel = "INTERNAL-PROMPT-LEAK-SENTINEL-9876";
    mockInfer.mockResolvedValueOnce({
      content: `Some prose with ${sentinel} inside that is not valid JSON`,
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    let caught: unknown = null;
    try {
      await plan("Leak test");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    // Direct planner throw — message is the raw LLMJsonParseError generic.
    expect(err.message).not.toContain(sentinel);
    expect(err.message).toBe("LLM returned unparseable JSON");
  });

  it("should throw on missing goals array", async () => {
    mockInfer.mockResolvedValueOnce({
      content: '{"not_goals": []}',
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    await expect(plan("No goals test")).rejects.toThrow("goals");
  });

  it("should inject knowledge map context when map exists", async () => {
    mockSearchMaps.mockReturnValueOnce([
      {
        id: "telecom-regulation",
        topic: "Telecom Regulation",
        node_count: 3,
        max_depth: 0,
        created_at: "2026-04-03 00:00:00",
        updated_at: "2026-04-03 00:00:00",
      },
    ] as never);
    mockGetNodes.mockReturnValueOnce([
      {
        id: "n-1",
        map_id: "telecom-regulation",
        label: "Spectrum Auction",
        type: "concept",
        summary: "How bandwidth is allocated",
        depth: 0,
        parent_id: null,
        created_at: "",
      },
      {
        id: "n-2",
        map_id: "telecom-regulation",
        label: "Regulatory Capture",
        type: "gotcha",
        summary: "When regulators serve industry instead of public",
        depth: 0,
        parent_id: null,
        created_at: "",
      },
    ] as never);

    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Analyze regulation",
            completion_criteria: ["done"],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
      provider: "test",
      latency_ms: 100,
    });

    await plan("Analyze Mexican telecom regulation");

    // Verify the LLM received map context in the prompt
    const callArgs = mockInfer.mock.calls[0][0];
    const userMsg = callArgs.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("Domain Knowledge Map");
    expect(userMsg!.content).toContain("Spectrum Auction");
    expect(userMsg!.content).toContain("Regulatory Capture");
  });
});

describe("replan", () => {
  it("should preserve completed goal statuses", async () => {
    // First plan
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Original",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph: originalGraph } = await plan("Task");
    originalGraph.updateStatus("g-1", GoalStatus.COMPLETED);

    // Replan with completed status preserved
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Original",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
            status: "completed",
          },
          {
            id: "g-2",
            description: "New goal",
            completion_criteria: [],
            parent_id: null,
            depends_on: ["g-1"],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      provider: "test",
      latency_ms: 50,
    });

    const { graph: newGraph } = await replan(
      "Task",
      originalGraph,
      "Goal blocked",
    );
    expect(newGraph.size).toBe(2);
    expect(newGraph.getGoal("g-1").status).toBe(GoalStatus.COMPLETED);
    expect(newGraph.getGoal("g-2").status).toBe(GoalStatus.PENDING);
  });

  it("replan system prompt carries the timeout-split rule and workload sizing (2026-07-27)", async () => {
    // A timed-out goal retried whole times out again — the replanner must
    // split it, and any new goals must be round-sized like plan-time goals.
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Goal",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      provider: "test",
      latency_ms: 10,
    });
    const { graph } = await plan("Task");

    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        goals: [
          {
            id: "g-1",
            description: "Goal",
            completion_criteria: [],
            parent_id: null,
            depends_on: [],
          },
        ],
      }),
      tool_calls: undefined,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      provider: "test",
      latency_ms: 10,
    });
    await replan("Task", graph, "Goal g-3 timed out after 120000ms");

    const sysMsg = mockInfer.mock.calls[1][0].messages.find(
      (m: { role: string }) => m.role === "system",
    );
    expect(sysMsg!.content).toContain("A goal TIMED OUT");
    expect(sysMsg!.content).toContain("Split it into smaller batch goals");
    expect(sysMsg!.content).toContain("same workload sizing as planning");
  });
});

describe("planner KB injection (regression — half-fix trap)", () => {
  // Earlier today's fix landed enforce-only KB in plan() first, then audit
  // caught replan() missing the same wiring. Both call sites now run through
  // buildKnowledgeBaseSection(..., enforceOnly=true). This test captures the
  // system prompt of each and asserts the [JARVIS KNOWLEDGE BASE] marker plus
  // the MANDATORY: prefix appear — guards against the next half-fix.
  const ENFORCE_FILE = {
    path: "directives/repo-authorization.md",
    title: "Repo Authorization",
    content: "Only commit to authorized EurekaMD-net repositories.",
    qualifier: "enforce",
    condition: null,
    priority: 0,
  };

  const SIMPLE_GRAPH_RESPONSE = {
    content: JSON.stringify({
      goals: [
        {
          id: "g-1",
          description: "Goal",
          completion_criteria: [],
          parent_id: null,
          depends_on: [],
        },
      ],
    }),
    tool_calls: undefined,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    provider: "test",
    latency_ms: 10,
  };

  // Find by role rather than positional indexing — protects the assertion
  // shape against future preamble/context messages being prepended.
  const findSystem = (call: number) =>
    mockInfer.mock.calls[call]?.[0]?.messages?.find((m) => m.role === "system");

  it("plan() injects enforce-only KB into the system prompt", async () => {
    mockGetFilesByQualifier.mockReturnValue([ENFORCE_FILE]);
    mockInfer.mockResolvedValueOnce(SIMPLE_GRAPH_RESPONSE);

    await plan("Test task");

    expect(mockGetFilesByQualifier).toHaveBeenCalledWith("enforce");
    const system = findSystem(0);
    expect(system).toBeDefined();
    expect(system?.content).toContain("[JARVIS KNOWLEDGE BASE]");
    expect(system?.content).toContain("MANDATORY: Repo Authorization");
    expect(system?.content).toContain(
      "Only commit to authorized EurekaMD-net repositories.",
    );
  });

  it("replan() injects enforce-only KB into the system prompt", async () => {
    mockGetFilesByQualifier.mockReturnValue([ENFORCE_FILE]);
    mockInfer
      .mockResolvedValueOnce(SIMPLE_GRAPH_RESPONSE)
      .mockResolvedValueOnce(SIMPLE_GRAPH_RESPONSE);

    const { graph } = await plan("Initial task");
    await replan("Initial task", graph, "Need revision");

    expect(mockGetFilesByQualifier).toHaveBeenCalledWith("enforce");
    const replanSystem = findSystem(1);
    expect(replanSystem).toBeDefined();
    expect(replanSystem?.content).toContain("[JARVIS KNOWLEDGE BASE]");
    expect(replanSystem?.content).toContain("MANDATORY: Repo Authorization");
  });

  it("plan() omits always-read/conditional KB even when those rows exist (planner only needs enforce)", async () => {
    // Differentiating mock: if the planner ever widens its qualifier set, the
    // extra always-read/conditional rows would surface in the system prompt
    // and the negative assertions below would fail. Returning extras only on
    // the wider call signature catches the regression even if the stub
    // accidentally returns everything.
    mockGetFilesByQualifier.mockImplementation((...quals: string[]) => {
      if (quals.length === 1 && quals[0] === "enforce") {
        return [ENFORCE_FILE];
      }
      return [
        ENFORCE_FILE,
        {
          path: "always.md",
          title: "Always",
          content: "ALWAYS_BLOCK_MARKER",
          qualifier: "always-read",
          condition: null,
          priority: 0,
        },
        {
          path: "code.md",
          title: "Code SOP",
          content: "CONDITIONAL_BLOCK_MARKER",
          qualifier: "conditional",
          condition: "coding",
          priority: 0,
        },
      ];
    });
    mockInfer.mockResolvedValueOnce(SIMPLE_GRAPH_RESPONSE);

    await plan("Test task");

    expect(mockGetFilesByQualifier).toHaveBeenCalledWith("enforce");
    const system = findSystem(0);
    expect(system?.content).toContain("MANDATORY: Repo Authorization");
    expect(system?.content).not.toContain("ALWAYS_BLOCK_MARKER");
    expect(system?.content).not.toContain("CONDITIONAL_BLOCK_MARKER");
  });
});
