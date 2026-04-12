/**
 * Message router — bridges messaging channels to the Agent Controller.
 *
 * Inbound: owner message → task via submitTask()
 * Outbound: task.completed/task.failed events → formatted reply to channel
 * Ritual: completed ritual tasks → broadcast to all active channels
 */

import { submitTask, cancelTask } from "../dispatch/dispatcher.js";
import { toolRegistry } from "../tools/registry.js";
import { SYSTEM_PROMPT_TOKEN_BUDGET } from "../config/constants.js";
import { getDatabase } from "../db/index.js";
import {
  findRecentCheckpoint,
  clearCheckpoint,
} from "../runners/checkpoint.js";
import { getEventBus } from "../lib/event-bus.js";
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
} from "../lib/events/types.js";
import type {
  ChannelAdapter,
  ChannelName,
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
  fileSystemSection,
  capabilitiesSection,
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
} from "./prompt-sections.js";
import {
  scopeToolsForMessage as scopeToolsPure,
  detectActiveGroups,
  DEFAULT_SCOPE_PATTERNS,
  CORE_TOOLS,
  SCHEDULE_TOOLS,
  GOOGLE_TOOLS,
  CODING_TOOLS,
  WORDPRESS_TOOLS,
  MISC_TOOLS,
  BROWSER_TOOLS,
  SPECIALTY_TOOLS,
  RESEARCH_TOOLS,
} from "./scope.js";
import { classifyScopeGroups } from "./scope-classifier.js";
import { normalizeForMatching, wasNormalized } from "./normalize.js";

import {
  recordScopeDecision,
  linkScopeToTask,
  linkFeedbackToScope,
} from "../intelligence/scope-telemetry.js";
import { autoPersistConversation } from "../memory/auto-persist.js";

const TASK_TIMEOUT_INTERIM_MS = 120_000; // 2 min → "still working"
const TASK_TIMEOUT_FINAL_MS = 300_000; // 5 min → second "still working" warning
const TASK_TIMEOUT_ABANDON_MS = 660_000; // 11 min → actually give up (past SDK 10min hard timeout)

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
function buildJarvisSystemPrompt(
  mxDate: string,
  mxTime: string,
  tools: string[],
  userFactsBlock: string,
  enrichmentBlock: string,
): string {
  const flags = detectToolFlags(tools);

  // CCP6: Priority-ordered sections. Higher priority = kept when over budget.
  // P1 (safety-critical), P2 (core), P3 (conditional), P4 (supplementary)
  const p1: string[] = []; // Never truncated
  const p2: string[] = [];
  const p3: string[] = [];
  const p4: string[] = []; // First to truncate

  // P1: Identity + safety
  p1.push(identitySection(mxDate, mxTime));
  p1.push(confirmationSection(flags));
  p1.push(toolFirstSection(flags));
  p1.push(mechanicalVerificationSection());

  // P2: Core knowledge
  if (flags.hasNorthStar) p2.push(fileSystemSection());
  p2.push(capabilitiesSection(flags));
  p2.push(personalDataSection());
  p2.push(correctionMemorySection());

  // P3: Domain-specific
  if (flags.hasBrowser) p3.push(verificationSection());
  if (flags.hasWordpress) p3.push(wordpressSection());
  if (tools.includes("memory_store")) p3.push(memoryPersistenceSection());
  if (flags.hasCoding) p3.push(codingSection());
  if (flags.hasBrowser) p3.push(browserSection());
  if (flags.hasResearch) p3.push(researchSection());

  // P4: Supplementary data (user facts, enrichment)
  if (userFactsBlock) p4.push(userFactsBlock);
  if (enrichmentBlock) p4.push(enrichmentBlock);

  // Assemble with budget check
  const budget = SYSTEM_PROMPT_TOKEN_BUDGET * 4; // Convert tokens to chars
  let prompt = [...p1, ...p2, ...p3, ...p4].join("\n\n");

  // CCP6: Truncate from lowest priority tier first, then next tier up.
  // Drain P4 completely before touching P3, P3 before P2. Never touch P1.
  if (prompt.length > budget) {
    const tiers = [p4, p3, p2]; // drain order (P4 first)
    for (const tier of tiers) {
      while (tier.length > 0 && prompt.length > budget) {
        tier.pop();
        prompt = [...p1, ...p2, ...p3, ...p4].join("\n\n");
      }
    }
    console.warn(
      `[prompt] System prompt truncated: ${Math.round(prompt.length / 4)} tokens (budget: ${SYSTEM_PROMPT_TOKEN_BUDGET})`,
    );
  }

  console.log(
    `[prompt] System prompt: ${Math.round(prompt.length / 4)} tokens, ${p1.length + p2.length + p3.length + p4.length} sections`,
  );
  return prompt;
}

