/**
 * Message router — bridges messaging channels to the Agent Controller.
 *
 * Inbound: owner message → task via submitTask()
 * Outbound: task.completed/task.failed events → formatted reply to channel
 * Ritual: completed ritual tasks → broadcast to all active channels
 */

import { submitTask } from "../dispatch/dispatcher.js";
import { getDatabase } from "../db/index.js";
import { getEventBus } from "../lib/event-bus.js";
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
import { formatUserFactsBlock, setUserFact } from "../db/user-facts.js";
import { formatProjectsBlock } from "../db/projects.js";
import {
  detectFeedbackSignal,
  detectImplicitFeedback,
  isFeedbackMessage,
} from "../intelligence/feedback.js";
import { isConversationalFastPath, fastPathRespond } from "./fast-path.js";
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
  commitSection,
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
  COMMIT_WRITE_TOOLS,
  COMMIT_JOURNAL_TOOLS,
  COMMIT_DESTRUCTIVE_TOOLS,
  SCHEDULE_TOOLS,
  GOOGLE_TOOLS,
  CODING_TOOLS,
  WORDPRESS_TOOLS,
  MISC_TOOLS,
  BROWSER_TOOLS,
  SPECIALTY_TOOLS,
  RESEARCH_TOOLS,
} from "./scope.js";

import {
  recordScopeDecision,
  linkScopeToTask,
  linkFeedbackToScope,
} from "../intelligence/scope-telemetry.js";
import { autoPersistConversation } from "../memory/auto-persist.js";

const TASK_TIMEOUT_INTERIM_MS = 120_000; // 2 min → "still working"
const TASK_TIMEOUT_FINAL_MS = 300_000; // 5 min → give up waiting

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
  const sections: string[] = [];

  // Always-on sections
  sections.push(identitySection(mxDate, mxTime));
  if (flags.hasCommit) sections.push(commitSection());
  sections.push(capabilitiesSection(flags));
  sections.push(personalDataSection());
  sections.push(confirmationSection(flags));
  if (flags.hasBrowser) sections.push(verificationSection());
  sections.push(toolFirstSection(flags));
  if (flags.hasWordpress) sections.push(wordpressSection());
  sections.push(mechanicalVerificationSection());
  if (tools.includes("memory_store")) sections.push(memoryPersistenceSection());
  sections.push(correctionMemorySection());
  if (flags.hasCoding) sections.push(codingSection());
  if (flags.hasBrowser) sections.push(browserSection());
  if (flags.hasResearch) sections.push(researchSection());

  let prompt = sections.join("\n\n");
  prompt += userFactsBlock;
  prompt += enrichmentBlock;
  return prompt;
}

/**
 * Scope tools to only groups relevant to the current conversation context.
 * Scans the current message + last 3 conversation turns for keyword signals.
 * Always includes core + COMMIT read + misc. Activates other groups on demand.
 *
 * Typical reduction: 49 → 15-25 tools = ~5-8K fewer tokens.
 */
function scopeToolsForMessage(
  currentMessage: string,
  conversationHistory: ConversationTurn[],
): { tools: string[]; activeGroups: string[] } {
  // Scope from RECENT user messages only (last 2) — older messages cause scope
  // accumulation where every past topic stays active, bloating the tool list.
  // The current message (first param) is always scanned separately.
  const userMsgs = conversationHistory
    .filter((t) => t.role === "user")
    .slice(-2)
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

  // Log which scope groups activated (diagnostic — critical for debugging scope misses)
  const activeGroups = detectActiveGroups(
    currentMessage,
    recentUserMessages,
    DEFAULT_SCOPE_PATTERNS,
  );
  if (activeGroups.size > 0) {
    console.log(`[router] Scope groups: ${[...activeGroups].join(", ")}`);
  }

  const tools = scopeToolsPure(
    currentMessage,
    recentUserMessages,
    DEFAULT_SCOPE_PATTERNS,
    {
      hasGoogle: !!process.env.GOOGLE_CLIENT_ID,
      hasWordpress: !!process.env.WP_SITES,
      hasMemory: getMemoryService().backend === "hindsight",
    },
  );

  const fullCount =
    CORE_TOOLS.length + // already includes COMMIT_READ_TOOLS
    COMMIT_WRITE_TOOLS.length +
    COMMIT_JOURNAL_TOOLS.length +
    COMMIT_DESTRUCTIVE_TOOLS.length +
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
  interimTimer: ReturnType<typeof setTimeout>;
  finalTimer: ReturnType<typeof setTimeout>;
  streamController?: TelegramStreamController;
}

/** In-memory ring buffer of recent exchanges per channel for thread continuity. */
const THREAD_BUFFER_SIZE = 15;
/** Max chars per Jarvis response stored in the thread buffer.
 *  Recent cap is higher to preserve state for multi-step workflows
 *  (e.g. "Continúa" chains where the LLM needs to know what it just did). */
const THREAD_RESPONSE_CAP = 1600;

interface ThreadEntry {
  text: string; // "User: ...\nJarvis: ..."
  imageUrl?: string; // base64 data URL — preserved so follow-up turns see the image
}

