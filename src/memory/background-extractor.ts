/**
 * Background Memory Extractor (v6.2 M0.5)
 *
 * Fires after noteworthy task completions. Uses cheapest inference to
 * extract 1-3 atomic facts from the conversation exchange, then stores
 * them in pgvector with embeddings for semantic retrieval.
 *
 * Integrates 7 Claude Code memory patterns:
 * 1. Post-task extraction (not inline) — fires after task completes
 * 2. Content-hash dedup — reinforce existing instead of duplicating
 * 3. Progressive disclosure — facts retrievable via pgvector hybrid search
 * 4. Staleness warnings — injected at enrichment read time
 * 5. Fire-and-forget — never blocks the response path
 * 6. Two-phase: extract facts (LLM) → store with embeddings (pgvector)
 * 7. Gate ordering — cheapest checks first
 *
 * autoDream patterns:
 * - Skip ritual/proactive/background-agent tasks
 * - Non-blocking async (IIFE with try/catch)
 */

import { infer } from "../inference/adapter.js";
import { generateEmbedding } from "../inference/embeddings.js";
import {
  isPgvectorEnabled,
  pgFindByHash,
  pgReinforce,
  pgUpsert,
  contentHash,
} from "../db/pgvector.js";

// ---------------------------------------------------------------------------
// Extraction trigger gate
// ---------------------------------------------------------------------------

/**
 * Determine if a task exchange is worth extracting memories from.
 * Gate ordering: cheapest checks first (in-memory → size → type).
 */
