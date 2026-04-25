/**
 * v7.11 — Jarvis Teaching Module: 6 tools under scope group `teaching`.
 *
 * All deferred. Domain logic lives in `src/teaching/`; these files are the
 * LLM-facing surface (argument parsing + orchestration).
 */

import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";
import {
  createPlanWithUnits,
  findOpenSession,
  getActivePlan,
  getConcept,
  getPlan,
  getSession,
  listConcepts,
  listUnits,
  recentQuizQuestions,
  startSession,
  endSession,
  updateUnitStatus,
  upsertConcept,
} from "../../teaching/persist.js";
import {
  parseDecomposition,
  parseQuiz,
  parseSummary,
  normalizeConcept,
} from "../../teaching/parse.js";
import {
  designPrompt,
  explainBackPrompt,
  quizPrompt,
  summaryPrompt,
} from "../../teaching/prompts.js";
import { gradeExplanation } from "../../teaching/grade.js";
import {
  advance,
  resolveUnit,
  targetDifficulty,
} from "../../teaching/state-machine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a plan_id from the argument (explicit) or fall back to the most
 * recently-updated active plan in the DB.
 * Returns null when neither is available — callers must handle that case.
 */
function resolvePlanId(args: Record<string, unknown>): string | null {
  if (typeof args.plan_id === "string" && args.plan_id.trim().length > 0) {
    return args.plan_id.trim();
  }
  const active = getActivePlan();
  return active ? active.plan_id : null;
}

// ---------------------------------------------------------------------------
// learning_plan_create
// ---------------------------------------------------------------------------

