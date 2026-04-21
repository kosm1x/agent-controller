/**
 * Socratic explain-back grading via LLM judge.
 */

import { infer } from "../inference/adapter.js";
import { gradingPrompt } from "./prompts.js";
import { parseGrading } from "./parse.js";
import type { LearningPlanUnitRow } from "./schema-types.js";

export interface GradeResult {
  quality: number;
  feedback: string;
  flagged_misconceptions: string[];
}

export async function gradeExplanation(
  unit: LearningPlanUnitRow,
  userExplanation: string,
): Promise<GradeResult> {
  const trimmed = userExplanation.trim();
  if (!trimmed) {
    return {
      quality: 0,
      feedback:
        "No explanation provided. Try writing 3-6 sentences in your own words.",
      flagged_misconceptions: [],
    };
  }
  const prompt = gradingPrompt(unit, trimmed);
  const response = await infer({
    messages: [
      { role: "system", content: "You are a strict but fair grader." },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });
  const raw = response.content ?? "";
  return parseGrading(raw);
}
