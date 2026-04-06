/**
 * Context Compressor — Summarize long tool conversations to stay within
 * the model's context window.
 *
 * Hermes-inspired: protect first 3 + last 4 messages, summarize the middle,
 * sanitize orphaned tool call/result pairs, fallback to drop-without-summary.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { upsertFile } from "../db/jarvis-fs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix marker for compression summaries — enables PRESERVE+ADD on subsequent compressions. */
export const SUMMARY_PREFIX = "[CONTEXT SUMMARY]";

/**
 * Structured 9-section compact prompt — guides the LLM to produce organized
 * summaries that preserve intent, key facts, and pending work across compression
 * cycles. Inspired by OpenClaude's compact format with analysis scratchpad.
 *
 * The structured sections prevent information loss that occurs with freeform
 * "summarize this" prompts, especially for multi-step tool conversations.
 */
const STRUCTURED_COMPACT_PROMPT = `Compress the following conversation into a structured summary. Use ONLY these sections (skip empty ones). Be concise but preserve ALL key facts.

<analysis>
Draft your reasoning here — identify what matters and what can be dropped. This block will be stripped from the output.
</analysis>

Write the final summary using these sections:

## Intent
What the user originally asked for and why. One sentence.

## Key Facts
Technical concepts, decisions made, constraints discovered. Bullet list.

## Files & Code
File paths read/written/modified, with key code snippets if they affect pending work. Only include if relevant to unfinished tasks.

## Errors & Fixes
Errors encountered and how they were resolved (or not). Skip if none.

## User Messages
Preserve the user's exact words for any instructions, corrections, or preferences — these define intent and must not be paraphrased.

## Actions Completed
What was done successfully. Bullet list with specifics (tool names, IDs, results).

## Pending Work
What remains to be done. Be specific — include file paths and next steps.

## Current State
The most recent action or result. What was the conversation doing when it was compressed?

RULES:
- Do NOT call any tools. Produce ONLY text.
- Strip the <analysis> block from your final output.
- Keep total output under 600 words.
- Preserve file paths, error messages, and IDs verbatim.
- If the user gave corrections or preferences, quote them exactly.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: chars / 4.
 * Extracted for reuse in context pressure calculations.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      totalChars += JSON.stringify(msg.content).length;
    }
    if (msg.tool_calls) {
      totalChars += JSON.stringify(msg.tool_calls).length;
    }
  }
  return totalChars / 4;
}

/**
 * Returns true if messages exceed `threshold` fraction of `contextLimit`.
 */
export function shouldCompress(
  messages: ChatMessage[],
  contextLimit: number,
  threshold = 0.85,
): boolean {
  return estimateTokens(messages) > contextLimit * threshold;
}

/**
 * Compress a conversation by summarizing the middle portion.
 * Protects the first `keepHead` and last `keepTail` messages.
 * Falls back to dropping without summary if summarization fails.
 *
 * PRESERVE+ADD: If the middle contains an existing compression summary
 * (marked with SUMMARY_PREFIX), updates it incrementally instead of
 * regenerating from scratch. Prevents information decay across cycles.
 *
 * @param contextInjection Optional context appended to the summary (e.g. active goal).
 *                         Keeps the compressor generic — callers define what to preserve.
 */
export async function compress(
  messages: ChatMessage[],
  keepHead = 3,
  keepTail = 4,
  contextInjection?: string,
): Promise<ChatMessage[]> {
  const total = messages.length;
  if (total <= keepHead + keepTail) return messages;

  const head = messages.slice(0, keepHead);
  const tail = messages.slice(total - keepTail);
  const middle = messages.slice(keepHead, total - keepTail);

  if (middle.length === 0) return messages;

  // PRESERVE+ADD: extract existing summary from middle if present
  let existingSummary: string | null = null;
  const newMiddle: ChatMessage[] = [];
  for (const m of middle) {
    if (
      !existingSummary &&
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.startsWith(SUMMARY_PREFIX)
    ) {
      existingSummary = m.content.slice(SUMMARY_PREFIX.length).trim();
    } else {
      newMiddle.push(m);
    }
  }

  // Build text from non-summary middle messages
  const middleText = newMiddle
    .map((m) => {
      const role = m.role;
      const content =
        typeof m.content === "string"
          ? m.content
          : (JSON.stringify(m.content) ?? "");
      return `[${role}]: ${content?.slice(0, 300) ?? ""}`;
    })
    .join("\n");

  // Try to summarize (or update existing summary) using structured 9-section format.
  // Inspired by OpenClaude's compact format: structured sections preserve intent
  // and key facts better than freeform summaries during multi-cycle compression.
  let summaryContent: string;
  try {
    const prompt = existingSummary
      ? `Update this existing summary with information from the new messages below. Preserve all prior facts, add new results and decisions. Keep the same structured section format.

Existing summary:
${existingSummary}

New messages:
${middleText}`
      : `${STRUCTURED_COMPACT_PROMPT}

Messages to compress:
${middleText}`;

    const summaryResponse = await infer({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 800,
    });

    let raw =
      summaryResponse.content ??
      `[Earlier conversation compressed — ${middle.length} messages removed]`;
    // Strip <analysis> scratchpad block if the LLM included it in output
    raw = raw.replace(/<analysis>[\s\S]*?<\/analysis>\s*/g, "").trim();
    summaryContent = raw;
  } catch {
    // Fallback: drop without summary
    summaryContent = `[Earlier conversation compressed — ${middle.length} messages removed]`;
  }

  // Persist summary to jarvis_files for cross-session retrieval
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    upsertFile(
      `compaction/${ts}.md`,
      `Compaction summary ${ts}`,
      summaryContent,
      ["compaction", "summary"],
      "workspace",
      90,
    );
  } catch {
    // Non-fatal
  }

  // Build final summary with prefix marker + optional context injection
  let fullSummary = `${SUMMARY_PREFIX} ${summaryContent}`;
  if (contextInjection) {
    fullSummary += `\n\n---\n[ACTIVE CONTEXT]\n${contextInjection}`;
  }

  const compressed: ChatMessage[] = [
    ...head,
    { role: "system", content: fullSummary },
    ...sanitizeToolPairs([...tail]),
  ];

  return compressed;
}

/**
 * Remove orphaned tool results (whose assistant tool_call was compressed)
 * and stub orphaned tool_calls (whose results were compressed).
 */
export function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  // Collect all tool_call_ids from assistant messages
  const callIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        callIds.add(tc.id);
      }
    }
  }

  // Collect all tool_call_ids from tool messages
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      resultIds.add(msg.tool_call_id);
    }
  }

  const sanitized: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      // Remove orphaned tool results (no matching assistant tool_call)
      if (!callIds.has(msg.tool_call_id)) continue;
    }
    sanitized.push(msg);
  }

  // For assistant messages with tool_calls where results are missing,
  // insert stub tool responses immediately after their parent assistant message.
  // OpenAI-compatible APIs require tool results to follow their tool_call message.
  const result: ChatMessage[] = [];
  for (const msg of sanitized) {
    result.push(msg);
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!resultIds.has(tc.id)) {
          result.push({
            role: "tool",
            content: "[Result compressed]",
            tool_call_id: tc.id,
          });
        }
      }
    }
  }

  return result;
}