/**
 * Scope tools to only groups relevant to the current conversation context.
 * Scans the current message + last 3 conversation turns for keyword signals.
 * Always includes core + misc. Activates other groups on demand.
 *
 * Typical reduction: 49 → 15-25 tools = ~5-8K fewer tokens.
 */
function scopeToolsForMessage(
  currentMessage: string,
  conversationHistory: ConversationTurn[],
  semanticGroups?: Set<string> | null,
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
  let activeGroups: Set<string>;
  if (semanticGroups && semanticGroups.size > 0) {
    activeGroups = semanticGroups;
    console.log(
      `[router] Scope groups (semantic): ${[...activeGroups].join(", ")}`,
    );
  } else {
    activeGroups = detectActiveGroups(
      currentMessage,
      recentUserMessages,
      DEFAULT_SCOPE_PATTERNS,
    );
    if (activeGroups.size > 0) {
      console.log(
        `[router] Scope groups (regex fallback): ${[...activeGroups].join(", ")}`,
      );
    }
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

  const fullCount =
    CORE_TOOLS.length +
    SCHEDULE_TOOLS.length +
    MISC_TOOLS.length +
    BROWSER_TOOLS.length +
    CODING_TOOLS.length +
    SPECIALTY_TOOLS.length +
    RESEARCH_TOOLS.length +
    (process.env.GOOGLE_CLIENT_ID ? GOOGLE_TOOLS.length : 0) +
    (process.env.WP_SITES ? WORDPRESS_TOOLS.length : 0) +
    2; // memory
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
 */
function threadKey(channel: string, from?: string, senderJid?: string): string {
  // Groups: isolate per sender so Person A's budget talk doesn't leak into Person B's poetry
  if (from && from.endsWith("@g.us") && senderJid) {
    return `${channel}:${from}:${senderJid}`;
  }
  // Groups without sender (shouldn't happen, but fallback to group-level isolation)
  if (from && from.endsWith("@g.us")) return `${channel}:${from}`;
  return channel;
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
  /problema t[eé]cnico (?:cr[ií]tico|grave)/i,
  /error de configuraci[oó]n/i,
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
];

function isPoisonedExchange(jarvisResponse: string): boolean {
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

  // Extract base channel from compound key for DB query.
  // Compound keys: "whatsapp:group@g.us:sender@s.whatsapp.net" → "whatsapp"
  // Simple keys: "telegram" → "telegram"
  const baseChannel = tk.split(":")[0];

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
    const entry = `- [${time}] **${role}**: ${text.slice(0, 500).replace(/\n/g, " ")}\n`;

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

    this.subscriptions.push(completedSub, failedSub);

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

      let channel = defaultChannel;
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

  /** Handle an inbound message from any channel → create task. */
  async handleInbound(msg: IncomingMessage): Promise<void> {
    this.lastMessageTime = Date.now();

    // Day log: record user message (mechanical, no LLM)
    appendDayLog("USER", msg.text);

    // Prompt enhancer toggle commands
    const toggleResult = checkToggle(msg.text);
    if (toggleResult !== null) {
      this.sendToChannel(
        msg.channel,
        msg.from,
        `🔍 Prompt enhancer: ${toggleResult ? "ACTIVADO" : "DESACTIVADO"}`,
      );
      return;
    }

    // Context clear: "limpia tu contexto", "clear context", "contexto limpio"
    // Mechanical: purges in-memory thread buffer + strips poisoned DB entries.
    // If the message continues after the phrase, process the rest as a fresh task.
    const CONTEXT_CLEAR_RE =
      /^(limpia\s+(?:tu\s+)?contexto|clear\s+context|contexto\s+limpio|borra\s+(?:el\s+)?contexto)\s*/i;
    const senderJid = (msg.metadata?.senderJid as string) ?? undefined;
    const tk = threadKey(msg.channel, msg.from, senderJid);
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
        return;
      }
    }

    // Background agents: "lanza un agente", "investiga en background"
    const BACKGROUND_AGENT_RE =
      /\b(lanza\s+(?:un\s+)?agente|investiga\s+en\s+background|averigua\s+mientras|agente.*investig[ae])\b/i;
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
          return;
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
          return;
        }

        const { tools: scopedTools } = scopeToolsForMessage(taskText, []);
        const enrichment = await enrichContext(taskText, msg.channel);
        const mxDate = nowMexDate();
        const mxTime = nowMexTime();
        const systemPrompt = buildJarvisSystemPrompt(
          mxDate,
          mxTime,
          scopedTools,
          "",
          enrichment.contextBlock,
        );

        // Worker isolation (OpenClaude InProcessBackend pattern):
        // - No conversationHistory passed (parent context NOT leaked)
        // - Scoped tools only (no parent tool leakage beyond scope)
        // - 60-min hard timeout on pendingReplies (existing)
        const result = await submitTask({
          title: `🤖 Agente: ${taskText.slice(0, 50)}`,
          description:
            systemPrompt +
            `\n\nTarea del agente (background):\n${taskText}\n\n` +
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
        return;
      } catch (err) {
        console.error("[router] Background agent spawn failed:", err);
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Error lanzando agente. Intenta de nuevo.",
        );
        return;
      }
    }

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
      return;
    }

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
      return;
    }

    // --- v6.2 S2: Task cancellation from Telegram ---
    // Detect cancel intent: "cancela", "detente", "para", "stop", "cancel"
    // Aborts the running task for this channel, extracts partial result, notifies user.
    const CANCEL_INTENT_RE =
      /^(cancela|detente|para|stop|cancel|aborta|déjalo|dejalo)\s*$/i;
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
      return;
    }

    // Prompt enhancer: if waiting for answers, build enhanced prompt or skip
    if (isWaitingForAnswers(msg.channel)) {
      const original = getOriginalMessage(msg.channel)!;
      const questions = getQuestions(msg.channel);
      clearEnhancerState(msg.channel);

      // Skip enhancer if user says "skip", "hazlo", "procede", "sin preguntas"
      // or sends a short dismissal — just pass the original through
      const SKIP_RE =
        /^(skip|hazlo|procede|sin preguntas|no importa|ya|dale|solo hazlo|just do it)\b/i;
      if (SKIP_RE.test(msg.text.trim())) {
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

      if (analysis.startsWith("ASSUME:")) {
        // v6.4 CL1.3: Show assumption to user, then proceed without blocking.
        const assumption = analysis.slice(7);
        this.sendToChannel(msg.channel, msg.from, `💡 ${assumption}`);
        console.log(
          "[enhancer] ASSUME — proceeding with stated interpretation",
        );
      } else if (analysis !== "PASS") {
        // Send questions to user, wait for answers
        setWaiting(msg.channel, msg.text, analysis);
        this.sendToChannel(
          msg.channel,
          msg.from,
          `🔍 Antes de proceder:\n\n${analysis}`,
        );
        console.log(
          `[enhancer] Asking ${analysis.split("\n").length} questions`,
        );
        return;
      } else {
        console.log("[enhancer] PASS — message is clear enough");
      }
    }

    // Pending confirmation check — user confirms/declines a high-risk tool operation.
    // Must be before feedback/fast-path/full pipeline — this is a direct tool execution.
    const pendingConf = getPendingConfirmation(tk);
    if (pendingConf) {
      const confResponse = detectConfirmationResponse(msg.text);
      if (confResponse === "confirm") {
        console.log(
          `[router] Confirmation accepted: ${pendingConf.toolName} — executing directly`,
        );
        clearPendingConfirmation(tk);
        try {
          const result = await toolRegistry.execute(
            pendingConf.toolName,
            pendingConf.args,
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
          appendDayLog("USER", msg.text);
          appendDayLog("JARVIS", userResponse);
          pushToThread(tk, `User: ${msg.text}\nJarvis: ${userResponse}`);
        } catch (err) {
          const errMsg = `Error ejecutando ${pendingConf.toolName}: ${err instanceof Error ? err.message : String(err)}`;
          this.sendToChannel(msg.channel, msg.from, errMsg);
        }
        return;
      } else if (confResponse === "decline") {
        console.log(`[router] Confirmation declined: ${pendingConf.toolName}`);
        clearPendingConfirmation(tk);
        this.sendToChannel(msg.channel, msg.from, "Cancelado.");
        appendDayLog("USER", msg.text);
        appendDayLog("JARVIS", "Cancelado.");
        return;
      }
      // Not a clear confirm/decline — clear stale pending and process normally
      clearPendingConfirmation(tk);
    }

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
      return;
    }

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
            ? response.slice(0, THREAD_RESPONSE_CAP) + "..."
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

        return;
      } catch (err) {
        console.error("[router] Fast-path failed, falling through:", err);
        // Fall through to full pipeline
      }
    }

    // Streaming setup for Telegram — progressive message updates as LLM generates
    let streamController: TelegramStreamController | null = null;
    if (msg.channel === "telegram") {
      const telegramAdapter = this.channels.get("telegram") as
        | (ChannelAdapter & { getBot?(): import("grammy").Bot | null })
        | undefined;
      const bot = telegramAdapter?.getBot?.();
      if (bot) {
        streamController = new TelegramStreamController(bot, msg.from);
        await streamController.sendPlaceholder("⏳").catch(() => {});
      }
    }

    // Fallback ACK for non-Telegram or if streaming setup failed
    if (!streamController) {
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

    // Recall semantic memories + enrich context IN PARALLEL
    const enrichment = await enrichContext(msg.text, msg.channel);

    // User profile facts + projects — always injected so the LLM never forgets context
    let userFactsBlock = "";
    try {
      userFactsBlock = formatUserFactsBlock(msg.text) + formatProjectsBlock();
    } catch {
      // Non-fatal — DB may not have the tables yet
    }

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
    const semanticGroups = await classifyScopeGroups(
      normalizedText,
      recentContext || undefined,
    );

    // Dynamic tool scoping — uses semantic groups if available, regex fallback.
    // Pass normalizedText so regex fallback benefits from typo corrections.
    const { tools, activeGroups } = scopeToolsForMessage(
      normalizedText,
      conversationHistory,
      semanticGroups,
    );

    // Implicit feedback: compare current scope groups with previous message's.
    // Uses feedbackTaskId captured at line 592 (checkFeedbackWindow is destructive
    // — consumes the ID on first call, so we can't call it again here).
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

    // Build system prompt with conditional sections based on scoped tools
    const systemPrompt = buildJarvisSystemPrompt(
      mxDate,
      mxTime,
      tools,
      userFactsBlock,
      enrichment.contextBlock,
    );

    // Execution pattern memory: inject relevant past lessons
    const patternBlock = findRelevantPatterns(msg.text, [...activeGroups]);
    const systemPromptWithPatterns = patternBlock
      ? systemPrompt + "\n\n" + patternBlock
      : systemPrompt;

    // Task continuity: check for a recent checkpoint ONLY on continuation messages.
    const CONTINUATION_RE =
      /^(contin[uú]a|sigue|termin[ae]|completa|finaliza|acaba|resume|continúe|continue)\b/i;
    let taskDescription = systemPromptWithPatterns;
    if (CONTINUATION_RE.test(msg.text.trim())) {
      try {
        const cp = findRecentCheckpoint();
        if (cp) {
          taskDescription =
            systemPrompt +
            `\n\n## CONTINUACIÓN DE TAREA ANTERIOR\n` +
            `La tarea anterior (${cp.taskId}) no terminó (${cp.exitReason}, round ${cp.roundsCompleted}/${cp.maxRounds}).\n` +
            `**Lo que ya se hizo:** ${cp.toolsCalled.join(", ") || "nada"}\n` +
            `**Lo que falta:** Completar lo que el usuario pidió originalmente.\n\n` +
            `**Solicitud original:**\n${cp.userMessage.slice(0, 2000)}\n\n` +
            `**Último resultado parcial:**\n${cp.summary.slice(0, 500)}\n\n` +
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

    // Create abort controller for task cancellation (v6.2 S2)
    const taskAbort = new AbortController();

    const result = await submitTask({
      title: `Chat: ${titleText}`,
      description: taskDescription,
      agentType: "auto",
      tools,
      conversationHistory,
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

    // Hard abandon: clean up after SDK timeout (10min) + 1min grace
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
    }, TASK_TIMEOUT_ABANDON_MS);

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

  /** Watch a ritual task for completion → broadcast result to all channels. */
  watchRitualTask(taskId: string, ritualId: string): void {
    this.ritualWatches.set(taskId, ritualId);
  }

  /** Broadcast a message to all active channels. */
  async broadcastToAll(text: string): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [name, adapter] of this.channels) {
      const to = this.getOwnerAddress(name);
      if (to) {
        promises.push(
          adapter
            .send({ channel: name, to, text })
            .then(() => undefined)
            .catch((err) => {
              console.error(`[router] Broadcast to ${name} failed:`, err);
            }),
        );
      }
    }

    await Promise.all(promises);
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
        this.sendToChannel(pending.channel, pending.to, notification);
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
            this.sendToChannel(pending.channel, pending.to, resultText);
          });
        } else {
          this.sendToChannel(pending.channel, pending.to, resultText);
        }
      }

      // Push to in-memory conversation thread (chronological, instant)
      const cappedResult =
        resultText.length > THREAD_RESPONSE_CAP
          ? resultText.slice(0, THREAD_RESPONSE_CAP) + "..."
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
            tags: [pending.channel, "conversation"],
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
          console.warn(
            "[router] Auto-persist failed:",
            err instanceof Error ? err.message : err,
          );
        });
      } catch {
        // Non-fatal
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
                  err instanceof Error ? err.message : err,
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
                console.warn(
                  "[router] Crystallization failed:",
                  err instanceof Error ? err.message : err,
                );
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

    // Clean up ritual watches
    this.ritualWatches.delete(taskId);

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

    // Track failed outcome
    trackTaskOutcome(taskId, 0, false, pending.channel);
  }

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
    if (channel === "whatsapp") return process.env.WHATSAPP_OWNER_JID ?? null;
    if (channel === "telegram")
      return process.env.TELEGRAM_OWNER_CHAT_ID ?? null;
    return null;
  }
}
