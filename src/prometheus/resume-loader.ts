/**
 * Resume loader — reconstruct a resumable OrchestratorResult from a persisted
 * `runs` row so a partially-failed Prometheus run can be re-executed.
 *
 * The dispatcher persists three Prometheus artifacts per run (dispatcher.ts:587):
 *   runs.goal_graph — JSON.stringify(OrchestratorResult.goalGraph) = { goals }
 *   runs.trace      — JSON.stringify(OrchestratorResult.trace)     = TraceEvent[]
 *   runs.output     — JSON.stringify(heavy-runner output)          =
 *                     { content, score, learnings, finalAnswer }
 *
 * PERSISTENCE GAP (intentional, documented): `runs.output` is the heavy-runner's
 * trimmed shape, NOT the full `executionResults`. The per-goal `GoalResult`
 * values (result text, provenance, per-goal token usage) are therefore NOT
 * persisted anywhere. What IS persisted is each goal's *status* inside
 * `goal_graph`, which is the load-bearing part: `resumeFromGoal` reconstructs
 * the graph from `goalGraph` and lets `getReady()` skip COMPLETED goals. We
 * synthesize minimal `GoalResult` stubs (status → ok, zeroed metrics, no result
 * text) so the merge/keep logic in `resumeFromGoal` stays structurally correct;
 * downstream context from kept goals is thin by design because the original
 * result text was never stored. This loader does not invent data it doesn't have.
 */

import { GoalGraph } from "./goal-graph.js";
import { GoalStatus } from "./types.js";
import type {
  Goal,
  GoalResult,
  OrchestratorResult,
  ReflectionResult,
  TokenUsage,
  TraceEvent,
} from "./types.js";
import { getDatabase } from "../db/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumableRun {
  /**
   * Goal graph reconstructed from the persisted run (per-goal statuses
   * preserved). Provided for the caller's convenience — e.g. an mc-ctl entry
   * point that lists goals or picks a default resume point (first FAILED goal).
   * `resumeFromGoal` reconstructs its OWN graph from `priorResult.goalGraph`,
   * so this instance is for inspection only, not to be passed back in.
   */
  graph: GoalGraph;
  /**
   * Reconstructed OrchestratorResult — the exact type `resumeFromGoal` consumes
   * as its `priorResult` argument.
   */
  priorResult: OrchestratorResult;
}

