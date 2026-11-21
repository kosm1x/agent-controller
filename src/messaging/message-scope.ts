/**
 * Per-message tool scope: which scope groups a chat turn activates and the
 * tool list built from them, the user's words recorded as evidence for the
 * run, and the streaming guard that holds a reply which asks for a tool or
 * shows an unproven mailbox password.
 *
 * This module must not import the message router: the router imports these
 * names and re-exports the public ones for its existing callers, so an import
 * back would make the two a cycle.
 */
import type { ConversationTurn } from "../runners/types.js";
import {
  scopeToolsForMessage as scopeToolsPure,
  detectActiveGroups,
  getAllAvailableTools,
  DEFAULT_SCOPE_PATTERNS,
  CONVERSATIONAL_PATTERN,
} from "./scope.js";
import { getMemoryService } from "../memory/index.js";
import { recordToolEvidence } from "../lib/v8-4/numbers.js";
import { hasUnprovenValue } from "../lib/v8-4/password-gate.js";
import {
  isSeenPassword,
  provenPasswords,
  recordUserPasswordProof,
} from "../lib/v8-4/mailbox-passwords.js";
import { currentRunTaskId } from "../tools/rule-of-two.js";
import { looksLikeScopeAsk } from "./scope-miss.js";

export type ScopeSource = "semantic" | "inherited" | "regex" | "regex_empty";

/** Phase 3: the user's message + recent user turns join the evidence corpus. */
export function recordUserEvidence(
  taskId: string,
  message: string,
  history: readonly ConversationTurn[] | undefined,
): void {
  try {
    // Only this turn's message is password proof (mailbox-passwords.ts);
    // the earlier user turns feed the figure corpus alone.
    recordUserPasswordProof(taskId, message);
    recordToolEvidence(taskId, message);
    const userTurns = (history ?? [])
      .filter((t) => t.role === "user")
      .slice(-3);
    for (const t of userTurns) recordToolEvidence(taskId, t.content);
  } catch {
    /* evidence is best-effort */
  }
}

/**
 * Three-way decision for which scope groups to activate. Earlier code
 * collapsed `null` and `empty Set` into the same regex-fallback branch, but
 * they mean different
 * things. The classifier explicitly returns `[]` (→ empty Set) for short
 * follow-ups like "dale", "procede", "continúa" per its own rules; that's a
 * signal to inherit prior scope, not to fall back to regex which can pick
 * the wrong group from prior-turn FPs.
 *
 *   semantic non-empty → use semantic, unioned with the prior scope when
 *     `sticky` and the message is not conversational ("semantic")
 *   semantic empty + conversational message → regex_empty (don't inherit
 *     scope onto a topic-closer like "gracias")
 *   semantic empty + prior scope present → inherit prior ("inherited")
 *   semantic empty + no prior → regex_empty
 *   semantic null/undefined → regex fallback ("regex")
 */
export function decideActiveGroups(
  semanticGroups: Set<string> | null | undefined,
  priorScope: Set<string> | undefined,
  regexFallback: () => Set<string>,
  currentMessage?: string,
  /** Phase 1.1: union prior (within TTL — the caller decides) into semantic. */
  sticky = true,
): { groups: Set<string>; source: ScopeSource; base: Set<string> } {
  // Conversational filter: short greetings/acks should not inherit prior
  // scope. Mirrors the protection scope.ts:scopeToolsForMessage already
  // applies to its own regex-inheritance branch (CONVERSATIONAL_PATTERN).
  const isConversational =
    !!currentMessage &&
    currentMessage.trim().length < 80 &&
    CONVERSATIONAL_PATTERN.test(currentMessage.trim());
  if (semanticGroups && semanticGroups.size > 0) {
    // Phase 1.1 sticky scope: a NEW non-empty classification used to REPLACE
    // the prior set, so "confirmo eliminación" (→ destructive) dropped the
    // coding group the previous turn needed and the model asked for "usa
    // shell" again (exchange 11189). Within the TTL the prior groups ride
    // along; the prior set is bounded by the TTL, not accumulated forever.
    // `base` is THIS turn's own classification; the caller stores base (not
    // the union) as the next prior, so the carried set is bounded to one
    // turn's groups plus any scope-miss widening — never an accumulation.
    if (sticky && priorScope && priorScope.size > 0 && !isConversational) {
      return {
        groups: new Set([...semanticGroups, ...priorScope]),
        source: "semantic",
        base: new Set(semanticGroups),
      };
    }
    return {
      groups: semanticGroups,
      source: "semantic",
      base: new Set(semanticGroups),
    };
  }
  const semanticEmpty =
    semanticGroups !== null &&
    semanticGroups !== undefined &&
    semanticGroups.size === 0;
  if (semanticEmpty && priorScope && priorScope.size > 0 && !isConversational) {
    // Separate Sets: scopeToolsForMessage MUTATES the groups it receives
    // (URL/meta injections), and `base` becomes the next turn's prior — an
    // alias would re-grow the prior to the full injected set (R2 audit C1).
    return {
      groups: new Set(priorScope),
      source: "inherited",
      base: new Set(priorScope),
    };
  }
  const fallback = regexFallback();
  return {
    groups: fallback,
    source: semanticEmpty ? "regex_empty" : "regex",
    base: new Set(fallback),
  };
}

