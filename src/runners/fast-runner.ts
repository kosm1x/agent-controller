/**
 * Fast Runner — In-process LLM + tool loop.
 *
 * Sends a task description to the LLM with available tools. The LLM calls tools,
 * results are appended, and it loops until a text-only response or max rounds.
 * Fastest runner type — no containers, no planning overhead.
 */

import { inferWithTools } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { toolRegistry } from "../tools/registry.js";
import { registerRunner } from "../dispatch/dispatcher.js";
import { parseRunnerStatus } from "./status.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import { TaskExecutionContext } from "../inference/execution-context.js";
import { createTaskExecutor } from "../tools/task-executor.js";
import {
  recordToolExecution,
  recordToolRepairs,
} from "../intelligence/scope-telemetry.js";
import { getFilesByQualifier } from "../db/jarvis-fs.js";

const GENERIC_SYSTEM_PROMPT = `You are a task execution agent. You have access to tools to accomplish the user's task.

Instructions:
- Use the available tools to complete the task.
- Be thorough but efficient — use the minimum number of tool calls needed.
- When you have enough information to answer, respond with a clear, concise result.
- If a tool fails, try an alternative approach or explain what went wrong.

When you finish, end your response with exactly one of these status lines:
STATUS: DONE
STATUS: DONE_WITH_CONCERNS — [brief explanation of what concerns you]
STATUS: NEEDS_CONTEXT — [what information is missing]
STATUS: BLOCKED — [what is preventing completion]`;

/**
 * Build the knowledge base injection section from jarvis_files.
 * Fetches always-read + enforce files, plus conditional files matching scope.
 */
function buildKnowledgeBaseSection(scopedTools: string[]): string | null {
  try {
    const files = getFilesByQualifier("always-read", "enforce", "conditional");
    if (files.length === 0) return null;

    const sections: string[] = [];
    let totalChars = 0;
    const KB_CHAR_BUDGET = 8000; // ~2000 tokens — protects prompt budget

    for (const f of files) {
      // Skip conditional files whose condition doesn't match scope
      if (f.qualifier === "conditional" && f.condition) {
        const condLower = f.condition.toLowerCase();
        const matches =
          (condLower.includes("crm") && scopedTools.includes("crm_query")) ||
          (condLower.includes("northstar") &&
            scopedTools.includes("jarvis_file_read")) ||
          (condLower.includes("google") &&
            scopedTools.includes("gmail_send")) ||
          (condLower.includes("wordpress") &&
            scopedTools.includes("wp_publish")) ||
          (condLower.includes("coding") &&
            scopedTools.includes("shell_exec")) ||
          (condLower.includes("browser") &&
            scopedTools.some((t) => t.startsWith("playwright__")));
        if (!matches) continue;
      }

      const prefix = f.qualifier === "enforce" ? "MANDATORY: " : "";
      const section = `### ${prefix}${f.title}\n${f.content}`;

      // Hard budget cap — enforce + always-read guaranteed, others fill remaining
      if (
        f.qualifier !== "enforce" &&
        f.qualifier !== "always-read" &&
        totalChars + section.length > KB_CHAR_BUDGET
      ) {
        continue;
      }
      sections.push(section);
      totalChars += section.length;
    }

    if (sections.length === 0) return null;
    return `[JARVIS KNOWLEDGE BASE]\n\n${sections.join("\n\n---\n\n")}`;
  } catch {
    // DB not ready or table missing — non-fatal
    return null;
  }
}

/** Status suffix appended to chat system prompts. */
const STATUS_SUFFIX = `

When you finish, end your response with exactly one of these status lines:
STATUS: DONE
STATUS: DONE_WITH_CONCERNS — [brief explanation of what concerns you]
STATUS: NEEDS_CONTEXT — [what information is missing]
STATUS: BLOCKED — [what is preventing completion]`;

import {
  MAX_ROUNDS_DEFAULT,
  MAX_ROUNDS_CODING,
  MAX_ROUNDS_BROWSER,
  TOKEN_BUDGET_FAST,
  TOKEN_BUDGET_CODING,
  TOKEN_BUDGET_BROWSER,
  HALLUCINATION_RETRY_HEADROOM,
} from "../config/constants.js";

