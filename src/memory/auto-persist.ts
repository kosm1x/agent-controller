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
import { getDatabase } from "../db/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const JARVIS_MIRROR = join(process.cwd(), "data", "jarvis");

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
    responseText.length > 500
      ? responseText.slice(0, 500) + "..."
      : responseText;

  const summary =
    `[AUTO-PERSIST task=${taskId}]\n` +
    `User: ${userText.slice(0, 200)}\n` +
    `Tools (${toolCalls.length}): ${toolList}\n` +
    `Response: ${responsePreview}`;

  await getMemoryService().retain(summary, {
    bank: "mc-jarvis",
    tags: [channel, "auto-persist", "noteworthy"],
    async: true,
    trustTier: 2,
    source: "auto-persist",
  });

  // Also persist to jarvis_files for structured retrieval
  try {
    const db = getDatabase();
    const date = new Date().toISOString().slice(0, 10);
    const shortId = taskId.slice(0, 8);
    const path = `auto-persist/${date}-${shortId}.md`;
    const title = `${userText.slice(0, 60)}`;

    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, 'workspace', 80, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
    ).run(
      path,
      path,
      title,
      summary,
      JSON.stringify(["auto-persist", channel]),
    );

    // Mirror to disk
    const fullPath = join(JARVIS_MIRROR, path);
    if (fullPath.startsWith(JARVIS_MIRROR)) {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, summary, "utf-8");
    }
  } catch {
    // Non-fatal — Hindsight is primary, this is secondary
  }
}
