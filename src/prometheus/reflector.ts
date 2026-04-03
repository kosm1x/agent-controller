/**
 * Reflector — Post-execution evaluation and learning extraction.
 *
 * Evaluates task execution results against goals using LLM assessment
 * with a heuristic fallback for score validation.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { GoalGraph } from "./goal-graph.js";
import { GoalStatus, parseLLMJson } from "./types.js";
import type { ReflectionResult, ExecutionResult, TokenUsage } from "./types.js";
import { getMemoryService } from "../memory/index.js";
import { searchMaps, getNodes } from "../db/knowledge-maps.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const REFLECT_SYSTEM = `You are the reflection module of an autonomous agent. Evaluate execution results against task goals.

Respond ONLY with a JSON object:
{
  "success": true,
  "score": 0.85,
  "learnings": ["actionable insight 1", "actionable insight 2"],
  "summary": "brief overall assessment of what was accomplished"
}

Rules:
- score = fraction of goals successfully completed (0.0 to 1.0).
- success = true only if score >= 0.8 and no critical goals failed.
- learnings should be actionable and specific, not generic.
- summary should be 1-3 sentences.
- If a domain knowledge map is provided, evaluate whether execution addressed key concepts and avoided listed gotchas.
- Emit ONLY valid JSON. No markdown, no commentary.`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReflectionAssessment {
  success: boolean;
  score: number;
  learnings: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate task execution and extract learnings.
 */
