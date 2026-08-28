/**
 * Tests for swarm runner sibling context injection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock dispatcher before importing swarm-runner (it auto-registers).
// getRunToolCalls added 2026-05-23 (queue #231) for the retry-policy taint check.
vi.mock("../dispatch/dispatcher.js", () => ({
  registerRunner: vi.fn(),
  submitTask: vi.fn(),
  getTask: vi.fn(),
  getRunToolCalls: vi.fn(() => []),
}));

// queue #231: swarm-retry-policy reads tool annotations via toolRegistry to
// veto retries with side-effect taint. Default mock: any name → undefined →
// classifier vetoes (returns null only when the toolCalls array is empty).
vi.mock("../tools/registry.js", () => ({
  toolRegistry: {
    get: (name: string) => {
      // Tests can override by setting `toolAnnotations.set(name, hints)`.
      const ann = toolAnnotations.get(name);
      if (!ann) return undefined;
      return { name, ...ann };
    },
  },
}));

const toolAnnotations = new Map<
  string,
  {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  }
>();

// queue #231: the swarm-runner records a Prometheus counter on every
// classifier decision. Mock the counter so the assertion targets here are
// the recorded labels, not the prom-client internals.
const recordSwarmSubtaskRetryMock = vi.fn();
vi.mock("../observability/prometheus.js", () => ({
  recordSwarmSubtaskRetry: (input: unknown) =>
    recordSwarmSubtaskRetryMock(input),
}));

vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => ({
    emitEvent: vi.fn(),
  }),
}));

vi.mock("../prometheus/planner.js", () => ({
  plan: vi.fn(),
}));

vi.mock("../prometheus/reflector.js", () => ({
  reflect: vi.fn(),
}));

// V8.4: parent re-verification seam (real module needs the DB + runs checks).
const v84 = vi.hoisted(() => ({ reverify: vi.fn() }));
vi.mock("../lib/v8-4/consumer.js", () => ({
  reverifyChildLedger: v84.reverify,
}));

import {
  buildSubTaskDescription,
  extractSharedFindings,
  stripSharedFindings,
  FORWARDED_FINDINGS_HEADING,
  SHARED_FINDINGS_HEADING,
  SHARED_FINDINGS_MAX_CHARS,
  SHARED_FINDINGS_TOTAL_MAX_CHARS,
  syncSubTaskStatuses,
  maxParallelWidth,
  swarmRunner,
} from "./swarm-runner.js";
import { plan } from "../prometheus/planner.js";
import { reflect } from "../prometheus/reflector.js";
const mockPlan = vi.mocked(plan);
const mockReflect = vi.mocked(reflect);
import { GoalGraph } from "../prometheus/goal-graph.js";
import { GoalStatus } from "../prometheus/types.js";
import {
  getTask,
  submitTask,
  getRunToolCalls,
} from "../dispatch/dispatcher.js";
const mockGetTask = vi.mocked(getTask);
const mockSubmitTask = vi.mocked(submitTask);
const mockGetRunToolCalls = vi.mocked(getRunToolCalls);

interface Tracker {
  goalId: string;
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: string;
  error?: string;
}

function makeGraph(): GoalGraph {
  const graph = new GoalGraph();
  graph.addGoal({ id: "g-1", description: "Setup database" });
  graph.addGoal({ id: "g-2", description: "Build API layer" });
  graph.addGoal({
    id: "g-3",
    description: "Write frontend",
    dependsOn: ["g-1"],
  });
  return graph;
}

describe("buildSubTaskDescription — sibling context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("includes sibling goals with their status", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      ["g-2", { goalId: "g-2", taskId: "t-2", status: "running" }],
    ]);

    const goal = graph.getGoal("g-1");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Sibling goals");
    expect(desc).toContain("Build API layer [running]");
    // g-3 depends on g-1, so it's a dependency, not a sibling here
    // But g-3's parentId is null (same as g-1), and g-1 is in g-3's dependsOn
    // When building desc for g-1, g-3 depends on g-1, but from g-1's perspective
    // g-3 is not in g-1.dependsOn. So g-3 IS a sibling of g-1
    expect(desc).toContain("Write frontend [pending]");
  });

  it("includes completed sibling output (truncated)", () => {
    const graph = makeGraph();
    const longOutput = "A".repeat(300);
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: longOutput,
        },
      ],
    ]);

    const goal = graph.getGoal("g-1");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Result: ");
    // Output should be truncated to 200 chars
    expect(desc).not.toContain("A".repeat(300));
    expect(desc).toContain("A".repeat(200));
  });

  it("does not duplicate dependency goals in sibling section", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>();

    // g-3 depends on g-1. When building desc for g-3, g-1 should NOT appear
    // in siblings because it's already in dependsOn
    graph.updateStatus("g-1", GoalStatus.COMPLETED);
    const goal = graph.getGoal("g-3");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    // g-1 should appear in dependencies section, not siblings
    expect(desc).toContain("Context from completed dependencies");
    expect(desc).toContain("Setup database (completed)");

    // g-2 is a sibling (same parentId, not a dependency of g-3)
    if (desc.includes("Sibling goals")) {
      expect(desc).toContain("Build API layer");
      // g-1 should NOT be in the sibling section
      const siblingSection = desc.split("Sibling goals")[1];
      expect(siblingSection).not.toContain("Setup database");
    }
  });

  it("omits sibling section when no siblings exist", () => {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-only", description: "Only goal" });
    const trackers = new Map<string, Tracker>();

    const goal = graph.getGoal("g-only");
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).not.toContain("Sibling goals");
  });

  it("handles empty tracker output without crashing", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: undefined,
        },
      ],
    ]);

    const goal = graph.getGoal("g-1");
    // Should not throw
    const desc = buildSubTaskDescription(
      goal,
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("Build API layer [completed]");
    expect(desc).not.toContain("Result:");
  });
});

describe("buildSubTaskDescription — ownership + shared findings (memory plan v2.0, Track 3)", () => {
  it("forwards a completed sibling's '## Shared findings' section in full, not the 200-char slice", () => {
    const graph = makeGraph();
    const findings = "- Kustodia: escrow fintech, 1.2% fee\n- Clip: 3.6% + IVA";
    const output = `# Report\n${"intro ".repeat(60)}\n${SHARED_FINDINGS_HEADING}\n${findings}\n## Next steps\n- nothing`;
    const trackers = new Map<string, Tracker>([
      ["g-2", { goalId: "g-2", taskId: "t-2", status: "completed", output }],
    ]);

    const desc = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );

    expect(desc).toContain("## Shared findings from completed siblings");
    expect(desc).toContain("### Build API layer");
    expect(desc).toContain(findings);
    // The section body stops at the next H2
    expect(desc).not.toContain("- nothing");
  });

  it("emits the Coordination contract only when siblings exist", () => {
    const graph = makeGraph();
    const withSiblings = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      new Map(),
    );
    expect(withSiblings).toContain("## Coordination");
    expect(withSiblings).toContain("owned by g-N");
    expect(withSiblings).toContain(`"${SHARED_FINDINGS_HEADING}" section`);
    // W5 fold: concurrent siblings' findings are NOT coming — say so.
    expect(withSiblings).toContain("finished before you started");

    const solo = new GoalGraph();
    solo.addGoal({ id: "g-only", description: "Only goal" });
    const alone = buildSubTaskDescription(
      solo.getGoal("g-only"),
      solo,
      new Map(),
    );
    expect(alone).not.toContain("## Coordination");
    expect(alone).not.toContain("Shared findings");
  });

  it("no shared-findings block when completed siblings did not publish one", () => {
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        { goalId: "g-2", taskId: "t-2", status: "completed", output: "done" },
      ],
    ]);
    const desc = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );
    expect(desc).not.toContain("Shared findings from completed siblings");
  });

  describe("extractSharedFindings", () => {
    it("returns null without the heading or with an empty section", () => {
      expect(extractSharedFindings("no section here")).toBeNull();
      expect(
        extractSharedFindings(`${SHARED_FINDINGS_HEADING}\n\n`),
      ).toBeNull();
    });

    it("caps the body at SHARED_FINDINGS_MAX_CHARS with an ellipsis", () => {
      const body = "x".repeat(SHARED_FINDINGS_MAX_CHARS + 100);
      const out = extractSharedFindings(`${SHARED_FINDINGS_HEADING}\n${body}`);
      expect(out).toHaveLength(SHARED_FINDINGS_MAX_CHARS + 1);
      expect(out!.endsWith("…")).toBe(true);
    });

    it("reads to the end when no later H2 exists", () => {
      expect(
        extractSharedFindings(`${SHARED_FINDINGS_HEADING}\n- a\n- b`),
      ).toBe("- a\n- b");
    });
  });
});

describe("shared findings — qa-audit R1 folds (C2 strip, C4 parser, W6 cap, fidelity)", () => {
  const H = SHARED_FINDINGS_HEADING;

  it("a completed sibling WITH a section gets the section, not the 200-char slice (plan §3.2 'instead of')", () => {
    const graph = makeGraph();
    const output = `${"intro ".repeat(50)}\n${H}\n- Clip: 3.6% + IVA`;
    const trackers = new Map<string, Tracker>([
      ["g-2", { goalId: "g-2", taskId: "t-2", status: "completed", output }],
    ]);
    const desc = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );
    expect(desc).toContain(FORWARDED_FINDINGS_HEADING.trim());
    expect(desc).toContain("- Clip: 3.6% + IVA");
    expect(desc).not.toContain("Result: ");
  });

  it("aggregate cap bounds the forwarded block across many siblings", () => {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-0", description: "Receiver" });
    const trackers = new Map<string, Tracker>();
    for (let i = 1; i <= 6; i++) {
      graph.addGoal({ id: `g-${i}`, description: `Sibling ${i}` });
      trackers.set(`g-${i}`, {
        goalId: `g-${i}`,
        taskId: `t-${i}`,
        status: "completed",
        output: `${H}\n${"f".repeat(SHARED_FINDINGS_MAX_CHARS)}`,
      });
    }
    const desc = buildSubTaskDescription(
      graph.getGoal("g-0"),
      graph,
      trackers as Map<string, any>,
    );
    const block = desc
      .split(FORWARDED_FINDINGS_HEADING.trim())[1]
      .split("\n## Coordination")[0];
    expect(block.trim().length).toBe(SHARED_FINDINGS_TOTAL_MAX_CHARS + 1);
    expect(block.endsWith("…\n") || block.endsWith("…")).toBe(true);
  });

  describe("extractSharedFindings — heading LINE, last section, fence-blind (C4)", () => {
    it("ignores a heading inside a fenced code example", () => {
      const out = extractSharedFindings(
        `Example:\n\`\`\`markdown\n${H}\n- PLACEHOLDER\n\`\`\`\n${H}\n- real`,
      );
      expect(out).toBe("- real");
      expect(
        extractSharedFindings(
          `\`\`\`\n${H}\n- only in fence\n\`\`\`\nno section`,
        ),
      ).toBeNull();
    });

    it("ignores a mid-line mention of the heading", () => {
      expect(
        extractSharedFindings(`See the ${H} section below.\n## Next\n- x`),
      ).toBeNull();
    });

    it("is case-insensitive, tolerates a trailing colon, takes the LAST section, stops at the next H2 but not H3", () => {
      const out = extractSharedFindings(
        `## Shared Findings:\n- first\n## Body\ntext\n${H}\n- last\n### detail\n- more\n## Next steps\n- nothing`,
      );
      expect(out).toBe("- last\n### detail\n- more");
    });

    it("does not prefix-match a longer heading", () => {
      expect(extractSharedFindings(`${H} and open questions\n- a`)).toBeNull();
    });

    it("handles CRLF", () => {
      expect(extractSharedFindings(`${H}\r\n- a\r\n- b`)).toBe("- a\n- b");
    });
  });

  describe("stripSharedFindings — the section never reaches the joined final answer (C2)", () => {
    it("removes the section (to the next H2 or the end) and keeps everything else", () => {
      const out = stripSharedFindings(
        `# Report\nbody\n${H}\n- Clip: 3.6%\n### detail\n- x\n## Next steps\n- keep`,
      );
      expect(out).toBe("# Report\nbody\n## Next steps\n- keep");
      expect(stripSharedFindings(`# Report\nbody\n${H}\n- tail`)).toBe(
        "# Report\nbody",
      );
    });

    it("leaves fenced code and mid-line mentions untouched", () => {
      const text = `See ${H} below.\n\`\`\`\n${H}\n- in fence\n\`\`\`\ndone`;
      expect(stripSharedFindings(text)).toBe(text);
    });

    it("is a no-op without a section", () => {
      expect(stripSharedFindings("plain answer")).toBe("plain answer");
    });
  });
});

describe("shared findings — qa-audit R2 folds (JSON tracker output, fence parity, indented code)", () => {
  const H = SHARED_FINDINGS_HEADING;

  it("tracker.output is the JSON-stringified tasks.output blob — the section is found INSIDE it and the Result slice is unwrapped (R2 C4/C3)", () => {
    const graph = makeGraph();
    const blob = JSON.stringify({
      text: `## Hallazgos\nLa cobertura es 92.4% a nivel AGEB.\n\n${H}\n- DENUE 2025 tiene 5,412,891 unidades\n`,
    });
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        { goalId: "g-2", taskId: "t-2", status: "completed", output: blob },
      ],
    ]);
    const desc = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );
    expect(desc).toContain("- DENUE 2025 tiene 5,412,891 unidades");
    expect(desc).not.toContain('{"text"');
    expect(desc).not.toContain("Result: ");

    // Without a section: the slice is the unwrapped deliverable, never raw JSON
    const plain = JSON.stringify({ text: "## Hallazgos\nCobertura 92.4%." });
    trackers.set("g-2", {
      goalId: "g-2",
      taskId: "t-2",
      status: "completed",
      output: plain,
    });
    const desc2 = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );
    expect(desc2).toContain("Result: ## Hallazgos\nCobertura 92.4%.");
    expect(desc2).not.toContain('{"text"');
  });

  it("the Result slice never carries a sibling's own '## Shared findings' section", () => {
    const graph = makeGraph();
    const blob = JSON.stringify({ text: `Body.\n${H}\n\n` }); // empty section → no forwarding
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        { goalId: "g-2", taskId: "t-2", status: "completed", output: blob },
      ],
    ]);
    const desc = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );
    expect(desc).toContain("Result: Body.");
    expect(desc.split("## Coordination")[0]).not.toContain(
      `Result: Body.\n${H}`,
    );
  });

  it("a section inside a code block is code: a fence pair around it, or an unclosed fence before it, means no section and nothing stripped (R2 W-c, CommonMark)", () => {
    const paired = `## Analysis\n\`\`\`json\n{"a":1}\n${H}\n- INSIDE 3.6%\n\`\`\`\nend`;
    expect(extractSharedFindings(paired)).toBeNull();
    expect(stripSharedFindings(paired)).toBe(paired);
    const unclosed = `## Analysis\n\`\`\`json\n{"a":1}\n${H}\n- INSIDE 3.6%`;
    expect(extractSharedFindings(unclosed)).toBeNull();
    expect(stripSharedFindings(unclosed)).toBe(unclosed);
    // …and a real section AFTER a closed pair is found and stripped
    const after = `\`\`\`\ncode\n\`\`\`\n${H}\n- real`;
    expect(extractSharedFindings(after)).toBe("- real");
    expect(stripSharedFindings(after)).toBe("\`\`\`\ncode\n\`\`\`");
  });

  it("prose that spells the old placeholder (' CODE0 ') is never rewritten (R4 W5)", () => {
    const prose =
      "| CODE0 | fallo de red |\nEl identificador CODE7 es interno.";
    expect(stripSharedFindings(prose)).toBe(prose);
    const withFence = "```\nx\n```\nluego CODE0 aparte";
    expect(stripSharedFindings(withFence)).toBe(withFence);
    expect(extractSharedFindings(`${H}\n- ver CODE0 en la tabla`)).toBe(
      "- ver CODE0 en la tabla",
    );
  });

  it("a 4-space continuation inside the section body is forwarded verbatim (placeholders restored)", () => {
    const body = "- item\n    detail line";
    expect(extractSharedFindings(`${H}\n${body}`)).toBe(body);
  });

  it("an indented (4-space) code block is not a section; a 1–3-space heading is (R2 W-d)", () => {
    const text = `Template:\n\n    ${H}\n    - PLACEHOLDER\n\n ${H}\n- real`;
    expect(extractSharedFindings(text)).toBe("- real");
    const stripped = stripSharedFindings(text);
    expect(stripped).toContain("    - PLACEHOLDER");
    expect(stripped).not.toContain("- real");
  });

  it("'##Shared findings' (no space) and a blockquoted heading are not headings — documented, not forwarded", () => {
    expect(extractSharedFindings(`##${H.slice(3)}\n- a`)).toBeNull();
    expect(extractSharedFindings(`> ${H}\n- a`)).toBeNull();
  });

  it("the V8.4 ledger strips the whole runner-authored sibling tail of a real description (R2 C3)", async () => {
    const { stripForwardedSiblingFindings } = await vi.importActual<
      typeof import("../lib/v8-4/consumer.js")
    >("../lib/v8-4/consumer.js");
    const graph = makeGraph();
    const trackers = new Map<string, Tracker>([
      [
        "g-2",
        {
          goalId: "g-2",
          taskId: "t-2",
          status: "completed",
          output: JSON.stringify({
            text: `Cobertura 92.4%.\n${H}\n- Clip: 3.6%`,
          }),
        },
      ],
      [
        "g-3",
        {
          goalId: "g-3",
          taskId: "t-3",
          status: "completed",
          output: JSON.stringify({ text: "Kustodia cobra 1.2% por escrow." }),
        },
      ],
    ]);
    const desc = buildSubTaskDescription(
      graph.getGoal("g-1"),
      graph,
      trackers as Map<string, any>,
    );
    expect(desc).toContain("3.6%");
    expect(desc).toContain("1.2%");
    const evidence = stripForwardedSiblingFindings(desc);
    expect(evidence).toBe("Setup database");
  });
});

describe("swarm final answer — '## Shared findings' never reaches the operator (R1 C2 / R2 W-b, at the execute() seam)", () => {
  it("children's sections are forwarded between siblings but stripped from the joined final answer", async () => {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "Research Clip fees" });
    graph.addGoal({ id: "g-2", description: "Research Kustodia fees" });
    mockPlan.mockResolvedValue({
      graph,
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    let n = 0;
    mockSubmitTask.mockImplementation(
      async () => ({ taskId: `seam-child-${++n}`, agentType: "fast" }) as never,
    );
    mockGetTask.mockImplementation(
      (id: string) =>
        ({
          task_id: id,
          status: "completed",
          output: JSON.stringify({
            text: `Reporte ${id}: comisión 3.6% + IVA.\n\n${SHARED_FINDINGS_HEADING}\n- SECRET-${id}: dato para el hermano`,
          }),
        }) as never,
    );
    mockReflect.mockResolvedValue({
      result: { success: true, score: 0.9, learnings: [], summary: "ok" },
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);

    const result = await swarmRunner.execute({
      taskId: "seam-parent",
      runId: "run-seam",
      title: "Compare fees",
      description: "Compare Clip and Kustodia fees",
    });

    expect(result.success).toBe(true);
    const out = result.output as Record<string, unknown>;
    const delivered = JSON.stringify(out);
    expect(delivered).toContain("comisión 3.6% + IVA");
    expect(delivered).not.toContain("SECRET-");
    expect(delivered).not.toContain(SHARED_FINDINGS_HEADING);
  });
});

describe("syncSubTaskStatuses — Hermes v0.13 zombie/terminal-status audit", () => {
  // Each test seeds the graph + one tracker, mocks getTask to return a
  // specific task.status, calls sync, and asserts the tracker and graph
  // both transitioned (or stayed put) correctly. The 3 new mappings are
  // the focus: completed_with_concerns, needs_context, blocked.

  afterEach(() => {
    vi.clearAllMocks();
  });

  function setup(taskStatus: string, taskOutput?: string, taskError?: string) {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "Test goal" });
    graph.updateStatus("g-1", GoalStatus.IN_PROGRESS);

    const trackers = new Map<string, Tracker>();
    trackers.set("g-1", {
      goalId: "g-1",
      taskId: "task-1",
      status: "running",
    });

    const goalTaskMap = new Map<string, string>();
    goalTaskMap.set("g-1", "task-1");

    mockGetTask.mockReturnValue({
      task_id: "task-1",
      status: taskStatus,
      output: taskOutput,
      error: taskError,
    } as any);

    return { graph, trackers, goalTaskMap };
  }

  it("maps task `completed` → tracker.completed + graph.COMPLETED (baseline)", () => {
    const { graph, trackers, goalTaskMap } = setup("completed", "all done");
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("completed");
    expect(trackers.get("g-1")!.output).toBe("all done");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.COMPLETED);
  });

  it("maps task `completed_with_concerns` → tracker.completed + preserves output (audit fix)", () => {
    // Pre-fix bug: this status was ignored. Tracker stayed non-terminal,
    // swarm waited up to 10 min, then `buildExecutionResults` marked the
    // successful sub-task as `ok: false`. Double penalty.
    const { graph, trackers, goalTaskMap } = setup(
      "completed_with_concerns",
      "partial result with note",
    );
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("completed");
    expect(trackers.get("g-1")!.output).toBe("partial result with note");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.COMPLETED);
  });

  it("maps task `needs_context` → tracker.failed (won't auto-resume)", () => {
    const { graph, trackers, goalTaskMap } = setup(
      "needs_context",
      undefined,
      "needs the user",
    );
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(trackers.get("g-1")!.error).toBe("needs the user");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("maps task `blocked` → tracker.failed (task-level block ≠ goal-graph BLOCKED)", () => {
    const { graph, trackers, goalTaskMap } = setup(
      "blocked",
      undefined,
      "external dep down",
    );
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(trackers.get("g-1")!.error).toBe("external dep down");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("falls back to a sensible error message when task.error is null", () => {
    // Defensive: the dispatcher SHOULD set task.error on needs_context /
    // blocked, but if it ever doesn't, we synthesize a placeholder so the
    // reflector and downstream callers always see a non-empty error.
    const { graph, trackers, goalTaskMap } = setup("needs_context", undefined);
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.error).toMatch(/needs additional user context/);
  });

  it("leaves pre-running statuses unchanged (pending/classifying/queued) — realistic first-poll scenario", () => {
    // Realistic first-poll after submit: tracker is "pending" (line 384
    // of swarm-runner.ts) and the task is still routing — pending, then
    // classifying, then queued. None of these are terminal; the function
    // must leave the tracker alone so `countActive` correctly keeps it
    // counted as active and the swarm waits for the eventual "running".
    // Audit W2/R2 — previous version of this test seeded tracker as
    // "running" which never observes the realistic seed state.
    for (const status of ["pending", "classifying", "queued"]) {
      const { graph, trackers, goalTaskMap } = setup(status);
      // Pre-set tracker to the realistic post-submit seed
      trackers.get("g-1")!.status = "pending";
      syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);
      expect(trackers.get("g-1")!.status).toBe("pending");
      expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.IN_PROGRESS);
    }
  });

  it("advances tracker from pending → running on the first `running` task observation", () => {
    // The transition the prior test couldn't cover: tracker starts
    // "pending" (post-submit), task becomes "running", sync flips tracker
    // to "running". Pins the existing `else if (task.status === "running")`
    // branch.
    const { graph, trackers, goalTaskMap } = setup("running");
    trackers.get("g-1")!.status = "pending";
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);
    expect(trackers.get("g-1")!.status).toBe("running");
  });

  it("does not re-process already-terminal trackers (idempotent)", () => {
    const { graph, trackers, goalTaskMap } = setup("completed", "x");
    // Pre-set tracker to a terminal state — function should skip even if
    // the DB row says otherwise.
    trackers.get("g-1")!.status = "completed";
    trackers.get("g-1")!.output = "PRIOR-VALUE";
    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    // Prior tracker output preserved; the function should not re-read or
    // overwrite a terminal entry. (getTask might not even get called, but
    // we don't assert that — only that the tracker is untouched.)
    expect(trackers.get("g-1")!.output).toBe("PRIOR-VALUE");
  });
});

// ---------------------------------------------------------------------------
// queue #231 — per-sub-task retry policy integration
// Tests the failed-branch wiring of syncSubTaskStatuses. The classifier
// itself is unit-tested in swarm-retry-policy.test.ts; these tests pin
// the swarm-runner-level contract: (a) shadow mode logs the would-decision
// but never respawns, (b) enabled mode respawns and rewires goalTaskMap,
// (c) the side-effect-taint / budget / terminal-class branches are
// surfaced through the recorded counter labels.
// ---------------------------------------------------------------------------

describe("syncSubTaskStatuses — retry-policy integration (queue #231)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    toolAnnotations.clear();
    delete process.env.SWARM_SUBTASK_RETRY_ENABLED;
    recordSwarmSubtaskRetryMock.mockClear();
  });

  function setupFailed(opts: {
    error?: string | null;
    retryCount?: number;
    toolCalls?: string[];
  }): {
    graph: GoalGraph;
    trackers: Map<string, Tracker>;
    goalTaskMap: Map<string, string>;
    goalsById: Map<string, { id: string; description: string }>;
  } {
    const graph = new GoalGraph();
    graph.addGoal({ id: "g-1", description: "Test goal" });
    graph.updateStatus("g-1", GoalStatus.IN_PROGRESS);

    const trackers = new Map<string, Tracker>();
    trackers.set("g-1", {
      goalId: "g-1",
      taskId: "task-1",
      status: "running",
    });

    const goalTaskMap = new Map<string, string>();
    goalTaskMap.set("g-1", "task-1");

    mockGetTask.mockReturnValue({
      task_id: "task-1",
      status: "failed",
      error: opts.error ?? null,
      retry_count: opts.retryCount ?? 0,
    } as any);
    mockGetRunToolCalls.mockReturnValue(opts.toolCalls ?? []);

    // Match the shape buildSubTaskDescription expects (Goal interface):
    // completionCriteria + dependsOn are required fields, default empty.
    const goalsById = new Map([
      [
        "g-1",
        {
          id: "g-1",
          description: "Test goal",
          completionCriteria: [],
          dependsOn: [],
        },
      ],
    ]);
    return { graph, trackers, goalTaskMap, goalsById };
  }

  function retryCtx(goalsById: Map<string, any>) {
    return {
      parentTaskId: "parent-1",
      tools: undefined,
      goalsById,
    };
  }

  it("absent retryContext → preserves legacy behavior (mark goal FAILED, no counter)", () => {
    const { graph, trackers, goalTaskMap } = setupFailed({
      error: "Provider 429",
      retryCount: 0,
    });

    syncSubTaskStatuses(goalTaskMap, graph, trackers as Map<string, any>);

    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
    expect(recordSwarmSubtaskRetryMock).not.toHaveBeenCalled();
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("shadow mode (flag off) on a retryable class → counter shadow_skipped + still marks FAILED", () => {
    // Default state. SWARM_SUBTASK_RETRY_ENABLED unset.
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429 rate limit",
      retryCount: 0,
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock).toHaveBeenCalledTimes(1);
    const labels = recordSwarmSubtaskRetryMock.mock.calls[0][0];
    expect(labels.decision).toBe("shadow_skipped");
    expect(labels.reason).toBe("provider_transient");
    // qa-audit W3 fold: recoveryMode is preserved in shadow rows so the
    // operator can see WHAT mode would have fired. Only collapsed to
    // "none" when the classifier itself said skipped_* (terminal class,
    // budget, taint) — not when the env flag suppressed an otherwise-
    // retryable decision.
    expect(labels.recoveryMode).toBe("plain");
    // No respawn fired
    expect(mockSubmitTask).not.toHaveBeenCalled();
    // Goal still marked failed (shadow mode preserves current behavior)
    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("enabled mode + retryable → respawn fires, tracker reset to pending, NO goal FAILED", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 503",
      retryCount: 0,
    });
    mockSubmitTask.mockResolvedValue({
      taskId: "task-2",
      agentType: "fast",
    } as any);

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    // Counter recorded as retried (not shadow_skipped)
    expect(recordSwarmSubtaskRetryMock).toHaveBeenCalledTimes(1);
    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0]).toEqual({
      decision: "retried",
      reason: "provider_transient",
      recoveryMode: "plain",
    });
    // submitTask called with retry_count = 1 (predecessor's + 1)
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.retryCount).toBe(1);
    expect(submission.parentTaskId).toBe("parent-1");
    expect(submission.spawnType).toBe("subtask");
    // Plain re-spawn: description does NOT contain the hallucination addendum
    expect(submission.description).not.toContain("⚠️ IMPORTANT");
    // Tracker reset to pending — NOT marked failed
    expect(trackers.get("g-1")!.status).toBe("pending");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.IN_PROGRESS);
  });

  it("hallucination recovery prepends the sterner addendum to the retry description", async () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "[hallucination guard] LLM narrated tool calls",
      retryCount: 0,
    });
    mockSubmitTask.mockResolvedValue({
      taskId: "task-2",
      agentType: "fast",
    } as any);

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0]).toEqual({
      decision: "retried",
      reason: "hallucination",
      recoveryMode: "hallucination",
    });
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.description).toContain("⚠️ IMPORTANT");
    expect(submission.description).toContain("MUST call the tools");
  });

  it("budget cap (retry_count >= 1) → skipped_budget, no respawn even with flag on", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429",
      retryCount: 1, // already at cap
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0].decision).toBe(
      "skipped_budget",
    );
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(trackers.get("g-1")!.status).toBe("failed");
    expect(graph.getGoal("g-1")!.status).toBe(GoalStatus.FAILED);
  });

  it("side-effect taint (destructive non-idempotent tool called) → skipped_side_effect, no respawn", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    toolAnnotations.set("gmail_send", {
      destructiveHint: true,
      idempotentHint: false,
      readOnlyHint: false,
    });
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429",
      retryCount: 0,
      toolCalls: ["gmail_send"],
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0].decision).toBe(
      "skipped_side_effect",
    );
    expect(mockSubmitTask).not.toHaveBeenCalled();
    expect(trackers.get("g-1")!.status).toBe("failed");
  });

  it("terminal class (max_rounds) → skipped_terminal, no respawn", () => {
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "true";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "max_rounds exceeded after 30 turns",
      retryCount: 0,
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0]).toEqual({
      decision: "skipped_terminal",
      reason: "max_rounds",
      recoveryMode: "none",
    });
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it("env flag string MUST be literal 'true' — other values stay in shadow", () => {
    // Defensive: env-var parsing should not loosely accept '1' / 'yes' /
    // 'TRUE' (case-insensitive variants). Same pattern as
    // `heavyRunnerContainerized`. Pin this so a future "be lenient" pass
    // doesn't silently widen the gate.
    process.env.SWARM_SUBTASK_RETRY_ENABLED = "1";
    const { graph, trackers, goalTaskMap, goalsById } = setupFailed({
      error: "Provider 429",
      retryCount: 0,
    });

    syncSubTaskStatuses(
      goalTaskMap,
      graph,
      trackers as Map<string, any>,
      retryCtx(goalsById) as any,
    );

    expect(recordSwarmSubtaskRetryMock.mock.calls[0][0].decision).toBe(
      "shadow_skipped",
    );
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fixes for task 7466 (2026-07-13): chain demotion + honest walls
// ---------------------------------------------------------------------------

describe("maxParallelWidth", () => {
  it("a strict chain has width 1", () => {
    expect(
      maxParallelWidth([
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]),
    ).toBe(1);
  });

  it("independent goals count as parallel width", () => {
    expect(maxParallelWidth([{ id: "a" }, { id: "b" }, { id: "c" }])).toBe(3);
  });

  it("a diamond (fan-out after a root) is wider than 1", () => {
    expect(
      maxParallelWidth([
        { id: "root" },
        { id: "l", dependsOn: ["root"] },
        { id: "r", dependsOn: ["root"] },
        { id: "join", dependsOn: ["l", "r"] },
      ]),
    ).toBe(2);
  });

  it("a single goal is width 1", () => {
    expect(maxParallelWidth([{ id: "only" }])).toBe(1);
  });

  it("does not loop forever on a dependency cycle", () => {
    expect(
      maxParallelWidth([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c" },
      ]),
    ).toBe(1); // c resolves; the a/b cycle breaks the walk defensively
  });
});

describe("swarm chain demotion (task 7466)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function chainGraph(): GoalGraph {
    const g = new GoalGraph();
    g.addGoal({ id: "g-1", description: "step 1" });
    g.addGoal({ id: "g-2", description: "step 2", dependsOn: ["g-1"] });
    g.addGoal({ id: "g-3", description: "step 3", dependsOn: ["g-2"] });
    return g;
  }

  it("delegates a chain plan to ONE heavy sub-task and mirrors its output", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-1",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-1",
      status: "completed",
      output: JSON.stringify({
        content: "the real answer",
        finalAnswer: "the real answer",
      }),
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-1",
      runId: "run-1",
      title: "chat chain",
      description: "do a sequential analysis",
    });

    expect(result.success).toBe(true);
    expect(mockSubmitTask).toHaveBeenCalledTimes(1);
    const submission = mockSubmitTask.mock.calls[0][0];
    expect(submission.agentType).toBe("heavy");
    expect(submission.parentTaskId).toBe("parent-1");
    const out = result.output as { content?: string; finalAnswer?: string };
    expect(out.content).toBe("the real answer");
    expect(out.finalAnswer).toBe("the real answer");
  });

  it("reports the demoted child's failure honestly (task id + status)", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-2",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-2",
      status: "failed",
      error: "child exploded",
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-2",
      runId: "run-2",
      title: "chat chain",
      description: "do a sequential analysis",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("demoted-2");
    expect(result.error).toContain("failed");
    expect(result.error).toContain("child exploded");
  });

  it("treats completed_with_concerns as a demoted-child success (audit W1)", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-3",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-3",
      status: "completed_with_concerns",
      output: JSON.stringify({ content: "qualified answer" }),
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-4",
      runId: "run-4",
      title: "chat chain",
      description: "sequential",
    });

    expect(result.success).toBe(true);
    expect((result.output as { content?: string }).content).toBe(
      "qualified answer",
    );
  });

  it("a completed demoted child with NO output is an honest failure, not an empty deliverable (audit W3)", async () => {
    mockPlan.mockResolvedValue({
      graph: chainGraph(),
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockResolvedValue({
      taskId: "demoted-4",
      agentType: "heavy",
    } as never);
    mockGetTask.mockReturnValue({
      task_id: "demoted-4",
      status: "completed",
      output: null,
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-5",
      runId: "run-5",
      title: "chat chain",
      description: "sequential",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("demoted-4");
    expect(result.error).toContain("no output");
  });

  it("does NOT demote a parallel plan — fan-out proceeds", async () => {
    const g = new GoalGraph();
    g.addGoal({ id: "p-1", description: "item A" });
    g.addGoal({ id: "p-2", description: "item B" });
    mockPlan.mockResolvedValue({
      graph: g,
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    // Make fan-out submissions fail fast so the poll loop terminates quickly
    // (goals go FAILED at submit → allTerminal → break).
    mockSubmitTask.mockRejectedValue(new Error("no capacity"));
    mockReflect.mockResolvedValue({
      result: {
        success: false,
        score: 0,
        learnings: [],
        summary: "nothing ran",
      },
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);

    const result = await swarmRunner.execute({
      taskId: "parent-3",
      runId: "run-3",
      title: "true fan-out",
      description: "process items A and B independently",
    });

    expect(result.success).toBe(false);
    // Both parallel goals were submitted through the NORMAL fan-out path
    // (no agentType override), not the demotion path.
    expect(mockSubmitTask).toHaveBeenCalledTimes(2);
    for (const call of mockSubmitTask.mock.calls) {
      expect(call[0].agentType).toBeUndefined();
    }
  }, 15_000);
});

describe("V8.4 ledger: child gates from the plan + parent re-verification", () => {
  const savedMode = process.env.TASK_GATES_MODE;
  afterEach(() => {
    vi.clearAllMocks();
    v84.reverify.mockReset();
    if (savedMode === undefined) delete process.env.TASK_GATES_MODE;
    else process.env.TASK_GATES_MODE = savedMode;
  });

  it("a goal with metadata.gates spawns its child WITH gates (source plan); a bare goal spawns none", async () => {
    const g = new GoalGraph();
    g.addGoal({
      id: "p-1",
      description: "gated item",
      metadata: {
        gates: [{ criterion: "typecheck", check: "npx tsc --noEmit" }],
      },
    });
    g.addGoal({ id: "p-2", description: "plain item" });
    mockPlan.mockResolvedValue({
      graph: g,
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    mockSubmitTask.mockRejectedValue(new Error("no capacity"));
    mockReflect.mockResolvedValue({
      result: { success: false, score: 0, learnings: [], summary: "n/a" },
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    await swarmRunner.execute({
      taskId: "parent-g",
      runId: "run-g",
      title: "fan-out",
      description: "process items",
    });
    expect(mockSubmitTask).toHaveBeenCalledTimes(2);
    const byTitle = new Map(
      mockSubmitTask.mock.calls.map((c) => [c[0].title, c[0]] as const),
    );
    const gated = byTitle.get("[Swarm] gated item")!;
    expect(gated.gates).toEqual([
      {
        id: "p-1.1",
        criterion: "typecheck",
        check: "npx tsc --noEmit",
        kind: "shell",
      },
    ]);
    expect(gated.gatesSource).toBe("plan");
    const plain = byTitle.get("[Swarm] plain item")!;
    expect(plain).not.toHaveProperty("gates");
  }, 15_000);

  async function runFanOut(parentId: string) {
    const g = new GoalGraph();
    g.addGoal({ id: "p-1", description: "item A" });
    g.addGoal({ id: "p-2", description: "item B" });
    mockPlan.mockResolvedValue({
      graph: g,
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    let n = 0;
    mockSubmitTask.mockImplementation(
      async () =>
        ({ taskId: `${parentId}-child-${++n}`, agentType: "fast" }) as never,
    );
    mockGetTask.mockImplementation(
      (id: string) =>
        ({
          task_id: id,
          status: "completed",
          output: JSON.stringify({ text: `done ${id}` }),
        }) as never,
    );
    // child-1's ledger fails re-verification; child-2 has no ledger.
    v84.reverify.mockImplementation(async (_parent: string, child: string) =>
      child.endsWith("child-1")
        ? {
            verdict: "failed",
            failed: 1,
            failedRows: [{ gate_id: "p-1.1" }],
            pending: 0,
            abandoned: 0,
          }
        : null,
    );
    mockReflect.mockResolvedValue({
      result: { success: true, score: 0.9, learnings: [], summary: "ok" },
      usage: { promptTokens: 0, completionTokens: 0 },
    } as never);
    const result = await swarmRunner.execute({
      taskId: parentId,
      runId: `run-${parentId}`,
      title: "fan-out",
      description: "process items",
    });
    const goals = (
      result.goalGraph as { goals: Record<string, { status: string }> }
    ).goals;
    return { result, goals };
  }

  it("enforce: a child whose ledger FAILS parent re-verification is demoted to FAILED before reflection", async () => {
    process.env.TASK_GATES_MODE = "enforce";
    const { result, goals } = await runFanOut("parent-e");
    expect(v84.reverify).toHaveBeenCalledTimes(2);
    expect(v84.reverify.mock.calls.map((c) => c[1]).sort()).toEqual([
      "parent-e-child-1",
      "parent-e-child-2",
    ]);
    expect(goals["p-1"]!.status).toBe("failed"); // child-1 (goal p-1) demoted by the parent
    expect(goals["p-2"]!.status).toBe("completed");
    const trace = result.trace as Array<{ taskId: string; status: string }>;
    expect(trace.find((t) => t.taskId === "parent-e-child-1")!.status).toBe(
      "failed",
    );
  }, 30_000);

  it("shadow: the same failing verdict is recorded but nothing is demoted", async () => {
    process.env.TASK_GATES_MODE = "shadow";
    const { goals } = await runFanOut("parent-s");
    expect(v84.reverify).toHaveBeenCalledTimes(2);
    expect(goals["p-1"]!.status).toBe("completed");
    expect(goals["p-2"]!.status).toBe("completed");
  }, 30_000);
});
