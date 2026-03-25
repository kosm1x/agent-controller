/**
 * Meta-agent — proposes mutations to improve Jarvis's configuration.
 *
 * Calls infer() with a structured prompt containing:
 * - Current eval scores and worst-performing cases
 * - Experiment history (what worked, what didn't)
 * - Current tool descriptions and scope patterns
 * - Recent production failures
 *
 * Returns a single Mutation proposal with hypothesis.
 */

import type {
  Mutation,
  CaseScore,
  TuningSurface,
  Experiment,
} from "./types.js";
import { toolRegistry } from "../tools/registry.js";
import { DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/** Get current tool descriptions for the tools involved in failing cases. */
export function getToolDescriptions(toolNames: string[]): string {
  const lines: string[] = [];
  for (const name of toolNames) {
    const tool = toolRegistry.get(name);
    if (tool) {
      const desc = tool.definition.function.description;
      lines.push(`### ${name}\n${desc}\n`);
    }
  }
  return lines.join("\n");
}

/** Format scope patterns as readable text. */
export function formatScopePatterns(): string {
  return DEFAULT_SCOPE_PATTERNS.map(
    (p) => `- Group "${p.group}": ${p.pattern.source}`,
  ).join("\n");
}

/** Format case scores for the prompt (worst first). */
export function formatWorstCases(cases: CaseScore[], limit: number): string {
  const worst = [...cases].sort((a, b) => a.score - b.score).slice(0, limit);

  return worst
    .map((c) => {
      const pct = (c.score * 100).toFixed(0);
      const detail = JSON.stringify(c.details, null, 2);
      return `- **${c.caseId}** (${c.category}): ${pct}%\n  ${detail}`;
    })
    .join("\n");
}

/** Format experiment history for the prompt. */
export function formatExperimentHistory(experiments: Experiment[]): string {
  if (experiments.length === 0) return "No previous experiments.";

  return experiments
    .map((e) => {
      const delta = (e.mutated_score ?? 0) - (e.baseline_score ?? 0);
      const sign = delta >= 0 ? "+" : "";
      return `- [${e.status}] ${e.surface}/${e.target}: ${sign}${delta.toFixed(1)} — ${e.hypothesis ?? "no hypothesis"}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export interface MetaAgentContext {
  compositeScore: number;
  worstCases: CaseScore[];
  experimentHistory: Experiment[];
  surfaces: TuningSurface[];
}

export function buildMetaAgentPrompt(ctx: MetaAgentContext): string {
  // Collect tool names from worst cases
  const toolsInFailures = new Set<string>();
  for (const c of ctx.worstCases) {
    const details = c.details as Record<string, unknown>;
    const expected = (details.expected as string[]) ?? [];
    const misses = (details.misses as string[]) ?? [];
    for (const t of [...expected, ...misses]) {
      if (t) toolsInFailures.add(t);
    }
  }

  const allowedSurfaces = ctx.surfaces.map((s) => `"${s}"`).join(", ");

  return `You are the Jarvis Self-Tuning Agent. Your job is to improve Jarvis's performance by modifying its configuration surfaces.

## Current Performance
Composite score: ${ctx.compositeScore.toFixed(1)} / 100

## Worst-Performing Test Cases (fix these)
${formatWorstCases(ctx.worstCases, 10)}

## Previous Experiments
${formatExperimentHistory(ctx.experimentHistory)}

## Current Tool Descriptions (for tools in failing cases)
${getToolDescriptions([...toolsInFailures])}

## Current Scope Patterns
${formatScopePatterns()}

## Available Surfaces
You can propose mutations to: ${allowedSurfaces}

### Surface: tool_description
Rewrite a tool's description to improve when the LLM selects it. The description is what the LLM reads to decide which tool to call.

### Surface: scope_rule
Modify a scope pattern regex to include/exclude keywords that should activate a tool group. Groups: ${DEFAULT_SCOPE_PATTERNS.map((p) => p.group).join(", ")}.

## Rules
1. Propose exactly ONE mutation per response
2. Focus on the worst-performing test cases
3. Don't repeat mutations that already failed (check experiment history)
4. For scope_rule changes: provide the new regex pattern as a string (will be compiled with /i flag)
5. For tool_description changes: provide the complete new description text
6. Keep descriptions concise — the LLM reads them on every call, so length costs tokens

## Few-shot Examples

Example 1 (scope_rule):
The test case "Revisa los containers de Docker" expected scope group "coding" but it wasn't activated.
Mutation: Add "docker|container" to the coding scope pattern.
{"surface":"scope_rule","target":"coding","mutation_type":"adjust","mutated_value":"\\\\b(c[oó]digo|code|archivos?|files?|docker|containers?|scripts?|deploy)\\\\i","hypothesis":"Docker/container queries should activate coding tools"}

Example 2 (tool_description):
web_search had 60% accuracy on price queries — the LLM wasn't calling it for "cuánto cuesta" messages.
Mutation: Added price-related triggers to the description.
{"surface":"tool_description","target":"web_search","mutation_type":"rewrite","mutated_value":"Search the internet... USE WHEN: ...prices, costs, quotes...","hypothesis":"Price queries should trigger web_search"}

## Your Task
Analyze the worst cases and propose ONE mutation. Output ONLY valid JSON:
{"surface":"...", "target":"...", "mutation_type":"rewrite"|"adjust", "mutated_value":"...", "hypothesis":"..."}`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse the meta-agent's response into a Mutation.
 * Handles JSON wrapped in markdown code blocks.
 */
export function parseMutationResponse(response: string): Mutation | null {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  }

  // Try to find JSON object in the response
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;

  try {
    const parsed = JSON.parse(objectMatch[0]) as Record<string, unknown>;

    // Validate required fields
    const surface = parsed.surface as string;
    const target = parsed.target as string;
    const mutated_value = parsed.mutated_value as string;
    const hypothesis = parsed.hypothesis as string;
    const mutation_type = (parsed.mutation_type as string) ?? "rewrite";

    if (!surface || !target || !mutated_value) return null;

    const validSurfaces: TuningSurface[] = [
      "tool_description",
      "scope_rule",
      "classifier",
      "prompt",
    ];
    if (!validSurfaces.includes(surface as TuningSurface)) return null;

    return {
      surface: surface as TuningSurface,
      target,
      mutation_type: mutation_type as Mutation["mutation_type"],
      mutated_value,
      hypothesis: hypothesis ?? "no hypothesis provided",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Meta-agent invocation
// ---------------------------------------------------------------------------

/** Inference function type for the meta-agent (injectable for testing). */
export type MetaInferFunction = (
  systemPrompt: string,
) => Promise<{ content: string; tokensUsed: number }>;

/** Default implementation using the real inference adapter. */
export async function defaultMetaInfer(
  systemPrompt: string,
): Promise<{ content: string; tokensUsed: number }> {
  const { infer } = await import("../inference/adapter.js");

  const result = await infer({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Propose your next mutation." },
    ],
    temperature: 0.7,
    max_tokens: 1024,
  });

  return {
    content: result.content ?? "",
    tokensUsed:
      (result.usage?.prompt_tokens ?? 0) +
      (result.usage?.completion_tokens ?? 0),
  };
}

/**
 * Ask the meta-agent for a mutation proposal.
 *
 * @returns Mutation and token usage, or null if parsing fails.
 */
export async function proposeMutation(
  ctx: MetaAgentContext,
  inferFn: MetaInferFunction = defaultMetaInfer,
): Promise<{ mutation: Mutation | null; tokensUsed: number }> {
  const prompt = buildMetaAgentPrompt(ctx);
  const { content, tokensUsed } = await inferFn(prompt);
  const mutation = parseMutationResponse(content);

  if (!mutation) {
    console.warn(
      `[tuning] Meta-agent response could not be parsed:\n${content.slice(0, 500)}`,
    );
  }

  return { mutation, tokensUsed };
}
