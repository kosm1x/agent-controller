/**
 * Reflector — Post-execution evaluation and learning extraction.
 *
 * Evaluates task execution results against goals using LLM assessment
 * with a heuristic fallback for score validation.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { queryClaudeSdkAsInfer } from "../inference/claude-sdk.js";
import { getConfig } from "../config.js";
import { GoalGraph } from "./goal-graph.js";
import {
  GoalStatus,
  parseLLMJson,
  convergenceScore,
  LLMJsonParseError,
} from "./types.js";
import type {
  ReflectionResult,
  ExecutionResult,
  TokenUsage,
  DimensionalCritique,
} from "./types.js";
import { getMemoryService } from "../memory/index.js";
import { searchMaps, getNodes } from "../db/knowledge-maps.js";
import { logReflectorGap } from "../db/reflector-gap.js";

// v7.9 Prometheus Sonnet port — see planner.ts for the rationale.
function useSdkPath(): boolean {
  return getConfig().inferencePrimaryProvider === "claude-sdk";
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const REFLECT_SYSTEM = `You are the reflection module of an autonomous agent. Evaluate execution results against task goals.

Think step by step before scoring. For each of these dimensions, write one short sentence:
1. completion       — Which goals actually completed with usable output?
2. correctness      — Which goals failed or produced degenerate/empty results?
3. evidence_quality — Were claims/numbers in the outputs defensible given the tool evidence observed?
4. effort           — Was the amount of work (tool calls, tokens, detail) appropriate, or bloated/thin?
5. domain_coverage  — If a domain knowledge map was provided, did execution cover the key concepts and avoid the listed gotchas?

After the reasoning, emit EXACTLY ONE JSON object as the FINAL content of your response:
{
  "success": true,
  "score": 0.85,
  "learnings": ["actionable insight 1", "actionable insight 2"],
  "summary": "brief overall assessment of what was accomplished",
  "dimensions": [
    { "dimension": "completion",       "score": 0.9, "evidence": "4/5 goals reached usable output; goal-3 incomplete" },
    { "dimension": "correctness",      "score": 1.0, "evidence": "no degenerate or empty results" },
    { "dimension": "evidence_quality", "score": 0.8, "evidence": "claim X cites tool result Y; one number unsourced" },
    { "dimension": "effort",           "score": 0.7, "evidence": "12 tool calls for a 3-goal task is on the heavy side" },
    { "dimension": "domain_coverage",  "score": 1.0, "evidence": "no map provided" }
  ]
}

Rules:
- score = fraction of goals successfully completed (0.0 to 1.0).
- success = true only if score >= 0.8 and no critical goals failed.
- learnings should be actionable and specific, not generic.
- summary should be 1-3 sentences.
- dimensions: emit exactly the 5 listed names with score (0.0-1.0) and one-sentence evidence each. If a dimension does not apply (e.g. no domain map), emit it anyway with score 1.0 and evidence "n/a — <reason>".
- The reasoning above can be any prose. Only the final JSON object is consumed.
- Do NOT wrap the JSON in markdown fences. Emit it bare at the end of your response.`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReflectionAssessment {
  success: boolean;
  score: number;
  learnings: string[];
  summary: string;
  dimensions?: DimensionalCritique[];
}

const DIMENSION_NAMES: ReadonlyArray<DimensionalCritique["dimension"]> = [
  "completion",
  "correctness",
  "evidence_quality",
  "effort",
  "domain_coverage",
];

/**
 * Sanitize the LLM-emitted `dimensions` array. Drops malformed entries,
 * clamps scores to [0, 1], rejects unknown dimension names, and returns
 * undefined if nothing remains so callers can detect "absent" cleanly.
 */