/** Confirmation words from the user (Spanish + English). */
const CONFIRM_PATTERN =
  /^(s[ií]|confirmo|dale|ok|yes|hazlo|adelante|procede|proceed|confirm|bórrala|bórralas|elimínalas?|go ahead|do it|haz(?:lo)?|claro)(\s|$|[.,!?])/i;
/** Pattern in assistant messages that indicates a deletion confirmation was requested. */
const DELETION_ASK_PATTERN =
  /(?:delete_item|eliminar|borrar|¿confirmo|confirmas|¿(?:lo|la|los|las)\s+(?:elimino|borro)|quieres que\s+(?:\S+\s+)?(?:elimine|borre)|want me to (?:delete|remove)|shall I (?:delete|remove)|should I (?:delete|remove)|confirm.*(?:delet|elimin|borr)|(?:delet|elimin|borr)\S*\s*\?|procedo con la eliminaci[oó]n|CONFIRMATION_REQUIRED)/i;

/** Direct user deletion command — the user explicitly tells Jarvis to delete.
 *  Three forms:
 *  1. Explicit target: "elimina lo que" / "delete those"
 *  2. Clitic pronoun: "elimínala" / "bórralas"
 *  3. Delete verb + optional adjectives + task noun: "delete completed tasks" */
const DIRECT_DELETE_COMMAND =
  /\b(?:elimina|borra|delete|quita|remueve)\w*\s+(?:lo que|las? que|los que|todo lo que|tareas? que|what|those|them|the ones|(?:\S+\s+){0,3}(?:tareas?|tasks?|metas?|goals?|objetivos?|objectives?|ideas?))|\b(?:elim[ií]nal[aoe]s?|b[oó]rral[aoe]s?|qu[ií]tal[aoe]s?)\b/i;

/**
 * Check conversation history for a confirmed deletion request.
 * Returns true if:
 * 1. An assistant asked about deletion AND the user confirmed after, OR
 * 2. The user's CURRENT message is a direct deletion command (no two-step needed)
 */
