/**
 * Planner — LLM-driven task decomposition into a GoalGraph.
 *
 * Calls the inference adapter to decompose a task description into a
 * structured goal graph, with replanning support for execution feedback.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { queryClaudeSdkAsInfer } from "../inference/claude-sdk.js";
import { getConfig } from "../config.js";
import { GoalGraph } from "./goal-graph.js";
import { GoalStatus, parseLLMJson } from "./types.js";
import type { TokenUsage } from "./types.js";
import { getMemoryService } from "../memory/index.js";
import { searchMaps, getNodes } from "../db/knowledge-maps.js";
import { buildKnowledgeBaseSection } from "../messaging/kb-injection.js";

// v7.9 Prometheus Sonnet port: route LLM calls through the Claude Agent SDK
// when the primary provider is claude-sdk. Matches the fast-runner branch in
// fast-runner.ts so heavy tasks get the same reasoning quality as chat tasks.
// Rollback: set INFERENCE_PRIMARY_PROVIDER=openai (systemd drop-in, zero LOC).
function useSdkPath(): boolean {
  return getConfig().inferencePrimaryProvider === "claude-sdk";
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = `You are the planning module of an autonomous agent. Decompose a task into a goal graph.

Respond ONLY with a JSON object:
{
  "goals": [
    {
      "id": "g-1",
      "description": "what this goal achieves",
      "completion_criteria": ["testable assertion 1", "testable assertion 2"],
      "parent_id": null,
      "depends_on": []
    }
  ]
}

Rules:
- Top-level goals have parent_id=null and depends_on=[].
- Use depends_on to express ordering constraints between goals.
- Keep the graph to at most 3 levels deep and 15 goals max.
- Each goal should have 1-3 completion criteria.
- IDs must be sequential: g-1, g-2, g-3, etc.
- If the task involves an unfamiliar or specialized domain, make the first goal "Build domain overview using knowledge_map tool" before detailed execution goals.
- NEVER delegate understanding: each goal description must be specific enough to execute without guessing. Include file paths, function names, or concrete targets when known. Never write "based on findings from g-1, do X" — instead, make g-2 depend_on g-1 and describe exactly what g-2 must do with its own terms.
- MANDATORY (CCP8): Every goal that modifies code, files, or configuration MUST include at least one file path or resource identifier in its description. Goals like "fix the bug" without specifying which file are too vague — write "fix the timeout handling in src/inference/adapter.ts" instead.
- Emit ONLY valid JSON. No markdown, no commentary.`;

const REPLAN_SYSTEM = `You are the replanning module of an autonomous agent. A previous plan partially executed but needs revision.

You receive: the original task, the current goal graph with statuses, and the reason for replanning.
Keep completed goals unchanged. Adjust pending/blocked/failed goals as needed.
You may add new goals, remove failed goals, or change dependencies.

## Continue vs. Rebuild Decision (apply before modifying the graph)

| Situation | Action | Why |
|-----------|--------|-----|
| Execution found the exact files/data needed | Revise minimally — keep context | Prior work is directly usable |
| Execution was broad but remaining work is narrow | Rebuild pending goals from scratch | Avoid dragging exploration noise into focused execution |
| A goal failed but the approach is sound | Revise the failed goal only | Don't discard working goals |
| The approach is fundamentally wrong | Rebuild all pending goals | Wrong-context poisons all downstream goals |
| Tool failure rate is high | Add diagnostic/fallback goals | The tools may need different parameters or alternatives |

Respond with a revised goal graph in the same JSON schema:
{
  "goals": [
    {
      "id": "g-1",
      "description": "...",
      "completion_criteria": ["..."],
      "parent_id": null,
      "depends_on": [],
      "status": "completed"
    }
  ]
}

Emit ONLY valid JSON. No markdown, no commentary.`;

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

interface PlanGoalEntry {
  id: string;
  description: string;
  completion_criteria?: string[];
  parent_id?: string | null;
  depends_on?: string[];
  status?: string;
}

interface PlanResponse {
  goals: PlanGoalEntry[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decompose a task description into a GoalGraph via LLM.
 */
export async function plan(
  taskDescription: string,
): Promise<{ graph: GoalGraph; usage: TokenUsage }> {
  const memories = await getMemoryService().recall(taskDescription, {
    bank: "mc-operational",
    tags: ["planning"],
    maxResults: 5,
  });
  const learnings = memories.map((m) => m.content);
  const learningsBlock =
    learnings.length > 0
      ? `\n\n## Prior learnings\n${learnings.map((l) => `- ${l}`).join("\n")}`
      : "";

  // Check for existing knowledge maps relevant to this task
  let mapBlock = "";
  try {
    const maps = searchMaps(taskDescription);
    if (maps.length > 0) {
      const map = maps[0];
      const nodes = getNodes(map.id);
      const concepts = nodes.filter((n) => n.type === "concept");
      const gotchas = nodes.filter((n) => n.type === "gotcha");
      if (concepts.length > 0 || gotchas.length > 0) {
        mapBlock =
          `\n\n## Domain Knowledge Map: ${map.topic}\n` +
          `Key concepts: ${concepts.map((n) => n.label).join(", ")}\n` +
          (gotchas.length > 0
            ? `Gotchas to address:\n${gotchas.map((n) => `- ${n.label}: ${n.summary.slice(0, 150)}`).join("\n")}\n`
            : "") +
          `Use this domain knowledge to create more specific, informed goals.`;
      }
    }
  } catch {
    // Non-fatal — plan without map context
  }

  // Inject enforce-only KB so plan-time prompts respect MANDATORY directives
  // (e.g. directives/repo-authorization.md). Skip always-read/conditional —
  // the planner only needs hard policy, not the per-task SOP.
  const enforceKb = buildKnowledgeBaseSection([], true, undefined, "planner");
  const systemPrompt = enforceKb
    ? `${enforceKb}\n\n${PLAN_SYSTEM}`
    : PLAN_SYSTEM;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `## Task\n${taskDescription}${mapBlock}${learningsBlock}\n\nDecompose this task into a goal graph. Respond with JSON only.`,
    },
  ];

  const response = useSdkPath()
    ? await queryClaudeSdkAsInfer(messages)
    : await infer({ messages, temperature: 0.4 });
  const content = response.content ?? "";
  return {
    graph: parseGoalGraph(content),
    usage: {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      ...(response.usage.cache_read_tokens !== undefined && {
        cacheReadTokens: response.usage.cache_read_tokens,
      }),
      ...(response.usage.cache_creation_tokens !== undefined && {
        cacheCreationTokens: response.usage.cache_creation_tokens,
      }),
    },
  };
}