function sanitizeDimensions(raw: unknown): DimensionalCritique[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const known = new Set<string>(DIMENSION_NAMES);
  const out: DimensionalCritique[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const dim = typeof e.dimension === "string" ? e.dimension : null;
    const score = typeof e.score === "number" ? e.score : NaN;
    const evidence = typeof e.evidence === "string" ? e.evidence : null;
    if (!dim || !known.has(dim) || !Number.isFinite(score) || evidence === null)
      continue;
    out.push({
      dimension: dim as DimensionalCritique["dimension"],
      score: Math.max(0, Math.min(1, score)),
      evidence,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Pick the lowest-scoring dimension from a critique array. Used by the
 * planner to target replans; ties broken by DIMENSION_NAMES order so the
 * choice is deterministic.
 */
export function lowestDimension(
  dimensions: DimensionalCritique[] | undefined,
): DimensionalCritique | undefined {
  if (!dimensions || dimensions.length === 0) return undefined;
  let best = dimensions[0];
  for (const d of dimensions) {
    if (d.score < best.score) best = d;
  }
  return best;
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
  let llmAvailable = false;
  let rawLlmScore: number | null = null;

  try {
    const response = useSdkPath()
      ? await queryClaudeSdkAsInfer(messages)
      : await infer({ messages, temperature: 0.3 });
    const content = response.content ?? "";
    assessment = parseLLMJson<ReflectionAssessment>(content);
    // Sanitize the optional dimensions array — drop malformed entries,
    // clamp scores, normalize. Keeps the rest of the assessment usable
    // even when only the dimensions block is malformed.
    assessment.dimensions = sanitizeDimensions(
      (assessment as { dimensions?: unknown }).dimensions,
    );
    llmAvailable = true;
    rawLlmScore = assessment.score;
    usage = {
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      ...(response.usage.cache_read_tokens !== undefined && {
        cacheReadTokens: response.usage.cache_read_tokens,
      }),
      ...(response.usage.cache_creation_tokens !== undefined && {
        cacheCreationTokens: response.usage.cache_creation_tokens,
      }),
    };
  } catch (err) {
    if (err instanceof LLMJsonParseError) {
      // Generic message + structured diagnostic detail. Diagnostic stays in
      // journalctl; the message itself never embeds raw LLM content (per
      // LLMJsonParseError contract — same surface used by planner).
      console.warn(
        `[reflector] Failed to get LLM reflection: ${err.message} ${err.diagnosticDetail()}; using heuristic`,
      );
    } else {
      console.warn(
        `[reflector] Failed to get LLM reflection: ${err instanceof Error ? err.message : err}; using heuristic`,
      );
    }
    assessment = heuristicFallback(graph);
  }

  // Heuristic override: if LLM score diverges > 0.3 from goal completion ratio
  const heuristicScore = computeHeuristicScore(graph);

  // Autoreason Phase 1: log generation-evaluation gap telemetry. Captures the
  // RAW LLM score (pre-override) vs the heuristic. Non-fatal, write-only.
  if (taskId) {
    const summary = graph.summary();
    logReflectorGap({
      taskId,
      llmScore: rawLlmScore ?? assessment.score,
      heuristicScore,
      llmAvailable,
      goalsTotal: summary.total,
      goalsCompleted: summary.completed,
      goalsFailed: summary.failed,
    });
  }

  // Track whether the score was overridden away from the LLM's number. If
  // so, the per-dimension critiques describe the LLM's view and may now
  // contradict the kept score — drop them rather than ship contradictions
  // (audit W1).
  let scoreOverridden = false;

  if (Math.abs(assessment.score - heuristicScore) > 0.3) {
    console.log(
      `[reflector] LLM score (${assessment.score.toFixed(2)}) diverges from ` +
        `heuristic (${heuristicScore.toFixed(2)}); using heuristic`,
    );
    assessment.score = heuristicScore;
    const hasFailedGoals = graph.getByStatus(GoalStatus.FAILED).length > 0;
    assessment.success = heuristicScore >= 0.8 && !hasFailedGoals;
    scoreOverridden = true;
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
      scoreOverridden = true;
      console.log(
        `[reflector] Source anchoring penalty: ${penalty.toFixed(3)} (${verified}/${total} verified)`,
      );
    }
  }

  // H1: Convergence penalty — penalize looping goals
  const goalResults = Object.values(executionResults.goalResults);
  const convergenceData = goalResults.map((gr) => {
    const uniqueTools = new Set(gr.toolNames).size;
    const conv = convergenceScore(gr.toolCalls, uniqueTools);
    return { goalId: gr.goalId, ...conv };
  });
  const loopingGoals = convergenceData.filter((c) => c.looping);
  if (loopingGoals.length > 0) {
    const penalty = 0.1 * Math.min(loopingGoals.length, 3);
    assessment.score = Math.max(0, assessment.score - penalty);
    scoreOverridden = true;
    console.log(
      `[reflector] Convergence penalty: -${penalty.toFixed(2)} (${loopingGoals.length} looping goals)`,
    );
  }

  // H2: Trace efficiency — pure arithmetic from execution metrics
  const totalTokens =
    executionResults.tokenUsage.promptTokens +
    executionResults.tokenUsage.completionTokens;
  const tokenBurnRate =
    executionResults.totalToolCalls > 0
      ? totalTokens / executionResults.totalToolCalls
      : 0;
  const avgConvergence =
    convergenceData.length > 0
      ? convergenceData.reduce((s, c) => s + c.score, 0) /
        convergenceData.length
      : 0;
  const burnPenalty =
    tokenBurnRate > 10_000
      ? Math.min((tokenBurnRate - 10_000) / 50_000, 0.3)
      : 0;
  const convergencePenalty =
    avgConvergence > 3.0 ? Math.min((avgConvergence - 3.0) * 0.05, 0.2) : 0;
  const traceEfficiency = {
    efficiency: Math.max(0, 1.0 - burnPenalty - convergencePenalty),
    tokenBurnRate,
    avgConvergence,
  };
  if (traceEfficiency.efficiency < 0.5) {
    const tracePenalty = (0.5 - traceEfficiency.efficiency) * 0.1;
    assessment.score = Math.max(0, assessment.score - tracePenalty);
    scoreOverridden = true;
    console.log(
      `[reflector] Trace efficiency penalty: -${tracePenalty.toFixed(3)} ` +
        `(eff=${traceEfficiency.efficiency.toFixed(2)}, burn=${Math.round(tokenBurnRate)} tok/call)`,
    );
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
      convergenceData: loopingGoals.length > 0 ? convergenceData : undefined,
      traceEfficiency,
      // Per-dimension critiques describe the LLM's score. If any pathway
      // overrode the LLM score (heuristic divergence, anchoring, convergence,
      // or trace-efficiency penalty), the dimensions may now contradict the
      // kept score — drop them so consumers don't act on stale evidence.
      dimensions: scoreOverridden ? undefined : assessment.dimensions,
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