export function hasUserConfirmedDeletion(
  history: { role: string; content: string }[],
): boolean {
  // Check for direct deletion command in the LAST user message.
  // "Elimina lo que no está en el roadmap" = explicit, unambiguous command.
  const lastUserMsg = [...history].reverse().find((t) => t.role === "user");
  if (lastUserMsg && DIRECT_DELETE_COMMAND.test(lastUserMsg.content)) {
    return true;
  }

  // Two-step confirmation: assistant asked → user confirmed
  let assistantAskedDeletion = false;
  for (const turn of history) {
    if (turn.role === "assistant" && DELETION_ASK_PATTERN.test(turn.content)) {
      assistantAskedDeletion = true;
    }
    if (
      assistantAskedDeletion &&
      turn.role === "user" &&
      CONFIRM_PATTERN.test(turn.content.trim())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Tools that perform write/mutate actions — if the response claims success
 * for any of these categories but the tool was never called, it's hallucinated.
 */
/** @internal Exported for compile-time sync test only. */
export const WRITE_TOOLS = new Set([
  // WordPress
  "wp_publish",
  "wp_media_upload",
  "wp_delete",
  "wp_raw_api",
  "wp_plugins",
  "wp_settings",
  // Google Workspace (must stay in sync with write tools in GOOGLE_TOOLS)
  "gmail_send",
  "gsheets_write",
  "gdrive_create",
  "gdrive_share",
  "gdrive_delete",
  "gdrive_move",
  "gdrive_upload",
  "calendar_create",
  "calendar_update",
  "gdocs_write",
  "gdocs_replace",
  "gslides_create",
  "gtasks_create",
  // File system
  "file_write",
  "file_edit",
  "file_delete",
  // Jarvis knowledge base
  "jarvis_file_write",
  "jarvis_file_update",
  "jarvis_file_delete",
  // Other
  "schedule_task",
  "delete_schedule",
  "user_fact_set",
  "user_fact_delete",
  "skill_save",
  "memory_store",
  "shell_exec",
]);

/**
 * Patterns that indicate the response claims a write/mutate action was performed.
 * Generic — covers all tool categories, not just WordPress.
 */
const WRITE_CLAIM_PATTERNS = [
  // Spanish first-person past tense write verbs
  /(?:escribí|actualicé|publiqué|subí|eliminé|borré|envié|configuré|instalé|activé|desactivé|limpié|creé|modifiqué|edité|guardé|programé|completé)\s/i,
  // Tool-mediated subjects (unambiguous — these can't be "state descriptions")
  /(?:sheet|hoja|filas?|celdas?|email|correo|tarea|meta|goal|objetivo|evento|calendario).*(?:actualizada?s?|escrit[oa]s?|completad[oa]s?|enviad[oa]s?|eliminad[oa]s?|creada?s?|publicada?s?|guardada?s?|modificada?s?|subida?s?)/i,
  // Passive voice with explicit verb (catches "artículo fue publicado", "imagen fue subida")
  /(?:fue|fueron|ha sido|han sido)\s+(?:actualizada?s?|escrit[oa]s?|completad[oa]s?|enviad[oa]s?|eliminad[oa]s?|creada?s?|publicada?s?|guardada?s?|modificada?s?|subida?s?)/i,
  // Past participle + success adverb (catches "subida correctamente", "publicado exitosamente")
  /(?:actualizada?|escrit[oa]|completad[oa]|enviad[oa]|eliminad[oa]|creada?|publicada?|guardada?|modificada?|subida?)\s+(?:exitosamente|correctamente|con éxito|successfully)/i,
  // Quantity + action claims ("50 celdas actualizadas", "5 filas escritas")
  /\d+\s+(?:celdas?|filas?|rows?|cells?|entries?|registros?|artículos?|archivos?|eventos?)\s+(?:actualizada?s?|escrit[oa]s?|written|updated|created|deleted|sent|saved)/i,
  // English first-person claims
  /I\s+(?:wrote|updated|published|uploaded|deleted|sent|created|saved|edited|configured|installed|scheduled|cleaned|modified)\s/i,
  // English passive claims
  /(?:has been|was|were)\s+(?:written|updated|published|uploaded|deleted|sent|created|saved|edited|configured|installed|scheduled)/i,
  // "Acción realizada" / "Acciones realizadas" (common hallucination opener)
  /accione?s?\s+realizada?s?/i,
];

/**
 * Detect hallucinated tool execution — LLM narrates actions without calling tools.
 *
 * Three detection layers:
 * 1. Full hallucination: success marker + write claim + zero tools
 * 2. Partial hallucination: claims write success but no write tool was called
 * 3. Narration patterns (processing steps, FTP claims, etc.)
 *
 * Returns true if the response looks like it's simulating execution.
 */
export function detectsHallucinatedExecution(
  text: string,
  toolsCalled: string[],
  userMessage?: string,
  failedWriteTools?: string[],
): boolean {
  const claimsWrite = WRITE_CLAIM_PATTERNS.some((p) => p.test(text));

  // --- Layer 0: Failed write tools ---
  // If a write tool was attempted and FAILED (returned error), and the response
  // claims success (✅), it's always a hallucination. The LLM tried, failed,
  // and narrates success — even passive voice ("Marcada como completed") is a
  // false claim here, not a legitimate status observation.
  if (failedWriteTools && failedWriteTools.length > 0) {
    const hasSuccessMarker =
      /✅|🚀|EXITOSAMENTE|SUCCESSFULLY|COMPLETADO|STATUS:\s*DONE\b/i.test(text);
    if (hasSuccessMarker) {
      console.log(
        `[fast-runner] Failed-write hallucination: write tools [${failedWriteTools.join(", ")}] failed but response claims success`,
      );
      return true;
    }
  }

  // --- Layer 1: Full hallucination (zero tools + write claim) ---
  // If no tools called at all and response claims a write action, it's hallucinated.
  if (toolsCalled.length === 0) {
    const hasSuccessMarker =
      /✅|🚀|EXITOSAMENTE|SUCCESSFULLY|COMPLETADO|STATUS:\s*DONE\b/i.test(text);
    if (hasSuccessMarker && claimsWrite) return true;

    // Also catch legacy concrete claims (URLs, file paths, FTP)
    const claimsLegacyConcrete =
      /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|html|php)/i.test(text) ||
      /\/(?:wp-content|tmp|var|home|workspace)\//i.test(text) ||
      /(?:vía|via|through)\s+(?:FTP|SSH|SFTP)/i.test(text) ||
      /\*[^*]*\.\.\.\*/.test(text);
    if (hasSuccessMarker && claimsLegacyConcrete) return true;

    // Layer 1b: Read hallucination — claims to have read/verified/reviewed
    // specific content without calling any tools. The LLM fabricates findings
    // from thread context or imagination instead of actually reading.
    const claimsRead =
      /(?:he revisado|revisando el contenido|leyendo el (?:archivo|contenido|artículo))/i.test(
        text,
      ) ||
      /(?:I (?:read|reviewed|checked|inspected|examined) the (?:file|article|content|post|page))/i.test(
        text,
      ) ||
      /\*?\((?:Leyendo|Buscando|Revisando|Analizando|Reading|Searching|Reviewing|Analyzing)[^)]*\)\*?/i.test(
        text,
      );
    const claimsVerificationResult =
      /(?:ENLACE (?:NO )?ENCONTRADO|LINK (?:NOT )?FOUND|no contiene (?:ningún )?enlace|does not contain (?:any )?link)/i.test(
        text,
      ) || /(?:❌|✅)\s*(?:ENLACE|LINK|VERIFICAD)/i.test(text);
    if (claimsRead && claimsVerificationResult) {
      console.log(
        `[fast-runner] Read hallucination: claims to have read/verified content but toolsCalled is empty`,
      );
      return true;
    }
  }

  // --- Layer 2: Partial hallucination (generic — all write tools) ---
  // LLM called SOME tools (e.g. gsheets_read, wp_list_posts) but narrated write
  // actions (gsheets_write, wp_publish, gmail_send) without calling them.
  // EXCEPTION: if the user asked to verify/check/confirm, the LLM is REPORTING
  // what it found using read tools — descriptive language about state is expected.
  const calledAnyWriteTool = toolsCalled.some((t) => WRITE_TOOLS.has(t));
  const isVerificationRequest = userMessage
    ? /\b(verifica|verificar|confirma|confirmar|revisa|revisar|check|verify|confirm|comprueba|comprobar|existen|existe|están|registrad[oa]s?|ves|aparece|no las veo|no lo veo|puedes ver)\b/i.test(
        userMessage,
      )
    : false;
  // Read/list/query requests: the LLM is reporting DB state, not claiming writes
  const isReadRequest = userMessage
    ? /\b(lista|listar|list|cu[aá]les|muestra|mostrar|show|dame|dime|qu[eé]\s+(hay|tareas?|metas?|objetivos?|visio)|report[ae]|describe|consulta|status|estado)\b/i.test(
        userMessage,
      )
    : false;
  if (
    !calledAnyWriteTool &&
    toolsCalled.length > 0 &&
    !isVerificationRequest &&
    !isReadRequest
  ) {
    const claimsAction =
      // First-person past tense (always hallucination)
      /(?:escribí|actualicé|publiqué|subí|eliminé|borré|envié|configuré|instalé|activé|desactivé|limpié|creé|modifiqué|edité|guardé|programé|completé|marqué)\s/i.test(
        text,
      ) ||
      /I\s+(?:wrote|updated|published|uploaded|deleted|sent|created|saved|edited)\s/i.test(
        text,
      ) ||
      // Passive + success adverb (claim, not observation)
      /(?:fue|fueron|ha sido|han sido)\s+\w+\s*(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      /(?:was|were|has been|have been)\s+\w+\s*(?:successfully|correctly)/i.test(
        text,
      ) ||
      /(?:publicad[oa]|enviad[oa]|subid[oa]|creada?|eliminad[oa])\s+(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      // Status change claims — must have first-person anchor or active voice
      // "marqué como completada" or "la marcamos como done" = hallucination
      // "está marcada como completada" = observation from read tool (allowed)
      /(?:marqué|marcamos|marc[oó])\s+(?:como\s+)?(?:complet|hech|done|termin)/i.test(
        text,
      ) ||
      // Passive participle with ✅ prefix — action claim, not observation.
      // "✅ Marcada como completed" = hallucinated write (no tool called)
      // "✅ Eliminada (no existe)" = hallucinated delete
      // vs "La tarea está marcada como completada" = read observation (no ✅)
      /✅[^.\n]{0,30}(?:Marcad[ao]s?|Eliminad[ao]s?|Actualizada?s?|Cambiad[ao]s?|Borrad[ao]s?|Cread[ao]s?|Modificad[ao]s?|Completad[ao]s?)\s*(?:como|a\s|en\s|\(|—|:)/i.test(
        text,
      ) ||
      // "Acciones Ejecutadas" header — narrated action table
      /accione?s?\s+ejecutadas?/i.test(text) ||
      // Direct status assignment (not a listing of multiple statuses)
      /status[:\s]+(?:completed|done|✅)\b/i.test(text) ||
      // Quantity claims ("50 celdas actualizadas")
      /\d+\s+(?:celdas?|filas?|rows?|cells?)\s+(?:actualizada?s?|escrit[oa]s?|written|updated)/i.test(
        text,
      ) ||
      // "Acciones realizadas" opener
      /accione?s?\s+realizada?s?/i.test(text);
    if (claimsAction) {
      console.log(
        `[fast-runner] Partial hallucination: write claim but no write tool called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

  // --- Layer 3: Impossible narration (always fire) ---
  // Narrating fake process steps (FTP connections, handshakes, ellipsis progress)
  // is always hallucinated — no tool produces these outputs.
  const impossibleNarration = [
    /\*?\((?:Procesando|Ejecutando|Conectando|Subiendo|Descargando|Verificando|Generando|Escaneando|Publicando|Guardando)[^)]*\.\.\.\)\*?/i,
    /\*?\((?:Processing|Executing|Connecting|Uploading|Downloading|Verifying|Generating|Scanning|Publishing|Saving)[^)]*\.\.\.\)\*?/i,
    /(?:Conexión exitosa|Handshake completado|Upload exitoso)/i,
    /(?:Conexión\s+(?:FTP|SSH|SFTP)).*(?:exitosa|establecida|OK)/i,
    /(?:FTP\s+connection|SSH\s+connection|SFTP\s+connection).*(?:successful|established|OK)/i,
  ];
  if (impossibleNarration.some((p) => p.test(text))) return true;

  // --- Layer 3b: Completion claims (only fire when NO write tools called) ---
  // "acabo de actualizar", "he verificado", "just updated" are legitimate when
  // the LLM actually called write tools. Only flag when tools weren't called.
  if (!calledAnyWriteTool) {
    const completionClaims = [
      /(?:he verificado|acabo de verificar|confirmado en tiempo real)/i,
      /acabo de (?:ejecutar|publicar|subir|crear|guardar|actualizar|inyectar|instalar|configurar)/i,
      /(?:ya está|ya queda)\s+(?:live|publicado|en línea|activo|guardado)/i,
      /(?:just (?:executed|published|uploaded|created|saved|updated|verified))/i,
      /(?:is now live|is now published|has been published)/i,
    ];
    if (completionClaims.some((p) => p.test(text))) return true;
  }

  return false;
}

const READ_HALLUCINATION_RE =
  /(?:he revisado|leyendo|revisando|ENLACE|ENCONTRADO|no contiene.*enlace)/i;

/** Map classifier model tier to inference provider name. */
function tierToProvider(tier?: string): string | undefined {
  if (tier === "flash") return "fallback";
  if (tier === "capable") return "primary";
  return undefined; // use default provider ordering
}

export const fastRunner: Runner = {
  type: "fast",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();

    // Get tool definitions for requested tools (or all if none specified)
    const definitions = toolRegistry.getDefinitions(input.tools);
    if (definitions.length === 0) {
      return {
        success: false,
        error: "No tools available. Register tools before running fast tasks.",
        durationMs: Date.now() - start,
      };
    }

    // Build messages: if conversation history is provided, use it as proper
    // user/assistant turns so the LLM participates in the conversation rather
    // than reading a transcript embedded in a single message.
    const messages: ChatMessage[] = [];

    if (input.conversationHistory && input.conversationHistory.length > 0) {
      // Chat task: description IS the system prompt (Jarvis persona + context).
      // conversationHistory includes prior turns + current user message as the
      // last entry, so we inject them all as proper message turns.
      messages.push({
        role: "system",
        content: input.description + STATUS_SUFFIX,
      });

      // Inject Jarvis knowledge base files (always-read, enforce, conditional)
      const kb = buildKnowledgeBaseSection(input.tools ?? []);
      if (kb) {
        messages.push({ role: "system", content: kb });
      }

      for (const turn of input.conversationHistory) {
        if (turn.imageUrl && turn.role === "user") {
          // Multimodal: text + image as content array for vision-capable models
          messages.push({
            role: "user",
            content: [
              { type: "text", text: turn.content },
              { type: "image_url", image_url: { url: turn.imageUrl } },
            ],
          });
        } else {
          messages.push({ role: turn.role, content: turn.content });
        }
      }
    } else {
      // Non-chat task: generic system prompt + description as user message
      messages.push({ role: "system", content: GENERIC_SYSTEM_PROMPT });
      messages.push({
        role: "user",
        content: `Task: ${input.title}\n\n${input.description}`,
      });
    }

    // Adaptive limits based on tool type:
    // - Playwright (SPA browsing): 35 rounds / 40K tokens — navigate+snapshot+click cycles
    // - Coding (file_edit, grep): 22 rounds / 30K tokens
    // - Default (chat): 20 rounds / 28K tokens
    const hasPlaywright = input.tools?.some((t) =>
      t.startsWith("playwright__"),
    );
    const hasCodingTools = input.tools?.some((t) =>
      [
        "file_edit",
        "grep",
        "glob",
        "git_commit",
        "git_push",
        "shell_exec",
      ].includes(t),
    );
    const maxRounds = hasPlaywright
      ? MAX_ROUNDS_BROWSER
      : hasCodingTools
        ? MAX_ROUNDS_CODING
        : MAX_ROUNDS_DEFAULT;

    // Per-task execution context: isolates destructive locks + memory rate limits
    const taskContext = new TaskExecutionContext(input.taskId);
    const taskExecutor = createTaskExecutor(toolRegistry, taskContext);

    try {
      let tokenBudget = hasPlaywright
        ? TOKEN_BUDGET_BROWSER
        : hasCodingTools
          ? TOKEN_BUDGET_CODING
          : TOKEN_BUDGET_FAST;
      // Many scoped tools (~15K tokens for 70+ tool defs) leave too little
      // room for tool results, causing budget blow-outs on web_read / browser.
      // Bump to browser-tier budget when tool count is high.
      const toolCount = definitions.length;
      if (toolCount > 60 && tokenBudget < TOKEN_BUDGET_BROWSER) {
        tokenBudget = TOKEN_BUDGET_BROWSER;
      }
      // Vision override: route to primary (vision-capable) when conversation
      // contains images, regardless of classifier-assigned tier.
      const hasVision = input.conversationHistory?.some((t) => t.imageUrl);
      const providerName = hasVision
        ? "primary"
        : tierToProvider(input.modelTier);
      if (hasVision) {
        console.log(
          "[fast-runner] Vision content detected, routing to primary provider",
        );
      }

      const result = await inferWithTools(messages, definitions, taskExecutor, {
        maxRounds,
        providerName,
        tokenBudget,
        onTextChunk: input.onTextChunk,
      });

      let parsed = parseRunnerStatus(result.content);

      // Provider failure or wrap-up failure: force DONE_WITH_CONCERNS regardless
      // of what the LLM says. The task is incomplete — don't claim success.
      if (
        result.exitReason === "provider_failure" ||
        result.exitReason === "wrapup_failed"
      ) {
        parsed = {
          ...parsed,
          status: "DONE_WITH_CONCERNS",
          concerns: [
            `Inference failed mid-execution (${result.exitReason}, round ${result.roundsCompleted}/${maxRounds}). Task may be incomplete.`,
          ],
        };
      }

      // Safety net: if the LLM returned substantial content but reported BLOCKED/NEEDS_CONTEXT,
      // override to DONE_WITH_CONCERNS. This prevents infinite retry loops when the wrap-up
      // call honestly reports limitations but DID produce a useful response.
      if (
        (parsed.status === "BLOCKED" || parsed.status === "NEEDS_CONTEXT") &&
        parsed.cleanContent.length > 100
      ) {
        parsed = {
          ...parsed,
          status: "DONE_WITH_CONCERNS",
          concerns: [
            `Original status: ${parsed.status}. ${parsed.concerns?.[0] ?? "Response promoted to success because content was produced."}`,
          ],
        };
      }

      // Extract tool names that were SUCCESSFULLY called during execution.
      // A tool is only counted as "called" if its result doesn't contain an error.
      // This prevents the hallucination guard from being bypassed when a tool
      // was invoked but failed (truncated args, validation error, API error).
      const toolsCalled: string[] = [];
      const failedToolCalls = new Set<string>();
      for (let i = 0; i < result.messages.length; i++) {
        const msg = result.messages[i];
        if (msg.role === "assistant" && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name;
            if (!name) continue;
            // Find the corresponding tool result message
            const toolResultMsg = result.messages
              .slice(i + 1)
              .find((m) => m.role === "tool" && m.tool_call_id === tc.id);
            const resultContent =
              typeof toolResultMsg?.content === "string"
                ? toolResultMsg.content
                : "";
            // Check if the result is a tool-level error (not just any JSON
            // containing the word "error" — that would match task lists with
            // "error_handling" in titles or status fields).
            const isError =
              resultContent.startsWith('{"error"') ||
              resultContent.startsWith('{"error":') ||
              resultContent.includes("Tool call truncated") ||
              resultContent.includes("Invalid arguments for");
            if (isError) {
              failedToolCalls.add(name);
            } else if (!toolsCalled.includes(name)) {
              toolsCalled.push(name);
            }
          }
        }
      }
      if (failedToolCalls.size > 0) {
        console.log(
          `[fast-runner] Failed tool calls (excluded from toolsCalled): [${[...failedToolCalls].join(", ")}]`,
        );
      }

      // Scope telemetry — record tool execution + repairs
      try {
        recordToolExecution(input.taskId, toolsCalled, [...failedToolCalls]);
        if (result.toolRepairs.length > 0) {
          recordToolRepairs(input.taskId, result.toolRepairs);
        }
      } catch {
        // Non-fatal — telemetry should never block execution
      }

      // Extract last user message for hallucination guard context
      const lastUserMessage = input.conversationHistory
        ?.filter((t) => t.role === "user")
        .pop()?.content;

      // Build failed write tools list for hallucination guard.
      // Exclude tools that failed once but succeeded on a later call within
      // the same execution (first call gets CONFIRMATION_REQUIRED, LLM
      // retries, second call succeeds).
      const failedWriteTools = [...failedToolCalls].filter(
        (t) => WRITE_TOOLS.has(t) && !toolsCalled.includes(t),
      );

      // Hallucination guard: if the LLM narrated tool execution without calling
      // the right tools, retry once if budget has headroom, else replace.
      // Skip for vision tasks — image analysis is a legitimate zero-tool response.
      if (
        !hasVision &&
        detectsHallucinatedExecution(
          parsed.cleanContent,
          toolsCalled,
          lastUserMessage,
          failedWriteTools,
        )
      ) {
        const lastPromptTokens = result.totalUsage.prompt_tokens;
        const hasHeadroom =
          lastPromptTokens < tokenBudget * HALLUCINATION_RETRY_HEADROOM;

        if (hasHeadroom) {
          // Budget has room — retry with correction instead of giving up.
          console.log(
            `[fast-runner] Hallucination detected (prompt=${lastPromptTokens}, budget=${tokenBudget}). Retrying with correction.`,
          );
          // Use result.messages (includes tool results from reads) — NOT the
          // original messages. The LLM needs to see gsheets_read data to act on it.
          // Strip the hallucinated text response (last assistant message).
          const retryMessages: ChatMessage[] = result.messages.filter(
            (m, i) =>
              !(
                i === result.messages.length - 1 &&
                m.role === "assistant" &&
                !m.tool_calls
              ),
          );
          // Context-aware retry message: read vs write hallucination
          const isReadHallucination =
            toolsCalled.length === 0 &&
            READ_HALLUCINATION_RE.test(parsed.cleanContent);
          // Build dynamic write tool list from scoped definitions instead of
          // hardcoding names — prevents the LLM from calling tools that are
          // not in scope and getting rejected in a loop.
          const scopedWriteTools = definitions
            .map((d) => d.function.name)
            .filter((n) => WRITE_TOOLS.has(n));
          const writeToolHint =
            scopedWriteTools.length > 0
              ? scopedWriteTools.join(", ")
              : "file_write, file_edit";
          retryMessages.push({
            role: "user",
            content: isReadHallucination
              ? "ALTO: Narraste una verificación sin llamar herramientas. DEBES llamar wp_read_post o file_read para leer el contenido REAL del artículo antes de reportar si contiene enlaces o no. NO inventes resultados."
              : `ALTO: Narraste acciones de escritura sin llamar las herramientas correctas. Solo llamaste: [${toolsCalled.join(", ")}]. Herramientas de escritura disponibles: [${writeToolHint}]. Llama a la correcta AHORA. NO narres — EJECUTA.`,
          });

          const retryResult = await inferWithTools(
            retryMessages,
            definitions,
            taskExecutor,
            {
              maxRounds: 5,
              providerName: tierToProvider(input.modelTier),
              tokenBudget,
            },
          );
          const retryParsed = parseRunnerStatus(retryResult.content);

          // Collect retry tools (only successfully executed ones)
          const retryToolsCalled: string[] = [];
          for (let ri = 0; ri < retryResult.messages.length; ri++) {
            const rmsg = retryResult.messages[ri];
            if (rmsg.role === "assistant" && rmsg.tool_calls) {
              for (const tc of rmsg.tool_calls) {
                const rname = tc.function?.name;
                if (!rname || retryToolsCalled.includes(rname)) continue;
                const rResultMsg = retryResult.messages
                  .slice(ri + 1)
                  .find((m) => m.role === "tool" && m.tool_call_id === tc.id);
                const rContent =
                  typeof rResultMsg?.content === "string"
                    ? rResultMsg.content
                    : "";
                const rIsError =
                  rContent.startsWith('{"error"') ||
                  rContent.startsWith('{"error":') ||
                  rContent.includes("Tool call truncated") ||
                  rContent.includes("Invalid arguments for");
                if (!rIsError) {
                  retryToolsCalled.push(rname);
                }
              }
            }
          }

          const retryCalledWrite = retryToolsCalled.some((t) =>
            WRITE_TOOLS.has(t),
          );
          if (retryCalledWrite) {
            // Retry succeeded — use its results
            parsed = retryParsed;
            toolsCalled.length = 0;
            toolsCalled.push(...retryToolsCalled);
          }
          // If retry also failed, fall through to mechanical replacement below

          result.totalUsage.prompt_tokens +=
            retryResult.totalUsage.prompt_tokens;
          result.totalUsage.completion_tokens +=
            retryResult.totalUsage.completion_tokens;
        }

        // If no headroom or retry didn't call write tools — mechanical replacement
        if (
          !detectsHallucinatedExecution(
            parsed.cleanContent,
            toolsCalled,
            lastUserMessage,
            failedWriteTools,
          )
        ) {
          // Retry fixed it — skip replacement
        } else {
          console.log(
            `[fast-runner] Hallucination persists. Replacing with honest response. Tools: [${toolsCalled.join(", ")}]`,
          );
          const toolList =
            toolsCalled.length > 0 ? toolsCalled.join(", ") : "ninguna";
          const readHalluc =
            toolsCalled.length === 0 &&
            READ_HALLUCINATION_RE.test(parsed.cleanContent);
          parsed = {
            cleanContent: readHalluc
              ? `⚠️ No verifiqué realmente — narré una verificación sin leer el contenido.\n\n` +
                `**Herramientas que SÍ llamé**: ${toolList}\n` +
                `**Necesito llamar**: wp_read_post o file_read para leer el artículo antes de verificar enlaces.\n\n` +
                `Intenta de nuevo — esta vez leeré el contenido real.`
              : `⚠️ No completé la acción solicitada.\n\n` +
                `**Herramientas que SÍ llamé**: ${toolList}\n` +
                `**Lo que faltó**: Llamar herramientas de escritura para ejecutar los cambios (solo leí datos, no los modifiqué).\n\n` +
                `Intenta con una instrucción más específica, por ejemplo: "actualiza el status de la tarea X a completada".`,
            status: "DONE_WITH_CONCERNS",
            concerns: [
              "Hallucination detected — response mechanically replaced with honest tool inventory",
            ],
          };
        }
      }

      return {
        success:
          parsed.status === "DONE" || parsed.status === "DONE_WITH_CONCERNS",
        status: parsed.status,
        concerns: parsed.concerns,
        output: {
          text: parsed.cleanContent,
          toolCalls: toolsCalled,
          exitReason: result.exitReason,
          roundsCompleted: result.roundsCompleted,
          maxRounds,
          contextPressure: result.contextPressure,
          ...(result.compactionApplied && {
            compactionApplied: result.compactionApplied,
          }),
        },
        toolCalls: toolsCalled,
        tokenUsage: {
          promptTokens: result.totalUsage.prompt_tokens,
          completionTokens: result.totalUsage.completion_tokens,
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    } finally {
      // TaskExecutionContext is GC'd with the task — no global cleanup needed
    }
  },
};

// Auto-register on import
registerRunner(fastRunner);
