/**
 * LLM prompt templates — ported (with adaptations) from HKUDS DeepTutor YAMLs.
 * Source: reference_deeptutor.md — design_agent.yaml, chat_agent.yaml,
 * summary_agent.yaml, agents/question/coordinator.py.
 *
 * Design note: outputs are strictly JSON so extractFirstJson can parse.
 */

import type { LearningPlanUnitRow } from "./schema-types.js";

export function designPrompt(topic: string, ceilingUnits: number): string {
  return `You are a curriculum designer. Decompose the topic below into 2-${ceilingUnits} ordered atomic learning units that a motivated adult can work through in sequence.

Topic: ${topic}

For each unit, produce:
- title (short, concrete — name the concept, not the activity)
- summary (2-3 sentences — what the learner will understand after this unit)
- predicted_difficulties (array of 1-3 strings — common misconceptions or sticking points for THIS unit; use plain words, no jargon in the label)
- prerequisites (array of earlier unit indexes — 0-based, must be < current index; empty for unit 0)

Rules:
- Order by prerequisite chain. Unit 0 has no prereqs.
- Each unit is self-contained enough for a single study session (~20-40 minutes).
- Avoid overlap — if two units cover the same concept, merge them.
- Prefer concrete named concepts over vague headings.

Output ONLY a JSON array. No prose before or after. Example shape:

[
  {"title":"...","summary":"...","predicted_difficulties":["..."],"prerequisites":[]},
  {"title":"...","summary":"...","predicted_difficulties":["..."],"prerequisites":[0]}
]`;
}

export function summaryPrompt(
  unit: LearningPlanUnitRow,
  transcript: string,
): string {
  return `You are writing a retrospective mastery report for a single tutoring session on Unit ${unit.unit_index + 1}: ${unit.title}.

Transcript of the session:
<<<
${transcript}
>>>

Extract every specific concept the learner engaged with. For each, cite a direct quote from the learner (not the tutor) as evidence of their understanding level, and estimate a mastery score between 0 (no grasp) and 1 (ready to teach it to someone else).

Rules:
- Concept names are short noun phrases, lowercase, no trailing punctuation. E.g. "promise chaining", "kelly fraction sizing", "lru cache eviction".
- evidence_quote must be an actual substring from the learner's turns. If the learner did not speak about a topic, do NOT include it.
- mastery_estimate reflects evidence, not wishful thinking. A single correct answer = 0.3-0.5. Multiple correct answers + a clean explanation = 0.7-0.9. Explaining an edge case the tutor didn't teach = 0.9-1.
- Prefer 3-8 concepts. More than 10 means you are including things the learner did not engage with.

Output ONLY a JSON object with shape:

{"concepts":[{"concept":"...","evidence_quote":"...","mastery_estimate":0.65}]}`;
}

export function quizPrompt(
  unit: LearningPlanUnitRow,
  history: string[],
  targetDifficulty: "easy" | "medium" | "hard",
  n: number,
): string {
  const historyBlock =
    history.length > 0
      ? `Prior questions asked on this unit (do NOT repeat):\n${history
          .slice(-15)
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n")}`
      : "No prior questions for this unit yet.";

  const difficultyDescription =
    targetDifficulty === "easy"
      ? "Easy: recall or recognize a single fact. One-sentence answer."
      : targetDifficulty === "hard"
        ? "Hard: apply the concept to a novel scenario, or compare with a related concept. 2-4 sentence answer required."
        : "Medium: explain a mechanism or work through a small example. 1-2 sentence answer.";

  return `You are generating ${n} fresh quiz questions for Unit ${unit.unit_index + 1}: ${unit.title}.
Unit summary: ${unit.summary}

Difficulty target: ${targetDifficulty}. ${difficultyDescription}

${historyBlock}

Rules:
- Each question tests a specific idea from the unit, not trivia.
- Avoid yes/no questions. Prefer "why", "how", "compare", "walk through".
- Provide a concise expected_answer (2-5 sentences) that would score 5/5.
- If you cannot generate ${n} non-duplicates, generate fewer.

Output ONLY a JSON array. Each item shape:
{"question":"...","expected_answer":"...","difficulty":"${targetDifficulty}"}`;
}

export function explainBackPrompt(unit: LearningPlanUnitRow): string {
  return `In your own words, how would you explain ${unit.title} to someone who doesn't know it?
You can use analogies, small examples, or drawn-from-memory details. Aim for 3-6 sentences.
When ready, reply with your explanation. I'll then grade it against the unit's core ideas.`;
}

export function gradingPrompt(
  unit: LearningPlanUnitRow,
  userExplanation: string,
): string {
  return `You are grading a learner's explain-back of Unit ${unit.unit_index + 1}: ${unit.title}.
Unit summary: ${unit.summary}

Learner's explanation:
<<<
${userExplanation}
>>>

Rubric (score each 0-1, then aggregate to quality ∈ {0..5}):
1. completeness — covers the core ideas of the unit
2. accuracy — no factual errors
3. structure — logical order, not a word soup
4. misconceptions_flagged — if the learner restated a predicted difficulty (${
    unit.predicted_difficulties.join("; ") || "none"
  }) as fact, flag it; if they correctly addressed one, credit it
5. confidence_tone — explains, doesn't hedge (so-maybe-kind-of tone lowers the score)

Scoring:
- 5 = all five criteria fully met, could teach the topic themselves
- 4 = all criteria met, minor gap
- 3 = passable but one criterion missing
- 2 = partial grasp, at least one factual error OR one criterion absent
- 1 = mostly wrong or off-topic
- 0 = blank, refusal, or unrelated

Output ONLY a JSON object with shape:
{"quality": 3, "feedback": "1-2 sentences of actionable feedback", "flagged_misconceptions": ["..."]}`;
}
