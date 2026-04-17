/**
 * Mechanical auto-persist — stores noteworthy conversation summaries
 * based on heuristics, without relying on the LLM to decide what to remember.
 *
 * Rules:
 * 1. Response >2K chars AND >3 tools called → persist
 * 2. Any Playwright tool used → always persist (browser sessions are expensive)
 * 3. Explanatory question AND response >1K chars → persist
 */

import { getMemoryService } from "./index.js";
import { upsertFile } from "../db/jarvis-fs.js";
import { safeSlice } from "../lib/unicode-safe.js";

export interface AutoPersistInput {
  userText: string;
  responseText: string;
  toolCalls: string[];
  channel: string;
  taskId: string;
}

/** Question patterns: starts with interrogative or ends with ? */
const QUESTION_RE =
  /^(qu[eé]|what|how|why|where|when|who|which|c[oó]mo|d[oó]nde|cu[aá]ndo|cu[aá]l|por\s*qu[eé]|para\s*qu[eé]|explain|explica)/i;

function isQuestion(text: string): boolean {
  return QUESTION_RE.test(text.trim()) || text.trim().endsWith("?");
}

/** Stop words filtered from topic slugs (ES + EN). */
const STOP_WORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "de",
  "del",
  "en",
  "con",
  "por",
  "para",
  "que",
  "qué",
  "como",
  "cómo",
  "es",
  "son",
  "está",
  "este",
  "esta",
  "the",
  "a",
  "an",
  "of",
  "in",
  "to",
  "for",
  "and",
  "is",
  "are",
  "was",
  "me",
  "mi",
  "te",
  "se",
  "lo",
  "le",
  "nos",
  "les",
  "yo",
  "tu",
  "su",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "this",
  "that",
  "do",
  "does",
  "did",
  "will",
  "can",
  "could",
  "should",
  "would",
  "hay",
  "no",
  "si",
  "sí",
  "ya",
  "más",
  "muy",
  "pero",
  "o",
  "y",
]);

/**
 * Derive a filesystem-safe topic slug from user text (v6.2 S4).
 * Extracts first 3 significant words, lowercased, hyphenated.
 * Falls back to "misc" if no meaningful words found.
 */
export function deriveTopicSlug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s]/gi, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 3);

  return words.length > 0 ? words.join("-") : "misc";
}

function hasPlaywrightTool(toolCalls: string[]): boolean {
  return toolCalls.some(
    (t) => t.startsWith("playwright__") || t.startsWith("browser_"),
  );
}

/**
 * Determine if a conversation exchange is worth persisting.
 * Pure function — no side effects, fully testable.
 */
export function shouldAutoPersist(input: AutoPersistInput): boolean {
  const { responseText, toolCalls, userText } = input;

  // Rule 1: substantial response + substantial tool usage
  if (responseText.length > 2000 && toolCalls.length > 3) return true;

  // Rule 2: browser sessions are expensive — always persist
  if (hasPlaywrightTool(toolCalls)) return true;

  // Rule 2b: document reads — persist so follow-up turns recall the content
  if (
    toolCalls.some(
      (t) =>
        t === "gsheets_read" ||
        t === "gdocs_read" ||
        t === "gdocs_read_full" ||
        t === "file_read",
    )
  )
    return true;

  // Rule 3: explanatory question with meaningful response
  if (isQuestion(userText) && responseText.length > 1000) return true;

  return false;
}

/**
 * Persist a noteworthy conversation exchange to memory.
 * Stores a compact summary with auto-persist tags.
 * Intentionally fire-and-forget — never blocks the response path.
 */
export async function autoPersistConversation(
  input: AutoPersistInput,
): Promise<void> {
  if (!shouldAutoPersist(input)) return;

  const { userText, responseText, toolCalls, channel, taskId } = input;

  // Build a compact summary (no LLM call — keep it mechanical and fast)
  const toolList = [...new Set(toolCalls)].slice(0, 10).join(", ");
  const responsePreview =
    responseText.length > 2000
      ? safeSlice(responseText, 2000) + "..."
      : responseText;

  const summary =
    `[AUTO-PERSIST task=${taskId}]\n` +
    `User: ${safeSlice(userText, 200)}\n` +
    `Tools (${toolCalls.length}): ${toolList}\n` +
    `Response: ${responsePreview}`;

  await getMemoryService().retain(summary, {
    bank: "mc-jarvis",
    tags: [channel, "auto-persist", "noteworthy"],
    async: true,
    trustTier: 2,
    source: "auto-persist",
  });

  // Also persist to jarvis_files with meaningful topic-based paths (v6.2 S4)
  try {
    const date = new Date().toISOString().slice(0, 10);
    const topicSlug = deriveTopicSlug(userText);
    const path = `workspace/${topicSlug}-${date}.md`;
    upsertFile(
      path,
      userText.slice(0, 60),
      summary,
      ["auto-persist", channel],
      "workspace",
      80,
    );
  } catch {
    // Non-fatal — Hindsight is primary, this is secondary
  }
}