/** Shape of the `runs` columns this loader reads. */
interface RunRow {
  run_id: string;
  status: string | null;
  goal_graph: string | null;
  output: string | null;
  trace: string | null;
  token_usage: string | null;
  duration_ms: number | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the latest run for a task and reconstruct the state needed to resume it.
 *
 * Returns `null` (never throws) when the run cannot be resumed:
 *   - no `runs` row for the task
 *   - latest run's `goal_graph` is NULL (run never got far enough to plan a graph)
 *   - `goal_graph` JSON is malformed
 *   - `goal_graph` JSON has the wrong shape (no `goals` object)
 *
 * The reason is logged so an operator can distinguish "never ran" from
 * "ran but wasn't a graph task" from "corrupt row".
 */
export function loadResumableRun(taskId: string): ResumableRun | null {
  const db = getDatabase();

  // Latest run for the task (mirrors the documented idx_runs_task_created
  // "latest run for task" access pattern). A null goal_graph on the latest run
  // means the most recent attempt never planned a graph → nothing to resume.
  const row = db
    .prepare(
      `SELECT run_id, status, goal_graph, output, trace, token_usage, duration_ms
         FROM runs
        WHERE task_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(taskId) as RunRow | undefined;

  if (!row) {
    console.warn(`[resume-loader] Task ${taskId}: no runs row — not resumable`);
    return null;
  }

  if (!row.goal_graph) {
    console.warn(
      `[resume-loader] Task ${taskId}: latest run ${row.run_id} has no goal_graph (never planned a graph) — not resumable`,
    );
    return null;
  }

  const graphJson = parseGoalGraph(row.goal_graph);
  if (!graphJson) {
    console.warn(
      `[resume-loader] Task ${taskId}: run ${row.run_id} goal_graph is malformed or wrong-shape — not resumable`,
    );
    return null;
  }

  const graph = GoalGraph.fromJSON(graphJson);
  const priorResult = reconstructPriorResult(row, graphJson, graph);

  return { graph, priorResult };
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

/** Parse + shape-validate `runs.goal_graph`. Returns null on any failure. */
function parseGoalGraph(raw: string): { goals: Record<string, Goal> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("goals" in parsed) ||
    typeof (parsed as { goals: unknown }).goals !== "object" ||
    (parsed as { goals: unknown }).goals === null
  ) {
    return null;
  }
  return parsed as { goals: Record<string, Goal> };
}

/**
 * Build a full, typed OrchestratorResult from the persisted row. Only
 * `goalGraph` is load-bearing for resume; the remaining fields are
 * reconstructed best-effort (reflection from `output`, tokenUsage/trace/
 * durationMs from their columns) with safe defaults so the shape is valid and
 * a resumed run's reflection can see the prior context.
 */
function reconstructPriorResult(
  row: RunRow,
  graphJson: { goals: Record<string, Goal> },
  graph: GoalGraph,
): OrchestratorResult {
  const goalResults: Record<string, GoalResult> = {};
  for (const goal of Object.values(graphJson.goals)) {
    goalResults[goal.id] = goalResultStub(goal);
  }

  const out = safeParseObject(row.output);
  const reflection: ReflectionResult = {
    success: row.status === "completed",
    score: typeof out?.score === "number" ? out.score : 0,
    learnings: Array.isArray(out?.learnings) ? (out.learnings as string[]) : [],
    summary: typeof out?.content === "string" ? out.content : "",
  };

  const trace = safeParseArray(row.trace) as TraceEvent[];

  return {
    success: row.status === "completed",
    goalGraph: graphJson,
    executionResults: {
      goalResults,
      summary: graph.summary(),
      totalToolCalls: 0,
      totalToolNames: [],
      totalToolFailures: 0,
      tokenUsage: reconstructTokenUsage(row.token_usage),
      toolRepairs: [],
    },
    reflection,
    trace,
    // No dedicated traceId column is persisted; the run's unique id is the
    // closest honest identity for the prior run.
    traceId: row.run_id,
    durationMs: row.duration_ms ?? 0,
    tokenUsage: reconstructTokenUsage(row.token_usage),
    iterationsUsed: 0,
  };
}

/**
 * Minimal GoalResult reconstructed from a persisted goal. Per-goal result text,
 * provenance and token usage are NOT persisted (see file header), so stubs
 * carry only status → ok and zeroed metrics. This keeps `resumeFromGoal`'s
 * keep/merge logic correct; it does not fabricate output the run never stored.
 */
function goalResultStub(goal: Goal): GoalResult {
  return {
    goalId: goal.id,
    ok: goal.status === GoalStatus.COMPLETED,
    durationMs: 0,
    toolCalls: 0,
    toolNames: [],
    toolFailures: 0,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
  };
}

/** Reconstruct TokenUsage from `runs.token_usage`, defaulting to zeros. */
function reconstructTokenUsage(raw: string | null): TokenUsage {
  const tu = safeParseObject(raw);
  return {
    promptTokens: typeof tu?.promptTokens === "number" ? tu.promptTokens : 0,
    completionTokens:
      typeof tu?.completionTokens === "number" ? tu.completionTokens : 0,
    ...(typeof tu?.cacheReadTokens === "number" && {
      cacheReadTokens: tu.cacheReadTokens,
    }),
    ...(typeof tu?.cacheCreationTokens === "number" && {
      cacheCreationTokens: tu.cacheCreationTokens,
    }),
    ...(typeof tu?.actualModel === "string" && { actualModel: tu.actualModel }),
    ...(typeof tu?.actualCostUsd === "number" && {
      actualCostUsd: tu.actualCostUsd,
    }),
  };
}

// ---------------------------------------------------------------------------
// Safe JSON helpers — never throw; malformed non-critical columns degrade to
// defaults rather than failing the whole load.
// ---------------------------------------------------------------------------

function safeParseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeParseArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
