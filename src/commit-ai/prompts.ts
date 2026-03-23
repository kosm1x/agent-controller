/**
 * Prompt assembly for COMMIT AI functions.
 *
 * Wraps the original COMMIT prompt with enriched context (goals, tasks,
 * memory) and language instructions. The original prompts are passed through
 * from the COMMIT frontend — we don't reconstruct them here.
 */

import type { EnrichedContext } from "./enrichment.js";

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  en: "IMPORTANT: Respond in English. All text, labels, and content must be in English.",
  es: "IMPORTANTE: Responde en español. Todo el texto, etiquetas y contenido deben estar en español.",
  zh: "重要：用中文回复。所有文本、标签和内容必须使用中文。",
};

/**
 * Build an enriched prompt by wrapping the original COMMIT prompt with
 * contextual information from the user's COMMIT state and memories.
 */
export function buildEnrichedPrompt(
  functionName: string,
  originalPrompt: string,
  context: EnrichedContext,
  language: string,
): string {
  const sections: string[] = [];

  // Context prefix — only if we have enrichment data
  const contextLines: string[] = [];
  if (context.snapshotSummary) {
    contextLines.push(context.snapshotSummary);
  }
  if (context.goalsSummary) {
    contextLines.push(`Active goals: ${context.goalsSummary}`);
  }
  if (context.memorySummary) {
    contextLines.push(
      `Relevant context from past interactions: ${context.memorySummary}`,
    );
  }

  if (contextLines.length > 0) {
    sections.push(
      `[CONTEXT — user's current personal growth state]\n${contextLines.join("\n")}`,
    );
  }

  // Original prompt
  sections.push(`[TASK]\n${originalPrompt}`);

  // JSON-only output instruction (helps with extraction)
  if (functionName !== "transformIdeaText") {
    sections.push(
      "Return ONLY valid JSON matching the expected schema. No markdown fences, no explanation outside the JSON.",
    );
  }

  // Language instruction
  const langInstruction =
    LANGUAGE_INSTRUCTIONS[language] ?? LANGUAGE_INSTRUCTIONS.en;
  sections.push(langInstruction);

  return sections.join("\n\n");
}
