/**
 * Multi-level compaction pipeline — cascading strategy from cheapest
 * (deterministic) to most expensive (LLM summary).
 *
 * L0: Truncate old tool results (deterministic, no LLM)
 * L1: Remove oldest matched assistant+tool pairs (pair drain)
 * L2: LLM summarization (delegates to existing compress())
 * L3: Emergency head truncation (no LLM, last resort)
 *
 * The pipeline runs L0+L1 first (free). If conversation still exceeds
 * the threshold after L0+L1, it falls back to L2. If L2 fails (e.g.
 * all providers down), L3 provides a deterministic fallback.
 */

import type { ChatMessage } from "../inference/adapter.js";
import {
  shouldCompress,
  compress,
  sanitizeToolPairs,
} from "./context-compressor.js";
import {
  COMPACTION_L0_TRUNCATE_CHARS,
  COMPACTION_L1_MIN_PAIRS,
} from "../config/constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactionLevel = "L0" | "L1" | "L2" | "L3";

export interface CompactionResult {
  messages: ChatMessage[];
  level: CompactionLevel;
  removedCount: number;
}

// ---------------------------------------------------------------------------
// L0: Truncate old tool results
// ---------------------------------------------------------------------------

/**
 * Truncate tool result contents in older messages. Keeps the tail window
 * intact so recent context is preserved. Returns new array (no mutation).
 */
export function compactL0(
  messages: ChatMessage[],
  keepTail: number,
  maxChars = COMPACTION_L0_TRUNCATE_CHARS,
): { messages: ChatMessage[]; truncated: number } {
  const cutoff = messages.length - keepTail;
  let truncated = 0;

  const result = messages.map((msg, i) => {
    if (
      i < cutoff &&
      msg.role === "tool" &&
      typeof msg.content === "string" &&
      msg.content.length > maxChars
    ) {
      truncated++;
      return {
        ...msg,
        content:
          msg.content.slice(0, maxChars) +
          `\n[…truncated ${msg.content.length} chars]`,
      };
    }
    return msg;
  });

  return { messages: result, truncated };
}

// ---------------------------------------------------------------------------
// L1: Pair drain — remove oldest matched (assistant+tool_calls, tool) pairs
// ---------------------------------------------------------------------------

/**
 * Remove the oldest matched pairs of (assistant with tool_calls) + (their tool results).
 * Preserves head and tail windows. Returns new array.
 */
export function compactL1(
  messages: ChatMessage[],
  keepHead: number,
  keepTail: number,
  minPairs = COMPACTION_L1_MIN_PAIRS,
): { messages: ChatMessage[]; removedPairs: number } {
  const head = messages.slice(0, keepHead);
  const tail = messages.slice(messages.length - keepTail);
  const middle = messages.slice(keepHead, messages.length - keepTail);

  if (middle.length === 0) return { messages, removedPairs: 0 };

  // Find assistant messages with tool_calls in the middle (oldest first)
  const pairsToRemove = new Set<number>(); // indices into middle
  const callIdsToRemove = new Set<string>();
  let removedPairs = 0;

  for (let i = 0; i < middle.length && removedPairs < minPairs; i++) {
    const msg = middle[i];
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      pairsToRemove.add(i);
      for (const tc of msg.tool_calls) {
        callIdsToRemove.add(tc.id);
      }
      removedPairs++;
    }
  }

  if (removedPairs === 0) return { messages, removedPairs: 0 };

  // Also remove the matching tool result messages
  for (let i = 0; i < middle.length; i++) {
    const msg = middle[i];
    if (
      msg.role === "tool" &&
      msg.tool_call_id &&
      callIdsToRemove.has(msg.tool_call_id)
    ) {
      pairsToRemove.add(i);
    }
  }

  const remaining = middle.filter((_, i) => !pairsToRemove.has(i));
  const result = [...head, ...sanitizeToolPairs([...remaining, ...tail])];

  return { messages: result, removedPairs };
}

// ---------------------------------------------------------------------------
// L3: Emergency head truncation (no LLM)
// ---------------------------------------------------------------------------

/**
 * Last resort: keep system message + tail, drop everything in between.
 * No LLM call — purely deterministic.
 */
export function compactL3(
  messages: ChatMessage[],
  keepTail: number,
): { messages: ChatMessage[]; removedCount: number } {
  // Preserve the system message (always first)
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  const tail = messages.slice(messages.length - keepTail);
  const removedCount = messages.length - (systemMsg ? 1 : 0) - keepTail;

  const marker: ChatMessage = {
    role: "system" as const,
    content: `[CONTEXT SUMMARY] [Emergency truncation — ${removedCount} messages removed. Prior context lost. Work with available information.]`,
  };

  const result: ChatMessage[] = [];
  if (systemMsg) result.push(systemMsg);
  result.push(marker);
  result.push(...sanitizeToolPairs([...tail]));

  return { messages: result, removedCount: Math.max(0, removedCount) };
}

// ---------------------------------------------------------------------------
// Pipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the compaction cascade. Returns the compacted messages and which
 * level was needed.
 *
 * @param contextLimit Model context window size in tokens
 * @param threshold Fraction of context window that triggers compression (0-1)
 * @param contextInjection Optional context to preserve through L2 compression
 */
export async function compactConversation(
  messages: ChatMessage[],
  contextLimit: number,
  threshold: number,
  contextInjection?: string,
): Promise<CompactionResult> {
  const keepHead = 3;
  const keepTail = 4;

  // L0: truncate old tool results (always run — free)
  const l0 = compactL0(messages, keepTail);
  if (!shouldCompress(l0.messages, contextLimit, threshold)) {
    return {
      messages: l0.messages,
      level: "L0",
      removedCount: l0.truncated,
    };
  }

  // L1: pair drain (always run — free)
  const l1 = compactL1(l0.messages, keepHead, keepTail);
  if (!shouldCompress(l1.messages, contextLimit, threshold)) {
    return {
      messages: l1.messages,
      level: "L1",
      removedCount: l0.truncated + l1.removedPairs,
    };
  }

  // L2: LLM summarization (expensive — only if L0+L1 insufficient)
  try {
    const l2messages = await compress(
      l1.messages,
      keepHead,
      keepTail,
      contextInjection,
    );
    return {
      messages: l2messages,
      level: "L2",
      removedCount: messages.length - l2messages.length,
    };
  } catch {
    // L2 failed (all providers down) — fall through to L3
  }

  // L3: emergency deterministic truncation
  const l3 = compactL3(l1.messages, keepTail);
  return {
    messages: l3.messages,
    level: "L3",
    removedCount: l3.removedCount,
  };
}