export const learningPlanCreateTool: Tool = {
  name: "learning_plan_create",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "teach me",
    "enséñame",
    "explícame desde cero",
    "quiero aprender",
    "want to learn",
  ],
  definition: {
    type: "function",
    function: {
      name: "learning_plan_create",
      description: `Create a learning plan for a topic. Uses an LLM to decompose the topic into 2-8 ordered atomic units (default 5) with predicted difficulties and prerequisites. Persists the plan + units. First unit is marked 'ready'; the rest 'locked' until prerequisites are mastered.

USE WHEN:
- User says "teach me X", "enséñame X", "I want to learn X", "explain X from scratch".
- You need to set up a study track the learner can work through over multiple sessions.

DO NOT USE WHEN:
- User asks for a one-off explanation (use a regular reply).
- User is asking to debug or discuss, not to be taught sequentially.

Returns: plan_id + list of units {index, title, predicted_difficulties}.`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The topic to decompose (e.g. 'React hooks', 'bond duration', 'kubernetes pods')",
          },
          ceiling_units: {
            type: "number",
            description: "Max units (2-8, default 5)",
          },
          notes: {
            type: "string",
            description: "Optional operator notes for the plan",
          },
        },
        required: ["topic"],
      },
    },
  },
  async execute(args): Promise<string> {
    const topicRaw = typeof args.topic === "string" ? args.topic.trim() : "";
    if (!topicRaw) return JSON.stringify({ error: "topic required" });
    if (topicRaw.length > 200)
      return JSON.stringify({
        error: "topic_too_long",
        max_chars: 200,
        received: topicRaw.length,
      });
    const topic = topicRaw.normalize("NFC");
    const ceiling =
      typeof args.ceiling_units === "number" &&
      Number.isFinite(args.ceiling_units)
        ? Math.max(2, Math.min(8, Math.trunc(args.ceiling_units)))
        : 5;
    const notes =
      typeof args.notes === "string" && args.notes.trim().length > 0
        ? args.notes.trim()
        : null;

    const prompt = designPrompt(topic, ceiling);
    let decomposed;
    try {
      const response = await infer({
        messages: [
          {
            role: "system",
            content:
              "You are a curriculum designer. Output strict JSON arrays.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 2000,
      });
      decomposed = parseDecomposition(response.content ?? "", ceiling);
    } catch (err) {
      return JSON.stringify({
        error: "decomposition_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (decomposed.units.length < 2) {
      return JSON.stringify({
        error: "decomposition_too_short",
        returned: decomposed.units.length,
      });
    }

    const plan_id = createPlanWithUnits({
      topic,
      notes,
      units: decomposed.units,
    });

    return JSON.stringify(
      {
        plan_id,
        topic,
        units: decomposed.units.map((u, i) => ({
          index: i,
          title: u.title,
          predicted_difficulties: u.predicted_difficulties,
        })),
        status:
          "Unit 0 is ready. Use learning_plan_quiz / learning_plan_explain_back to work through it, then learning_plan_advance to progress.",
      },
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// learning_plan_advance
// ---------------------------------------------------------------------------

export const learningPlanAdvanceTool: Tool = {
  name: "learning_plan_advance",
  deferred: true,
  riskTier: "low",
  triggerPhrases: ["next unit", "avanzar", "advance plan", "next lesson"],
  definition: {
    type: "function",
    function: {
      name: "learning_plan_advance",
      description: `Advance a learning plan to the next ready unit. Checks the current unit's mastery_score (must be >= 0.7) and the next unit's prerequisites (all must be mastered) before advancing. Pass force=true to override the mastery check (prerequisite check is still enforced).`,
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description: "Plan UUID returned by learning_plan_create. Optional — if omitted, uses the most recently active plan.",
          },
          force: {
            type: "boolean",
            description:
              "Bypass current-unit mastery threshold (prereqs still enforced)",
          },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<string> {
    const plan_id = resolvePlanId(args);
    if (!plan_id) return JSON.stringify({ error: "plan_id required — no active plan found" });
    const force = args.force === true;
    const result = advance(plan_id, force);
    return JSON.stringify(result, null, 2);
  },
};

// ---------------------------------------------------------------------------
// learning_plan_quiz
// ---------------------------------------------------------------------------

export const learningPlanQuizTool: Tool = {
  name: "learning_plan_quiz",
  deferred: true,
  riskTier: "low",
  triggerPhrases: ["quiz me", "quízame", "tómame un quiz", "test me on"],
  definition: {
    type: "function",
    function: {
      name: "learning_plan_quiz",
      description: `Generate an adaptive-difficulty quiz for a unit of a learning plan. Difficulty is derived from the unit's current mastery_score (< 0.3 easy, 0.3-0.7 medium, > 0.7 hard). Deduplicates against recent quiz questions for this unit. Persists a quiz session with the questions + expected answers for grading on the next turn.`,
      parameters: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          unit_index: {
            type: "number",
            description:
              "Unit to quiz on (0-based). Defaults to the plan's current_unit.",
          },
          n: {
            type: "number",
            description: "Number of questions (1-5, default 3)",
          },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<string> {
    const plan_id = resolvePlanId(args);
    if (!plan_id) return JSON.stringify({ error: "plan_id required — no active plan found" });
    const unit_index =
      typeof args.unit_index === "number" && Number.isFinite(args.unit_index)
        ? Math.max(0, Math.trunc(args.unit_index))
        : undefined;
    const n =
      typeof args.n === "number" && Number.isFinite(args.n)
        ? Math.max(1, Math.min(5, Math.trunc(args.n)))
        : 3;

    const unit = resolveUnit(plan_id, unit_index);
    if (!unit)
      return JSON.stringify({ error: "unit_not_found", plan_id, unit_index });

    const history = recentQuizQuestions(plan_id, unit.unit_index, 15);
    const diff = targetDifficulty(unit.mastery_score);
    const prompt = quizPrompt(unit, history, diff, n);

    let parsed;
    try {
      const response = await infer({
        messages: [
          { role: "system", content: "Output strict JSON arrays." },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 1800,
      });
      parsed = parseQuiz(response.content ?? "", n);
    } catch (err) {
      return JSON.stringify({
        error: "quiz_generation_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const session_id = startSession({
      plan_id,
      unit_index: unit.unit_index,
      kind: "quiz",
    });
    endSession({
      session_id,
      mastery_delta: null,
      summary: JSON.stringify(parsed.questions),
    });
    updateUnitStatus(plan_id, unit.unit_index, "in_progress");

    return JSON.stringify(
      {
        session_id,
        unit_index: unit.unit_index,
        unit_title: unit.title,
        difficulty: diff,
        questions: parsed.questions.map((q, i) => ({
          n: i + 1,
          question: q.question,
          difficulty: q.difficulty,
        })),
        instructions:
          "Reply with your answers numbered 1..N. For per-answer grading, follow up with learning_plan_explain_back (user_explanation=your answer). For a session-wide summary after the quiz, pass the full conversation to learning_plan_summarize.",
      },
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// learning_plan_explain_back
// ---------------------------------------------------------------------------

export const learningPlanExplainBackTool: Tool = {
  name: "learning_plan_explain_back",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "explain back",
    "explícame de vuelta",
    "I'll explain it",
    "let me explain",
  ],
  definition: {
    type: "function",
    function: {
      name: "learning_plan_explain_back",
      description: `Socratic explain-back loop for a learning plan unit.

Two modes:
- Without user_explanation: emits a Socratic prompt asking the learner to explain the unit in their own words. Starts a session.
- With user_explanation: grades the explanation via LLM judge (5 criteria), updates the learner_model concept for the unit, closes the session, returns quality (0-5) + feedback + flagged_misconceptions.`,
      parameters: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          unit_index: {
            type: "number",
            description: "Defaults to plan's current_unit.",
          },
          user_explanation: {
            type: "string",
            description:
              "The learner's explanation. Omit to request one; supply to grade.",
          },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<string> {
    const plan_id = resolvePlanId(args);
    if (!plan_id) return JSON.stringify({ error: "plan_id required — no active plan found" });
    const unit_index =
      typeof args.unit_index === "number" && Number.isFinite(args.unit_index)
        ? Math.max(0, Math.trunc(args.unit_index))
        : undefined;
    const userExplanationRaw =
      typeof args.user_explanation === "string"
        ? args.user_explanation.trim()
        : "";
    if (userExplanationRaw.length > 8_000)
      return JSON.stringify({
        error: "user_explanation_too_long",
        max_chars: 8_000,
        received: userExplanationRaw.length,
      });
    // Neutralize fence-break prompt-injection for gradingPrompt's <<</>>>
    // fence — symmetric with the summarize fix.
    const userExplanation = userExplanationRaw
      .normalize("NFC")
      .replace(/<<</g, "«««")
      .replace(/>>>/g, "»»»");

    const unit = resolveUnit(plan_id, unit_index);
    if (!unit)
      return JSON.stringify({ error: "unit_not_found", plan_id, unit_index });

    if (!userExplanation) {
      const session_id = startSession({
        plan_id,
        unit_index: unit.unit_index,
        kind: "explain_back",
      });
      updateUnitStatus(plan_id, unit.unit_index, "in_progress");
      return JSON.stringify(
        {
          mode: "prompt",
          session_id,
          unit_index: unit.unit_index,
          unit_title: unit.title,
          prompt: explainBackPrompt(unit),
        },
        null,
        2,
      );
    }

    let grade;
    try {
      grade = await gradeExplanation(unit, userExplanation);
    } catch (err) {
      return JSON.stringify({
        error: "grading_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Close the prompt-mode session this grading pairs with, if any. Only
    // open a new session when no prompt-mode session is outstanding — avoids
    // orphaned session rows per audit round 1 finding #1.
    const open = findOpenSession({
      plan_id,
      unit_index: unit.unit_index,
      kind: "explain_back",
    });
    const session_id =
      open?.session_id ??
      startSession({
        plan_id,
        unit_index: unit.unit_index,
        kind: "explain_back",
      });

    const misconceptionPenalty = Math.min(
      0.3,
      0.1 * grade.flagged_misconceptions.length,
    );
    const masteryEstimate = Math.max(
      0,
      Math.min(1, grade.quality / 5 - misconceptionPenalty),
    );

    const concept = normalizeConcept(unit.title);
    const upsert = upsertConcept({
      concept,
      mastery_estimate: masteryEstimate,
      evidence_quote: userExplanation.slice(0, 240),
      session_id,
    });
    endSession({
      session_id,
      mastery_delta: masteryEstimate,
      summary: JSON.stringify({
        quality: grade.quality,
        feedback: grade.feedback,
        flagged: grade.flagged_misconceptions.length,
      }),
    });
    updateUnitStatus(plan_id, unit.unit_index, "in_progress", masteryEstimate);

    return JSON.stringify(
      {
        mode: "grade",
        session_id,
        unit_index: unit.unit_index,
        unit_title: unit.title,
        quality: grade.quality,
        mastery_delta: masteryEstimate,
        feedback: grade.feedback,
        flagged_misconceptions: grade.flagged_misconceptions,
        concept_mastery: upsert.mastery_score,
        next_review_epoch: upsert.review_due_date,
      },
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// learning_plan_summarize
// ---------------------------------------------------------------------------

export const learningPlanSummarizeTool: Tool = {
  name: "learning_plan_summarize",
  deferred: true,
  riskTier: "low",
  triggerPhrases: ["summarize session", "resume la sesión"],
  definition: {
    type: "function",
    function: {
      name: "learning_plan_summarize",
      description: `Retrospective mastery summary for a learning session. Takes a transcript (the session's conversation) + the unit it covered, asks an LLM judge to extract every concept the learner engaged with, cite evidence quotes from the learner, and estimate mastery 0..1 per concept. Upserts each concept into learner_model via SM-2, updates the unit's mastery_score to the mean of its concepts, closes the session. Returns concept-count + next review dates.`,
      parameters: {
        type: "object",
        properties: {
          plan_id: { type: "string" },
          unit_index: {
            type: "number",
            description: "Defaults to plan's current_unit.",
          },
          transcript: {
            type: "string",
            description:
              "The full session transcript (learner + tutor turns). Required.",
          },
        },
        required: ["plan_id", "transcript"],
      },
    },
  },
  async execute(args): Promise<string> {
    const plan_id = resolvePlanId(args);
    if (!plan_id) return JSON.stringify({ error: "plan_id required — no active plan found" });
    const transcriptRaw =
      typeof args.transcript === "string" ? args.transcript.trim() : "";
    if (!transcriptRaw) return JSON.stringify({ error: "transcript required" });
    if (transcriptRaw.length > 50_000)
      return JSON.stringify({
        error: "transcript_too_long",
        max_chars: 50_000,
        received: transcriptRaw.length,
      });
    // Neutralize fence-break prompt-injection: strip the delimiters we use
    // in summaryPrompt so an adversary-controlled transcript can't escape
    // the fenced block and inject instructions.
    const transcript = transcriptRaw
      .normalize("NFC")
      .replace(/<<</g, "«««")
      .replace(/>>>/g, "»»»");
    const unit_index =
      typeof args.unit_index === "number" && Number.isFinite(args.unit_index)
        ? Math.max(0, Math.trunc(args.unit_index))
        : undefined;

    const unit = resolveUnit(plan_id, unit_index);
    if (!unit)
      return JSON.stringify({ error: "unit_not_found", plan_id, unit_index });

    let parsed;
    try {
      const response = await infer({
        messages: [
          {
            role: "system",
            content:
              "You are a mastery assessor. Output strict JSON. Do not speculate about concepts the learner did not engage with.",
          },
          { role: "user", content: summaryPrompt(unit, transcript) },
        ],
        temperature: 0.1,
        max_tokens: 1500,
      });
      parsed = parseSummary(response.content ?? "");
    } catch (err) {
      return JSON.stringify({
        error: "summary_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (parsed.concepts.length === 0) {
      return JSON.stringify({
        warning: "no_concepts_extracted",
        plan_id,
        unit_index: unit.unit_index,
      });
    }

    const session_id = startSession({
      plan_id,
      unit_index: unit.unit_index,
      kind: "review",
    });
    const updates: Array<{
      concept: string;
      mastery_score: number;
      review_due_date: number;
      is_new: boolean;
    }> = [];
    for (const c of parsed.concepts) {
      const u = upsertConcept({
        concept: c.concept,
        mastery_estimate: c.mastery_estimate,
        evidence_quote: c.evidence_quote,
        session_id,
      });
      updates.push(u);
    }
    const meanMastery =
      parsed.concepts.reduce((sum, c) => sum + c.mastery_estimate, 0) /
      parsed.concepts.length;
    updateUnitStatus(
      plan_id,
      unit.unit_index,
      meanMastery >= 0.7 ? "mastered" : "in_progress",
      meanMastery,
    );
    endSession({
      session_id,
      mastery_delta: meanMastery,
      summary: JSON.stringify(parsed.concepts),
    });

    return JSON.stringify(
      {
        session_id,
        unit_index: unit.unit_index,
        unit_title: unit.title,
        concepts_updated: updates.length,
        new_concepts: updates.filter((u) => u.is_new).length,
        unit_mastery: meanMastery,
        concepts: updates.map((u) => ({
          concept: u.concept,
          mastery: u.mastery_score,
          next_review_epoch: u.review_due_date,
        })),
      },
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// learning_plan_status  (read-only — "where am I in my plan?")
// ---------------------------------------------------------------------------

export const learningPlanStatusTool: Tool = {
  name: "learning_plan_status",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "dónde me quedé",
    "where was I",
    "continúa mis lecciones",
    "continue my lessons",
    "resume lessons",
    "retoma mis lecciones",
  ],
  definition: {
    type: "function",
    function: {
      name: "learning_plan_status",
      description: `Read-only snapshot of a learning plan: topic, current unit, unit statuses, and mastery scores.

USE WHEN:
- User says "continúa mis lecciones", "where was I", "dónde me quedé", "resume my lessons".
- You need to know which unit to resume without asking the user.
- You lost plan_id context between sessions.

DO NOT USE for actual teaching (use learning_plan_quiz / learning_plan_explain_back).

plan_id is OPTIONAL — omit it to get the most recently active plan automatically.`,
      parameters: {
        type: "object",
        properties: {
          plan_id: {
            type: "string",
            description:
              "Plan UUID. Optional — if omitted, uses the most recently active plan.",
          },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<string> {
    const plan_id = resolvePlanId(args);
    if (!plan_id)
      return JSON.stringify({
        error: "no_active_plan",
        message: "No active learning plan found. Use learning_plan_create to start one.",
      });

    const plan = getPlan(plan_id);
    if (!plan)
      return JSON.stringify({ error: "plan_not_found", plan_id });

    const units = listUnits(plan_id);
    const currentUnit = units.find((u) => u.unit_index === plan.current_unit);

    return JSON.stringify(
      {
        plan_id,
        topic: plan.topic,
        status: plan.status,
        current_unit: plan.current_unit,
        current_unit_title: currentUnit?.title ?? null,
        current_unit_status: currentUnit?.status ?? null,
        current_unit_mastery: currentUnit
          ? Number(currentUnit.mastery_score.toFixed(2))
          : null,
        resume_instruction: currentUnit
          ? `Resume with learning_plan_quiz or learning_plan_explain_back on unit ${plan.current_unit} ("${currentUnit.title}"). plan_id: ${plan_id}`
          : "All units complete.",
        units: units.map((u) => ({
          index: u.unit_index,
          title: u.title,
          status: u.status,
          mastery: Number(u.mastery_score.toFixed(2)),
        })),
      },
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// learner_model_status  (read-only)
// ---------------------------------------------------------------------------

export const learnerModelStatusTool: Tool = {
  name: "learner_model_status",
  deferred: true,
  riskTier: "low",
  triggerPhrases: [
    "what's due",
    "review today",
    "lo que tengo pendiente",
    "mastery status",
  ],
  definition: {
    type: "function",
    function: {
      name: "learner_model_status",
      description: `Read-only report on the learner model. Groups concepts by category:
- "due": review_due_date <= now
- "mastered": mastery_score >= 0.8
- "shaky": 0 < mastery_score < 0.5
- "all": everything, ordered by last_seen DESC

Use for morning-ritual "what's due today" surfacing and operator status checks.`,
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["due", "mastered", "shaky", "all"],
            description: "Which slice (default: due)",
          },
          limit: {
            type: "number",
            description: "Max rows (1-50, default 20)",
          },
        },
      },
    },
  },
  async execute(args): Promise<string> {
    const filter =
      args.filter === "mastered" ||
      args.filter === "shaky" ||
      args.filter === "all"
        ? args.filter
        : "due";
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(50, Math.trunc(args.limit)))
        : 20;

    const rows = listConcepts({ filter, limit });
    if (rows.length === 0) {
      return JSON.stringify(
        {
          filter,
          count: 0,
          message:
            filter === "due"
              ? "Nothing due for review right now."
              : `No concepts match filter '${filter}'.`,
        },
        null,
        2,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const fmt = rows.map((r) => ({
      concept: r.concept,
      mastery: Number(r.mastery_score.toFixed(2)),
      last_seen_epoch: r.last_seen,
      next_review_epoch: r.review_due_date,
      days_until_review:
        r.review_due_date !== null
          ? Math.round((r.review_due_date - now) / 86400)
          : null,
      repetitions: r.repetitions,
    }));

    return JSON.stringify(
      {
        filter,
        count: rows.length,
        as_of_epoch: now,
        concepts: fmt,
      },
      null,
      2,
    );
  },
};

// ---------------------------------------------------------------------------
// Grouped export for registration convenience
// ---------------------------------------------------------------------------

export const TEACHING_TOOL_OBJECTS: readonly Tool[] = [
  learningPlanCreateTool,
  learningPlanAdvanceTool,
  learningPlanQuizTool,
  learningPlanExplainBackTool,
  learningPlanSummarizeTool,
  learningPlanStatusTool,
  learnerModelStatusTool,
] as const;

// Internal helpers re-exported for test use
export { getPlan, listUnits, getSession, getConcept, getActivePlan };