/**
 * Scope tools to the groups the current message and recent turns activate:
 * `decideActiveGroups` picks the groups, scope.ts `scopeToolsForMessage`
 * builds the tool list.
 */
export function scopeToolsForMessage(
  currentMessage: string,
  conversationHistory: ConversationTurn[],
  semanticGroups?: Set<string> | null,
  priorScope?: Set<string>,
): {
  tools: string[];
  activeGroups: string[];
  baseGroups: string[];
  requestGroups: string[];
} {
  // Scope from recent user messages. Previously slice(-2) to avoid scope
  // accumulation on hallucinated assistant content, but user messages are
  // trusted. Widened to -4 so confirmation chains ("Lista X" → "Elimina 6 y 7"
  // → "Confirmado" → "Confirma el status") preserve the original domain
  // context (schedule, coding, etc.) across 3-4 turn acknowledgment loops.
  // The current message (first param) is always scanned separately.
  const userMsgs = conversationHistory
    .filter((t) => t.role === "user")
    .slice(-4)
    .map((t) => t.content);

  // For assistant messages, extract only google/wp keywords to avoid false triggers
  const assistantContext = conversationHistory
    .filter((t) => t.role === "assistant")
    .slice(-2)
    .map((t) => {
      // Only pass through words that match google or wordpress patterns
      const googleMatch = t.content.match(
        /\b(emails?|correos?|gmail|calendar|drive|hojas?|sheets?|google|gsheets)/gi,
      );
      const wpMatch = t.content.match(
        /\b(wordpress|wp|posts?|art[ií]culos?|livingjoyfully)/gi,
      );
      return [...(googleMatch ?? []), ...(wpMatch ?? [])].join(" ");
    })
    .filter((s) => s.length > 0);

  const recentUserMessages = [...userMsgs, ...assistantContext];

  // v6.4 CL1.1: Use semantic classifier groups if available, regex as fallback.
  // The LLM understands intent ("abre mi northstar", "manda un correo") without
  // needing exact keyword patterns. Regex stays as safety net for timeouts.
  // v8 2026-04-26: three-way decision delegated to decideActiveGroups so the
  // empty-vs-null distinction (was previously collapsed) is unit-testable.
  const decision = decideActiveGroups(
    semanticGroups,
    priorScope,
    () =>
      detectActiveGroups(
        currentMessage,
        recentUserMessages,
        DEFAULT_SCOPE_PATTERNS,
      ),
    currentMessage,
  );
  const activeGroups = decision.groups;
  // Ruling 3t (audit W1): the groups THIS message produced on its own — the
  // classifier's answer (before the sticky union and the history safety
  // net) or the patterns the current text matches; inherited scope → none.
  // Read by chat attribution only (`chatProject`).
  const requestGroups =
    decision.source === "semantic"
      ? [...decision.base]
      : decision.source === "inherited"
        ? []
        : [...detectActiveGroups(currentMessage, [], DEFAULT_SCOPE_PATTERNS)];
  if (decision.source === "semantic") {
    console.log(
      `[router] Scope groups (semantic): ${[...activeGroups].join(", ")}`,
    );
  } else if (decision.source === "inherited") {
    console.log(
      `[router] Scope groups (inherited from prior turn): ${[...activeGroups].join(", ")}`,
    );
  } else if (
    (decision.source === "regex" || decision.source === "regex_empty") &&
    activeGroups.size > 0
  ) {
    const tag =
      decision.source === "regex_empty"
        ? "regex (post-empty)"
        : "regex fallback";
    console.log(
      `[router] Scope groups (${tag}): ${[...activeGroups].join(", ")}`,
    );
  }

  const tools = scopeToolsPure(
    currentMessage,
    recentUserMessages,
    DEFAULT_SCOPE_PATTERNS,
    {
      hasGoogle: !!process.env.GOOGLE_CLIENT_ID,
      hasWordpress: !!process.env.WP_SITES,
      hasMemory: getMemoryService().backend === "hindsight",
      hasCrm: !!process.env.CRM_API_TOKEN,
    },
    activeGroups,
  );

  // fullCount = the universe of every tool name scopeToolsForMessage could
  // return for the current env config. Source of truth co-located with the
  // assembly logic in scope.ts so adding a new tool group can't silently rot
  // this denominator (v7.6 Spine 2 — observability backfill).
  const fullCount = getAllAvailableTools({
    hasGoogle: !!process.env.GOOGLE_CLIENT_ID,
    hasWordpress: !!process.env.WP_SITES,
    hasMemory: getMemoryService().backend === "hindsight",
    hasCrm: !!process.env.CRM_API_TOKEN,
  }).size;
  console.log(`[router] Tool scope: ${tools.length}/${fullCount} tools`);

  return {
    tools,
    activeGroups: [...activeGroups],
    baseGroups: [...decision.base],
    requestGroups,
  };
}

