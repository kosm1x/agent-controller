/**
 * Planner — LLM-driven task decomposition into a GoalGraph.
 *
 * Calls the inference adapter to decompose a task description into a
 * structured goal graph, with replanning support for execution feedback.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { GoalGraph } from "./goal-graph.js";
import { GoalStatus, parseLLMJson } from "./types.js";
import type { TokenUsage } from "./types.js";
import { getDatabase } from "../db/index.js";

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
- Emit ONLY valid JSON. No markdown, no commentary.`;

const REPLAN_SYSTEM = `You are the replanning module of an autonomous agent. A previous plan partially executed but needs revision.

You receive: the original task, the current goal graph with statuses, and the reason for replanning.
Keep completed goals unchanged. Adjust pending/blocked/failed goals as needed.
You may add new goals, remove failed goals, or change dependencies.

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
function queryPriorLearnings(limit: number): string[] {
  try {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT content FROM learnings ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } catch {
    return [];
  }
}

export async function plan(
  taskDescription: string,
): Promise<{ graph: GoalGraph; usage: TokenUsage }> {
  const learnings = queryPriorLearnings(5);
  const learningsBlock =
    learnings.length > 0
      ? `\n\n## Prior learnings\n${learnings.map((l) => `- ${l}`).join("\n")}`
      : "";

  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_SYSTEM },
    {
      role: "user",
      content: `## Task\n${taskDescription}${learningsBlock}\n\nDecompose this task into a goal graph. Respond with JSON only.`,
    },
  ];

  const response = await infer({ messages, temperature: 0.4 });
  const content = response.content ?? "";
  return {
    graph: parseGoalGraph(content),
    usage: {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
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
  const messages: ChatMessage[] = [
    { role: "system", content: REPLAN_SYSTEM },
    {
      role: "user",
      content:
        `## Original task\n${taskDescription}\n\n` +
        `## Current goal graph\n${JSON.stringify(graph.toJSON(), null, 2)}\n\n` +
        `## Reason for replanning\n${reason}`,
    },
  ];

  const response = await infer({ messages, temperature: 0.4 });
  return {
    graph: parseGoalGraph(response.content ?? ""),
    usage: {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
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
