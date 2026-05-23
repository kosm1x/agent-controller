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
// Shared language directive — appended to both the initial-compress prompt and
// the PRESERVE+ADD update prompt. Jarvis's primary user converses in
// Spanish-MX (`identitySection`: "Habla en español mexicano") but the compress
// path was English-only, producing English `[CONTEXT SUMMARY]` blocks that
// poisoned otherwise-Spanish conversations on every compaction cycle. Hermes
// v0.11 May Tier-2 #7 fix.
//
// Anchored on USER-role turns (the operator has a stable language preference;
// tool/error/code text is the noise that drove the prior ambiguity). Quotes
// under `## User Messages` are exempt from translation — they must stay
// verbatim per that section's own rule, which would otherwise conflict.
// Header names stay English so the structure is stable across summaries;
// nothing in the codebase parses these headers (only `SUMMARY_PREFIX` is
// checked at line 136), but stable structure is friendlier when an operator
// inspects a long thread.
const LANGUAGE_RULE =
  "Write the summary CONTENT in the language used by the USER in the messages being compressed (look at user-role turns only; ignore code blocks, error text, file paths, tool outputs). Tie-break under heavy code-switching: use the most recent user message's language. Keep the section HEADER names exactly as written (`## Intent`, `## Key Facts`, etc.) — they are structural markers. EXCEPTION: verbatim quotes under `## User Messages` stay in their original language regardless of the summary language.";

// Update-path addendum — the PRESERVE+ADD prompt sees BOTH the prior summary
// (which has its own language) AND new messages (which may have switched).
// Audit W1: prefer continuity, switch only on a clear signal from new turns.
const UPDATE_LANGUAGE_ADDENDUM =
  "When updating an existing summary, prefer the existing summary's language for CONTENT for continuity. Switch only if the new user messages clearly indicate a language change.";

// Tier-A cherry-pick (Hermes April Tier-2 #1 §7) — focus-topic posture for L2.
// Adopts the *interesting bit* of Hermes's `/compress [focus topic]` at the
// auto-compaction layer where we actually use it, without importing their
// plugin-slot scaffolding. Additive to LANGUAGE_RULE / STRUCTURED_COMPACT_PROMPT
// — instructs the LLM to BIAS preservation toward the topic, never to drop
// prior facts. Floor-preserve invariant stays intact in the PRESERVE+ADD path.
//
// Defensive clamp: 200 chars, single line. Long prose blobs would bloat the
// prompt (we already pay the L2 LLM call). Operators set the topic from a
// scope label or short string, not a paragraph.
const FOCUS_TOPIC_MAX_CHARS = 200;
function focusTopicAddendum(focusTopic: string): string {
  // ALSO/bias phrasing — additive, not override. LANGUAGE_RULE's verbatim-quote
  // exception still wins where they appear to conflict.
  return `ALSO prioritize preserving content related to: ${focusTopic}. This biases summarization posture — it does NOT permit dropping facts unrelated to the topic, especially in the PRESERVE+ADD update path where prior summary contents are floor-preserved.`;
}

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
- If the user gave corrections or preferences, quote them exactly.
- ${LANGUAGE_RULE}`;

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
 * @param focusTopic Optional short topic that BIASES summarization posture toward
 *                   content relevant to it (e.g. `"coding artifacts (file paths,
 *                   diffs, errors)"` when active scope is `coding`). Additive to
 *                   LANGUAGE_RULE / structured prompt; never drops prior facts.
 *                   Clamped to {@link FOCUS_TOPIC_MAX_CHARS}. Tier-A cherry-pick
 *                   from Hermes April Tier-2 #1 §7 — `/compress <focus>` posture
 *                   at the auto-compaction layer where we actually use it.
 */
