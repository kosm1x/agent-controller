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
import { isReadOnlyTool } from "../inference/guards.js";
import { writeCheckpoint } from "./checkpoint.js";
import { getFilesByQualifier, getFile } from "../db/jarvis-fs.js";
import { getConfig } from "../config.js";

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
/** Known project slugs for README auto-injection. */
const PROJECT_SLUGS = [
  "agent-controller",
  "braid-jarvis",
  "cmll-gira-estrellas",
  "cuatro-flor",
  "livingjoyfully",
  "obsidian-brain",
  "pipesong",
  "presencia-digital-eurekamd",
  "reddit-scraper-tool",
  "vlmp",
];

/** Match project names in message text (slug or natural name). */
function detectProjectInMessage(text: string): string | null {
  const lower = text.toLowerCase();
  for (const slug of PROJECT_SLUGS) {
    // Match slug directly or as separate words (e.g. "cuatro flor", "living joyfully")
    if (lower.includes(slug) || lower.includes(slug.replace(/-/g, " "))) {
      return slug;
    }
  }
  // Common aliases
  if (/\bcrm\b/i.test(text)) return "crm-azteca";
  if (/\bvlmp\b/i.test(text)) return "vlmp";
  if (/\bpipesong\b/i.test(text)) return "pipesong";
  return null;
}

function buildKnowledgeBaseSection(
  scopedTools: string[],
  enforceOnly = false,
  messageText?: string,
): string | null {
  try {
    const files = enforceOnly
      ? getFilesByQualifier("enforce")
      : getFilesByQualifier("always-read", "enforce", "conditional");
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
            scopedTools.includes("northstar_sync")) ||
          (condLower.includes("google") &&
            scopedTools.includes("gmail_send")) ||
          (condLower.includes("wordpress") &&
            scopedTools.includes("wp_publish")) ||
          (condLower.includes("coding") &&
            scopedTools.includes("shell_exec")) ||
          (condLower.includes("browser") &&
            scopedTools.some((t) => t.startsWith("playwright__"))) ||
          (condLower.includes("schedule") &&
            scopedTools.includes("list_schedules")) ||
          (condLower.includes("reporting") &&
            scopedTools.some((t) =>
              ["web_search", "exa_search", "gmail_send"].includes(t),
            ));
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

    // Project README auto-injection: when the user mentions a project by name,
    // inject that project's README.md so the LLM has full context without
    // needing a tool call first.
    if (messageText) {
      const projectSlug = detectProjectInMessage(messageText);
      if (projectSlug) {
        try {
          const readme = getFile(`projects/${projectSlug}/README.md`);
          if (readme && totalChars + readme.content.length < KB_CHAR_BUDGET) {
            sections.push(
              `### Project Context: ${readme.title}\n${readme.content}`,
            );
            totalChars += readme.content.length;
            console.log(
              `[fast-runner] Project README injected: projects/${projectSlug}/README.md (${readme.content.length} chars)`,
            );
          }
        } catch {
          // Project README not found — non-fatal
        }
      }
    }

    if (sections.length === 0) return null;

    if (totalChars > 6000) {
      console.warn(
        `[fast-runner] KB injection at ${totalChars} chars — enforce+always-read files may be too large`,
      );
    }

    return `[JARVIS KNOWLEDGE BASE]\n\n${sections.join("\n\n---\n\n")}`;
  } catch {
    // DB not ready or table missing — non-fatal
    return null;
  }
}

/**
 * Verification nudge appended to multi-step task results (≥3 tool calls with
 * write operations). Inspired by OpenClaude's verification agent discipline:
 * two named failure patterns and an adversarial probe checklist.
 *
 * NOT a blocker — just a reminder appended to the response text so the user
 * (or Jarvis in autonomous mode) is aware verification is warranted.
 */
const VERIFICATION_NUDGE = `

---
⚠ **Verificación pendiente** — Esta tarea usó múltiples herramientas de escritura. Antes de considerar completado:
- Leer ≠ verificar: confirma que los cambios surtieron efecto (lee el resultado, no asumas).
- No caigas en el 80%: el happy path funciona, pero ¿qué pasa con edge cases, entradas vacías, o errores?
- Si modificaste código: ¿corrieron los tests? ¿typecheck pasa?
- Autoevalúa 4 ejes antes de decir "listo" — cada uno necesita evidencia de tools, no tu opinión: instrucción seguida, datos correctos, todo cubierto, formato apropiado.`;