export function shouldExtract(opts: {
  toolCalls: string[];
  responseLength: number;
  spawnType?: string;
  isRitual: boolean;
  isProactive: boolean;
}): boolean {
  // Gate 1: pgvector must be enabled
  if (!isPgvectorEnabled()) return false;

  // Gate 2: skip ritual, proactive, and background-agent tasks
  if (opts.isRitual) return false;
  if (opts.isProactive) return false;
  if (opts.spawnType === "user-background") return false;

  // Gate 3: task must be noteworthy (≥3 tools OR >2K response)
  if (opts.toolCalls.length >= 3) return true;
  if (opts.responseLength > 2000) return true;

  return false;
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `Extract 1-3 facts worth remembering from this conversation exchange.

Rules:
- Each fact: one specific, actionable sentence
- Only facts that would help in FUTURE conversations (not this one)
- Focus on: user preferences, project decisions, discovered constraints, new domain knowledge revealed by the user
- NEVER write facts about which tools were used, tool success rates, runner performance, or workflow patterns of the assistant. Those are system telemetry, not user knowledge, and recalling them poisons future prompts with self-referential guidance.
- NEVER describe the assistant's own behavior as if it were a user preference ("user has recurring workflow pattern using tool X" is forbidden).
- Skip procedural details ("I called tool X", "the file was created", "the task completed successfully").
- DO capture operational failures, blocked capabilities, and recurring error patterns (e.g. "Google Slides access fails because Jarvis lacks browser session for Google Workspace"). Instructive failures help avoid repeating mistakes; tool success narratives do not.
- If nothing is worth remembering, respond with "NONE"

Format: one fact per line, no numbering, no bullets.`;

/**
 * Extract atomic facts from a task exchange using cheapest inference.
 * Returns array of fact strings (0-3 items). Never throws.
 */
export async function extractFacts(
  userMessage: string,
  responseText: string,
  toolCalls: string[],
): Promise<string[]> {
  try {
    const toolList = [...new Set(toolCalls)].slice(0, 10).join(", ");
    const context =
      `User: ${userMessage.slice(0, 500)}\n` +
      `Tools (${toolCalls.length}): ${toolList}\n` +
      `Response: ${responseText.slice(0, 2000)}`;

    const result = await infer(
      {
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: context },
        ],
        temperature: 0.3,
        max_tokens: 300,
      },
      { providerName: "fallback" }, // cheapest provider
    );

    const text = result.content?.trim() ?? "";
    if (!text || text === "NONE" || text.length < 10) return [];

    // Parse: one fact per line, filter empty/short lines
    return text
      .split("\n")
      .map((line) => line.replace(/^[-•*]\s*/, "").trim())
      .filter((line) => line.length > 15)
      .slice(0, 3);
  } catch (err) {
    console.warn(
      "[extractor] LLM extraction failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Storage with dedup
// ---------------------------------------------------------------------------

/**
 * Store extracted facts in pgvector with content-hash dedup.
 * If a fact already exists (same hash), reinforce instead of duplicating.
 * New facts get embeddings generated via Gemini.
 * Fire-and-forget — never throws.
 */
export async function storeFacts(
  facts: string[],
  taskId: string,
): Promise<{ stored: number; reinforced: number }> {
  let stored = 0;
  let reinforced = 0;

  for (const fact of facts) {
    try {
      const hash = contentHash(fact);
      const existing = await pgFindByHash(hash);

      if (existing) {
        // Fact already known — reinforce confidence
        await pgReinforce(existing.path);
        reinforced++;
        console.log(
          `[extractor] Reinforced existing fact: ${existing.path} (confidence boosted)`,
        );
      } else {
        // New fact — generate embedding and store
        const embedding = await generateEmbedding(fact);
        const date = new Date().toISOString().slice(0, 10);
        const shortHash = hash.slice(0, 16);
        const path = `extracted/${date}-${shortHash}.md`;

        await pgUpsert({
          path,
          title: fact.slice(0, 80),
          content: fact,
          content_hash: hash,
          embedding: embedding ?? undefined,
          type: "fact",
          qualifier: "workspace",
          salience: 0.5,
          source_task_id: taskId,
        });
        stored++;
        console.log(`[extractor] Stored new fact: ${path}`);
      }
    } catch (err) {
      console.warn(
        `[extractor] Failed to store fact:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { stored, reinforced };
}

// ---------------------------------------------------------------------------
// Main entry point (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Run background extraction for a completed task.
 * Call this from handleTaskCompleted — it's async and non-blocking.
 * The entire flow is wrapped in try/catch to never propagate errors.
 */
export async function runBackgroundExtraction(
  userMessage: string,
  responseText: string,
  toolCalls: string[],
  taskId: string,
): Promise<void> {
  try {
    const facts = await extractFacts(userMessage, responseText, toolCalls);
    if (facts.length === 0) return;

    const result = await storeFacts(facts, taskId);
    if (result.stored + result.reinforced > 0) {
      console.log(
        `[extractor] Task ${taskId.slice(0, 8)}: ${result.stored} new, ${result.reinforced} reinforced`,
      );
    }
  } catch (err) {
    console.warn(
      "[extractor] Background extraction failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // v6.5 M3: Auto entity detection → temporal knowledge graph
  try {
    const { extractEntities } = await import("./entity-extractor.js");
    const { addTriple } = await import("./knowledge-graph.js");
    const combinedText = `${userMessage}\n${responseText}`;
    const triples = extractEntities(combinedText);
    if (triples.length > 0) {
      for (const t of triples) {
        addTriple(t.subject, t.predicate, t.object, {
          source: "extraction",
          confidence: 0.7,
          taskId,
        });
      }
      console.log(
        `[extractor] Task ${taskId.slice(0, 8)}: ${triples.length} KG triples extracted`,
      );
    }
  } catch {
    // Entity extraction is best-effort — don't block
  }
}

// ---------------------------------------------------------------------------
// Crystal → Lesson Pipeline (v6.2 M3)
// ---------------------------------------------------------------------------

const CRYSTALLIZATION_PROMPT = `Extract 1-3 LESSONS from this task execution. A lesson is different from a fact — it's about what WORKED, what FAILED, and what to DO DIFFERENTLY next time.

Rules:
- Each lesson: one actionable sentence phrased as advice to the assistant
- Focus on: approach that succeeded or failed (not which tools), constraints the user revealed, surprising edge cases, mistakes to avoid
- NEVER describe which tools were called or how often. Tool-usage descriptions read as user directives when recalled later and distort future tool selection. Lessons must be about the APPROACH, not the tool inventory.
- NEVER phrase lessons as "the user uses tools X, Y, Z" or "the task used tools X, Y, Z" — that is telemetry, not a lesson.
- Skip obvious lessons ("the task completed successfully", "all tools worked")
- If nothing is worth learning from this execution, respond with "NONE"

Format: one lesson per line, no numbering, no bullets.`;

/**
 * Determine if a task is worth crystallizing into lessons.
 * Higher bar than fact extraction: ≥5 tool calls AND >30s duration.
 */
export function shouldCrystallize(opts: {
  toolCalls: string[];
  durationMs: number;
  spawnType?: string;
  isRitual: boolean;
  isProactive: boolean;
}): boolean {
  if (!isPgvectorEnabled()) return false;
  if (opts.isRitual || opts.isProactive) return false;
  if (opts.spawnType === "user-background") return false;

  return opts.toolCalls.length >= 5 && opts.durationMs > 30_000;
}

/**
 * Extract lessons from a task execution via LLM crystallization.
 * Returns 0-3 lesson strings. Never throws.
 */
export async function extractLessons(
  userMessage: string,
  responseText: string,
  toolCalls: string[],
  durationMs: number,
): Promise<string[]> {
  try {
    const toolList = [...new Set(toolCalls)].slice(0, 15).join(", ");
    const context =
      `User: ${userMessage.slice(0, 500)}\n` +
      `Tools (${toolCalls.length}): ${toolList}\n` +
      `Duration: ${Math.round(durationMs / 1000)}s\n` +
      `Response: ${responseText.slice(0, 2000)}`;

    const result = await infer(
      {
        messages: [
          { role: "system", content: CRYSTALLIZATION_PROMPT },
          { role: "user", content: context },
        ],
        temperature: 0.3,
        max_tokens: 300,
      },
      { providerName: "fallback" },
    );

    const text = result.content?.trim() ?? "";
    if (!text || text === "NONE" || text.length < 10) return [];

    return text
      .split("\n")
      .map((line) => line.replace(/^[-•*]\s*/, "").trim())
      .filter((line) => line.length > 15)
      .slice(0, 3);
  } catch (err) {
    console.warn(
      "[crystal] LLM crystallization failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Store extracted lessons in pgvector with type="pattern" and higher salience.
 * Reuses storeFacts infrastructure but with different type/salience.
 */
async function storeLessons(
  lessons: string[],
  taskId: string,
): Promise<{ stored: number; reinforced: number }> {
  let stored = 0;
  let reinforced = 0;

  for (const lesson of lessons) {
    try {
      const hash = contentHash(lesson);
      const existing = await pgFindByHash(hash);

      if (existing) {
        await pgReinforce(existing.path);
        reinforced++;
      } else {
        const embedding = await generateEmbedding(lesson);
        const date = new Date().toISOString().slice(0, 10);
        const shortHash = hash.slice(0, 16);
        const path = `lessons/${date}-${shortHash}.md`;

        await pgUpsert({
          path,
          title: lesson.slice(0, 80),
          content: lesson,
          content_hash: hash,
          embedding: embedding ?? undefined,
          type: "pattern", // lessons are patterns, not facts
          qualifier: "workspace",
          salience: 0.7, // higher salience than facts (0.5)
          source_task_id: taskId,
        });
        stored++;
        console.log(`[crystal] Stored lesson: ${path}`);
      }
    } catch (err) {
      console.warn(
        `[crystal] Failed to store lesson:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { stored, reinforced };
}

/**
 * Run crystallization for a completed task (fire-and-forget).
 */
export async function runCrystallization(
  userMessage: string,
  responseText: string,
  toolCalls: string[],
  durationMs: number,
  taskId: string,
): Promise<void> {
  try {
    const lessons = await extractLessons(
      userMessage,
      responseText,
      toolCalls,
      durationMs,
    );
    if (lessons.length === 0) return;

    const result = await storeLessons(lessons, taskId);
    if (result.stored + result.reinforced > 0) {
      console.log(
        `[crystal] Task ${taskId.slice(0, 8)}: ${result.stored} new lessons, ${result.reinforced} reinforced`,
      );
    }
  } catch (err) {
    console.warn(
      "[crystal] Crystallization failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