export async function compress(
  messages: ChatMessage[],
  keepHead = 3,
  keepTail = 4,
  contextInjection?: string,
  focusTopic?: string,
): Promise<ChatMessage[]> {
  const total = messages.length;
  if (total <= keepHead + keepTail) return messages;

  const head = messages.slice(0, keepHead);
  const tail = messages.slice(total - keepTail);
  const middle = messages.slice(keepHead, total - keepTail);

  if (middle.length === 0) return messages;

  // PRESERVE+ADD: extract existing summary from middle if present.
  // Hermes v0.11 anti-thrashing #1 — defensive multi-summary collapse:
  // previously only the FIRST SUMMARY_PREFIX match was captured and any
  // later one was treated as raw text → summary-of-summary fidelity loss.
  // Now we take the LATEST as the best heuristic — under the normal
  // PRESERVE+ADD pipeline each successive summary already absorbed prior
  // facts via the update prompt, so the most recent is canonical. The
  // edge case where two summaries are siblings (no parent-child relation,
  // e.g. snapshot replay or interrupted/retried compaction) will lose the
  // older one's facts; the warn below is the escape hatch for that case.
  let existingSummary: string | null = null;
  let summaryBlockCount = 0;
  const newMiddle: ChatMessage[] = [];
  for (const m of middle) {
    if (
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.startsWith(SUMMARY_PREFIX)
    ) {
      summaryBlockCount++;
      existingSummary = m.content.slice(SUMMARY_PREFIX.length).trim();
    } else {
      newMiddle.push(m);
    }
  }
  if (summaryBlockCount > 1) {
    console.warn(
      `[compressor] ${summaryBlockCount} SUMMARY_PREFIX blocks in middle slice; using the latest (defensive collapse). Unexpected — investigate upstream.`,
    );
  }

  // Hermes v0.11 anti-thrashing #2 — short-circuit a no-op LLM round.
  // If middle had ONLY the prior summary (no new turns to fold in), the
  // update prompt would land with an empty `New messages:` slot — Sonnet
  // would either echo back the summary verbatim (best case, still costs
  // ~$0.01 + 2-5s) or hallucinate updates (worst case). Skip it: return
  // the preserved summary in the same shape the regular path produces.
  //
  // We intentionally do NOT re-call `upsertFile` here (audit W1/W2). The
  // summary was already persisted on the cycle that created it; writing a
  // fresh `compaction/${ts}.md` per no-op tick would turn a stall-compress
  // loop into a `jarvis_files` write storm — which is the very class of
  // thrash this guard exists to stop. Trade-off: an analytics scan that
  // filters compaction files by freshness will miss long-idle threads.
  // Accept that: thread-idleness is a separate signal, not this guard's
  // job to emit.
  if (existingSummary !== null && newMiddle.length === 0) {
    let preservedContent = `${SUMMARY_PREFIX} ${existingSummary}`;
    if (contextInjection) {
      preservedContent += `\n\n---\n[ACTIVE CONTEXT]\n${contextInjection}`;
    }
    return [
      ...head,
      { role: "system", content: preservedContent },
      ...sanitizeToolPairs([...tail]),
    ];
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

  // Clamp the focus topic defensively — prevents an oversized blob from
  // bloating the L2 prompt budget (we already pay the LLM call). Single-line
  // assertion: collapse internal newlines before slicing so the addendum
  // remains a single bullet in the prompt body.
  const cleanFocusTopic =
    typeof focusTopic === "string" && focusTopic.trim().length > 0
      ? focusTopic.replace(/\s+/g, " ").trim().slice(0, FOCUS_TOPIC_MAX_CHARS)
      : null;
  if (
    cleanFocusTopic &&
    focusTopic &&
    focusTopic.length > FOCUS_TOPIC_MAX_CHARS
  ) {
    console.warn(
      `[compressor] focusTopic clamped from ${focusTopic.length} → ${FOCUS_TOPIC_MAX_CHARS} chars. Pass a shorter topic.`,
    );
  }

  // Try to summarize (or update existing summary) using structured 9-section format.
  // Inspired by OpenClaude's compact format: structured sections preserve intent
  // and key facts better than freeform summaries during multi-cycle compression.
  let summaryContent: string;
  try {
    // FOCUS posture lands BEFORE both the structural prompt and LANGUAGE_RULE
    // — sets the bias up front, leaves LANGUAGE_RULE as the final instruction
    // on both paths (most-recent-wins heuristic). The addendum's own phrasing
    // ("does NOT permit dropping facts") protects the floor regardless of
    // ordering, but consistent ordering across paths keeps prompt-shape drift
    // detectable in tests.
    const focusPreamble = cleanFocusTopic
      ? `${focusTopicAddendum(cleanFocusTopic)}\n\n`
      : "";

    const prompt = existingSummary
      ? `${focusPreamble}Update this existing summary with information from the new messages below. Preserve all prior facts, add new results and decisions. Keep the same structured section format.

${LANGUAGE_RULE}
${UPDATE_LANGUAGE_ADDENDUM}

Existing summary:
${existingSummary}

New messages:
${middleText}`
      : `${focusPreamble}${STRUCTURED_COMPACT_PROMPT}

Messages to compress:
${middleText}`;

    // NO_TOOLS_PREAMBLE sandwich: suppress tool calls during compression.
    // On Sonnet 4.6+, adaptive-thinking models sometimes attempt tool calls
    // despite instructions. Placing the prohibition FIRST and LAST prevents this.
    // Pattern from OpenClaude: measured 2.79% failure rate without it.
    const NO_TOOLS =
      "CRITICAL: Do NOT call any tools. Produce ONLY text output. Any tool call will be rejected.";
    const summaryResponse = await infer({
      messages: [
        { role: "system", content: NO_TOOLS },
        { role: "user", content: prompt },
        { role: "user", content: NO_TOOLS },
      ],
      temperature: 0.2,
      max_tokens: 1200, // 9 sections + analysis scratchpad overhead needs headroom
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

  // Persist summary to jarvis_files for cross-session retrieval. Prepend a
  // one-line `[FOCUS: …]` marker so an operator scanning a long compaction
  // history can attribute summary posture to the topic that drove it.
  // Marker is on the persisted body only — it does NOT enter the in-memory
  // [CONTEXT SUMMARY] block (which feeds back into the LLM on next L2 cycle
  // and would re-anchor the next compress unhelpfully).
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const persisted = cleanFocusTopic
      ? `[FOCUS: ${cleanFocusTopic}]\n\n${summaryContent}`
      : summaryContent;
    upsertFile(
      `compaction/${ts}.md`,
      `Compaction summary ${ts}`,
      persisted,
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
