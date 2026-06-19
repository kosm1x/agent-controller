/**
 * Execution Pattern Memory — v6.0 S8.
 *
 * After successful tasks, extracts 1-2 lessons and stores them.
 * Before similar tasks, injects relevant patterns as context.
 *
 * Storage: knowledge/execution-patterns/ in Jarvis KB (jarvis_files).
 * Matching: scope group + keyword overlap.
 */

import { upsertFile, listFiles, getFile } from "../db/jarvis-fs.js";
import { infer } from "../inference/adapter.js";

const PATTERNS_PREFIX = "knowledge/execution-patterns/";
const MAX_PATTERNS = 50; // cap to prevent bloat
const PATTERN_INJECT_LIMIT = 3; // max patterns injected per task
const PATTERN_MAX_CHARS = 500; // max chars per injected pattern

/**
 * Extract execution patterns from a completed task.
 * Called by the router after successful task completion.
 * Uses a cheap LLM call to summarize the lesson.
 */
export async function extractPattern(opts: {
  taskId: string;
  title: string;
  toolsCalled: string[];
  scopeGroups: string[];
  userMessage: string;
  result: string;
}): Promise<void> {
  // Only extract from tasks with meaningful tool usage
  if (opts.toolsCalled.length < 2) return;
  if (opts.result.length < 100) return;

  // Check if we're at the cap
  const existing = listFiles({ prefix: PATTERNS_PREFIX });
  if (existing.length >= MAX_PATTERNS) {
    // Prune oldest
    const sorted = existing.sort(
      (a, b) =>
        new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
    );
    const { deleteFile } = await import("../db/jarvis-fs.js");
    for (let i = 0; i < 5 && i < sorted.length; i++) {
      deleteFile(sorted[i].path);
    }
  }

  try {
    const extraction = await infer({
      messages: [
        {
          role: "system",
          content:
            "Extract 1-2 reusable lessons from this task execution. Format: one line per lesson, starting with the scope (e.g., 'livingjoyfully:', 'coding:', 'northstar:'). Max 100 chars per lesson. If nothing is reusable, respond with just 'NONE'.",
        },
        {
          role: "user",
          content: `Task: ${opts.title}\nTools: ${opts.toolsCalled.join(", ")}\nScope: ${opts.scopeGroups.join(", ")}\nRequest: ${opts.userMessage.slice(0, 300)}\nResult: ${opts.result.slice(0, 500)}`,
        },
      ],
      max_tokens: 100,
      temperature: 0.2,
    });

    const raw = (extraction.content ?? "").trim();
    if (!raw || raw === "NONE" || raw.length < 10) return;

    // Store the pattern
    const slug = opts.taskId.slice(0, 8);
    const date = new Date().toISOString().slice(0, 10);
    const path = `${PATTERNS_PREFIX}${date}-${slug}.md`;

    const content = [
      `# Pattern: ${opts.title.slice(0, 60)}`,
      "",
      `**Scope:** ${opts.scopeGroups.join(", ") || "general"}`,
      `**Tools:** ${opts.toolsCalled.join(", ")}`,
      `**Date:** ${new Date().toISOString()}`,
      "",
      raw,
    ].join("\n");

    upsertFile(
      path,
      `Pattern: ${opts.title.slice(0, 40)}`,
      content,
      ["execution-pattern", ...opts.scopeGroups],
      "reference",
      80, // low priority — patterns are supplementary
    );

    console.log(
      `[execution-patterns] Extracted from task ${opts.taskId}: ${raw.slice(0, 80)}`,
    );
  } catch {
    // Non-fatal — pattern extraction is best-effort
  }
}

/**
 * Find relevant patterns for a task based on scope groups and keywords.
 * Called by the router before task submission to enrich context.
 * Returns formatted text block to inject into the system prompt.
 */
export function findRelevantPatterns(
  userMessage: string,
  scopeGroups: string[],
): string {
  try {
    const allPatterns = listFiles({ prefix: PATTERNS_PREFIX });
    if (allPatterns.length === 0) return "";

    // Score patterns by relevance: scope overlap + keyword match
    const msgWords = new Set(
      userMessage
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );

    // First pass — cheap metadata score (scope-tag overlap + title keywords).
    // Gates which patterns we bother reading from disk.
    const candidates = allPatterns
      .map((p) => {
        let score = 0;
        // Scope overlap
        const tags = Array.isArray(p.tags) ? p.tags : [];
        for (const g of scopeGroups) {
          if (tags.includes(g)) score += 2;
        }
        // Keyword overlap with title
        const titleWords = p.title
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        for (const w of titleWords) {
          if (msgWords.has(w)) score += 1;
        }
        return { ...p, score };
      })
      .filter((p) => p.score > 0);

    if (candidates.length === 0) return "";

    // Second pass — read the lesson body once and add keyword-overlap score so a
    // domain-specific pattern (e.g. a DENUE lesson) outranks generic same-scope
    // patterns when the message is about that domain. Without this, every
    // `coding`-tagged pattern ties at the scope score and the relevant one gets
    // diluted out of the top-N. Body contribution is capped so a long pattern
    // can't dominate on length alone. The content read here is reused to build
    // the injection block (no double read). NOTE: this reads content for EVERY
    // in-scope candidate (up to MAX_PATTERNS reads), not just the top-N — the
    // cost of ranking on body. Runs once per task; revisit if MAX_PATTERNS grows.
    const lines = ["## Patrones de ejecución anteriores"];
    const enriched = candidates
      .map((p) => {
        const file = getFile(p.path);
        // Extract just the lesson lines (after the metadata header)
        const body = file
          ? file.content
              .split("\n")
              .filter(
                (l) =>
                  !l.startsWith("#") &&
                  !l.startsWith("**") &&
                  l.trim().length > 0,
              )
              .join("\n")
          : "";
        let bodyScore = 0;
        for (const w of new Set(
          body
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 3),
        )) {
          if (msgWords.has(w)) bodyScore++;
        }
        return { ...p, body, score: p.score + Math.min(bodyScore, 3) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, PATTERN_INJECT_LIMIT);

    for (const p of enriched) {
      const content = p.body.slice(0, PATTERN_MAX_CHARS);
      if (content) {
        lines.push(`- ${content}`);
      }
    }

    return lines.length > 1 ? lines.join("\n") : "";
  } catch {
    return "";
  }
}