/**
 * Revise an existing GoalGraph based on execution feedback.
 */
export async function replan(
  taskDescription: string,
  graph: GoalGraph,
  reason: string,
): Promise<{ graph: GoalGraph; usage: TokenUsage }> {
  const enforceKb = buildKnowledgeBaseSection([], true, undefined, "planner");
  const systemPrompt = enforceKb
    ? `${enforceKb}\n\n${REPLAN_SYSTEM}`
    : REPLAN_SYSTEM;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        `## Original task\n${taskDescription}\n\n` +
        `## Current goal graph\n${JSON.stringify(graph.toJSON(), null, 2)}\n\n` +
        `## Reason for replanning\n${reason}`,
    },
  ];

  const response = useSdkPath()
    ? await queryClaudeSdkAsInfer(messages)
    : await infer({ messages, temperature: 0.4 });
  return {
    graph: parseGoalGraph(response.content ?? ""),
    usage: {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      ...(response.usage.cache_read_tokens !== undefined && {
        cacheReadTokens: response.usage.cache_read_tokens,
      }),
      ...(response.usage.cache_creation_tokens !== undefined && {
        cacheCreationTokens: response.usage.cache_creation_tokens,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: parse LLM JSON into GoalGraph
// ---------------------------------------------------------------------------

function parseGoalGraph(raw: string): GoalGraph {
  const data = parseLLMJson<PlanResponse>(raw);

  if (!data.goals || !Array.isArray(data.goals)) {
    throw new Error("LLM plan response missing 'goals' array");
  }

  const graph = new GoalGraph();
  const goalEntries = data.goals;
  const allIds = new Set(goalEntries.map((g) => g.id));
  const added = new Set<string>();
  const remaining = [...goalEntries];
  let maxPasses = remaining.length + 1;

  while (remaining.length > 0 && maxPasses-- > 0) {
    const stillRemaining: PlanGoalEntry[] = [];

    for (const entry of remaining) {
      const deps = (entry.depends_on ?? []).filter((d) => allIds.has(d));
      const parentId =
        entry.parent_id && allIds.has(entry.parent_id) ? entry.parent_id : null;

      // Check if deps and parent are already added
      const depsReady = deps.every((d) => added.has(d));
      const parentReady = !parentId || added.has(parentId);

      if (depsReady && parentReady) {
        const validDeps = deps.filter((d) => added.has(d));

        // Map status string to GoalStatus
        let status: GoalStatus = GoalStatus.PENDING;
        if (entry.status === "completed") status = GoalStatus.COMPLETED;
        else if (entry.status === "failed") status = GoalStatus.FAILED;
        else if (entry.status === "blocked") status = GoalStatus.BLOCKED;
        else if (entry.status === "in_progress")
          status = GoalStatus.IN_PROGRESS;

        graph.addGoal({
          id: entry.id,
          description: entry.description,
          dependsOn: validDeps,
          parentId,
          completionCriteria: entry.completion_criteria ?? [],
          status,
        });
        added.add(entry.id);
      } else {
        stillRemaining.push(entry);
      }
    }

    if (stillRemaining.length === remaining.length) {
      // No progress — force-add with cleaned refs
      for (const entry of stillRemaining) {
        const validDeps = (entry.depends_on ?? []).filter((d) => added.has(d));
        const validParent =
          entry.parent_id && added.has(entry.parent_id)
            ? entry.parent_id
            : null;

        const droppedDeps = (entry.depends_on ?? []).filter(
          (d) => !added.has(d),
        );
        if (droppedDeps.length > 0) {
          console.warn(
            `[planner] Goal ${entry.id}: dropped unresolvable deps ${droppedDeps.join(", ")}`,
          );
        }

        graph.addGoal({
          id: entry.id,
          description: entry.description,
          dependsOn: validDeps,
          parentId: validParent,
          completionCriteria: entry.completion_criteria ?? [],
        });
        added.add(entry.id);
      }
      break;
    }

    remaining.length = 0;
    remaining.push(...stillRemaining);
  }

  // Validate and log warnings
  const errors = graph.validate();
  for (const err of errors) {
    console.warn(`[planner] Validation: ${err}`);
  }

  return graph;
}