const conversationThreads = new Map<string, ThreadEntry[]>();
const threadLastAccess = new Map<string, number>();
/** Previous scope groups per channel — used for implicit feedback detection. */
const previousScopeGroups = new Map<string, Set<string>>();
const previousMessages = new Map<string, string>();
const THREAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let threadAccessCount = 0;
const hydratedChannels = new Set<string>();

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
  /no tengo.*(?:commit__|wp_|gmail_|gsheets_)/i,
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
  // Narrated update claim — LLM claims to have updated COMMIT without tools.
  // NOTE: "Acciones Ejecutadas" removed from here — it's a legitimate header
  // when tools actually ran. The hallucination guard (fast-runner Layer 2)
  // handles it with tool-call context; the poison filter cannot distinguish.
  /acabo de actualizar\s+COMMIT/i,
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
function hydrateThreadIfNeeded(channel: string): void {
  if (hydratedChannels.has(channel)) return;
  hydratedChannels.add(channel);

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
      .all(channel, THREAD_BUFFER_SIZE) as { content: string }[];

    if (rows.length > 0) {
      // Reverse to chronological order (query returns newest-first)
      // Images don't survive restarts (base64 not stored in DB) — text only
      const thread: ThreadEntry[] = rows
        .reverse()
        .map((r) => ({ text: r.content }));
      conversationThreads.set(channel, thread);
    } else {
      conversationThreads.set(channel, []);
    }
  } catch {
    conversationThreads.set(channel, []);
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
  }

  /** Handle an inbound message from any channel → create task. */
  async handleInbound(msg: IncomingMessage): Promise<void> {
    this.lastMessageTime = Date.now();

    // Check if this message is feedback for a recently completed task
    const feedbackTaskId = checkFeedbackWindow(msg.channel);
    if (feedbackTaskId) {
      const signal = detectFeedbackSignal(msg.text);
      if (signal !== "neutral") {
        recordTaskFeedback(feedbackTaskId, signal);
        try {
          linkFeedbackToScope(feedbackTaskId, signal);
        } catch {
          /* non-fatal */
        }
      }

      // Pure feedback ("gracias", "perfecto", "no") → ack and skip task creation
      if (isFeedbackMessage(msg.text)) {
        if (signal === "positive") {
          this.sendToChannel(msg.channel, msg.from, "👍");
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
    }

    // Fast-path: simple conversational messages → direct LLM, no tools, ~2s
    if (!msg.imageUrl && isConversationalFastPath(msg.text)) {
      try {
        console.log(
          `[router] Fast-path: "${msg.text.slice(0, 40)}" → direct LLM`,
        );
        const threadTurns = getThreadTurns(msg.channel);
        const response = await fastPathRespond(msg.text, threadTurns);

        this.sendToChannel(msg.channel, msg.from, response);

        const cappedResponse =
          response.length > THREAD_RESPONSE_CAP
            ? response.slice(0, THREAD_RESPONSE_CAP) + "..."
            : response;
        pushToThread(
          msg.channel,
          `User: ${msg.text}\nJarvis: ${cappedResponse}`,
        );

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
    const conversationHistory = getThreadTurns(msg.channel);
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

    // Dynamic tool scoping — only include tool groups relevant to the conversation
    const { tools, activeGroups } = scopeToolsForMessage(
      msg.text,
      conversationHistory,
    );

    // Implicit feedback: compare current scope groups with previous message's.
    // Uses feedbackTaskId captured at line 592 (checkFeedbackWindow is destructive
    // — consumes the ID on first call, so we can't call it again here).
    const prevGroups = previousScopeGroups.get(msg.channel);
    const prevMsg = previousMessages.get(msg.channel);
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
        console.log(
          `[router] Implicit feedback for ${feedbackTaskId}: ${implicitSignal}`,
        );
      }
    }
    previousScopeGroups.set(msg.channel, new Set(activeGroups));
    previousMessages.set(msg.channel, msg.text);

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

    const result = await submitTask({
      title: `Chat: ${titleText}`,
      description: systemPrompt,
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
        this.pendingReplies.delete(result.taskId);
        this.sendToChannel(
          msg.channel,
          msg.from,
          "Se agotó el tiempo. Revisa el dashboard para más detalles.",
        );
      }
    }, TASK_TIMEOUT_FINAL_MS);

    this.pendingReplies.set(result.taskId, {
      channel: msg.channel,
      to: msg.from,
      originalText: msg.text,
      imageUrl: msg.imageUrl,
      interimTimer,
      finalTimer,
      ...(streamController && { streamController }),
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
    this.pendingReplies.delete(taskId);

    const resultText = this.extractResultText(data.result);
    if (resultText) {
      // Finalize streaming message or send fresh
      if (pending.streamController) {
        pending.streamController.finalize(resultText).catch((err) => {
          console.error("[router] Stream finalize failed:", err);
          this.sendToChannel(pending.channel, pending.to, resultText);
        });
      } else {
        this.sendToChannel(pending.channel, pending.to, resultText);
      }

      // Push to in-memory conversation thread (chronological, instant)
      const cappedResult =
        resultText.length > THREAD_RESPONSE_CAP
          ? resultText.slice(0, THREAD_RESPONSE_CAP) + "..."
          : resultText;
      pushToThread(
        pending.channel,
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

      // Safety net: auto-persist critical data the LLM may have ignored
      try {
        ensureCriticalDataPersisted(pending.originalText, taskId);
      } catch {
        // Non-fatal
      }

      // Mechanical auto-persist: store noteworthy exchanges based on heuristics
      try {
        let apToolCalls: string[] = [];
        const apRow = getDatabase()
          .prepare(
            "SELECT output FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(taskId) as { output: string | null } | undefined;
        if (apRow?.output) {
          try {
            apToolCalls = JSON.parse(apRow.output).toolCalls ?? [];
          } catch {
            /* ignore */
          }
        }
        autoPersistConversation({
          userText: pending.originalText,
          responseText: resultText,
          toolCalls: apToolCalls,
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
    this.pendingReplies.delete(taskId);

    this.sendToChannel(
      pending.channel,
      pending.to,
      "No pude completar eso. Revisa el dashboard para más detalles.",
    );

    // Track failed outcome
    trackTaskOutcome(taskId, 0, false, pending.channel);
  }

  private sendToChannel(channel: ChannelName, to: string, text: string): void {
    const adapter = this.channels.get(channel);
    if (!adapter) return;

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