/**
 * The stream hold's password test (password-gate.ts): a value the mailbox
 * tool printed that this run has not proven, from `from` on. The run is the
 * one whose stream this is (the chunk arrives inside its tool context; with
 * no run, nothing is proven). A failing check holds (the safe side).
 */
function holdForPassword(text: string, from: number): boolean {
  try {
    const proven = provenPasswords(currentRunTaskId());
    return hasUnprovenValue(
      text,
      { isSeen: isSeenPassword, isProven: (fp) => proven.has(fp) },
      from,
    );
  } catch {
    console.warn(
      "[router] password-gate stream check failed — holding the stream",
    );
    return true;
  }
}

/**
 * Streaming guard for scope asks (2026-09-06). The Telegram placeholder was
 * edited with the raw reply as it streamed, so «Necesito `shell_exec` para
 * esto.» was on the operator's screen for the seconds before the scope-miss
 * re-run wiped it — the ask the Phase 1.2 filter exists to hide. Once the
 * accumulated text reads as an ask, wipe the placeholder and hold chunks;
 * the re-run's reset() or the final finalize() writes the real reply
 * (finalize always rewrites the whole message, so no content is lost).
 *
 * The hold is re-evaluated per chunk, not latched (qa-audit W1: a latch cost
 * 3.3% of replies their streaming — «necesito que me digas…» mid-answer).
 * When the ask scrolls out of the predicate's tail window the whole
 * accumulation is re-appended (reset() emptied the controller), so a reply
 * that asked and then kept going streams again.
 */
export function holdScopeAsks(stream: {
  appendChunk(text: string): void;
  reset(placeholder?: string): void;
}): (chunk: string) => void {
  let accumulated = "";
  let holding = false;
  // An unproven mailbox password (password-gate.ts) latches the hold: it is
  // withheld at completion, so it never stays on screen — finalize() writes
  // the checked text, and if finalize fails the old message shows only the
  // placeholder. Only the new tail is scanned (a run cut by the previous
  // end is walked back), so a long reply stays linear.
  let passwordHeld = false;
  let scanned = 0;
  return (chunk: string) => {
    accumulated += chunk;
    if (passwordHeld) return;
    const from = scanned;
    scanned = accumulated.length;
    if (holdForPassword(accumulated, from)) {
      passwordHeld = true;
      if (!holding) stream.reset("⏳");
      holding = true;
      return;
    }
    if (looksLikeScopeAsk(accumulated)) {
      if (!holding) {
        holding = true;
        stream.reset("⏳");
      }
      return;
    }
    if (holding) {
      holding = false;
      stream.appendChunk(accumulated);
      return;
    }
    stream.appendChunk(chunk);
  };
}
