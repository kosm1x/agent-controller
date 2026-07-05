/**
 * Message router — bridges messaging channels to the Agent Controller.
 *
 * Inbound: owner message → task via submitTask()
 * Outbound: task.completed/task.failed events → formatted reply to channel
 * Ritual: completed ritual tasks → broadcast to all active channels
 */

import { submitTask, cancelTask } from "../dispatch/dispatcher.js";
import { toolRegistry } from "../tools/registry.js";
import { executeGatedCapability } from "../lib/v8-3/trigger.js";
import { SYSTEM_PROMPT_TOKEN_BUDGET } from "../config/constants.js";
import { getDatabase } from "../db/index.js";
import {
  findRecentCheckpoint,
  clearCheckpoint,
} from "../runners/checkpoint.js";
import { getEventBus } from "../lib/event-bus.js";
import { safeSlice } from "../lib/unicode-safe.js";
import {
  extractPattern,
  findRelevantPatterns,
} from "../intelligence/execution-patterns.js";
import { getFile, mirrorToDisk } from "../db/jarvis-fs.js";
import {
  shouldEnhance,
  checkToggle,
  isWaitingForAnswers,
  getOriginalMessage,
  getQuestions,
  clearEnhancerState,
  setWaiting,
  analyzePrompt,
  buildEnhancedPrompt,
} from "./prompt-enhancer.js";
import type { Event } from "../lib/events/types.js";
import type {
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskCancelledPayload,
} from "../lib/events/types.js";
import type {
  ChannelAdapter,
  ChannelName,
  EmailChannelMode,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";
import { getMemoryService } from "../memory/index.js";
import {
  trackTaskOutcome,
  checkFeedbackWindow,
  recordTaskFeedback,
  clearAllFeedbackWindows,
} from "../intelligence/outcome-tracker.js";
import { enrichContext } from "../intelligence/enrichment.js";
import { extractAndPersistCorrection } from "../intelligence/correction-loop.js";
import { formatUserFactsBlock, setUserFact } from "../db/user-facts.js";
import { formatProjectsBlock } from "../db/projects.js";
import {
  detectFeedbackSignal,
  detectImplicitFeedback,
  isFeedbackMessage,
} from "../intelligence/feedback.js";
import { isConversationalFastPath, fastPathRespond } from "./fast-path.js";
import { resolveBriefingOnOperatorReply } from "../briefing/promote.js";
import { isV82ProducerEnabled } from "../lib/v8-2/flags.js";
import { reRunJudgment } from "../lib/v8-2/produce.js";
import {
  getPendingConfirmation,
  clearPendingConfirmation,
  storePendingConfirmation,
  detectConfirmationResponse,
} from "./confirmations.js";
import { TelegramStreamController } from "./channels/telegram-stream.js";
import {
  isProactiveTask,
  handleProactiveResult,
  handleProactiveFailure,
} from "../intelligence/proactive.js";
import {
  isScheduledTask,
  handleScheduledTaskResult,
  handleScheduledTaskFailure,
} from "../rituals/dynamic.js";
import type { ConversationTurn } from "../runners/types.js";
import { nowMexDate, nowMexTime } from "../lib/timezone.js";
import {
  detectToolFlags,
  identitySection,
  timeContextLine,
  fileSystemSection,
  capabilitiesSection,
  orgPersonaSection,
  personalDataSection,
  confirmationSection,
  verificationSection,
  toolFirstSection,
  wordpressSection,
  mechanicalVerificationSection,
  memoryPersistenceSection,
  correctionMemorySection,
  codingSection,
  browserSection,
  researchSection,
  availableSkillsSection,
  cohortSection,
} from "./prompt-sections.js";
import { listSkillsForTools } from "../skills/catalog.js";
import { getCohort, type CohortMember } from "../cohort/self-defining.js";
import {
  scopeToolsForMessage as scopeToolsPure,
  detectActiveGroups,
  getAllAvailableTools,
  DEFAULT_SCOPE_PATTERNS,
  CONVERSATIONAL_PATTERN,
  applyCommunityChannelScopeOverride,
} from "./scope.js";
import { classifyScopeGroups } from "./scope-classifier.js";
import { normalizeForMatching, wasNormalized } from "./normalize.js";
import {
  gateCommunityReply,
  COMMUNITY_REPLY_FALLBACK,
} from "./community-reply-gate.js";

import {
  recordScopeDecision,
  linkScopeToTask,
  linkFeedbackToScope,
} from "../intelligence/scope-telemetry.js";
import { autoPersistConversation } from "../memory/auto-persist.js";
import { getOutcomeTag } from "../memory/outcome-tag.js";
import { errMsg } from "../lib/err-msg.js";

const TASK_TIMEOUT_INTERIM_MS = 120_000; // 2 min → "still working"
const TASK_TIMEOUT_FINAL_MS = 300_000; // 5 min → second "still working" warning
const TASK_TIMEOUT_ABANDON_MS = 660_000; // 11 min → give up (past SDK 15min timeout with grace)
const TASK_TIMEOUT_ABANDON_CODING_MS = 1_200_000; // 20 min → coding tasks need more runway

// Intent regexes for handleInbound. Module-level (they close over nothing) so
// they compile once, not on every inbound message.
const CONTEXT_CLEAR_RE =
  /^(limpia\s+(?:tu\s+)?contexto|clear\s+context|contexto\s+limpio|borra\s+(?:el\s+)?contexto)\s*/i;
const BACKGROUND_AGENT_RE =
  /\b(lanza\s+(?:un\s+)?agente|investiga\s+en\s+background|averigua\s+mientras|agente.*investig[ae])\b/i;
const CANCEL_INTENT_RE =
  /^(cancela|detente|para|stop|cancel|aborta|déjalo|dejalo)\s*$/i;
const SKIP_ENHANCER_RE =
  /^(skip|hazlo|procede|sin preguntas|no importa|ya|dale|solo hazlo|just do it)\b/i;
const CONTINUATION_RE =
  /^(contin[uú]a|sigue|termin[ae]|completa|finaliza|acaba|resume|continúe|continue)\b/i;

/**
 * Fork child injection boilerplate for background agents (OpenClaude pattern).
 * Explicit identity, numbered rules, structured output. Module-level constant
 * to avoid re-allocation on every spawn.
 */
const BACKGROUND_AGENT_BOILERPLATE = `
IMPORTANTE: Eres un agente de background. NO eres el agente principal de Jarvis.

REGLAS (no negociables):
1. NO converses con el usuario — solo ejecuta y reporta.
2. NO lances sub-agentes ni tareas adicionales.
3. Guarda TODOS los hallazgos en workspace/ con jarvis_file_write (qualifier: workspace).
4. Si necesitas información que no puedes obtener, documenta qué falta y por qué.
5. Sé conciso — el usuario revisará los resultados después.
6. Tu respuesta DEBE incluir estas secciones:
   - Alcance: qué investigaste/ejecutaste
   - Resultado: hallazgos principales (datos concretos, no narrativa)
   - Archivos creados: paths de los archivos guardados en workspace/
   - Pendientes: qué queda por hacer (si aplica)`;

// ---------------------------------------------------------------------------
// Jarvis system prompt builder — conditional sections based on scoped tools
// ---------------------------------------------------------------------------

/**
 * Build the Jarvis system prompt with only the sections relevant to the
 * tools actually in scope. Prevents the LLM from attempting to use tools
 * it cannot call (e.g., browser__goto when browser tools aren't scoped).
 */
/**
 * v8 S1: Cache-break marker. Splits the system prompt into a stable prefix
 * (P1 + P2 sections — same across all tasks for this user) and a variable
 * suffix (P3 + P4 — scope-conditional + per-call data). Runners that want to
 * exploit the prompt cache split on this marker and emit the halves as
 * separate system messages, with stable content first. Runners that don't
 * (heavy/nanoclaw/swarm) replace the marker with a single newline and treat
 * description as one blob — no regression vs pre-S1 behavior.
 *
 * Format chosen to be unambiguous (HTML comment line) and unlikely to collide
 * with real persona/KB content. Versioned so future changes can be detected.
 */
export const CACHE_BREAK_MARKER = "\n<!--CACHE_BREAK_v1-->\n";

/**
 * Strip the cache-break marker, replacing it with a single newline.
 * Use at any boundary where `description` text is exposed to a consumer
 * that doesn't honor the split (A2A peers, persistence, dashboard, classifier).
 * The fast-runner chat branch is the only consumer that splits on the marker;
 * everywhere else this helper makes the description look as if S1 didn't exist.
 */
export function stripCacheMarker(text: string): string {
  return text.includes(CACHE_BREAK_MARKER)
    ? text.replace(CACHE_BREAK_MARKER, "\n")
    : text;
}

/**
 * Build the static (byte-identical across calls) portion of the Jarvis system
 * prompt. The current date/time is deliberately NOT included here — it goes
 * into the user message via `timeContextLine()` so the SDK's prompt cache
 * hits on the system prompt. See `identitySection` comment for history.
 *
 * v8 S1: Returns `{ stable, variable }` so runners can place the variable
 * portion AFTER stable content (essentials, enforce-KB, always-read-KB) for
 * cache stability. See `CACHE_BREAK_MARKER` and `feedback_cache_prefix_variability.md`.
 */
function buildJarvisSystemPrompt(
  tools: string[],
  userFactsBlock: string,
  enrichmentBlock: string,
  personaContent: string | null = null,
  // Operator-private grounding (the self-defining cohort) is emitted ONLY
  // when this is true. Defaults to false so a caller that forgets to pass it
  // fails safe — no private data leaks. See `cohortSection`.
  ownerChannel = false,
): { stable: string; variable: string } {
  const flags = detectToolFlags(tools);

  // CCP6: Priority-ordered sections. Higher priority = kept when over budget.
  // P1 (safety-critical), P2 (core), P3 (conditional), P4 (supplementary)
  const p1: string[] = []; // Never truncated
  const p2: string[] = [];
  const p3: string[] = [];
  const p4: string[] = []; // First to truncate

  // P1: Identity + safety (STABLE)
  p1.push(identitySection());
  // Per-channel org persona for community-manager email mailboxes. Loaded
  // once at startup from `EMAIL_<ID>_PERSONA_FILE`, so the content is byte-
  // stable across calls on the same channel and prompt-cache friendly. P1
  // because it is authoritative context for the reply — never truncate it
  // in favour of variable-half blocks.
  if (personaContent) p1.push(orgPersonaSection(personaContent));
  p1.push(confirmationSection(flags));
  p1.push(toolFirstSection(flags));
  p1.push(mechanicalVerificationSection());

  // P2: Core knowledge (STABLE — same content per user across tasks)
  // Note: fileSystemSection is gated on hasNorthStar but the gate decision is
  // stable per scope-tool composition; it stays in the stable layer. Coding
  // tasks without NorthStar tools won't see this either way.
  if (flags.hasNorthStar) p2.push(fileSystemSection());
  p2.push(capabilitiesSection(flags));
  // V8.1 Phase A — Conway Pattern 2 grounding. Surface the self-defining
  // cohort (what Fede actually has live) in the stable layer so the model
  // grounds answers in real projects/objectives. getCohort() is one indexed
  // SELECT on a ≤30-row table; the cohort is re-rolled once daily, so the
  // section is byte-stable within a day → prompt-cache friendly. The cohort
  // is operator-PRIVATE — cohortSection() emits it only when ownerChannel.
  let cohortMembers: CohortMember[] = [];
  try {
    cohortMembers = getCohort();
  } catch (err) {
    // Table absent in bootstrap/test paths is expected; once it exists in
    // prod (it does) any throw is an anomaly worth surfacing — not silence.
    console.warn(
      "[prompt] getCohort failed — cohort grounding omitted:",
      errMsg(err),
    );
  }
  const cohortBlock = cohortSection(cohortMembers, ownerChannel);
  if (cohortBlock) p2.push(cohortBlock);
  // personalDataSection instructs the model to call user_fact_set — gate on
  // the tool's availability. Community-manager email scope excludes the tool
  // (the section would otherwise hallucinate calls on stranger-sent data).
  if (flags.hasUserFacts) p2.push(personalDataSection());
  p2.push(correctionMemorySection());

  // P3: Domain-specific (VARIABLE — varies by tool scope)
  if (flags.hasBrowser) p3.push(verificationSection());
  if (flags.hasWordpress) p3.push(wordpressSection());
  if (tools.includes("memory_store")) p3.push(memoryPersistenceSection());
  if (flags.hasCoding) p3.push(codingSection());
  if (flags.hasBrowser) p3.push(browserSection());
  if (flags.hasResearch) p3.push(researchSection());
  // v7.6 Spine 5 — surface first-party skill catalog. Filtered to skills whose
  // parent tool is in scope so we never advertise a skill the LLM cannot use
  // (round-1 audit H1: identity-section rule "no menciones herramientas que no
  // están en tu lista"). availableSkillsSection returns "" when the filtered
  // list is empty so the section auto-omits cleanly.
  const skillsBlock = availableSkillsSection(listSkillsForTools(tools));
  if (skillsBlock) p3.push(skillsBlock);

  // P4: Supplementary data (VARIABLE — per-call user facts, enrichment)
  if (userFactsBlock) p4.push(userFactsBlock);
  if (enrichmentBlock) p4.push(enrichmentBlock);

  // Assemble with budget check across both halves combined
  const budget = SYSTEM_PROMPT_TOKEN_BUDGET * 4; // Convert tokens to chars
  let stable = [...p1, ...p2].join("\n\n");
  let variable = [...p3, ...p4].join("\n\n");
  let combinedLength = stable.length + variable.length;

  // CCP6: Truncate from lowest priority tier first, then next tier up.
  // Drain P4 completely before touching P3, P3 before P2. Never touch P1.
  if (combinedLength > budget) {
    const tiers: { arr: string[]; recompute: () => void }[] = [
      {
        arr: p4,
        recompute: () => {
          variable = [...p3, ...p4].join("\n\n");
        },
      },
      {
        arr: p3,
        recompute: () => {
          variable = [...p3, ...p4].join("\n\n");
        },
      },
      {
        arr: p2,
        recompute: () => {
          stable = [...p1, ...p2].join("\n\n");
        },
      },
    ];
    for (const { arr, recompute } of tiers) {
      while (arr.length > 0 && combinedLength > budget) {
        arr.pop();
        recompute();
        combinedLength = stable.length + variable.length;
      }
    }
    console.warn(
      `[prompt] System prompt truncated: ${Math.round(combinedLength / 4)} tokens (budget: ${SYSTEM_PROMPT_TOKEN_BUDGET})`,
    );
  }

  console.log(
    `[prompt] System prompt: ${Math.round(combinedLength / 4)} tokens, ${p1.length + p2.length + p3.length + p4.length} sections (stable=${p1.length + p2.length}, variable=${p3.length + p4.length})`,
  );
  return { stable, variable };
}

/**
 * Scope tools to only groups relevant to the current conversation context.
 * Scans the current message + last 3 conversation turns for keyword signals.
 * Always includes core + misc. Activates other groups on demand.
 *
 * Typical reduction: 49 → 15-25 tools = ~5-8K fewer tokens.
 */
/**
 * Three-way decision for which scope groups to activate. Source of bug class
 * `feedback_classifier_empty_vs_null.md`: prior code collapsed `null` and
 * `empty Set` into the same regex-fallback branch, but they mean different
 * things. The classifier explicitly returns `[]` (→ empty Set) for short
 * follow-ups like "dale", "procede", "continúa" per its own rules; that's a
 * signal to inherit prior scope, not to fall back to regex which can pick
 * the wrong group from prior-turn FPs.
 *
 *   semantic non-empty → use semantic ("semantic")
 *   semantic empty + conversational message → regex_empty (don't inherit
 *     scope onto a topic-closer like "gracias" — qa-audit W2)
 *   semantic empty + prior scope present → inherit prior ("inherited")
 *   semantic empty + no prior → regex_empty
 *   semantic null/undefined → regex fallback ("regex")
 */
export type ScopeSource = "semantic" | "inherited" | "regex" | "regex_empty";

export function decideActiveGroups(
  semanticGroups: Set<string> | null | undefined,
  priorScope: Set<string> | undefined,
  regexFallback: () => Set<string>,
  currentMessage?: string,
): { groups: Set<string>; source: ScopeSource } {
  if (semanticGroups && semanticGroups.size > 0) {
    return { groups: semanticGroups, source: "semantic" };
  }
  const semanticEmpty =
    semanticGroups !== null &&
    semanticGroups !== undefined &&
    semanticGroups.size === 0;
  // Conversational filter: short greetings/acks should not inherit prior
  // scope. Mirrors the protection scope.ts:scopeToolsForMessage already
  // applies to its own regex-inheritance branch (CONVERSATIONAL_PATTERN).
  const isConversational =
    !!currentMessage &&
    currentMessage.trim().length < 80 &&
    CONVERSATIONAL_PATTERN.test(currentMessage.trim());
  if (semanticEmpty && priorScope && priorScope.size > 0 && !isConversational) {
    return { groups: new Set(priorScope), source: "inherited" };
  }
  return {
    groups: regexFallback(),
    source: semanticEmpty ? "regex_empty" : "regex",
  };
}

function scopeToolsForMessage(
  currentMessage: string,
  conversationHistory: ConversationTurn[],
  semanticGroups?: Set<string> | null,
  priorScope?: Set<string>,
): { tools: string[]; activeGroups: string[] } {
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

  return { tools, activeGroups: [...activeGroups] };
}

interface PendingReply {
  channel: ChannelName;
  to: string;
  originalText: string;
  imageUrl?: string; // preserved for thread continuity (vision follow-ups)
  scopeGroups?: string[]; // for execution pattern extraction on completion
  interimTimer: ReturnType<typeof setTimeout>;
  finalTimer: ReturnType<typeof setTimeout>;
  abandonTimer: ReturnType<typeof setTimeout>;
  streamController?: TelegramStreamController;
  /** Abort controller for task cancellation (v6.2 S2). */
  abortController?: AbortController;
  /** Thread key for conversation isolation (groups vs DMs). */
  tk: string;
}

/** In-memory ring buffer of recent exchanges per channel for thread continuity. */
const THREAD_BUFFER_SIZE = 15;
/** Max chars per Jarvis response stored in the thread buffer.
 *  Higher cap preserves more context for multi-turn workflows where
 *  Jarvis needs to remember file contents, data, or analysis from prior turns. */
const THREAD_RESPONSE_CAP = 3000;

interface ThreadEntry {
  text: string; // "User: ...\nJarvis: ..."
  imageUrl?: string; // base64 data URL — preserved so follow-up turns see the image
}

const conversationThreads = new Map<string, ThreadEntry[]>();
const threadLastAccess = new Map<string, number>();
/** Previous scope groups per conversation — used for implicit feedback detection. */
const previousScopeGroups = new Map<string, Set<string>>();
const previousMessages = new Map<string, string>();
const THREAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let threadAccessCount = 0;
const hydratedChannels = new Set<string>();

/**
 * Thread key: isolates conversation buffers per unique endpoint.
 * WhatsApp groups use group:sender so each person has their own thread.
 * DMs and Telegram use the channel name (backward-compatible).
 *
 * Community-manager email channels MUST isolate per sender — otherwise every
 * stranger writing to a public mailbox shares one conversationHistory buffer,
 * one scope-inheritance bag, and one SQLite hydration query, and Sender A's
 * PII bleeds into Sender B's runner context on the next turn. Owner-only
 * email keeps the channel-only key (one trusted sender, backward-compat with
 * existing persisted conversations).
 */
export function threadKey(
  channel: string,
  from?: string,
  senderJid?: string,
  mode?: EmailChannelMode,
): string {
  // Groups: isolate per sender so Person A's budget talk doesn't leak into Person B's poetry
  if (from && from.endsWith("@g.us") && senderJid) {
    return `${channel}:${from}:${senderJid}`;
  }
  // Groups without sender (shouldn't happen, but fallback to group-level isolation)
  if (from && from.endsWith("@g.us")) return `${channel}:${from}`;
  // Community-manager email: isolate per sender. The address is already
  // lowercased by extractAddress() in email-mime.ts, but lowercasing again
  // here is cheap and removes any ambiguity if a non-email caller upstream
  // passes a mixed-case `from`.
  if (isEmailChannel(channel) && mode === "community-manager" && from) {
    return `${channel}:${from.toLowerCase()}`;
  }
  return channel;
}

/**
 * Whether a channel name belongs to the email transport. Email is
 * multi-mailbox — every account is its own `email:<id>` channel — so an
 * exact `=== "email"` check is wrong. Precise (not a loose `startsWith`):
 * matches the bare `"email"` and `email:<id>`, nothing else.
 */
function isEmailChannel(channel: string): boolean {
  return channel === "email" || channel.startsWith("email:");
}

/**
 * Whether a channel is a trusted OWNER channel (operator-only), as opposed to
 * a public-facing community-manager mailbox. Gate for operator-private prompt
 * content (the self-defining cohort — see `cohortSection`).
 *
 * Fail-safe by construction — owner status must be POSITIVELY established:
 *   - non-email channels (WhatsApp, Telegram) → owner (operator-only by design)
 *   - email with `mode === "owner-only"`      → owner
 *   - email with `mode === "community-manager"` → NOT owner (public)
 *   - email with `mode` undefined/ambiguous   → NOT owner (default-deny)
 *
 * The email branch is the exact inverse of the community-manager gate at the
 * `needsGate` check (`isEmailChannel(channel) && mode !== "owner-only"`).
 */
export function isOwnerChannel(
  channel: string,
  mode: EmailChannelMode | undefined,
): boolean {
  return !isEmailChannel(channel) || mode === "owner-only";
}

// ---------------------------------------------------------------------------
// Critical data persistence safety net
// ---------------------------------------------------------------------------

interface DetectedCredential {
  key: string;
  value: string;
}

/**
 * Scan user text for critical data patterns (API keys, IDs, credentials)
 * that should be persisted regardless of whether the LLM called user_fact_set.
 */
function detectCriticalData(text: string): DetectedCredential[] {
  const results: DetectedCredential[] = [];

  // Google API keys: AIzaSy...
  const googleApiKey = text.match(/\b(AIzaSy[A-Za-z0-9_-]{33})\b/);
  if (googleApiKey) {
    results.push({ key: "google_api_key", value: googleApiKey[1] });
  }

  // GA4 Measurement IDs: G-XXXXXXXXXX (with or without G- prefix)
  const ga4Full = text.match(/\b(G-[A-Z0-9]{8,12})\b/);
  if (ga4Full) {
    results.push({ key: "ga4_measurement_id", value: ga4Full[1] });
  }
  // Measurement/Msrmnt ID without G- prefix
  if (!ga4Full) {
    const ga4Labeled = text.match(
      /(?:m(?:e(?:asure)?)?s?rmnt|measurement)\s*id\s*[:\s]*([A-Z0-9]{8,12})\b/i,
    );
    if (ga4Labeled) {
      results.push({
        key: "ga4_measurement_id",
        value: `G-${ga4Labeled[1]}`,
      });
    }
  }

  // GA4 Stream IDs: long numeric (10+ digits, preceded by "stream" context)
  const streamId = text.match(/(?:stream\s*(?:id)?)\s*[:\s]*(\d{10,15})/i);
  if (streamId) {
    results.push({ key: "ga4_stream_id", value: streamId[1] });
  }

  // Generic API keys/tokens: explicit label + value patterns
  const labeledSecret = text.match(
    /(?:api[_ ]?key|token|secret)\s*[:\s=]+\s*["']?([A-Za-z0-9_\-.]{20,})/i,
  );
  if (labeledSecret && !googleApiKey) {
    results.push({ key: "api_credential", value: labeledSecret[1] });
  }

  // Passwords: label + value (allows special chars)
  const labeledPassword = text.match(
    /(?:password|contraseña|pswd|pwd|pass)\s*[:\s=]+\s*["']?(\S{8,})/i,
  );
  if (labeledPassword) {
    results.push({ key: "password", value: labeledPassword[1] });
  }

  // Login/username: label + value
  const labeledLogin = text.match(
    /(?:login|user(?:name)?|usuario)\s*[:\s=]+\s*["']?(\S{3,})/i,
  );
  if (labeledLogin) {
    results.push({ key: "login", value: labeledLogin[1] });
  }

  // WP Application Passwords: 4-char groups separated by spaces (e.g. "BtZU tFsT EUhC l2z5 No4B F4aU")
  const wpAppPass = text.match(
    /(?:app(?:lication)?\s*pass(?:word)?|contraseña\s*de\s*aplicación)[^:=\n]*[:\s=]+\s*["']?([A-Za-z0-9]{4}(?:\s+[A-Za-z0-9]{4}){4,})/i,
  );
  if (wpAppPass) {
    results.push({ key: "wp_app_password", value: wpAppPass[1] });
  }

  // FTP host: ftp://... or sftp://...
  const ftpHost = text.match(
    /(?:ftp|sftp)\s*(?:host)?\s*[:\s=]*\s*((?:s?ftp:\/\/)?[\d.]+|(?:s?ftp:\/\/)?[\w.-]+\.\w{2,})/i,
  );
  if (ftpHost) {
    results.push({ key: "ftp_host", value: ftpHost[1] });
  }

  return results;
}

/**
 * Post-execution safety net: if user message contained critical data
 * and the LLM didn't call user_fact_set, auto-store it.
 */
function ensureCriticalDataPersisted(userText: string, taskId: string): void {
  const detected = detectCriticalData(userText);
  if (detected.length === 0) return;

  // Check if user_fact_set was called by this task
  try {
    const run = getDatabase()
      .prepare(
        "SELECT r.output FROM runs r WHERE r.task_id = ? ORDER BY r.created_at DESC LIMIT 1",
      )
      .get(taskId) as { output: string | null } | undefined;

    let toolCalls: string[] = [];
    if (run?.output) {
      try {
        const parsed = JSON.parse(run.output);
        toolCalls = parsed.toolCalls ?? [];
      } catch {
        /* bare string output — no tools */
      }
    }

    if (toolCalls.includes("user_fact_set")) return; // LLM already stored it

    // Auto-store detected credentials
    for (const cred of detected) {
      setUserFact("projects", cred.key, cred.value, "auto-detected");
      console.log(
        `[router] Auto-persisted critical data: projects/${cred.key} (LLM missed user_fact_set)`,
      );
    }
  } catch (err) {
    console.error(`[router] Critical data persistence check failed: ${err}`);
  }
}

function pushToThread(
  channel: string,
  exchange: string,
  imageUrl?: string,
): void {
  hydrateThreadIfNeeded(channel);
  // Check for poisoned responses before adding to the thread buffer.
  // Without this, poisoned entries live in-memory until the next restart
  // and teach the LLM learned helplessness for the rest of the session.
  const jarvisIdx = exchange.indexOf("\nJarvis: ");
  if (jarvisIdx !== -1) {
    const jarvisText = exchange.slice(jarvisIdx + "\nJarvis: ".length).trim();
    if (isPoisonedExchange(jarvisText)) {
      console.log(
        `[router] Blocked poisoned exchange from thread buffer: ${jarvisText.slice(0, 80)}...`,
      );
      return;
    }
  }
  const thread = conversationThreads.get(channel)!;
  thread.push({ text: exchange, imageUrl });
  if (thread.length > THREAD_BUFFER_SIZE) thread.shift();
  // Keys created here that never pass through getThreadTurns (e.g. the
  // background-agent spawn path) would otherwise have no lastAccess entry
  // and never be TTL-evicted.
  threadLastAccess.set(channel, Date.now());
}

/**
 * Detect poisoned exchanges — hallucinated success, system errors, or
 * refusals that teach the LLM learned helplessness if kept in context.
 */
const POISONED_RESPONSE_PATTERNS = [
  // Hallucinated success without tool calls
  /estoy alucinando/i,
  /est[aá]s alucinando/i,
  /narr(?:ando|é) acciones sin ejecutar/i,
  // Lazy acknowledgments — claimed action "in process" without executing.
  // These teach the LLM to plan instead of execute.
  // IMPORTANT: limit .{0,80} span — ✅ followed much later by "en progreso"
  // in a status report (e.g. "10 tareas en progreso") is NOT lazy acknowledgment.
  /✅.{0,80}(?:en proceso|en curso|iniciando|comenzando)\b/i,
  /✅.{0,80}(?:Entendido|Recibido|Confirmado).{0,40}(?:proceso|homolog|reescritura)/i,
  // Mechanical hallucination replacement (from our detector)
  /⚠️ No completé la acción solicitada/i,
  /Herramientas que SÍ llamé/i,
  // System errors
  /🔴 ERROR DE SISTEMA/i,
  /el sistema encontr[oó] un error/i,
  /herramientas? no est[aá](?:n)? respondiendo/i,
  // Tool refusals (LLM claims it can't use available tools)
  /no tengo (?:acceso|(?:la|una|ninguna)\s+herramienta|herramienta)/i,
  /no tengo disponible/i,
  /no tengo.*(?:wp_|gmail_|gsheets_)/i,
  /no tengo.*wp_publish/i,
  /no pude completar la acci[oó]n/i,
  /no (?:puedo|es posible) (?:renombrar|cambiar el nombre|actualizar el nombre)/i,
  /necesitas? hacer.{0,20}(?:manualmente|desde la interfaz)/i,
  // Learned helplessness — LLM gives up or reports inability to continue.
  // Require sentence-start position (^|\n|[.!?]\s+) to avoid matching
  // inside capability reports ("No puedo hacer búsquedas" as status vs refusal).
  /(?:^|[\n.!?]\s*)no puedo (?:continuar|completar|ejecutar)\b/im,
  // Anchored to sentence-start too (2026-06-17 FP fix). An external description
  // ("...el broker ejecutó el stop como buy stop por error de configuración —
  // ya lo corregiste") is a legitimate status report, NOT Jarvis self-excusing.
  // Only a sentence-initial claim is the learned-helplessness signal; the
  // unanchored forms stripped a real vision-analysis answer from the thread,
  // which read as the assistant "forgetting" its own prior reply.
  // ACCEPTED TRADEOFF (qa W1): a genuine self-error phrased mid-clause ("Hubo un
  // error de configuración con Gmail, no pude enviar") is NOT caught here and
  // has NO sibling net — unlike the don't-ask class below. We accept that false
  // negative because over-stripping a real answer is worse than leaving one
  // self-excuse in the buffer; the durable fix for self-excuses is the persona,
  // not this regex.
  /(?:^|[\n.!?]\s*)problema t[eé]cnico (?:cr[ií]tico|grave)/im,
  /(?:^|[\n.!?]\s*)error de configuraci[oó]n/im,
  // Tool configuration errors (stale from prior session)
  /(?:wordpress|wp).{0,20}not configured/i,
  /falla con.*(?:not configured|no configurad)/i,
  // False capability claims — LLM researches tool docs instead of calling tools
  /(?:API|endpoint|modelo).{0,30}no soporta.{0,30}(?:generaci[oó]n|imagen|image)/i,
  /(?:API|endpoint|model).{0,30}(?:doesn.t|does not|cannot).{0,30}(?:generat|image|support.*image)/i,
  /requiere.{0,20}(?:Vertex AI|billing|configuraci[oó]n diferente)/i,
  // Inference cascade failures
  /inference.*failed/i,
  /timeout.*inference/i,
  // Narrated update claim — LLM claims to have updated NorthStar without tools.
  // NOTE: "Acciones Ejecutadas" removed from here — it's a legitimate header
  // when tools actually ran. The hallucination guard (fast-runner Layer 2)
  // handles it with tool-call context; the poison filter cannot distinguish.
  /acabo de actualizar\s+NorthStar/i,
  // Confabulated permission-block refusals (2026-06-16). gmail_send and MCP
  // tools (e.g. mcp__supabase__query) are in scope AND auto-approved under the
  // SDK's permissionMode:"dontAsk" — yet the LLM sometimes invents a "blocked
  // by don't-ask policy" gate and refuses instead of calling the available
  // tool. Left in the thread buffer the excuse reinforces (the LLM reads its
  // own prior refusal and repeats it → the "recurring" symptom). Strip it.
  // The real fix is the persona (confirmationSection + "solo usa herramientas
  // disponibles"); this is the belt-and-suspenders so a stray one can't recur.
  // Patterns are anchored on the confabulation's distinguishing signature —
  // the FALSE "blocked by a session/policy/don't-ask permission gate" framing —
  // NOT on a bare "X está bloqueado", which legitimately reports a real external
  // block (rate-limit, Cloudflare, provider lockout) we must NOT strip.
  // The confabulation always frames it as a "don't ask MODE/policy" gate, never
  // a bare phrase. Require the mode/modo signature so an incidental English
  // "don't ask" in legitimate prose ("you said don't ask, so I just did it")
  // can't strip a real answer (2026-06-17 FP fix; the bare /\bdon.?t ask\b/
  // form was over-broad). A real don't-ask refusal also carries a
  // `bloqueado … don't ask` clause (next pattern) or `no tengo acceso`, so the
  // don't-ask class stays caught even if this signature drifts. NOTE: that
  // sibling net is specific to the don't-ask class — it does NOT backstop the
  // sentence-anchored self-error patterns above.
  /(?:modo\s*['"]?\s*don.?t[\s-]?ask|don.?t[\s-]?ask[\s'"-]*mode)/i,
  /\bbloquead[oa]s?\b[^.\n]{0,40}(?:en esta sesi[oó]n|por la pol[ií]tica|don.?t[\s-]?ask)/i,
  /requiere\s+(?:permiso|autorizaci[oó]n|confirmaci[oó]n)\s+(?:del|de)\s+sistema/i,
];

export function isPoisonedExchange(jarvisResponse: string): boolean {
  return POISONED_RESPONSE_PATTERNS.some((p) => p.test(jarvisResponse));
}

/**
 * Parse stored exchanges ("User: ...\nJarvis: ...") into structured turns.
 * Returns ConversationTurn[] for injection as proper message turns in inference.
 *
 * Filters out poisoned exchanges (hallucinated success, system errors, refusals)
 * that would teach the LLM to repeat failures or refuse to use tools.
 */
function getThreadTurns(channel: string): ConversationTurn[] {
  hydrateThreadIfNeeded(channel);

  // Track access + periodic TTL eviction (every 100 accesses)
  threadLastAccess.set(channel, Date.now());
  if (++threadAccessCount % 100 === 0) {
    const now = Date.now();
    for (const [ch, lastAccess] of threadLastAccess) {
      if (now - lastAccess > THREAD_TTL_MS) {
        conversationThreads.delete(ch);
        threadLastAccess.delete(ch);
        hydratedChannels.delete(ch);
        // Same lifecycle as the thread buffer — keys are per-sender for
        // groups/community email, so without eviction every stranger adds
        // permanent entries to a long-lived daemon.
        previousScopeGroups.delete(ch);
        previousMessages.delete(ch);
      }
    }
  }

  const thread = conversationThreads.get(channel);
  if (!thread || thread.length === 0) return [];

  const turns: ConversationTurn[] = [];
  let poisonedCount = 0;
  for (const entry of thread) {
    const jarvisIdx = entry.text.indexOf("\nJarvis: ");
    if (jarvisIdx === -1) continue;

    const userText = entry.text.slice("User: ".length, jarvisIdx).trim();
    const assistantText = entry.text
      .slice(jarvisIdx + "\nJarvis: ".length)
      .trim();

    // Poisoned exchanges: keep the user message (it carries valid scope
    // keywords for follow-up inheritance) but drop the assistant response
    // (it teaches learned helplessness / hallucinated success).
    if (isPoisonedExchange(assistantText)) {
      poisonedCount++;
      if (userText) {
        turns.push({
          role: "user",
          content: userText,
          ...(entry.imageUrl && { imageUrl: entry.imageUrl }),
        });
      }
      continue;
    }

    if (userText)
      turns.push({
        role: "user",
        content: userText,
        ...(entry.imageUrl && { imageUrl: entry.imageUrl }),
      });
    if (assistantText)
      turns.push({ role: "assistant", content: assistantText });
  }
  if (poisonedCount > 0) {
    console.log(
      `[router] Stripped ${poisonedCount} poisoned exchange(s) from thread (hallucinations/errors/refusals)`,
    );
  }
  return turns;
}

/**
 * On first access per channel, hydrate the thread buffer from SQLite conversations.
 * This ensures conversation continuity survives process restarts.
 */
function hydrateThreadIfNeeded(tk: string): void {
  if (hydratedChannels.has(tk)) return;
  hydratedChannels.add(tk);

  // Extract the channel tag used to tag conversations for this thread.
  // Compound keys: "whatsapp:group@g.us:sender@s.whatsapp.net" → "whatsapp"
  // Simple keys: "telegram" → "telegram"
  // Email is the exception: each mailbox is its own `email:<id>` channel and
  // conversations are tagged with that full name, so the hydration query must
  // use the whole key — splitting on ":" would collapse all mailboxes to one.
  // Routed through the shared isEmailChannel() predicate so every "is this
  // email" check in the router stays consistent.
  const baseChannel = isEmailChannel(tk) ? tk : tk.split(":")[0];

  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT content FROM conversations
         WHERE bank = 'mc-jarvis'
         AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(baseChannel, THREAD_BUFFER_SIZE) as { content: string }[];

    if (rows.length > 0) {
      // Reverse to chronological order (query returns newest-first)
      // Images don't survive restarts (base64 not stored in DB) — text only
      const thread: ThreadEntry[] = rows
        .reverse()
        .map((r) => ({ text: r.content }));
      conversationThreads.set(tk, thread);
    } else {
      conversationThreads.set(tk, []);
    }
  } catch {
    conversationThreads.set(tk, []);
  }
}

// ---------------------------------------------------------------------------
// Day log — mechanical append of every user + Jarvis exchange to jarvis_files DB.
// No LLM involvement, no scheduled task — direct DB write on every message.
// Writes to jarvis_files table (where jarvis_file_read reads from) + disk mirror.
// ---------------------------------------------------------------------------

/** Format a human-readable confirmation result based on tool name. */
function formatConfirmationResult(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string {
  switch (toolName) {
    case "gmail_send":
      return `✅ Correo enviado a ${args.to ?? "destinatario"}.\nAsunto: ${args.subject ?? "(sin asunto)"}`;
    case "calendar_create":
    case "calendar_update":
      return `✅ Evento ${toolName === "calendar_create" ? "creado" : "actualizado"}: ${args.title ?? args.summary ?? "evento"}`;
    case "gdrive_delete":
      return `✅ Archivo eliminado de Drive.`;
    case "gdrive_move":
      return `✅ Archivo movido en Drive.`;
    case "gdrive_share":
      return `✅ Archivo compartido${args.email ? ` con ${args.email}` : ""}.`;
    case "wp_publish":
      return `✅ Publicado en WordPress: ${(result as Record<string, unknown>).title ?? args.title ?? "post"}`;
    case "wp_delete":
      return `✅ Post eliminado de WordPress.`;
    case "file_delete":
      return `✅ Archivo eliminado: ${args.path ?? ""}`;
    case "jarvis_file_delete":
      return `✅ Archivo eliminado: ${args.path ?? ""}`;
    case "jarvis_files_batch_delete": {
      const ok = (result as { ok?: number }).ok ?? 0;
      const nf = (result as { not_found?: number }).not_found ?? 0;
      const err = (result as { errors?: number }).errors ?? 0;
      const parts = [`✅ ${ok} archivo(s) eliminado(s)`];
      if (nf > 0) parts.push(`${nf} no encontrado(s)`);
      if (err > 0) parts.push(`${err} error(es)`);
      return parts.join("; ") + ".";
    }
    case "jarvis_files_batch_write": {
      const ok = (result as { ok?: number }).ok ?? 0;
      const err = (result as { errors?: number }).errors ?? 0;
      return err > 0
        ? `✅ ${ok} archivo(s) escrito(s); ${err} error(es).`
        : `✅ ${ok} archivo(s) escrito(s).`;
    }
    case "vps_deploy":
      return `✅ Deploy ejecutado.`;
    case "schedule_delete":
      return `✅ Schedule eliminado.`;
    default:
      return `✅ ${toolName} ejecutado correctamente.`;
  }
}

function appendDayLog(role: "USER" | "JARVIS", text: string): void {
  try {
    const now = new Date();
    const date = now.toLocaleDateString("en-CA", {
      timeZone: "America/Mexico_City",
    }); // YYYY-MM-DD
    const time = now.toLocaleTimeString("es-MX", {
      timeZone: "America/Mexico_City",
      hour12: false,
    });

    const path = `logs/day-logs/${date}.md`;
    const entry = `- [${time}] **${role}**: ${safeSlice(text, 500).replace(/\n/g, " ")}\n`;

    // Synchronous read-append-write via jarvis_files DB (atomic per SQLite)
    const existing = getFile(path);
    const content = existing
      ? existing.content + entry
      : `# Day Log: ${date}\n\n${entry}`;

    // Direct DB write — skip pgvector embedding + Drive sync + index regen.
    // Day logs are ephemeral workspace entries; embedding/syncing them is waste.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, priority, related_to, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         content = excluded.content, updated_at = datetime('now')`,
    ).run(
      path,
      path,
      `Day Log: ${date}`,
      content,
      '["day-log"]',
      "workspace",
      90,
      "[]",
    );
    mirrorToDisk(path, content);
  } catch {
    // Non-fatal — never block message processing for logging
  }
}

export class MessageRouter {
  private channels = new Map<ChannelName, ChannelAdapter>();
  private pendingReplies = new Map<string, PendingReply>();
  private subscriptions: Array<{ unsubscribe: () => void }> = [];
  private ritualWatches = new Map<string, string>(); // taskId → ritualId
  private lastMessageTime = 0;

  get channelCount(): number {
    return this.channels.size;
  }

  /** Connection status per channel — for /health endpoint. */
  getChannelStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name, adapter] of this.channels) {
      status[name] = adapter.isConnected();
    }
    return status;
  }

  /** Timestamp of the last inbound message (for proactive throttle). */
  getLastMessageTime(): number {
    return this.lastMessageTime;
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);

    adapter.onMessage((msg) => {
      this.handleInbound(msg).catch((err) => {
        console.error(
          `[router] Failed to handle inbound from ${msg.channel}:`,
          err,
        );
      });
    });
  }

  /**
   * Remove a channel whose start() failed AFTER registerChannel (channels must
   * register before start so the boot-time poll has an onMessage handler).
   * Leaving a dead adapter registered would route broadcasts into a channel
   * that can never deliver.
   */
  unregisterChannel(name: ChannelName): void {
    this.channels.delete(name);
  }

  /** Start listening for task completion/failure events. */
  startEventListeners(): void {
    const bus = getEventBus();

    const completedSub = bus.subscribe(
      "task.completed",
      (event: Event<"task.completed">) => {
        this.handleTaskCompleted(event.data);
      },
    );

    const failedSub = bus.subscribe(
      "task.failed",
      (event: Event<"task.failed">) => {
        this.handleTaskFailed(event.data);
      },
    );

    const cancelledSub = bus.subscribe(
      "task.cancelled",
      (event: Event<"task.cancelled">) => {
        this.handleTaskCancelled(event.data);
      },
    );

    this.subscriptions.push(completedSub, failedSub, cancelledSub);

    // Notify user about tasks killed by service restart.
    // On shutdown, orphaned tasks get status='failed', error='Service shutdown'
    // but the messaging router is already torn down — failure messages never sent.
    // On startup, find recent orphans and send a brief apology so the user knows.
    this.notifyOrphanedTasks();
  }

  /**
   * Find tasks killed by the last service restart and notify the user.
   * Only looks at tasks from the last 10 minutes to avoid spamming on
   * first boot after a long downtime.
   */
  private notifyOrphanedTasks(): void {
    try {
      const db = getDatabase();
      const orphans = db
        .prepare(
          `SELECT task_id, title FROM tasks
           WHERE error = 'Service shutdown'
             AND completed_at > datetime('now', '-10 minutes')
             AND title LIKE 'Chat:%'
           ORDER BY completed_at DESC
           LIMIT 3`,
        )
        .all() as Array<{ task_id: string; title: string }>;

      if (orphans.length === 0) return;

      // Find the most recent channel from thread history
      const defaultChannel: ChannelName = this.channels.has("telegram")
        ? "telegram"
        : "whatsapp";
      const defaultTo = ""; // Will be populated from thread if available

      // Get the sender from thread entries for the first orphan
      const thread = db
        .prepare(`SELECT metadata FROM tasks WHERE task_id = ? LIMIT 1`)
        .get(orphans[0].task_id) as { metadata: string } | undefined;

      let channel: ChannelName = defaultChannel;
      let to = defaultTo;
      try {
        if (thread?.metadata) {
          const meta = JSON.parse(thread.metadata);
          if (meta.channel) channel = meta.channel as ChannelName;
          if (meta.from) to = meta.from;
        }
      } catch {
        /* best effort */
      }

      if (!to) return; // Can't determine recipient — skip silently

      const titles = orphans
        .map((o) => o.title.replace("Chat: ", "").slice(0, 50))
        .join(", ");
      this.sendToChannel(
        channel,
        to,
        `Tuve un reinicio mientras procesaba tu solicitud. Lo que se interrumpió: "${titles}". Puedes repetirlo y lo intento de nuevo.`,
      );
      console.log(
        `[router] Notified user about ${orphans.length} task(s) killed by restart`,
      );
    } catch {
      // Best effort — don't crash startup
    }
  }

  /**
   * V8.1/V8.2 briefing resolution on the operator's reply — fire-and-forget
   * (isOwnerChannel guard inside); never blocks or stops the pipeline.
   */
  private resolveBriefingOnReply(msg: IncomingMessage): void {
    // V8.1 Phase 8: the operator's reply promotes or discards a delivered
    // briefing (spec §10). Owner channels only — a briefing is operator-
    // private. The call is self-contained and never throws, so it cannot
    // disrupt message handling; it is a no-op until a briefing is actually
    // delivered (delivery is flag-gated off until Phase 9 activation).
    //
    // V8.2 §13: when the brief carries judgments, the reply may be a pushback;
    // the handler classifies it, applies the evidence gate, and returns a
    // re-delivery `reply` (held restatement / "updating on your input" update).
    // The per-judgment re-run (`reRunJudgment`) is injected ONLY when the V8.2
    // producer is armed — otherwise no `judgments` rows exist, so
    // countJudgmentsForBriefing === 0 keeps this the pure V8.1 regex path
    // (byte-identical, zero new LLM calls) for all current traffic.
    // Fire-and-forget; the handler swallows its own errors.
    if (isOwnerChannel(msg.channel, this.channels.get(msg.channel)?.mode)) {
      void resolveBriefingOnOperatorReply(
        msg.text,
        isV82ProducerEnabled() ? { reRunJudgment } : {},
      )
        .then((res) => {
          if (res?.reply) this.sendToChannel(msg.channel, msg.from, res.reply);
        })
        .catch(() => {
          /* defense-in-depth: the handler never throws, but guard the chain */
        });
    }
  }

  /** Prompt-enhancer toggle commands (checkToggle). Returns true when a toggle was handled (stop). */
  private interceptEnhancerToggle(msg: IncomingMessage): boolean {
    // Prompt enhancer toggle commands
    const toggleResult = checkToggle(msg.text);
    if (toggleResult !== null) {
      this.sendToChannel(
        msg.channel,
        msg.from,
        `🔍 Prompt enhancer: ${toggleResult ? "ACTIVADO" : "DESACTIVADO"}`,
      );
      return true;
    }
    return false;
  }

  /**
   * Context-clear phrase. Returns true when fully handled (no remainder);
   * false when remainder text was left in msg.text (mutated) for the pipeline.
   */
  private interceptContextClear(msg: IncomingMessage, tk: string): boolean {
    // Context clear: "limpia tu contexto", "clear context", "contexto limpio"
    // Mechanical: purges in-memory thread buffer + strips poisoned DB entries.
    // If the message continues after the phrase, process the rest as a fresh task.
    // Strip WhatsApp group prefix before matching (same pattern as feedback/fast-path)
    const textForClear = msg.text.replace(/^\[Grupo:.*?\]\n?/i, "").trim();
    if (CONTEXT_CLEAR_RE.test(textForClear)) {
      // Set empty thread AND mark as hydrated — prevents re-hydration from DB
      conversationThreads.set(tk, []);
      hydratedChannels.add(tk);
      console.log(
        `[router] Context cleared for ${msg.channel} (thread buffer purged, hydration blocked)`,
      );
      // If there's more text after the clear phrase, process it as a fresh message
      const remainder = textForClear.replace(CONTEXT_CLEAR_RE, "").trim();
      if (remainder.length > 0) {
        msg.text = remainder;
        // Fall through to process the remainder with a clean thread
      } else {
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Contexto limpio. ¿En qué te ayudo?",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Background-agent spawn (BACKGROUND_AGENT_RE). Returns true whenever the
   * trigger matched (spawned, capped, empty task, or errored — all handled).
   */
  private async interceptBackgroundAgentSpawn(
    msg: IncomingMessage,
    tk: string,
  ): Promise<boolean> {
    // Background agents: "lanza un agente", "investiga en background"
    if (BACKGROUND_AGENT_RE.test(msg.text)) {
      try {
        const db = getDatabase();
        const running = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM tasks WHERE spawn_type='user-background' AND status IN ('pending','running','queued')`,
          )
          .get() as { cnt: number };

        if (running.cnt >= 3) {
          this.sendToChannel(
            msg.channel,
            msg.from,
            "⚠�� Ya hay 3 agentes activos. Espera a que terminen o cancela uno con 'cancela agente'.",
          );
          return true;
        }

        // Strip the trigger phrase to get the actual task
        const taskText = msg.text
          .replace(BACKGROUND_AGENT_RE, "")
          .replace(/^[,.:;\s]+/, "")
          .trim();

        if (!taskText) {
          this.sendToChannel(
            msg.channel,
            msg.from,
            "¿Qué quieres que investigue el agente? Ejemplo: 'lanza un agente e investiga el tráfico de livingjoyfully.art'",
          );
          return true;
        }

        const { tools: scopedTools } = scopeToolsForMessage(taskText, []);
        const enrichment = await enrichContext(taskText, msg.channel);
        const mxDate = nowMexDate();
        const mxTime = nowMexTime();
        const spChannel = this.channels.get(msg.channel);
        const { stable: stableSP, variable: variableSP } =
          buildJarvisSystemPrompt(
            scopedTools,
            "",
            enrichment.contextBlock,
            spChannel?.personaContent ?? null,
            isOwnerChannel(msg.channel, spChannel?.mode),
          );

        // Worker isolation (OpenClaude InProcessBackend pattern):
        // - No conversationHistory passed (parent context NOT leaked)
        // - Scoped tools only (no parent tool leakage beyond scope)
        // - 60-min hard timeout on pendingReplies (existing)
        // Time context goes into the task body (which the non-chat fast-runner
        // branch emits as a user message), so the system prompt above stays
        // byte-stable for cache hits.
        // v8 S1: stable + CACHE_BREAK_MARKER + variable lets runners that
        // honor the marker (fast-runner chat path) split for cache stability;
        // others (heavy/nanoclaw/swarm) strip the marker and treat as a blob.
        // Per-call extras (time context, agent boilerplate) attach to the
        // VARIABLE half — they'd bust the cache anyway.
        const result = await submitTask({
          title: `🤖 Agente: ${taskText.slice(0, 50)}`,
          description:
            stableSP +
            CACHE_BREAK_MARKER +
            variableSP +
            `\n\n${timeContextLine(mxDate, mxTime)}\n` +
            `\nTarea del agente (background):\n${taskText}\n\n` +
            BACKGROUND_AGENT_BOILERPLATE,
          agentType: "auto",
          tools: scopedTools,
          spawnType: "user-background",
          tags: ["messaging", msg.channel, "background-agent"],
        });

        const agentNotification = `🤖 Agente lanzado: "${taskText.slice(0, 60)}"\nID: ${result.taskId.slice(0, 8)}\nTe aviso cuando termine. Puedes seguir hablando conmigo.`;
        this.sendToChannel(msg.channel, msg.from, agentNotification);

        // Push to thread so next task knows this was a REAL router action
        // (prevents false hallucination self-diagnosis)
        pushToThread(tk, `User: ${msg.text}\nJarvis: ${agentNotification}`);

        // Track for completion notification
        this.pendingReplies.set(result.taskId, {
          channel: msg.channel,
          to: msg.from,
          originalText: taskText,
          tk,
          interimTimer: setTimeout(() => {}, 0),
          finalTimer: setTimeout(() => {}, 0),
          abandonTimer: setTimeout(() => {
            this.pendingReplies.delete(result.taskId);
          }, 60 * 60_000), // 60 min — background agents can run long
        });

        console.log(
          `[router] Background agent spawned: ${result.taskId} — "${taskText.slice(0, 60)}"`,
        );
        return true;
      } catch (err) {
        console.error("[router] Background agent spawn failed:", err);
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Error lanzando agente. Intenta de nuevo.",
        );
        return true;
      }
    }
    return false;
  }

  /** Background-agent list ("mis agentes"/"agentes"/"agents"). Returns true when handled (stop). */
  private interceptAgentList(msg: IncomingMessage): boolean {
    // Background agent management commands
    const agentMgmtText = msg.text.trim().toLowerCase();
    if (
      agentMgmtText === "mis agentes" ||
      agentMgmtText === "agentes" ||
      agentMgmtText === "agents"
    ) {
      try {
        const db = getDatabase();
        const agents = db
          .prepare(
            `SELECT task_id, title, status, created_at FROM tasks
             WHERE spawn_type='user-background'
             ORDER BY created_at DESC LIMIT 10`,
          )
          .all() as Array<{
          task_id: string;
          title: string;
          status: string;
          created_at: string;
        }>;

        if (agents.length === 0) {
          this.sendToChannel(
            msg.channel,
            msg.from,
            "No hay agentes recientes.",
          );
        } else {
          const lines = ["🤖 **Agentes recientes:**"];
          for (const a of agents) {
            const icon =
              a.status === "running"
                ? "🔄"
                : a.status === "completed"
                  ? "✅"
                  : "❌";
            lines.push(
              `${icon} ${a.title.replace("🤖 Agente: ", "")} — ${a.status} (${a.task_id.slice(0, 8)})`,
            );
          }
          this.sendToChannel(msg.channel, msg.from, lines.join("\n"));
        }
      } catch {
        this.sendToChannel(msg.channel, msg.from, "Error consultando agentes.");
      }
      return true;
    }
    return false;
  }

  /** Background-agent cancel (/^cancela\s+agente/). Returns true when handled (stop). */
  private interceptAgentCancel(msg: IncomingMessage): boolean {
    const agentMgmtText = msg.text.trim().toLowerCase();
    if (/^cancela\s+agente/i.test(agentMgmtText)) {
      try {
        const db = getDatabase();
        // Cancel the most recent running background agent
        const agent = db
          .prepare(
            `SELECT task_id, title FROM tasks
             WHERE spawn_type='user-background' AND status IN ('running','pending','queued')
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get() as { task_id: string; title: string } | undefined;

        if (!agent) {
          this.sendToChannel(
            msg.channel,
            msg.from,
            "No hay agentes activos para cancelar.",
          );
        } else {
          cancelTask(agent.task_id);
          this.pendingReplies.delete(agent.task_id);
          this.sendToChannel(
            msg.channel,
            msg.from,
            `🛑 Agente cancelado: ${agent.title.replace("🤖 Agente: ", "")}`,
          );
        }
      } catch {
        this.sendToChannel(msg.channel, msg.from, "Error cancelando agente.");
      }
      return true;
    }
    return false;
  }

  /** Task-cancel intent (CANCEL_INTENT_RE) — aborts the active task for this channel. Returns true when handled (stop). */
  private interceptTaskCancel(msg: IncomingMessage, tk: string): boolean {
    // --- v6.2 S2: Task cancellation from Telegram ---
    // Detect cancel intent: "cancela", "detente", "para", "stop", "cancel"
    // Aborts the running task for this channel, extracts partial result, notifies user.
    if (CANCEL_INTENT_RE.test(msg.text.trim())) {
      // Find the active pending reply for this channel
      let cancelledTaskId: string | null = null;
      for (const [taskId, pending] of this.pendingReplies.entries()) {
        if (pending.channel === msg.channel) {
          // Abort the running inference loop
          if (pending.abortController) {
            pending.abortController.abort();
          }
          // Cancel in the DB (cascades to subtasks)
          cancelTask(taskId);
          // Clean up timers
          clearTimeout(pending.interimTimer);
          clearTimeout(pending.finalTimer);
          clearTimeout(pending.abandonTimer);
          // Stop streaming if active
          if (pending.streamController) {
            pending.streamController
              .finalize("🛑 Tarea cancelada.")
              .catch(() => {});
          }
          this.pendingReplies.delete(taskId);
          cancelledTaskId = taskId;
          break;
        }
      }

      if (cancelledTaskId) {
        this.sendToChannel(
          msg.channel,
          msg.from,
          `🛑 Tarea cancelada (${cancelledTaskId.slice(0, 8)}). ¿En qué más te ayudo?`,
        );
        pushToThread(tk, `User: ${msg.text}\nJarvis: Tarea cancelada.`);
      } else {
        this.sendToChannel(
          msg.channel,
          msg.from,
          "No hay tarea activa para cancelar.",
        );
      }
      return true;
    }
    return false;
  }

  /**
   * Prompt enhancer — waiting-for-answers branch + shouldEnhance branch.
   * Returns true when SPLIT/ASK was sent (stop); false on answer-built,
   * SKIP, ASSUME and PASS paths (msg.text may be mutated) — pipeline continues.
   */
  private async interceptEnhancer(
    msg: IncomingMessage,
    tk: string,
  ): Promise<boolean> {
    // Prompt enhancer: if waiting for answers, build enhanced prompt or skip
    if (isWaitingForAnswers(msg.channel)) {
      const original = getOriginalMessage(msg.channel)!;
      const questions = getQuestions(msg.channel);
      clearEnhancerState(msg.channel);

      // Skip enhancer if user says "skip", "hazlo", "procede", "sin preguntas"
      // or sends a short dismissal — just pass the original through
      if (SKIP_ENHANCER_RE.test(msg.text.trim())) {
        console.log("[enhancer] User skipped questions. Passing original.");
        this.sendToChannel(msg.channel, msg.from, "🔍 Procesando...");
        msg.text = original;
      } else {
        // Build enhanced prompt from user's answers/clarification
        const threadTurns = getThreadTurns(tk);
        const builderContext = threadTurns
          .slice(-4)
          .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
          .join("\n");

        console.log(
          `[enhancer] Building enhanced prompt from answers: "${msg.text.slice(0, 60)}"`,
        );
        const enhanced = await buildEnhancedPrompt(
          original,
          questions,
          msg.text,
          builderContext,
        );
        console.log(`[enhancer] Enhanced: "${enhanced.slice(0, 100)}"`);

        this.sendToChannel(msg.channel, msg.from, "🔍 Procesando...");
        msg.text = enhanced;
      }
    }
    // Prompt enhancer: check if new message needs enhancement
    else if (!msg.imageUrl && shouldEnhance(msg.text)) {
      const threadTurns = getThreadTurns(tk);
      const recentContext = threadTurns
        .slice(-4)
        .map((t) => `${t.role}: ${t.content.slice(0, 200)}`)
        .join("\n");

      console.log(`[enhancer] Analyzing: "${msg.text.slice(0, 60)}"`);
      const analysis = await analyzePrompt(msg.text, recentContext);

      // Branch order is load-bearing: prefix-typed markers (ASSUME:, SPLIT:)
      // MUST be checked before the generic non-PASS ASK branch — otherwise
      // SPLIT plans silently regress to the `🔍 Antes de proceder:` ASK
      // framing. See audit W5 (prompt-enhancer-leakage bundle).
      if (analysis.startsWith("ASSUME:")) {
        // v6.4 CL1.3: Show assumption to user, then proceed without blocking.
        const assumption = analysis.slice(7);
        this.sendToChannel(msg.channel, msg.from, `💡 ${assumption}`);
        console.log(
          "[enhancer] ASSUME — proceeding with stated interpretation",
        );
      } else if (analysis.startsWith("SPLIT:")) {
        // RC2: SPLIT path — proposal to chunk a too-big task. Frame as a
        // plan suggestion, not a clarifying question. Wait for the user
        // to confirm the proposed decomposition (or correct it).
        const plan = analysis.slice("SPLIT:".length);
        setWaiting(msg.channel, msg.text, plan);
        this.sendToChannel(
          msg.channel,
          msg.from,
          `📋 Plan sugerido:\n\n${plan}\n\n¿Procedemos así, o prefieres otro orden?`,
        );
        console.log(
          "[enhancer] SPLIT — proposing decomposition, awaiting confirmation",
        );
        return true;
      } else if (analysis !== "PASS") {
        // ASK path — actual clarifying questions
        setWaiting(msg.channel, msg.text, analysis);
        this.sendToChannel(
          msg.channel,
          msg.from,
          `🔍 Antes de proceder:\n\n${analysis}`,
        );
        // RC4: count actual numbered questions, not raw newlines. The old
        // counter overcounted (counted blank lines, wrap artifacts, etc.)
        // which masked RC1 in observability — "Asking 27 questions" was
        // really "raw LLM blob with 27 newlines" not "27 questions".
        const qCount = analysis
          .split("\n")
          .filter((l) => /^\s*\d+[\.\)]\s/.test(l)).length;
        console.log(`[enhancer] Asking ${qCount} question(s)`);
        return true;
      } else {
        console.log("[enhancer] PASS — message is clear enough");
      }
    }
    return false;
  }

  /**
   * Pending high-risk tool confirmation. Returns true on confirm/decline
   * (handled); false when nothing pending or response unclear (stale cleared).
   */
  private async interceptPendingConfirmation(
    msg: IncomingMessage,
    tk: string,
  ): Promise<boolean> {
    // Pending confirmation check — user confirms/declines a high-risk tool operation.
    // Must be before feedback/fast-path/full pipeline — this is a direct tool execution.
    const pendingConf = getPendingConfirmation(tk);
    if (pendingConf) {
      // Destructive ops require stricter matching — a broad action verb
      // ("dale", "súbelo") in incidental utterances must NOT accidentally
      // confirm an irreversible operation. F5 carve-out per v7.6 audit.
      const pendingTool = toolRegistry.get(pendingConf.toolName);
      const isDestructive = pendingTool?.destructiveHint === true;
      const confResponse = detectConfirmationResponse(msg.text, {
        strict: isDestructive,
      });
      if (confResponse === "confirm") {
        console.log(
          `[router] Confirmation accepted: ${pendingConf.toolName} — executing directly`,
        );
        clearPendingConfirmation(tk);
        try {
          // Tools with handler-level precious-path / precious-target re-checks
          // (jarvis_file_delete, jarvis_files_batch_delete, etc.) ALSO read a
          // `confirmed: true` arg to skip the secondary scan. The router has
          // already validated operator intent via the conversation flow, so we
          // inject the flag here. Tools that don't have a `confirmed` param
          // simply ignore the extra arg (no schema-level rejection on extras).
          // Without this, a precious-path delete loops: tool returns
          // CONFIRMATION_REQUIRED → router formats as "Error: ..." → operator
          // never gets the actual deletion. Queue #17 audit W2 (2026-05-15).
          // V8.3 L1-L2: route operator-confirmed gated capabilities through the
          // decision ledger (dormant/passthrough unless V83_ENABLED + canary).
          const result = await executeGatedCapability(
            pendingConf.toolName,
            { ...pendingConf.args, confirmed: true },
            { threadId: tk },
          );
          // Format result for user — human-readable confirmation
          let userResponse: string;
          try {
            const parsed = JSON.parse(result);
            if (parsed.error) {
              userResponse = `Error: ${parsed.error}`;
            } else {
              userResponse = formatConfirmationResult(
                pendingConf.toolName,
                pendingConf.args,
                parsed,
              );
            }
          } catch {
            userResponse = `✅ ${pendingConf.toolName} ejecutado.`;
          }
          this.sendToChannel(msg.channel, msg.from, userResponse);
          // USER line already day-logged at the top of handleInbound.
          appendDayLog("JARVIS", userResponse);
          pushToThread(tk, `User: ${msg.text}\nJarvis: ${userResponse}`);
        } catch (err) {
          const errText = `Error ejecutando ${pendingConf.toolName}: ${errMsg(err)}`;
          this.sendToChannel(msg.channel, msg.from, errText);
        }
        return true;
      } else if (confResponse === "decline") {
        console.log(`[router] Confirmation declined: ${pendingConf.toolName}`);
        clearPendingConfirmation(tk);
        this.sendToChannel(msg.channel, msg.from, "Cancelado.");
        // USER line already day-logged at the top of handleInbound.
        appendDayLog("JARVIS", "Cancelado.");
        return true;
      }
      // Not a clear confirm/decline — clear stale pending and process normally
      clearPendingConfirmation(tk);
    }
    return false;
  }

  /**
   * checkFeedbackWindow block — records explicit feedback signals. Side-effect
   * only (always falls through). Returns the destructively-consumed
   * feedbackTaskId for submitInboundTask's implicit-feedback block.
   */
  private recordFeedbackWindowSignal(
    msg: IncomingMessage,
    tk: string,
  ): string | null {
    // Check if this message is feedback for a recently completed task
    const feedbackTaskId = checkFeedbackWindow(msg.channel);
    if (feedbackTaskId) {
      const signal = detectFeedbackSignal(msg.text, previousMessages.get(tk));
      if (signal !== "neutral") {
        recordTaskFeedback(feedbackTaskId, signal);
        try {
          linkFeedbackToScope(feedbackTaskId, signal);
        } catch {
          /* non-fatal */
        }
        // v6.4 H1: When user rephrases, extract what changed and persist
        // as a correction so the enrichment pipeline recalls it on future
        // similar messages. Builds a "when Fede says X, he means Y" dictionary.
        if (signal === "rephrase") {
          const prevMsg = previousMessages.get(tk);
          if (prevMsg) {
            extractAndPersistCorrection(prevMsg, msg.text).catch(() => {});
          }
        }
      }
    }
    return feedbackTaskId;
  }

  /** Pure feedback ("excelente", "gracias", "no") — ack without spawning a task. Returns true when intercepted (stop). */
  private interceptPureFeedback(msg: IncomingMessage, tk: string): boolean {
    // Pure feedback ("excelente", "gracias", "perfecto", "no") → ack and skip task creation.
    // Runs UNCONDITIONALLY — even without a feedback window, these messages
    // should never spawn a 21K-token task. Record the signal so Jarvis knows.
    if (isFeedbackMessage(msg.text)) {
      const signal = detectFeedbackSignal(msg.text, previousMessages.get(tk));
      // Note: recordTaskFeedback already called in feedbackWindow block above
      // when feedbackTaskId is available — no duplicate recording needed here.
      // Persist positive feedback to memory so Jarvis learns what works
      if (signal === "positive") {
        this.sendToChannel(msg.channel, msg.from, "👍");
        getMemoryService()
          .retain(
            `User: ${msg.text}\nJarvis: [positive feedback acknowledged]`,
            {
              bank: "mc-jarvis",
              tags: [msg.channel, "feedback", "positive"],
              async: true,
              trustTier: 2,
              source: "router",
            },
          )
          .catch(() => {});
      } else if (signal === "negative") {
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Entendido, lo tendré en cuenta. ¿Puedes darme más detalle?",
        );
      }
      console.log(
        `[router] Feedback intercepted from ${msg.channel}: ${signal}`,
      );
      return true;
    }
    return false;
  }

  /**
   * Conversational fast-path (direct LLM, no tools). Returns true when
   * answered; false when not applicable or on error (falls through to full pipeline).
   */
  private async interceptConversationalFastPath(
    msg: IncomingMessage,
    tk: string,
  ): Promise<boolean> {
    // Fast-path: simple conversational messages → direct LLM, no tools, ~2s
    if (!msg.imageUrl && isConversationalFastPath(msg.text)) {
      try {
        console.log(
          `[router] Fast-path: "${msg.text.slice(0, 40)}" → direct LLM`,
        );
        const threadTurns = getThreadTurns(tk);
        const response = await fastPathRespond(msg.text, threadTurns);

        this.sendToChannel(msg.channel, msg.from, response);
        appendDayLog("JARVIS", response);

        const cappedResponse =
          response.length > THREAD_RESPONSE_CAP
            ? safeSlice(response, THREAD_RESPONSE_CAP) + "..."
            : response;
        pushToThread(tk, `User: ${msg.text}\nJarvis: ${cappedResponse}`);

        try {
          const exchange = `User: ${msg.text}\nJarvis: ${response}`;
          getMemoryService()
            .retain(exchange, {
              bank: "mc-jarvis",
              tags: [msg.channel, "conversation", "fast-path"],
              async: true,
              trustTier: 2,
              source: "router",
            })
            .catch(() => {});
        } catch {
          /* non-fatal */
        }

        return true;
      } catch (err) {
        console.error("[router] Fast-path failed, falling through:", err);
        // Fall through to full pipeline
      }
    }
    return false;
  }

  /**
   * Full-pipeline tail: streaming setup, scope classification, system-prompt
   * build, task submission, pending-reply tracking. Always the final step.
   */
  private async submitInboundTask(
    msg: IncomingMessage,
    tk: string,
    feedbackTaskId: string | null,
  ): Promise<void> {
    // Phase 4.1/Phase 3 hoists: the channel adapter and the env-flag reads
    // were each fetched/built multiple times across this tail — resolve once.
    const chan = this.channels.get(msg.channel);
    const envFlags = {
      hasGoogle: !!process.env.GOOGLE_CLIENT_ID,
      hasWordpress: !!process.env.WP_SITES,
      hasMemory: getMemoryService().backend === "hindsight",
      hasCrm: !!process.env.CRM_API_TOKEN,
    };

    // Streaming setup for Telegram — progressive message updates as LLM generates
    let streamController: TelegramStreamController | null = null;
    if (msg.channel === "telegram") {
      const telegramAdapter = chan as
        | (ChannelAdapter & { getBot?(): import("grammy").Bot | null })
        | undefined;
      const bot = telegramAdapter?.getBot?.();
      if (bot) {
        streamController = new TelegramStreamController(bot, msg.from);
        await streamController.sendPlaceholder("⏳").catch(() => {});
      }
    }

    // Fallback ACK for non-Telegram or if streaming setup failed.
    // Email is skipped: it is async by nature, so a separate "working on it"
    // email per message is just inbox noise — the result email is the reply.
    if (!streamController && !isEmailChannel(msg.channel)) {
      this.sendToChannel(
        msg.channel,
        msg.from,
        "Recibido, trabajando en ello...",
      );
    }

    const titleText =
      msg.text.length > 60 ? msg.text.slice(0, 60) + "..." : msg.text;

    // Build structured conversation turns from in-memory thread buffer.
    // The current user message is appended as the final turn so the fast runner
    // can send it as a proper user message rather than embedding it in the description.
    const conversationHistory = getThreadTurns(tk);
    conversationHistory.push({
      role: "user",
      content: msg.text,
      ...(msg.imageUrl && { imageUrl: msg.imageUrl }),
    });

    // v6.4 CL1.5: Normalize input for better matching (typo correction)
    const normalizedText = normalizeForMatching(msg.text);
    if (wasNormalized(msg.text, normalizedText)) {
      console.log(
        `[router] Input normalized: "${msg.text.slice(0, 60)}" → "${normalizedText.slice(0, 60)}"`,
      );
    }

    // v6.4 CL1.1: Semantic scope classification — LLM understands intent,
    // replaces brittle regex matching. 3s timeout, regex fallback on failure.
    const recentContext = conversationHistory
      .slice(-2)
      .map((t) => `${t.role}: ${t.content.slice(0, 150)}`)
      .join("\n");

    // Context enrichment (embedding + recall) and scope classification (LLM
    // call) are independent — neither consumes the other's output. Awaiting
    // them sequentially added the classifier's full latency (up to its 3s
    // timeout) on top of enrichment on EVERY non-fast-path message.
    const [enrichment, semanticGroups] = await Promise.all([
      enrichContext(msg.text, msg.channel),
      classifyScopeGroups(normalizedText, recentContext || undefined),
    ]);

    // User profile facts + projects — always injected so the LLM never forgets context
    let userFactsBlock = "";
    try {
      userFactsBlock = formatUserFactsBlock(msg.text) + formatProjectsBlock();
    } catch {
      // Non-fatal — DB may not have the tables yet
    }

    // Dynamic tool scoping — uses semantic groups if available, regex fallback.
    // Pass normalizedText so regex fallback benefits from typo corrections.
    // Pass prior scope so empty-classifier follow-ups inherit (v8 2026-04-26).
    let { tools, activeGroups } = scopeToolsForMessage(
      normalizedText,
      conversationHistory,
      semanticGroups,
      previousScopeGroups.get(tk),
    );

    // Channel-policy override (FAIL-SAFE). A public-facing email channel must
    // not let stranger-controlled text decide which tools Jarvis can touch.
    // Pure helper in scope.ts so the contract is testable end-to-end. Default-
    // deny: any email channel whose adapter is NOT explicitly owner-only
    // (undefined adapter, undefined mode, or community-manager) gets the
    // restricted allowlist. Owner-only mailboxes and non-email channels pass
    // through unchanged.
    const adapter = chan;
    const override = applyCommunityChannelScopeOverride({
      isEmail: isEmailChannel(msg.channel),
      mode: adapter?.mode,
      baseTools: tools,
      baseActiveGroups: activeGroups,
      envFlags,
    });
    tools = override.tools;
    activeGroups = override.activeGroups;
    if (override.restricted) {
      const modeLabel = adapter?.mode ?? "<undefined>";
      console.log(
        `[router] Channel ${msg.channel} (mode=${modeLabel}) → restricted community scope (${tools.length} tools)`,
      );
    }

    // Implicit feedback: compare current scope groups with previous message's.
    // Uses the feedbackTaskId param threaded from recordFeedbackWindowSignal
    // (checkFeedbackWindow is destructive — consumes the ID on first call, so
    // it can't be called again here).
    const prevGroups = previousScopeGroups.get(tk);
    const prevMsg = previousMessages.get(tk);
    if (prevGroups && prevMsg && feedbackTaskId) {
      const implicitSignal = detectImplicitFeedback(
        new Set(activeGroups),
        prevGroups,
        msg.text,
        prevMsg,
      );
      if (implicitSignal !== "neutral") {
        try {
          linkFeedbackToScope(feedbackTaskId, `implicit_${implicitSignal}`);
        } catch {
          /* non-fatal */
        }
        // Bridge to task_outcomes so the classifier can see implicit signals
        recordTaskFeedback(feedbackTaskId, `implicit_${implicitSignal}`);
        console.log(
          `[router] Implicit feedback for ${feedbackTaskId}: ${implicitSignal}`,
        );
      }
    }
    previousScopeGroups.set(tk, new Set(activeGroups));
    previousMessages.set(tk, msg.text);
    // Inheritance-chain debug trace — without this, when the next turn fails
    // to inherit (DENUE incident 2026-05-06: task #2's empty result blocked
    // task #3's inheritance), there's no journalctl evidence of what was
    // actually stored. Stable per-turn line, ≤120 chars, safe for grep.
    // TODO(2026-06-06): if no scope-inheritance failures are observed in 30d,
    // gate this behind `DEBUG_SCOPE_INHERIT=true` to reduce journald volume.
    console.log(
      `[router] Stored prior scope tk=${tk.slice(-12)}: [${[...activeGroups].join(", ")}]`,
    );

    // Scope telemetry — record decision for self-tuning pipeline
    let scopeRowId = 0;
    try {
      scopeRowId = recordScopeDecision(msg.text, activeGroups, tools);
    } catch {
      // Non-fatal — telemetry should never block the pipeline
    }

    // Current date/time in Mexico City for the LLM
    const mxDate = nowMexDate();
    const mxTime = nowMexTime();

    // Build system prompt with conditional sections based on scoped tools.
    // The system prompt stays byte-stable across calls (no timestamps) so the
    // Anthropic SDK's prompt cache can hit. Time context is injected into the
    // user message below via `timeContextLine()`.
    const spChannel = chan;
    const { stable: stableSP, variable: variableSP } = buildJarvisSystemPrompt(
      tools,
      userFactsBlock,
      enrichment.contextBlock,
      // Per-channel persona — set on email adapters when EMAIL_<ID>_PERSONA_FILE
      // is configured; null elsewhere. The function adds an org-context section
      // to the stable half only when this is non-null.
      spChannel?.personaContent ?? null,
      // Operator-private cohort grounding is gated on owner-channel trust.
      isOwnerChannel(msg.channel, spChannel?.mode),
    );

    // Execution pattern memory: inject relevant past lessons. Patterns vary
    // by message + active scope — they belong in the VARIABLE half.
    const patternBlock = findRelevantPatterns(msg.text, [...activeGroups]);

    // Task continuity: check for a recent checkpoint ONLY on continuation
    // messages. Checkpoint blocks are per-call by definition — VARIABLE half.
    let checkpointBlock = "";
    if (CONTINUATION_RE.test(msg.text.trim())) {
      try {
        const cp = findRecentCheckpoint();
        if (cp) {
          checkpointBlock =
            `\n\n## CONTINUACIÓN DE TAREA ANTERIOR\n` +
            `La tarea anterior (${cp.taskId}) no terminó (${cp.exitReason}, round ${cp.roundsCompleted}/${cp.maxRounds}).\n` +
            `**Lo que ya se hizo:** ${cp.toolsCalled.join(", ") || "nada"}\n` +
            `**Lo que falta:** Completar lo que el usuario pidió originalmente.\n\n` +
            `**Solicitud original:**\n${safeSlice(cp.userMessage, 2000)}\n\n` +
            `**Último resultado parcial:**\n${safeSlice(cp.summary, 500)}\n\n` +
            `INSTRUCCIÓN: Continúa desde donde se quedó. NO repitas lo que ya se hizo. Enfócate en lo pendiente.`;
          console.log(
            `[router] Checkpoint injected for task ${cp.taskId} (${cp.exitReason})`,
          );
          clearCheckpoint(cp.taskId);
        }
      } catch {
        // Non-fatal — checkpoint system is best-effort
      }
    }

    // v8 S1: assemble description with cache-break marker between stable
    // and variable halves. Per-call additions (patternBlock, checkpointBlock)
    // join the variable half — they'd bust the cache anyway.
    const variableTail =
      (patternBlock ? "\n\n" + patternBlock : "") + checkpointBlock;
    const taskDescription =
      stableSP + CACHE_BREAK_MARKER + variableSP + variableTail;

    // Create abort controller for task cancellation (v6.2 S2)
    const taskAbort = new AbortController();

    // Clone history so the downstream task sees the time context prepended to
    // the CURRENT user message only, without mutating the thread-buffer turn
    // that other consumers (scope classifier, feedback tracker) already saw.
    // Prepending to the system prompt would bust the prompt cache every call.
    const historyForRunner: ConversationTurn[] = conversationHistory.map(
      (turn, i) =>
        i === conversationHistory.length - 1 && turn.role === "user"
          ? {
              ...turn,
              content: `${timeContextLine(mxDate, mxTime)}\n\n${turn.content}`,
            }
          : turn,
    );

    const result = await submitTask({
      title: `Chat: ${titleText}`,
      description: taskDescription,
      agentType: "auto",
      tools,
      conversationHistory: historyForRunner,
      tags: [
        "messaging",
        msg.channel,
        ...enrichment.matchedSkillIds.map((id) => `skill:${id}`),
      ],
      onTextChunk: streamController
        ? (chunk: string) => streamController!.appendChunk(chunk)
        : undefined,
      abortController: taskAbort,
    });

    // Link scope telemetry to this task
    if (scopeRowId > 0) {
      try {
        linkScopeToTask(scopeRowId, result.taskId);
      } catch {
        /* non-fatal */
      }
    }

    // Track pending reply
    const interimTimer = setTimeout(() => {
      this.sendToChannel(msg.channel, msg.from, "Sigo trabajando en eso...");
    }, TASK_TIMEOUT_INTERIM_MS);

    const finalTimer = setTimeout(() => {
      const pending = this.pendingReplies.get(result.taskId);
      if (pending) {
        // Send timeout warning but DON'T delete the pending reply.
        // The SDK path can take 5-10 minutes for heavy tasks (gdocs_write,
        // Playwright crawls). Deleting here causes the actual result to be
        // silently dropped when it arrives seconds later.
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Sigo trabajando, esto está tomando más de lo esperado...",
        );
      }
    }, TASK_TIMEOUT_FINAL_MS);

    // Hard abandon: coding tasks get 20min (55 turns × tool calls), others 11min
    const isCodingTask = tools.some((t) =>
      ["file_edit", "git_commit", "gh_create_pr"].includes(t),
    );
    const abandonMs = isCodingTask
      ? TASK_TIMEOUT_ABANDON_CODING_MS
      : TASK_TIMEOUT_ABANDON_MS;
    const abandonTimer = setTimeout(() => {
      const pending = this.pendingReplies.get(result.taskId);
      if (pending) {
        this.pendingReplies.delete(result.taskId);
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Se agotó el tiempo. Puedes intentar de nuevo.",
        );
      }
    }, abandonMs);

    this.pendingReplies.set(result.taskId, {
      channel: msg.channel,
      to: msg.from,
      originalText: msg.text,
      imageUrl: msg.imageUrl,
      scopeGroups: [...activeGroups],
      tk,
      interimTimer,
      finalTimer,
      abandonTimer,
      ...(streamController && { streamController }),
      abortController: taskAbort,
    });

    console.log(
      `[router] Inbound from ${msg.channel} → task ${result.taskId} (${result.agentType})`,
    );
  }

  /** Handle an inbound message from any channel → create task. */
  async handleInbound(msg: IncomingMessage): Promise<void> {
    this.lastMessageTime = Date.now();

    // Day log: record user message (mechanical, no LLM)
    appendDayLog("USER", msg.text);

    this.resolveBriefingOnReply(msg);

    if (this.interceptEnhancerToggle(msg)) return;

    const senderJid = (msg.metadata?.senderJid as string) ?? undefined;
    // Pass the channel adapter's email mode so threadKey can per-sender isolate
    // community-manager mailboxes (each external sender gets their own buffer +
    // scope-inheritance bag). Owner-only email and non-email channels keep the
    // channel-only key (backward-compat with existing persisted conversations).
    const tk = threadKey(
      msg.channel,
      msg.from,
      senderJid,
      this.channels.get(msg.channel)?.mode,
    );

    if (this.interceptContextClear(msg, tk)) return;
    if (await this.interceptBackgroundAgentSpawn(msg, tk)) return;
    if (this.interceptAgentList(msg)) return;
    if (this.interceptAgentCancel(msg)) return;
    if (this.interceptTaskCancel(msg, tk)) return;
    if (await this.interceptEnhancer(msg, tk)) return;
    if (await this.interceptPendingConfirmation(msg, tk)) return;
    const feedbackTaskId = this.recordFeedbackWindowSignal(msg, tk);
    if (this.interceptPureFeedback(msg, tk)) return;
    if (await this.interceptConversationalFastPath(msg, tk)) return;
    await this.submitInboundTask(msg, tk, feedbackTaskId);
  }

  /** Watch a ritual task for completion → broadcast result to all channels. */
  watchRitualTask(taskId: string, ritualId: string): void {
    this.ritualWatches.set(taskId, ritualId);
  }

  /** Broadcast a message to all active channels. */
  /**
   * Broadcast `text` to all non-email channels.
   *
   * Per-channel send failures are swallowed (logged) so a Telegram outage
   * doesn't block a WhatsApp delivery. The optional `onChannelFailure`
   * callback fires for each failure — used by Bundle 3's S3 push counter
   * (R1-C1 fold from v7.7-spine-2-bundle-3 audit): without it, callers
   * couldn't observe per-channel failures because the inner `.catch`
   * resolves before `Promise.all`. The callback must not throw; if it
   * throws, the throw is logged and ignored to keep this method's
   * fire-and-forget contract intact.
   */
  async broadcastToAll(
    text: string,
    onChannelFailure?: (channelName: ChannelName, err: unknown) => void,
  ): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [name, adapter] of this.channels) {
      // Email channels are request/response, not push surfaces — a ritual or
      // proactive broadcast must not email every project mailbox's owner
      // unsolicited (each email:<id> resolves a non-null owner address).
      if (isEmailChannel(name)) continue;
      const to = this.getOwnerAddress(name);
      if (to) {
        promises.push(
          adapter
            .send({ channel: name, to, text })
            .then(() => undefined)
            .catch((err) => {
              console.error(`[router] Broadcast to ${name} failed:`, err);
              if (onChannelFailure) {
                try {
                  onChannelFailure(name, err);
                } catch (cbErr) {
                  console.error(
                    `[router] broadcastToAll onChannelFailure callback threw:`,
                    errMsg(cbErr),
                  );
                }
              }
            }),
        );
      }
    }

    await Promise.all(promises);
  }

  /**
   * V8.1 Phase 8 — deliver an operator-private briefing to every OWNER
   * channel: Telegram, WhatsApp, and owner-only email mailboxes. Unlike
   * `broadcastToAll` (which skips ALL email), owner-only email IS included —
   * the morning brief is an email-primary surface. Community-manager mailboxes
   * are excluded by `isOwnerChannel`: a briefing carries operator-private
   * health/business judgments, same discipline as the cohort-leak fix.
   *
   * Single-operator assumption: every owner-only channel resolves to the SAME
   * operator (Fede). Briefing resolution (`getResolvablePendingBriefing`) is a
   * global singleton — fine for one operator. A multi-operator deployment
   * would need per-operator briefing scoping (Phase 9+ concern).
   *
   * Returns the per-channel send tally so the caller can tell a total send
   * failure from a success — each channel send is error-isolated, so this
   * never rejects.
   */
  async sendBriefingToOwner(
    text: string,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const promises: Promise<void>[] = [];
    for (const [name, adapter] of this.channels) {
      if (!isOwnerChannel(name, adapter.mode)) continue;
      const to = this.getOwnerAddress(name);
      if (!to) continue;
      promises.push(
        adapter
          .send({ channel: name, to, text })
          .then(() => {
            sent++;
          })
          .catch((err) => {
            failed++;
            console.error(`[router] Briefing send to ${name} failed:`, err);
          }),
      );
    }
    await Promise.all(promises);
    return { sent, failed };
  }

  async stopAll(): Promise<void> {
    // Clear feedback windows
    clearAllFeedbackWindows();

    // Clear event subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    // Clear pending timers
    for (const pending of this.pendingReplies.values()) {
      clearTimeout(pending.interimTimer);
      clearTimeout(pending.finalTimer);
      clearTimeout(pending.abandonTimer);
    }
    this.pendingReplies.clear();

    // v7.7 Spine 1 Phase 2b: drain in-flight community-reply gate IIFEs
    // BEFORE stopping adapters. Otherwise a reply finalized in the ~30-100ms
    // before shutdown is silently dropped — sender gets no reply even though
    // the task is marked completed. R1-C1 from the Phase 2b audit.
    if (this.gateInflight.size > 0) {
      console.log(
        `[router] Awaiting ${this.gateInflight.size} in-flight community-reply gate(s) before shutdown...`,
      );
      await Promise.allSettled([...this.gateInflight]);
    }

    // Stop channels
    for (const adapter of this.channels.values()) {
      await adapter.stop();
    }
    this.channels.clear();
  }

  // --------------------------------------------------------------------------
  // Private handlers
  // --------------------------------------------------------------------------

  private handleTaskCompleted(data: TaskCompletedPayload): void {
    const taskId = data.task_id;

    // C2 deeper audit fix (queue #16, 2026-05-07): a runner finishing after
    // the user already cancelled previously emitted task.completed AND
    // overwrote the cancelled status. The dispatcher updateTaskStatus guards
    // now prevent the row flip, but this handler still gets the event. Read
    // fresh status from DB and short-circuit if cancelled — prevents
    // duplicate user-visible messages.
    //
    // Round-2 sweep audit C1 fix: still call trackTaskOutcome on the
    // short-circuit path so telemetry doesn't go missing when status was
    // flipped to 'cancelled' by a path that didn't emit task.cancelled
    // (e.g. direct DB UPDATE, or a future code path). Idempotency caveat:
    // if BOTH task.cancelled AND task.completed fire for the same task,
    // we'll track twice — same as pre-fix behavior. Skip retain to avoid
    // double-writing (handleTaskCancelled already retains).
    try {
      const row = getDatabase()
        .prepare("SELECT status FROM tasks WHERE task_id = ?")
        .get(taskId) as { status: string | null } | undefined;
      if (row?.status === "cancelled") {
        console.log(
          `[router] handleTaskCompleted: task ${taskId} already cancelled — short-circuit`,
        );
        this.ritualWatches.delete(taskId);
        const stale = this.pendingReplies.get(taskId);
        if (stale) {
          clearTimeout(stale.interimTimer);
          clearTimeout(stale.finalTimer);
          clearTimeout(stale.abandonTimer);
          this.pendingReplies.delete(taskId);
          trackTaskOutcome(taskId, 0, false, stale.channel);
        }
        return;
      }
    } catch {
      // DB unavailable — proceed with legacy behavior (the WHERE-guard at
      // dispatcher level still prevents the destructive row flip).
    }

    // Check if it's a ritual task → broadcast
    const ritualId = this.ritualWatches.get(taskId);
    if (ritualId) {
      this.ritualWatches.delete(taskId);
      const resultText = this.extractResultText(data.result);
      if (resultText) {
        this.broadcastToAll(resultText).catch((err) => {
          console.error(`[router] Ritual broadcast failed:`, err);
        });
      }
      // F9 audit C2: close the alert-budget loop for budget-aware rituals.
      // Market-morning-scan + market-eod-scan consume from the daily cap; a
      // runaway loop shuts down next-day retries. Swallow errors so this
      // never breaks delivery above.
      if (
        ritualId === "market-morning-scan" ||
        ritualId === "market-eod-scan"
      ) {
        // Dynamic import avoids a router↔rituals hard dep; rituals depend on
        // the router interface for delivery. `import()` returns a Promise
        // synchronously, so the inner `.catch` handles both import-time and
        // runtime failures.
        import("../rituals/alert-budget.js")
          .then(({ recordRitualTokensForTask }) => {
            recordRitualTokensForTask(ritualId, taskId);
          })
          .catch((err) => {
            console.error(`[router] alert-budget consume failed:`, err);
          });
      }
      return;
    }

    // Check if it's a proactive scan → conditionally broadcast
    if (isProactiveTask(taskId)) {
      const resultText = this.extractResultText(data.result);
      handleProactiveResult(taskId, resultText ?? "");
      return;
    }

    // Check if it's a scheduled task → verify delivery + broadcast
    if (isScheduledTask(taskId)) {
      const resultText = this.extractResultText(data.result);
      // Extract task status and tool calls from the DB for delivery verification
      const task = getDatabase()
        .prepare(
          "SELECT t.status, r.output FROM tasks t LEFT JOIN runs r ON r.task_id = t.task_id WHERE t.task_id = ? ORDER BY r.created_at DESC LIMIT 1",
        )
        .get(taskId) as { status: string; output: string | null } | undefined;
      let toolCalls: string[] | undefined;
      if (task?.output) {
        try {
          const parsed = JSON.parse(task.output);
          toolCalls = parsed.toolCalls;
        } catch {
          /* ignore */
        }
      }
      handleScheduledTaskResult(
        taskId,
        resultText ?? "",
        task?.status,
        toolCalls,
      );
      return;
    }

    // Check if it's a chat reply
    const pending = this.pendingReplies.get(taskId);
    if (!pending) return;

    clearTimeout(pending.interimTimer);
    clearTimeout(pending.finalTimer);
    clearTimeout(pending.abandonTimer);
    this.pendingReplies.delete(taskId);

    const resultText = this.extractResultText(data.result);
    if (resultText) {
      // Background agent notification: different format
      let isBackground = false;
      let bgTitle = "";
      try {
        const task = getDatabase()
          .prepare("SELECT spawn_type, title FROM tasks WHERE task_id = ?")
          .get(taskId) as { spawn_type: string; title: string } | undefined;
        isBackground = task?.spawn_type === "user-background";
        bgTitle = task?.title?.replace("🤖 Agente: ", "") ?? "";
      } catch {
        // DB not available (e.g. in tests) — treat as normal task
      }

      if (isBackground) {
        const summary =
          resultText.length > 500
            ? resultText.slice(0, 500) + "..."
            : resultText;
        const notification = `🤖 **Agente terminó:** ${bgTitle}\n\n${summary}\n\n_Escribe "mis agentes" para ver el historial._`;
        // Background-agent notification IS LLM-derived (summary contains LLM
        // output); route through the gate so community-manager mailboxes get
        // the same write-gate protection as direct LLM replies.
        this.sendLLMReplyToChannel(pending.channel, pending.to, notification);
        appendDayLog(
          "JARVIS",
          `[Agente background] ${notification.slice(0, 200)}`,
        );
      } else {
        appendDayLog("JARVIS", resultText);

        // Finalize streaming message or send fresh
        if (pending.streamController) {
          pending.streamController.finalize(resultText).catch((err) => {
            console.error("[router] Stream finalize failed:", err);
            this.sendLLMReplyToChannel(pending.channel, pending.to, resultText);
          });
        } else {
          this.sendLLMReplyToChannel(pending.channel, pending.to, resultText);
        }
      }

      // Push to in-memory conversation thread (chronological, instant)
      const cappedResult =
        resultText.length > THREAD_RESPONSE_CAP
          ? safeSlice(resultText, THREAD_RESPONSE_CAP) + "..."
          : resultText;
      pushToThread(
        pending.tk,
        `User: ${pending.originalText}\nJarvis: ${cappedResult}`,
        pending.imageUrl,
      );

      // Retain the exchange in conversation memory (works with any backend)
      try {
        const exchange = `User: ${pending.originalText}\nJarvis: ${resultText}`;
        getMemoryService()
          .retain(exchange, {
            bank: "mc-jarvis",
            tags: [pending.channel, "conversation", getOutcomeTag(taskId)],
            async: true,
            trustTier: 2, // inferred — conversation exchange
            source: "router",
          })
          .catch(() => {});
      } catch {
        // Non-fatal
      }

      // Read tool calls once — shared by extractPattern + auto-persist + background extraction
      // (C1 audit fix: hoisted above all consumers to eliminate duplicate DB read)
      let taskToolCalls: string[] = [];
      let taskPendingConfirmation: {
        toolName: string;
        args: Record<string, unknown>;
      } | null = null;
      try {
        const toolRow = getDatabase()
          .prepare(
            "SELECT output FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(taskId) as { output: string | null } | undefined;
        if (toolRow?.output) {
          const parsedOutput = JSON.parse(toolRow.output);
          taskToolCalls = parsedOutput.toolCalls ?? [];
          taskPendingConfirmation = parsedOutput.pendingConfirmation ?? null;
        }
      } catch {
        /* DB or JSON parse failure — proceed with empty tool list */
      }

      // Store pending confirmation for the next user message (pause/resume pattern)
      if (taskPendingConfirmation && pending.tk) {
        const summary = `${taskPendingConfirmation.toolName}(${Object.entries(
          taskPendingConfirmation.args,
        )
          .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
          .join(", ")})`;
        storePendingConfirmation(
          pending.tk,
          taskPendingConfirmation.toolName,
          taskPendingConfirmation.args,
          summary,
        );
        console.log(`[router] Stored pending confirmation: ${summary}`);
      }

      // Execution pattern extraction (async, fire-and-forget)
      try {
        const db = getDatabase();
        const task = db
          .prepare("SELECT title, spawn_type FROM tasks WHERE task_id = ?")
          .get(taskId) as { title: string; spawn_type: string } | undefined;
        if (task && !isBackground && taskToolCalls.length >= 2) {
          extractPattern({
            taskId,
            title: task.title,
            toolsCalled: taskToolCalls,
            scopeGroups: pending.scopeGroups ?? [],
            userMessage: pending.originalText,
            result: resultText.slice(0, 500),
          }).catch(() => {});
        }
      } catch {
        // Non-fatal
      }

      // Safety net: auto-persist critical data the LLM may have ignored
      try {
        ensureCriticalDataPersisted(pending.originalText, taskId);
      } catch {
        // Non-fatal
      }

      // Mechanical auto-persist: store noteworthy exchanges based on heuristics
      try {
        autoPersistConversation({
          userText: pending.originalText,
          responseText: resultText,
          toolCalls: taskToolCalls,
          channel: pending.channel,
          taskId,
        }).catch((err) => {
          console.warn("[router] Auto-persist failed:", errMsg(err));
        });
      } catch {
        // Non-fatal
      }

      // Recall utility instrumentation: claim unmatched recall_audit rows from
      // the last 60s and substring-match snippets against the assistant
      // response. Answers "is recall actually used?" without coupling to the
      // recall caller's context. Fire-and-forget; never blocks delivery.
      try {
        import("../memory/recall-utility.js")
          .then(({ markRecallUtility }) => {
            markRecallUtility({
              taskId,
              responseText: resultText,
            });
          })
          .catch((err) => {
            console.warn("[router] recall-utility match failed:", errMsg(err));
          });
      } catch {
        // Non-fatal — instrumentation must never break delivery
      }

      // v6.2 M0.5: Background memory extraction (fire-and-forget)
      // Extracts 1-3 atomic facts from noteworthy exchanges via LLM,
      // stores in pgvector with embeddings for semantic enrichment.
      // Dynamic import + .then() because handleTaskCompleted is not async.
      try {
        import("../memory/background-extractor.js")
          .then(({ shouldExtract, runBackgroundExtraction }) => {
            if (
              shouldExtract({
                toolCalls: taskToolCalls,
                responseLength: resultText.length,
                spawnType: isBackground ? "user-background" : undefined,
                isRitual: false, // rituals return early above
                isProactive: false, // proactive tasks return early above
              })
            ) {
              runBackgroundExtraction(
                pending.originalText,
                resultText,
                taskToolCalls,
                taskId,
              ).catch((err) => {
                console.warn(
                  "[router] Background extraction failed:",
                  errMsg(err),
                );
              });
            }
          })
          .catch(() => {});
      } catch {
        // Non-fatal — extraction is best-effort
      }

      // v6.2 M3: Crystal → Lesson pipeline (fire-and-forget)
      // Higher bar than M0.5 fact extraction: ≥5 tools AND >30s duration.
      // Extracts lessons (what worked/failed) vs facts (what happened).
      try {
        import("../memory/background-extractor.js")
          .then(({ shouldCrystallize, runCrystallization }) => {
            if (
              shouldCrystallize({
                toolCalls: taskToolCalls,
                durationMs: data.duration_ms,
                spawnType: isBackground ? "user-background" : undefined,
                isRitual: false,
                isProactive: false,
              })
            ) {
              runCrystallization(
                pending.originalText,
                resultText,
                taskToolCalls,
                data.duration_ms,
                taskId,
              ).catch((err) => {
                console.warn("[router] Crystallization failed:", errMsg(err));
              });
            }
          })
          .catch(() => {});
      } catch {
        // Non-fatal
      }

      // Track outcome for adaptive intelligence
      trackTaskOutcome(taskId, data.duration_ms, true, pending.channel);
    }
  }

  private handleTaskFailed(data: TaskFailedPayload): void {
    const taskId = data.task_id;

    // C2 deeper audit fix (queue #16, 2026-05-07): same short-circuit as
    // handleTaskCompleted — if the task was already cancelled, swallow the
    // event so the user doesn't see a duplicate "task failed" message.
    // Round-2 sweep audit C1 fix: telemetry-preserve trackTaskOutcome.
    try {
      const row = getDatabase()
        .prepare("SELECT status FROM tasks WHERE task_id = ?")
        .get(taskId) as { status: string | null } | undefined;
      if (row?.status === "cancelled") {
        console.log(
          `[router] handleTaskFailed: task ${taskId} already cancelled — short-circuit`,
        );
        this.ritualWatches.delete(taskId);
        const stale = this.pendingReplies.get(taskId);
        if (stale) {
          clearTimeout(stale.interimTimer);
          clearTimeout(stale.finalTimer);
          clearTimeout(stale.abandonTimer);
          this.pendingReplies.delete(taskId);
          trackTaskOutcome(taskId, 0, false, stale.channel);
        }
        return;
      }
    } catch {
      // DB unavailable — proceed with legacy behavior
    }

    // Clean up ritual watches. F9 audit W-R2-1: failed budget-aware rituals
    // still consumed tokens — charge the budget before clearing the watch so
    // runaway failure loops eventually trip the daily cap.
    const ritualId = this.ritualWatches.get(taskId);
    this.ritualWatches.delete(taskId);
    if (ritualId === "market-morning-scan" || ritualId === "market-eod-scan") {
      import("../rituals/alert-budget.js")
        .then(({ recordRitualTokensForTask }) => {
          recordRitualTokensForTask(ritualId, taskId);
        })
        .catch((err) => {
          console.error(`[router] alert-budget consume (failed task):`, err);
        });
    }

    // Clean up proactive scan tracking (prevents Set leak)
    if (isProactiveTask(taskId)) {
      handleProactiveFailure(taskId);
    }

    // Alert on scheduled task failures
    if (isScheduledTask(taskId)) {
      handleScheduledTaskFailure(taskId, data.error ?? "Unknown error");
    }

    const pending = this.pendingReplies.get(taskId);
    if (!pending) return;

    clearTimeout(pending.interimTimer);
    clearTimeout(pending.finalTimer);
    clearTimeout(pending.abandonTimer);
    this.pendingReplies.delete(taskId);

    // Background-agent-aware failure notification
    let failMsg =
      "No pude completar eso. Revisa el dashboard para más detalles.";
    try {
      const task = getDatabase()
        .prepare("SELECT spawn_type, title FROM tasks WHERE task_id = ?")
        .get(taskId) as { spawn_type: string; title: string } | undefined;
      if (task?.spawn_type === "user-background") {
        failMsg = `🤖❌ **Agente falló:** ${task.title.replace("🤖 Agente: ", "")}\nError: ${data.error ?? "desconocido"}`;
      }
    } catch {
      // DB not available — use generic message
    }
    this.sendToChannel(pending.channel, pending.to, failMsg);

    // Outcome-aware retain (queue item #7 part 1, 2026-05-07): close the
    // failed-task gap so outcome:failed rows actually populate in
    // conversations. Recall-side bias against negative precedents lands in
    // Part 2 of the same queue item.
    try {
      const errorText = (data.error ?? "Unknown error").slice(0, 500);
      // W8 audit fix: cap user text at 2000 to prevent oversized rows.
      const userText = safeSlice(pending.originalText, 2000);
      const exchange = `User: ${userText}\nJarvis: [Task failed] ${errorText}`;
      getMemoryService()
        .retain(exchange, {
          bank: "mc-jarvis",
          tags: [pending.channel, "conversation", getOutcomeTag(taskId)],
          async: true,
          trustTier: 2,
          source: "router",
        })
        .catch(() => {});
    } catch {
      // Non-fatal — instrumentation must never break the failure-notification path
    }

    // Track failed outcome
    trackTaskOutcome(taskId, 0, false, pending.channel);
  }

  private handleTaskCancelled(data: TaskCancelledPayload): void {
    const taskId = data.task_id;

    // Clean up ritual watches mirror handleTaskFailed — cancelled rituals
    // shouldn't keep their watch alive.
    this.ritualWatches.delete(taskId);

    if (isProactiveTask(taskId)) {
      handleProactiveFailure(taskId);
    }

    const pending = this.pendingReplies.get(taskId);
    if (!pending) return;

    clearTimeout(pending.interimTimer);
    clearTimeout(pending.finalTimer);
    clearTimeout(pending.abandonTimer);
    this.pendingReplies.delete(taskId);

    // W2 audit fix (queue #16, 2026-05-07): non-user cancellations are
    // typically cascades (parent timeout, dependency failure) — send a
    // tailored message so the operator isn't left wondering why their
    // request went silent. User-initiated cancels (e.g. /cancel command)
    // already produced their own UX so we stay quiet there.
    if (data.cancelled_by && data.cancelled_by !== "user") {
      const cancelMsg = `Tarea cancelada (${data.reason ?? data.cancelled_by}).`;
      this.sendToChannel(pending.channel, pending.to, cancelMsg);
    }

    // Outcome-aware retain (queue item #7 part 1, 2026-05-07): cancelled tasks
    // map to outcome:failed via statusToOutcomeTag. We retain the user prompt
    // so a future similar query can be ranked against this negative precedent.
    try {
      const reason = (data.reason ?? "cancelled").slice(0, 500);
      const userText = safeSlice(pending.originalText, 2000); // W8 audit fix
      const exchange = `User: ${userText}\nJarvis: [Task cancelled by ${data.cancelled_by}] ${reason}`;
      getMemoryService()
        .retain(exchange, {
          bank: "mc-jarvis",
          tags: [pending.channel, "conversation", getOutcomeTag(taskId)],
          async: true,
          trustTier: 2,
          source: "router",
        })
        .catch(() => {});
    } catch {
      // Non-fatal
    }

    trackTaskOutcome(taskId, 0, false, pending.channel);
  }

  /**
   * Direct sync send. Use for router-generated text (status notifications,
   * orphan-restart messages, etc.) that is safe-by-construction and does NOT
   * need the community-reply write-gate. LLM-generated replies MUST flow
   * through `sendLLMReplyToChannel` instead so the Phase 2b critic gate fires.
   */
  private sendToChannel(channel: ChannelName, to: string, text: string): void {
    const adapter = this.channels.get(channel);
    if (!adapter) return;

    // v6.3 W1.5: log AI writing patterns before delivery (detect-only, no modification)
    import("./post-filter.js")
      .then(({ logAIPatterns }) => logAIPatterns(text, channel))
      .catch(() => {});

    const msg: OutgoingMessage = { channel, to, text };
    adapter.send(msg).catch((err) => {
      console.error(`[router] Send to ${channel} failed:`, err);
    });
  }

  /**
   * In-flight gate IIFEs from community-manager email channels (v7.7 Spine 1
   * Phase 2b). `stopAll()` MUST await Promise.allSettled([...this.gateInflight])
   * before stopping adapters; otherwise a community reply finalized in the
   * ~30-100ms before shutdown would be silently dropped (sender gets no reply,
   * task already marked completed). R1-C1 from the Phase 2b audit.
   */
  private gateInflight: Set<Promise<unknown>> = new Set();

  /**
   * Send an LLM-produced reply text. For email channels NOT in `owner-only`
   * mode (i.e. community-manager mailboxes facing the public), runs the
   * v7.7 Spine 1 Phase 2b critic write-gate before sending — on fail or
   * critic infra error, replaces the reply with COMMUNITY_REPLY_FALLBACK.
   * For all other channels, behaves identically to sendToChannel.
   *
   * Sync signature (callers fire-and-forget). The actual gate+send happens
   * on the microtask queue via an IIFE tracked in `this.gateInflight` so
   * shutdown can await pending sends.
   */
  private sendLLMReplyToChannel(
    channel: ChannelName,
    to: string,
    text: string,
  ): void {
    const adapter = this.channels.get(channel);
    if (!adapter) return;

    // v6.3 W1.5: log AI writing patterns on the ORIGINAL text, before any
    // gate substitution, so observability captures what the LLM produced.
    import("./post-filter.js")
      .then(({ logAIPatterns }) => logAIPatterns(text, channel))
      .catch(() => {});

    // Positive default-deny: any email channel that is NOT explicitly
    // owner-only gets the gate. Matches applyCommunityChannelScopeOverride's
    // fail-safe semantic (scope.ts:479): undefined mode on an email channel
    // is treated as community-manager. R1-W2 from the Phase 2b audit.
    const needsGate = isEmailChannel(channel) && adapter.mode !== "owner-only";
    if (!needsGate) {
      adapter
        .send({ channel, to, text })
        .catch((err) =>
          console.error(`[router] Send to ${channel} failed:`, err),
        );
      return;
    }

    const inflight = (async () => {
      let outbound = text;
      let verdictBucket: "pass" | "fail" | "error" = "error";
      try {
        const verdict = await gateCommunityReply(text);
        if (verdict.error) {
          verdictBucket = "error";
          console.warn(
            `[router] community-reply gate ERROR for ${channel}→${to} (${verdict.latencyMs}ms): ${verdict.critique.slice(0, 200)}`,
          );
          outbound = COMMUNITY_REPLY_FALLBACK;
        } else if (verdict.verdict !== "pass") {
          verdictBucket = "fail";
          console.warn(
            `[router] community-reply gate FAIL for ${channel}→${to} (${verdict.latencyMs}ms): ${verdict.critique.slice(0, 200)}`,
          );
          outbound = COMMUNITY_REPLY_FALLBACK;
        } else {
          verdictBucket = "pass";
          console.log(
            `[router] community-reply gate PASS for ${channel}→${to} (${verdict.latencyMs}ms)`,
          );
        }
      } catch (err) {
        verdictBucket = "error";
        console.error(
          `[router] community-reply gate threw, using fallback:`,
          err,
        );
        outbound = COMMUNITY_REPLY_FALLBACK;
      }
      try {
        const { recordCommunityGateVerdict } =
          await import("../observability/prometheus.js");
        recordCommunityGateVerdict(verdictBucket);
      } catch {
        /* metric registration shouldn't block delivery */
      }
      try {
        await adapter.send({ channel, to, text: outbound });
      } catch (err) {
        console.error(`[router] Send to ${channel} failed:`, err);
      }
    })();

    this.gateInflight.add(inflight);
    inflight.finally(() => this.gateInflight.delete(inflight));
  }

  private extractResultText(result: unknown): string | null {
    let text: string | null = null;

    if (typeof result === "string") {
      // Try to parse JSON strings that wrap a { text } object (fast-runner output)
      if (result.startsWith("{")) {
        try {
          const parsed = JSON.parse(result);
          if (typeof parsed.text === "string") {
            text = parsed.text;
          }
        } catch {
          // Not JSON — return as-is
        }
      }
      if (text === null) text = result;
    } else if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (typeof obj.text === "string") text = obj.text;
      else if (typeof obj.output === "string") text = obj.output;
      else if (typeof obj.result === "string") text = obj.result;
      else if (typeof obj.content === "string") text = obj.content;
      else text = JSON.stringify(result);
    }

    // Strip CJK characters that leak from Qwen model responses
    if (text) {
      text = text
        .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g, "")
        .trim();
    }

    return text || null;
  }

  private getOwnerAddress(channel: ChannelName): string | null {
    // Adapters that own their owner mapping (email accounts each carry one)
    // win over the env-var lookup — there is no single EMAIL_OWNER_ADDRESS
    // once mailboxes are per-account.
    const adapter = this.channels.get(channel);
    if (adapter?.ownerAddress) return adapter.ownerAddress;
    if (channel === "whatsapp") return process.env.WHATSAPP_OWNER_JID ?? null;
    if (channel === "telegram")
      return process.env.TELEGRAM_OWNER_CHAT_ID ?? null;
    return null;
  }
}
