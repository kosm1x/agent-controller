/**
 * Outbound secret scrub (ruling 3c, audit round 4 — the structural closer;
 * audit round 5 — typed failure, JSON-aware tool-call arguments).
 *
 * The ONE outbound scrub for model-bound text, re-exported by `adapter.ts`
 * and applied at the two provider choke points — `queryClaudeSdk`
 * (claude-sdk.ts: prompt, systemPrompt, tool results, Stop-hook reasons) and
 * `callProvider` (adapter-openai.ts: every message) — plus the model-bound
 * requests outside the adapter (vision, embeddings, Jev). Kept in its own
 * module (imports only secret-refs) so those leaf modules need not load the
 * whole adapter.
 */

import { scrubJsonText, scrubSecrets } from "../lib/secret-refs.js";
import type { ChatMessage } from "./adapter.js";

/**
 * The secret index could not be built (and no current last-good index
 * exists), so the request was NOT sent. Not a provider failure: callers must
 * not count it against a provider's circuit breaker or metrics.
 */
export class SecretScrubUnavailableError extends Error {
  override readonly name = "SecretScrubUnavailableError";
  constructor(cause: unknown) {
    super(
      `secret scrub unavailable, request not sent: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SecretScrubUnavailableError) throw err;
    throw new SecretScrubUnavailableError(err);
  }
}

/**
 * Every stored credential value replaced by its by-name placeholder
 * (`scrubSecrets`). A value not yet stored (a credential pasted in the
 * current turn) is not in the index and passes, so the model can still save
 * it. Throws `SecretScrubUnavailableError` when the index cannot be built
 * (fail closed).
 */
export function scrubOutboundText(text: string): string {
  return guarded(() => scrubSecrets(text));
}

/**
 * Tool-call arguments (a JSON text): JSON-aware scrub — string leaves
 * scrubbed, a number leaf equal to a stored value replaced by its
 * placeholder; unparseable text falls back to the text scrub.
 */
export function scrubOutboundToolArguments(args: string): string {
  return guarded(() => scrubJsonText(args));
}

/**
 * `scrubOutboundText` over every text part of every message (all roles,
 * string content, `text` parts of array content) and
 * `scrubOutboundToolArguments` over tool-call arguments. Returns copies; the
 * caller's array and messages are never mutated.
 */
export function scrubOutboundMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    let content = m.content;
    if (typeof content === "string") {
      content = scrubOutboundText(content);
    } else if (Array.isArray(content)) {
      content = content.map((part) =>
        part.type === "text" && typeof part.text === "string"
          ? { ...part, text: scrubOutboundText(part.text) }
          : part,
      );
    }
    const out: ChatMessage = { ...m, content };
    if (m.tool_calls) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments:
            typeof tc.function.arguments === "string"
              ? scrubOutboundToolArguments(tc.function.arguments)
              : tc.function.arguments,
        },
      }));
    }
    return out;
  });
}
