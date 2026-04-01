/**
 * Session repair — sanitizes conversation history before inference.
 *
 * Fixes structural anomalies that cause provider HTTP 400s or confused
 * LLM behavior: orphaned ToolResults, unmatched ToolUse blocks,
 * duplicate ToolResults, consecutive same-role messages.
 *
 * Adapted from OpenFang's session_repair.rs pattern. All operations
 * are in-place on the array (mutates, does not clone).
 */

import type { ChatMessage } from "./adapter.js";

export interface RepairStats {
  orphanedToolResults: number;
  syntheticErrors: number;
  dedupedResults: number;
  mergedMessages: number;
}

/**
 * Repair a conversation array in-place. Returns stats for observability.
 */
export function repairSession(messages: ChatMessage[]): RepairStats {
  const stats: RepairStats = {
    orphanedToolResults: 0,
    syntheticErrors: 0,
    dedupedResults: 0,
    mergedMessages: 0,
  };

  // Pass 1: Build a set of all tool_call IDs from assistant messages
  const knownCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        knownCallIds.add(tc.id);
      }
    }
  }

  // Pass 2: Remove orphaned ToolResults (tool_call_id not in knownCallIds)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "tool" &&
      msg.tool_call_id &&
      !knownCallIds.has(msg.tool_call_id)
    ) {
      messages.splice(i, 1);
      stats.orphanedToolResults++;
    }
  }

  // Pass 3: Dedup ToolResults with same tool_call_id (keep last)
  const seenToolCallIds = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "tool" && msg.tool_call_id) {
      if (seenToolCallIds.has(msg.tool_call_id)) {
        messages.splice(i, 1);
        stats.dedupedResults++;
      } else {
        seenToolCallIds.add(msg.tool_call_id);
      }
    }
  }

  // Pass 4: Insert synthetic errors for unmatched ToolUse blocks
  const answeredCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      answeredCallIds.add(msg.tool_call_id);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      const unanswered = msg.tool_calls.filter(
        (tc) => !answeredCallIds.has(tc.id),
      );
      if (unanswered.length > 0) {
        // Insert synthetic tool results right after this assistant message
        const synthetics: ChatMessage[] = unanswered.map((tc) => ({
          role: "tool" as const,
          content: JSON.stringify({
            error: "Tool result missing — session corrupted or truncated",
          }),
          tool_call_id: tc.id,
        }));
        messages.splice(i + 1, 0, ...synthetics);
        stats.syntheticErrors += synthetics.length;
        i += synthetics.length; // skip past inserted messages
      }
    }
  }

  // Pass 5: Merge consecutive same-role messages (except assistant with tool_calls)
  for (let i = messages.length - 1; i > 0; i--) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (
      prev.role === curr.role &&
      typeof prev.content === "string" &&
      typeof curr.content === "string" &&
      !(prev.role === "assistant" && prev.tool_calls) &&
      !(curr.role === "assistant" && curr.tool_calls) &&
      prev.role !== "tool" // don't merge tool results
    ) {
      prev.content = `${prev.content}\n\n${curr.content}`;
      messages.splice(i, 1);
      stats.mergedMessages++;
    }
  }

  return stats;
}