export async function reflect(
  taskDescription: string,
  graph: GoalGraph,
  executionResults: ExecutionResult,
  taskId?: string,
): Promise<{ result: ReflectionResult; usage: TokenUsage }> {
  const userContent = buildReflectPrompt(
    taskDescription,
    graph,
    executionResults,
  );
  const messages: ChatMessage[] = [
    { role: "system", content: REFLECT_SYSTEM },
    { role: "user", content: userContent },
  ];

  let assessment: ReflectionAssessment;
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

  try {
    const response = await infer({ messages, temperature: 0.3 });
    const content = response.content ?? "";
    assessment = parseLLMJson<ReflectionAssessment>(content);
    usage = {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
    };
  } catch (err) {
    console.warn(
      `[reflector] Failed to get LLM reflection: ${err instanceof Error ? err.message : err}; using heuristic`,
    );
    assessment = heuristicFallback(graph);
  }

  // Heuristic override: if LLM score diverges > 0.3 from goal completion ratio
  const heuristicScore = computeHeuristicScore(graph);
  if (Math.abs(assessment.score - heuristicScore) > 0.3) {
    console.log(
      `[reflector] LLM score (${assessment.score.toFixed(2)}) diverges from ` +
        `heuristic (${heuristicScore.toFixed(2)}); using heuristic`,
    );
    assessment.score = heuristicScore;
    const hasFailedGoals = graph.getByStatus(GoalStatus.FAILED).length > 0;
    assessment.success = heuristicScore >= 0.8 && !hasFailedGoals;
  }

  // Source anchoring heuristic (S5c): penalize unverified citations
  let anchoringScore: number | undefined;
  if (
    executionResults.provenanceRecords &&
    executionResults.provenanceRecords.length > 0
  ) {
    const records = executionResults.provenanceRecords;
    const verified = records.filter((r) => r.status === "verified").length;
    const total = records.length;
    anchoringScore = total > 0 ? verified / total : 1;

    // Penalize score if anchoring is weak (< 50% verified) and enough sources
    if (anchoringScore < 0.5 && total >= 3) {
      const penalty = (0.5 - anchoringScore) * 0.2; // Max 10% penalty
      assessment.score = Math.max(0, assessment.score - penalty);
      console.log(
        `[reflector] Source anchoring penalty: ${penalty.toFixed(3)} (${verified}/${total} verified)`,
      );
    }
  }

  const learnings = assessment.learnings ?? [];

  // Persist learnings via memory service
  if (taskId && learnings.length > 0) {
    const memory = getMemoryService();
    for (const learning of learnings) {
      memory
        .retain(learning, {
          bank: "mc-operational",
          tags: ["reflection"],
          taskId,
          async: true,
          trustTier: 2, // inferred — reflector synthesis
          source: "reflector",
        })
        .catch(() => {
          // Best-effort persistence
        });
    }
  }

  return {
    result: {
      success: assessment.success,
      score: assessment.score,
      learnings,
      summary: assessment.summary ?? "",
      anchoringScore,
    },
    usage,
  };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildReflectPrompt(
  taskDescription: string,
  graph: GoalGraph,
  executionResults: ExecutionResult,
): string {
  const summary = graph.summary();
  const goalDetails: string[] = [];

  const graphData = graph.toJSON();
  for (const [id, goal] of Object.entries(graphData.goals)) {
    const result = executionResults.goalResults[id];
    let detail = `- ${id}: [${goal.status}] ${goal.description}`;
    if (goal.completionCriteria.length > 0) {
      detail += `\n  Criteria: ${goal.completionCriteria.join("; ")}`;
    }
    if (result?.ok && result.result) {
      const truncated =
        result.result.length > 300
          ? result.result.slice(0, 300) + "..."
          : result.result;
      detail += `\n  Result: ${truncated}`;
    } else if (result?.error) {
      detail += `\n  Error: ${result.error}`;
    }
    goalDetails.push(detail);
  }

  // Check for domain knowledge map to score against
  let mapSection = "";
  try {
    const maps = searchMaps(taskDescription);
    if (maps.length > 0) {
      const nodes = getNodes(maps[0].id);
      const concepts = nodes.filter((n) => n.type === "concept");
      const gotchas = nodes.filter((n) => n.type === "gotcha");
      if (concepts.length > 0 || gotchas.length > 0) {
        mapSection =
          `\n\n## Domain Knowledge Map: ${maps[0].topic}\n` +
          `Key concepts that should have been addressed:\n` +
          concepts.map((n) => `- ${n.label}`).join("\n") +
          "\n" +
          (gotchas.length > 0
            ? `Gotchas that should have been considered:\n` +
              gotchas
                .map((n) => `- ${n.label}: ${n.summary.slice(0, 200)}`)
                .join("\n") +
              "\n"
            : "") +
          `Score lower if critical concepts were ignored or gotchas were not addressed.`;
      }
    }
  } catch {
    // Non-fatal
  }

  // Provenance context — inject source verification data (S5c)
  let provenanceSection = "";
  if (
    executionResults.provenanceRecords &&
    executionResults.provenanceRecords.length > 0
  ) {
    const records = executionResults.provenanceRecords;
    const verified = records.filter((r) => r.status === "verified").length;
    const inferred = records.filter((r) => r.status === "inferred").length;
    const unverified = records.filter((r) => r.status === "unverified").length;

    provenanceSection =
      `\n\n## Source Provenance\n` +
      `Sources consulted: ${records.length} (verified: ${verified}, inferred: ${inferred}, unverified: ${unverified})\n` +
      records
        .slice(0, 20)
        .map(
          (r) => `- [${r.status}] ${r.tool_name}: ${r.url ?? r.query ?? "N/A"}`,
        )
        .join("\n") +
      `\nScore lower if many sources are unverified or if URLs in the output were not actually fetched.`;
  }

  return (
    `## Task\n${taskDescription}\n\n` +
    `## Goal Graph Summary\n` +
    `Total: ${summary.total}, Completed: ${summary.completed}, Failed: ${summary.failed}, ` +
    `Pending: ${summary.pending}, Blocked: ${summary.blocked}\n\n` +
    `## Goal Details\n${goalDetails.join("\n")}\n\n` +
    `## Execution Stats\n` +
    `Tool calls: ${executionResults.totalToolCalls}, ` +
    `Tool failures: ${executionResults.totalToolFailures}` +
    mapSection +
    provenanceSection
  );
}

// ---------------------------------------------------------------------------
// Heuristic scoring
// ---------------------------------------------------------------------------

function computeHeuristicScore(graph: GoalGraph): number {
  const summary = graph.summary();
  const total = summary.total || 1;
  return Math.round((summary.completed / total) * 1000) / 1000;
}

function heuristicFallback(graph: GoalGraph): ReflectionAssessment {
  const score = computeHeuristicScore(graph);
  return {
    success: score >= 0.8 && graph.getByStatus(GoalStatus.FAILED).length === 0,
    score,
    learnings: ["Reflection LLM unavailable; scored via heuristic"],
    summary: `Heuristic score: ${score.toFixed(2)}. ${graph.summary().completed}/${graph.summary().total} goals completed.`,
  };
}