/** Status suffix appended to chat system prompts. */
const STATUS_SUFFIX = `

REQUIRED: End EVERY response with exactly one status line. Omitting it marks your task as incomplete.
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
  // v7.6 gws dispatch: classified as write-capable because the `method`
  // param can be create/update/patch/delete. The hallucination guard will
  // flag any success claim that didn't actually invoke it. For read-only
  // LLM calls (method=list/get), the false-positive cost is minimal — the
  // tool still runs, it just gets tracked in the write-capable set.
  "google_workspace_cli",
  // v7.7.2 Layer 4b retry-swap fix: jarvis_propose_directive is not
  // strictly a "write" tool, but it IS a tool where narrating success
  // without calling it is a hallucination. Including it here lets the
  // fast-runner retry path (line ~1218) swap in the retry output when
  // the LLM finally calls the tool on the second pass. Same rationale
  // as google_workspace_cli above — the set tracks "narrate = must-call".
  "jarvis_propose_directive",
  // File system
  "file_write",
  "file_edit",
  "file_delete",
  // Jarvis knowledge base
  "jarvis_file_write",
  "jarvis_file_update",
  "jarvis_file_delete",
  // Git / GitHub
  "git_commit",
  "git_push",
  "gh_repo_create",
  "gh_create_pr",
  "jarvis_dev",
  "vps_deploy",
  "jarvis_apply_proposal",
  // Other
  "schedule_task",
  "delete_schedule",
  "user_fact_set",
  "user_fact_delete",
  "skill_save",
  "memory_store",
  "shell_exec",
  // F1 finance writes (v7.0 Phase β)
  "market_watchlist_add",
  "market_watchlist_remove",
  "market_watchlist_reseed",
  // v7.13 KB ingestion writes (Phase β S5)
  "kb_ingest_pdf_structured",
  "kb_batch_insert",
  // F7 alpha combination write (Phase β S6) — persists to signal_weights + signal_isq
  "alpha_run",
  // F7.5 strategy backtester write (Phase β S10) — persists to backtest_runs/paths/overfit
  "backtest_run",
  // F8 paper trading write (Phase β S11) — persists to paper_fills/portfolio/balance + trade_theses
  "paper_rebalance",
  // F8.1a PM alpha write (β-addendum) — persists to pm_signal_weights
  "pm_alpha_run",
  // F8.1b PM paper trading write (β-addendum) — persists to pm_paper_fills/portfolio/balance + trade_theses
  "pm_paper_rebalance",
  // v7.10 file conversion — writes converted output to /tmp or /workspace.
  // Narrating "I converted the file to X" without the tool call is a
  // hallucination the WRITE_TOOLS guard catches.
  "file_convert",
]);

/**
 * CCP4: Classify tool errors as transient (worth retrying) vs permanent
 * (should escalate to user). Prevents blind retry of auth failures, missing
 * resources, and permission errors.
 */
export function classifyToolError(
  errorText: string,
): "transient" | "permanent" {
  // Permanent: auth expired, permission denied, not found, invalid args
  if (
    /token.*expir|invalid.?grant|\b401\b|\b403\b|permission.?denied|not.?found|\b404\b|invalid.?argument|does not exist|no.?such/i.test(
      errorText,
    )
  ) {
    return "permanent";
  }
  // Transient: timeouts, rate limits, server errors, network issues
  if (
    /timeout|\b429\b|rate.?limit|too many|\b5\d{2}\b|econnreset|enotfound|fetch.?fail|abort/i.test(
      errorText,
    )
  ) {
    return "transient";
  }
  // Default: treat unknown errors as transient (give it one more shot)
  return "transient";
}

/**
 * Patterns that indicate the response claims a write/mutate action was performed.
 * Generic — covers all tool categories, not just WordPress.
 */
const WRITE_CLAIM_PATTERNS = [
  // Spanish first-person past tense write verbs
  /(?:escribí|actualicé|publiqué|subí|eliminé|borré|envié|configuré|instalé|activé|desactivé|limpié|creé|modifiqué|edité|guardé|programé|completé|empujé|commiteé|comiteé|hice\s+(?:push|commit))\s/i,
  // Tool-mediated subjects (unambiguous — these can't be "state descriptions")
  /(?:sheet|hoja|filas?|celdas?|email|correo|tarea|meta|goal|objetivo|evento|calendario).*(?:actualizada?s?|escrit[oa]s?|completad[oa]s?|enviad[oa]s?|eliminad[oa]s?|creada?s?|publicada?s?|guardada?s?|modificada?s?|subida?s?)/i,
  // Passive voice with explicit verb (catches "artículo fue publicado", "imagen fue subida")
  /(?:fue|fueron|ha sido|han sido)\s+(?:actualizada?s?|escrit[oa]s?|completad[oa]s?|enviad[oa]s?|eliminad[oa]s?|creada?s?|publicada?s?|guardada?s?|modificada?s?|subida?s?)/i,
  // Past participle + success adverb (catches "subida correctamente", "publicado exitosamente")
  /(?:actualizada?|escrit[oa]|completad[oa]|enviad[oa]|eliminad[oa]|creada?|publicada?|guardada?|modificada?|subida?)\s+(?:exitosamente|correctamente|con éxito|successfully)/i,
  // Quantity + action claims ("50 celdas actualizadas", "5 filas escritas")
  /\d+\s+(?:celdas?|filas?|rows?|cells?|entries?|registros?|artículos?|archivos?|eventos?)\s+(?:actualizada?s?|escrit[oa]s?|written|updated|created|deleted|sent|saved)/i,
  // English first-person claims
  /I\s+(?:wrote|updated|published|uploaded|deleted|sent|created|saved|edited|configured|installed|scheduled|cleaned|modified|pushed|committed)\s/i,
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
  // Read/list/query/diagnostic requests: the LLM is reporting state, not claiming writes
  const isReadRequest = userMessage
    ? /\b(lista|listar|list|cu[aá]les|muestra|mostrar|show|dame|dime|qu[eé]\s+(hay|tareas?|metas?|objetivos?|visio)|report[ae]|describe|consulta|status|estado|diagnos|fallo|fail|error|histor|qué\s+pas[oó]|why\s+did|what\s+happened)\b/i.test(
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
      /(?:escribí|actualicé|publiqué|subí|eliminé|borré|envié|configuré|instalé|activé|desactivé|limpié|creé|modifiqué|edité|guardé|programé|completé|marqué|empujé|commiteé|comiteé|hice\s+(?:push|commit))\s/i.test(
        text,
      ) ||
      /I\s+(?:wrote|updated|published|uploaded|deleted|sent|created|saved|edited|pushed|committed)\s/i.test(
        text,
      ) ||
      // Git-specific claims (Spanish + English)
      /(?:PUSH|COMMIT)\s+EXITOSO/i.test(text) ||
      /(?:push|commit)\s+\w*\s*(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      /(?:cambios|changes)\s+\S*\s*(?:subidos?|pushed|enviados?)\s+(?:a|to)\s+(?:GitHub|origin|remote)/i.test(
        text,
      ) ||
      // Passive + success adverb (claim, not observation)
      /(?:fue|fueron|ha sido|han sido)\s+\w+\s*(?:exitosamente|correctamente|con éxito|successfully)/i.test(
        text,
      ) ||
      /(?:was|were|has been|have been)\s+\w+\s*(?:successfully|correctly)/i.test(
        text,
      ) ||
      /(?:publicad[oa]|enviad[oa]|subid[oa]|creada?|eliminad[oa]|compartid[oa]|guardad[oa]|programad[oa]|configurad[oa]|sincronizad[oa])\s+(?:exitosamente|correctamente|con éxito|successfully)/i.test(
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
      /✅[^.\n]{0,30}(?:Marcad[ao]s?|Eliminad[ao]s?|Actualizada?s?|Cambiad[ao]s?|Borrad[ao]s?|Cread[ao]s?|Modificad[ao]s?|Completad[ao]s?|Compartid[ao]s?|Enviad[ao]s?|Publicad[ao]s?|Guardad[ao]s?)/i.test(
        text,
      ) ||
      // "Acciones Ejecutadas" header — narrated action table
      /accione?s?\s+ejecutadas?/i.test(text) ||
      // NOTE: "status[:\s]+completed" was removed (v6.4 OH2) — it's a data label
      // from diagnostic tools (task_history, list_schedules), not a write claim.
      // Real status-change claims are caught by first-person ("marqué como completada")
      // and ✅-participle patterns.
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

  // --- Layer 4: Domain-specific claim mismatch ---
  // Claims about git/PR/branch/push/commit are only valid if git tools were called.
  // Jarvis can write a file to KB (jarvis_file_write) and claim "PR CREADO" —
  // the write tool call makes Layer 2 pass, but the claim domain (git) doesn't
  // match the tool domain (KB). This catches that specific hallucination pattern.
  const GIT_TOOLS = new Set([
    "git_status",
    "git_diff",
    "git_commit",
    "git_push",
    "gh_repo_create",
    "gh_create_pr",
  ]);
  const calledAnyGitTool = toolsCalled.some((t) => GIT_TOOLS.has(t));
  if (!calledAnyGitTool) {
    const claimsGitAction =
      /\bPR\s+CREAD[OA]\b/i.test(text) ||
      /\bPR\s+(?:created|opened|submitted)\b/i.test(text) ||
      /\b(?:branch|rama)\s+(?:cread[oa]|created|pushed)\b/i.test(text) ||
      /\b(?:PUSH|COMMIT)\s+(?:EXITOSO|exitosamente|correctamente|successfully)\b/i.test(
        text,
      ) ||
      /\bhttps:\/\/github\.com\/\S+\/pull\/\d+/i.test(text) ||
      /\bgh\s+pr\s+create\b/i.test(text);
    if (claimsGitAction) {
      console.log(
        `[fast-runner] Git claim hallucination: claims PR/branch/push but no git tool called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

  // --- Layer 4b: Directive-cooldown claim mismatch ---
  // SG4 enforces a 48h cooldown on jarvis_propose_directive. The LLM "knows"
  // the safeguard exists and will sometimes narrate specific cooldown timing
  // ("próxima propuesta en ~15h", "33h ago", "Next allowed in 14.6h") without
  // actually calling the tool to verify. That's a hallucination even when the
  // numbers happen to be close — the process is wrong. Flag and retry so the
  // LLM is forced to call jarvis_propose_directive and echo its real response.
  const calledProposeDirective = toolsCalled.includes(
    "jarvis_propose_directive",
  );
  if (!calledProposeDirective) {
    // Unit token matching minutes / hours / days, spelled-out or short form,
    // Spanish or English: `h`, `hr`, `hrs`, `hour`, `hours`, `hora`, `horas`,
    // `m`, `min`, `mins`, `minuto`, `minutos`, `d`, `day`, `days`, `día`, `días`.
    const NUM = String.raw`\d+(?:[.,]\d+)?`; // allow comma or dot decimal separator
    const UNIT = String.raw`(?:h(?:ours?|rs?|oras?)?|m(?:in(?:ut(?:es?|os?))?)?|d(?:ays?|[ií]as?)?)`;
    const NUM_UNIT = new RegExp(`\\b${NUM}\\s*${UNIT}\\b`, "i");
    const PROP_KEYS = /\b(?:propuesta|directiv|cooldown)/i; // keyword anchor for co-occurrence checks
    // Helper: does the text contain both a numeric-time claim and a
    // propuesta/directiva/cooldown keyword within ~80 chars of each other?
    const hasNearbyNumericTime = (() => {
      const numMatch = NUM_UNIT.exec(text);
      if (!numMatch) return false;
      const propMatch = PROP_KEYS.exec(text);
      if (!propMatch) return false;
      const distance = Math.abs((numMatch.index ?? 0) - (propMatch.index ?? 0));
      return distance <= 120;
    })();

    const claimsDirectiveCooldown =
      // Explicit cooldown-state phrases (these are always hallucinations
      // without the tool call, regardless of numeric co-occurrence):
      /\bcooldown\s+(?:active|activo|activa)\b/i.test(text) ||
      /\b(?:pr[oó]xima|next)\s+(?:propuesta|proposal)\s+(?:disponible\s+)?(?:en|in)\s+~?\d/i.test(
        text,
      ) ||
      /\bpropuesta\s+(?:de\s+directiva\s+)?en\s+(?:cola|cooldown)\b/i.test(
        text,
      ) ||
      /\bnext\s+allowed\s+in\s+\d/i.test(text) ||
      /\blast\s+proposal\s+was\s+\d/i.test(text) ||
      // Spanish "faltan/restan/quedan X unidad" near propuesta/cooldown/directiv
      /\b(?:quedan|faltan|restan)\s+\d+(?:[.,]\d+)?\s*(?:h(?:oras?)?|m(?:in(?:utos?)?)?|d(?:[ií]as?)?)\b[^.\n]{0,80}\b(?:propuesta|cooldown|directiv)/i.test(
        text,
      ) ||
      /\b(?:propuesta|cooldown|directiv)[^.\n]{0,80}\b(?:quedan|faltan|restan)\s+\d+(?:[.,]\d+)?\s*(?:h(?:oras?)?|m(?:in(?:utos?)?)?|d(?:[ií]as?)?)\b/i.test(
        text,
      ) ||
      // English "available in X units" / "in X units" near proposal/cooldown
      /\b(?:available|allowed|ready)\s+(?:in|again\s+in)\s+\d+(?:[.,]\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|d(?:ays?)?)\b[^.\n]{0,80}\b(?:proposal|cooldown|directive)/i.test(
        text,
      ) ||
      /\b(?:proposal|cooldown|directive)[^.\n]{0,80}\b(?:available|allowed|ready)\s+(?:in|again\s+in)\s+\d+(?:[.,]\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|d(?:ays?)?)\b/i.test(
        text,
      ) ||
      // Fallback: numeric-time claim + propuesta/directiv/cooldown keyword
      // within ~120 chars. Catches paraphrases like "handle en 2 días, check
      // el estado de la propuesta" and "the directive window reopens in 45 min".
      hasNearbyNumericTime;

    if (claimsDirectiveCooldown) {
      console.log(
        `[fast-runner] Directive cooldown hallucination: narrates SG4 state but jarvis_propose_directive not called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

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
  // All tool-calling tasks use primary (qwen3.5-plus). kimi-k2.5 (fallback)
  // freezes with 20+ tool schemas — only suitable for wrap-up/extraction.
  if (tier === "capable") return "primary";
  return "primary";
}

export const fastRunner: Runner = {
  type: "fast",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();

    // Get tool definitions for requested tools (or all if none specified).
    // Tool deferral pattern (OpenClaude): deferred tools are NOT included
    // as full schema definitions — only their names + descriptions are sent
    // as a text catalog. This saves significant context tokens when many
    // tools are in scope. When the LLM calls a deferred tool, the executor
    // returns the full schema so the LLM can retry with correct arguments.
    //
    // Small tool sets (≤ 6 tools): skip deferral entirely. Scheduled tasks
    // and rituals have explicit, small tool sets where deferral overhead
    // (extra inference round + timeout risk) outweighs token savings (~200
    // tokens per deferred tool). Deferral is designed for scope-triggered
    // sessions with 20-40+ tools.
    const totalTools = toolRegistry.getDefinitions(input.tools).length;
    const skipDeferral = totalTools <= 6;
    const definitions = toolRegistry.getDefinitions(input.tools, !skipDeferral);
    const deferredCatalog = skipDeferral
      ? undefined
      : toolRegistry.getDeferredCatalog(input.tools);
    const deferredCount = totalTools - definitions.length;
    if (deferredCount > 0) {
      console.log(
        `[fast-runner] Tool deferral: ${definitions.length} full + ${deferredCount} deferred (${totalTools} total)`,
      );
    } else if (skipDeferral && totalTools > 0) {
      console.log(
        `[fast-runner] Deferral skipped: ${totalTools} tools (≤6 threshold)`,
      );
    }
    if (totalTools === 0) {
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

      // v6.5 M2: Essential facts layer — compact identity/context block (~150-200 tokens)
      // Injected before KB so Claude always has core user context even if KB is omitted.
      const { getEssentialFacts } = await import("../memory/essentials.js");
      const essentials = getEssentialFacts("mc-jarvis");
      if (essentials) {
        messages.push({ role: "system", content: essentials });
      }

      // Inject Jarvis knowledge base files (always-read, enforce, conditional).
      // omitKB pattern (OpenClaude): read-only subagents skip KB to save tokens.
      // If ALL scoped tools are read-only, the task is pure research/observation —
      // KB sections (NorthStar visions, directives, conditional files) add ~500-1000
      // tokens of context that won't be acted on. Enforce files are ALWAYS included
      // since they contain safety-critical rules even for read-only operations.
      const scopedTools = input.tools ?? [];
      const isReadOnlyTask =
        scopedTools.length > 0 && scopedTools.every((t) => isReadOnlyTool(t));
      // Extract current user message for project README detection
      const lastUserMsg = input.conversationHistory
        ?.filter((t) => t.role === "user")
        .pop()?.content;
      const kb = buildKnowledgeBaseSection(
        scopedTools,
        isReadOnlyTask,
        lastUserMsg,
      );
      if (kb) {
        messages.push({ role: "system", content: kb });
      }

      // v6.4 CL1.2: Precedent resolution — inject recent entities so the LLM
      // can resolve "it", "that", "the file", "continue" from conversation.
      if (input.conversationHistory.length > 1) {
        const { buildPrecedentBlock } =
          await import("../messaging/precedent.js");
        const precedent = buildPrecedentBlock(input.conversationHistory);
        if (precedent) {
          messages.push({ role: "system", content: precedent });
        }
      }

      // Inject deferred tool catalog (names + descriptions only, no schemas)
      if (deferredCatalog) {
        messages.push({ role: "system", content: deferredCatalog });
      }

      for (const turn of input.conversationHistory) {
        if (turn.imageUrl && turn.role === "user") {
          console.log(
            `[fast-runner] Injecting vision content: text="${turn.content.slice(0, 50)}" imageLen=${turn.imageUrl.length}`,
          );
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
      if (deferredCatalog) {
        messages.push({ role: "system", content: deferredCatalog });
      }
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
    // Non-interactive tasks (scheduled, rituals) bypass the confirmation gate.
    const taskContext = new TaskExecutionContext(
      input.taskId,
      input.interactive !== false,
    );
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

      // v6.4 ST1: exempt email-delivery tasks from analysis_paralysis guard.
      // Research-then-send workflows (scheduled reports) legitimately do many
      // read-only rounds (web_search) before calling gmail_send.
      const hasEmailDelivery = input.tools?.includes("gmail_send") ?? false;

      // Skip tool-skip nudge for short conversational messages (reactions,
      // thanks, agreements) that don't need tool calls. Check the raw user
      // message from the task input, not the enriched conversation messages.
      const rawUserMsgFull =
        input.conversationHistory?.filter((t) => t.role === "user").pop()
          ?.content ?? "";
      // Strip group metadata prefix "[Grupo: ..., De: ...]\n" to get actual text
      const rawUserMsg = rawUserMsgFull
        .replace(/^\[Grupo:.*?\]\n?/i, "")
        .trim();
      const isConversational =
        rawUserMsg.length < 50 &&
        !/\?|busca|crea|haz|envía|agenda|programa|genera|analiz|revis|actualiz|configur|escrib/i.test(
          rawUserMsg,
        );

      // ---------------------------------------------------------------
      // Claude SDK path: delegate to Agent SDK when configured.
      // All prompt building above is reused; we just extract the parts
      // the SDK needs and bypass inferWithTools entirely.
      // ---------------------------------------------------------------
      if (getConfig().inferencePrimaryProvider === "claude-sdk") {
        const { queryClaudeSdk } = await import("../inference/claude-sdk.js");
        type ClaudeSdkImage =
          import("../inference/claude-sdk.js").ClaudeSdkImage;

        // Extract system prompt (all system messages concatenated)
        const systemPrompt = messages
          .filter((m) => m.role === "system")
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("\n\n");

        // Extract user prompt + any vision payloads. Multimodal user messages
        // contain an array of {type:"text"|"image_url"} blocks; we pull text
        // into the prompt string and convert image data URLs to the SDK's
        // base64 image format so the model actually sees the pixels.
        const userParts: string[] = [];
        const sdkImages: ClaudeSdkImage[] = [];
        for (const m of messages) {
          if (m.role === "system") continue;
          if (m.role === "user") {
            if (typeof m.content === "string") {
              userParts.push(m.content);
            } else if (Array.isArray(m.content)) {
              for (const block of m.content) {
                if (typeof block !== "object" || block === null) continue;
                if ("text" in block && typeof block.text === "string") {
                  userParts.push(block.text);
                } else if (
                  "type" in block &&
                  block.type === "image_url" &&
                  "image_url" in block
                ) {
                  const url = (block.image_url as { url?: string })?.url ?? "";
                  const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                  if (match) {
                    const mediaType = match[1];
                    if (
                      mediaType === "image/jpeg" ||
                      mediaType === "image/png" ||
                      mediaType === "image/gif" ||
                      mediaType === "image/webp"
                    ) {
                      sdkImages.push({ mediaType, data: match[2] });
                    }
                  }
                }
              }
            }
          } else if (m.role === "assistant") {
            userParts.push(
              `[Previous response]: ${typeof m.content === "string" ? m.content : ""}`,
            );
          }
        }
        const userPrompt = userParts.join("\n\n");

        // All tool names (no deferral needed — SDK handles schemas internally)
        const allToolNames =
          input.tools ??
          toolRegistry.getDefinitions().map((d) => d.function.name);

        console.log(
          `[fast-runner] Claude SDK path: ${allToolNames.length} tools, maxTurns=${maxRounds}` +
            (sdkImages.length > 0 ? `, images=${sdkImages.length}` : ""),
        );

        const sdkResult = await queryClaudeSdk({
          prompt: userPrompt,
          systemPrompt,
          toolNames: allToolNames,
          maxTurns: maxRounds,
          abortSignal: input.signal,
          ...(sdkImages.length > 0 && { images: sdkImages }),
        });

        // Map SDK result to RunnerOutput
        let parsed = parseRunnerStatus(sdkResult.text);

        // Safety net: if the LLM returned substantial content but reported
        // BLOCKED/NEEDS_CONTEXT (e.g. a confirmation prompt for a destructive
        // action), promote to DONE_WITH_CONCERNS so the content gets delivered.
        // Mirrors the OpenAI path (below, ~line 896). Without this, confirmation
        // prompts from the claude-sdk path get silently dropped because
        // result.success=false → dispatcher marks the task failed and the
        // messaging router sends a generic failure message instead of the text.
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

        return {
          success:
            parsed.status === "DONE" || parsed.status === "DONE_WITH_CONCERNS",
          status: parsed.status,
          concerns: parsed.concerns,
          output: {
            text: parsed.cleanContent,
            toolCalls: sdkResult.toolCalls,
          },
          toolCalls: sdkResult.toolCalls,
          tokenUsage: {
            promptTokens: sdkResult.usage.promptTokens,
            completionTokens: sdkResult.usage.completionTokens,
          },
          durationMs: sdkResult.durationMs || Date.now() - start,
        };
      }

      const result = await inferWithTools(messages, definitions, taskExecutor, {
        maxRounds,
        providerName,
        tokenBudget,
        onTextChunk: input.onTextChunk,
        signal: input.signal,
        exemptAnalysisParalysis: hasEmailDelivery,
        taskId: input.taskId,
        skipToolNudge: isConversational,
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
      // Map tool name → first error message (for retry context)
      const failedToolCalls = new Map<string, string>();
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
              if (!failedToolCalls.has(name)) {
                failedToolCalls.set(name, resultContent.slice(0, 200));
              }
            } else if (!toolsCalled.includes(name)) {
              toolsCalled.push(name);
            }
          }
        }
      }
      if (failedToolCalls.size > 0) {
        console.log(
          `[fast-runner] Failed tool calls (excluded from toolsCalled): [${[...failedToolCalls.keys()].join(", ")}]`,
        );
      }

      // Scope telemetry — record tool execution + repairs
      try {
        recordToolExecution(input.taskId, toolsCalled, [
          ...failedToolCalls.keys(),
        ]);
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
      // Track which write tools failed with a real error (not CONFIRMATION_REQUIRED).
      // CONFIRMATION_REQUIRED is a gate, not a real failure — the tool retries
      // and succeeds on the next call, so exclude those.
      // But "File not found", "Invalid arguments", etc. are real failures —
      // even if a later call with the same tool name succeeds (different args),
      // the first target was never written/deleted.
      const confirmationRetries = new Set<string>();
      for (let ci = 0; ci < result.messages.length; ci++) {
        const cmsg = result.messages[ci];
        if (cmsg.role === "tool" && typeof cmsg.content === "string") {
          if (cmsg.content.includes("CONFIRMATION_REQUIRED")) {
            // Find the tool call that produced this result
            for (let cj = ci - 1; cj >= 0; cj--) {
              const amsg = result.messages[cj];
              if (amsg.role === "assistant" && amsg.tool_calls) {
                for (const tc of amsg.tool_calls) {
                  if (tc.id === cmsg.tool_call_id) {
                    confirmationRetries.add(tc.function?.name ?? "");
                  }
                }
                break;
              }
            }
          }
        }
      }
      const failedWriteTools = [...failedToolCalls.keys()].filter(
        (t) =>
          WRITE_TOOLS.has(t) &&
          // Exclude only confirmation-retry tools that later succeeded
          !(confirmationRetries.has(t) && toolsCalled.includes(t)),
      );

      if (failedWriteTools.length > 0) {
        console.log(
          `[fast-runner] Guard input: failedWriteTools=[${failedWriteTools.join(", ")}], toolsCalled=[${toolsCalled.join(", ")}], contentLen=${parsed.cleanContent.length}`,
        );
      }

      // CCP4: Structured failure recovery protocol.
      // 4 steps: diagnose (extract error) → classify (transient vs permanent) →
      // targeted correction (retry with context OR skip) → respect sound strategy.
      // Max 1 hallucination retry per task. Permanent errors skip retry entirely.
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

        // Step 1 — Diagnose: extract actual error text from failed tools
        const failedErrorContext = failedWriteTools
          .map((t) => {
            const errText = failedToolCalls.get(t);
            return errText
              ? `  - ${t}: ${errText}`
              : `  - ${t}: (unknown error)`;
          })
          .join("\n");
        const hasToolErrors = failedErrorContext.length > 0;

        // Step 2 — Classify: are ALL errors permanent?
        const allPermanent =
          hasToolErrors &&
          failedWriteTools.every((t) => {
            const err = failedToolCalls.get(t) ?? "";
            return classifyToolError(err) === "permanent";
          });

        // Step 3 — Decide: retry only if transient errors + budget headroom
        const shouldRetry = hasHeadroom && !allPermanent;

        if (shouldRetry) {
          console.log(
            `[fast-runner] Hallucination detected (prompt=${lastPromptTokens}, budget=${tokenBudget}). Retrying with correction.`,
          );
          const retryMessages: ChatMessage[] = result.messages.filter(
            (m, i) =>
              !(
                i === result.messages.length - 1 &&
                m.role === "assistant" &&
                !m.tool_calls
              ),
          );
          const isReadHallucination =
            toolsCalled.length === 0 &&
            READ_HALLUCINATION_RE.test(parsed.cleanContent);
          const scopedWriteTools = definitions
            .map((d) => d.function.name)
            .filter((n) => WRITE_TOOLS.has(n));
          const writeToolHint =
            scopedWriteTools.length > 0
              ? scopedWriteTools.join(", ")
              : "file_write, file_edit";

          let retryContent: string;
          if (isReadHallucination) {
            retryContent =
              "ALTO: Narraste una verificación sin llamar herramientas. DEBES llamar wp_read_post o file_read para leer el contenido REAL del artículo antes de reportar si contiene enlaces o no. NO inventes resultados.";
          } else if (hasToolErrors) {
            retryContent =
              `ALTO: Las siguientes herramientas FALLARON con errores reales:\n${failedErrorContext}\n\n` +
              `Si el error es permanente (token expirado, permiso denegado, recurso no encontrado), ` +
              `NO reintentes — reporta el error al usuario. ` +
              `Si el error es transitorio (timeout, rate limit), intenta de nuevo. ` +
              `Herramientas disponibles: [${writeToolHint}].`;
          } else {
            retryContent = `ALTO: Narraste acciones de escritura sin llamar las herramientas correctas. Solo llamaste: [${toolsCalled.join(", ")}]. Herramientas de escritura disponibles: [${writeToolHint}]. Llama a la correcta AHORA. NO narres — EJECUTA.`;
          }
          retryMessages.push({ role: "user", content: retryContent });

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
          // Step 4 — Honest replacement with diagnosis
          const reason = allPermanent
            ? "permanent tool errors (retry skipped)"
            : "hallucination persists after retry";
          console.log(
            `[fast-runner] ${reason}. Replacing with honest response. Tools: [${toolsCalled.join(", ")}]`,
          );
          const toolList =
            toolsCalled.length > 0 ? toolsCalled.join(", ") : "ninguna";
          const readHalluc =
            toolsCalled.length === 0 &&
            READ_HALLUCINATION_RE.test(parsed.cleanContent);

          // Build error diagnosis for the user when tools failed
          const errorDiagnosis =
            hasToolErrors && failedWriteTools.length > 0
              ? `\n\n**Errores de herramientas**:\n${failedWriteTools
                  .map((t) => {
                    const err = failedToolCalls.get(t) ?? "desconocido";
                    const cls = classifyToolError(err);
                    return `- ${t}: ${err.slice(0, 100)} (${cls === "permanent" ? "permanente — requiere acción manual" : "transitorio — reintenta"})`;
                  })
                  .join("\n")}`
              : "";

          parsed = {
            cleanContent: readHalluc
              ? `⚠️ No verifiqué realmente — narré una verificación sin leer el contenido.\n\n` +
                `**Herramientas que SÍ llamé**: ${toolList}\n` +
                `**Necesito llamar**: wp_read_post o file_read para leer el artículo antes de verificar enlaces.\n\n` +
                `Intenta de nuevo — esta vez leeré el contenido real.`
              : `⚠️ No completé la acción solicitada.\n\n` +
                `**Herramientas que SÍ llamé**: ${toolList}\n` +
                `**Lo que faltó**: Llamar herramientas de escritura para ejecutar los cambios.${errorDiagnosis}\n\n` +
                `Intenta con una instrucción más específica, o resuelve los errores permanentes primero.`,
            status: "DONE_WITH_CONCERNS",
            concerns: [
              `Hallucination detected — ${reason}. Response mechanically replaced with honest tool inventory`,
            ],
          };
        }
      }

      // Fallback: if the LLM's final response is a refusal but tools DID execute
      // and return results, use the last successful tool result as the response.
      // This catches the fallback model pattern: calls tool → gets results → says
      // "no tengo esa herramienta" or gives a short refusal instead of the data.
      const REFUSAL_RE =
        /\b(no tengo|no puedo|no disponible|not available|cannot|unable to)\b/i;
      if (
        parsed.cleanContent.length < 100 &&
        REFUSAL_RE.test(parsed.cleanContent) &&
        toolsCalled.length > 0
      ) {
        // Find the last successful tool result
        const toolResults = result.messages.filter(
          (m) =>
            m.role === "tool" &&
            typeof m.content === "string" &&
            m.content.length > 50,
        );
        if (toolResults.length > 0) {
          const lastResult = toolResults[toolResults.length - 1]
            .content as string;
          console.log(
            `[fast-runner] LLM refused after tool success. Using tool result directly (${lastResult.length} chars)`,
          );
          parsed = {
            ...parsed,
            cleanContent: lastResult,
            status: "DONE_WITH_CONCERNS",
            concerns: [
              "LLM refused to format tool results. Raw tool output shown.",
            ],
          };
        }
      }

      // Verification discipline: for multi-step tasks (≥3 tool calls), append
      // a verification nudge to the result. Inspired by OpenClaude's verification
      // agent pattern: "reading is not verification — run it."
      // Two named failure modes:
      //   1. Verification avoidance: reading code instead of testing it
      //   2. First-80% seduction: stopping after the happy path works
      if (
        toolsCalled.length >= 3 &&
        parsed.status === "DONE" &&
        result.exitReason === "natural"
      ) {
        // Use the curated READ_ONLY_TOOLS set (inverted) instead of a manual
        // write-tool list — covers git, Drive, Calendar, video, and future tools.
        const hasWriteTools = toolsCalled.some((t) => !isReadOnlyTool(t));
        if (hasWriteTools) {
          parsed = {
            ...parsed,
            cleanContent: parsed.cleanContent + VERIFICATION_NUDGE,
          };
        }
      }

      // v6.4 QP1: Post-task quality check — detect delivery misses and tool gaps.
      // This catches issues that the hallucination guard misses because the LLM
      // DID call some tools but skipped the critical delivery step.
      const qpConcerns: string[] = [];
      if (
        hasEmailDelivery &&
        !toolsCalled.includes("gmail_send") &&
        parsed.status === "DONE"
      ) {
        qpConcerns.push(
          "Delivery miss: gmail_send was in scope but never called. Email was not sent.",
        );
      }

      // CCP2/QP2: Read-after-write verification — check that write tools that
      // WERE called actually returned success markers, not silent failures.
      // Maps tool name → expected success marker in the result JSON.
      const WRITE_VERIFICATION: Record<string, string> = {
        gmail_send: '"sent":true',
        gdrive_create: '"id"',
        gdrive_upload: '"id"',
        gsheets_write: '"cells"',
        calendar_create: '"id"',
        calendar_update: '"id"',
        gdocs_write: '"document_id"',
        gslides_create: '"presentationId"',
        gtasks_create: '"id"',
        wp_publish: '"post_id"',
      };
      for (const msg of result.messages) {
        if (msg.role !== "assistant" || !msg.tool_calls) continue;
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (!name || !WRITE_VERIFICATION[name]) continue;
          if (!toolsCalled.includes(name)) continue; // already flagged as failed
          const toolResultMsg = result.messages.find(
            (m) => m.role === "tool" && m.tool_call_id === tc.id,
          );
          const content =
            typeof toolResultMsg?.content === "string"
              ? toolResultMsg.content
              : "";
          if (!content.includes(WRITE_VERIFICATION[name])) {
            qpConcerns.push(
              `Write verification failed: ${name} was called but result lacks expected success marker (${WRITE_VERIFICATION[name]}).`,
            );
          }
        }
      }

      if (qpConcerns.length > 0) {
        console.warn(
          `[fast-runner] QP quality check: ${qpConcerns.join("; ")}`,
        );
        parsed = {
          ...parsed,
          status: "DONE_WITH_CONCERNS",
          concerns: [...(parsed.concerns ?? []), ...qpConcerns],
        };
      }

      // Task continuity: save checkpoint when hitting max_rounds or token_budget
      // so user can say "continúa" and resume where we left off.
      if (
        result.exitReason === "max_rounds" ||
        result.exitReason === "token_budget"
      ) {
        try {
          const lastUserMsg =
            input.conversationHistory?.filter((t) => t.role === "user").pop()
              ?.content ?? input.description;
          writeCheckpoint({
            taskId: input.taskId,
            title: input.title,
            userMessage: lastUserMsg,
            toolsCalled,
            scopeGroups: [], // Re-derived from message on continuation
            exitReason: result.exitReason,
            roundsCompleted: result.roundsCompleted,
            maxRounds,
            responseText: parsed.cleanContent,
          });
        } catch {
          // Non-fatal — checkpoint is best-effort
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
          ...(taskContext.getPendingConfirmation() && {
            pendingConfirmation: taskContext.getPendingConfirmation(),
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
