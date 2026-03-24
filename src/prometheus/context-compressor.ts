/**
 * Context Compressor — Summarize long tool conversations to stay within
 * the model's context window.
 *
 * Hermes-inspired: protect first 3 + last 4 messages, summarize the middle,
 * sanitize orphaned tool call/result pairs, fallback to drop-without-summary.
 */

import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: chars / 4. Returns true if messages exceed
 * `threshold` fraction of `contextLimit`.
 */
export function shouldCompress(
  messages: ChatMessage[],
  contextLimit: number,
  threshold = 0.85,
): boolean {
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
  const estimatedTokens = totalChars / 4;
  return estimatedTokens > contextLimit * threshold;
}

/**
 * Compress a conversation by summarizing the middle portion.
 * Protects the first `keepHead` and last `keepTail` messages.
 * Falls back to dropping without summary if summarization fails.
 */
export async function compress(
  messages: ChatMessage[],
  keepHead = 3,
  keepTail = 4,
): Promise<ChatMessage[]> {
  const total = messages.length;
  if (total <= keepHead + keepTail) return messages;

  const head = messages.slice(0, keepHead);
  const tail = messages.slice(total - keepTail);
  const middle = messages.slice(keepHead, total - keepTail);

  if (middle.length === 0) return messages;

  // Try to summarize the middle
  let summaryContent: string;
  try {
    const middleText = middle
      .map((m) => {
        const role = m.role;
        const content =
          typeof m.content === "string"
            ? m.content
            : (JSON.stringify(m.content) ?? "");
        return `[${role}]: ${content?.slice(0, 300) ?? ""}`;
      })
      .join("\n");

    const summaryResponse = await infer({
      messages: [
        {
          role: "user",
          content: `Summarize the following tool conversation concisely, preserving key results and decisions:\n\n${middleText}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    summaryContent =
      summaryResponse.content ??
      `[Earlier conversation compressed — ${middle.length} messages removed]`;
  } catch {
    // Fallback: drop without summary
    summaryContent = `[Earlier conversation compressed — ${middle.length} messages removed]`;
  }

  const compressed: ChatMessage[] = [
    ...head,
    { role: "system", content: summaryContent },
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
