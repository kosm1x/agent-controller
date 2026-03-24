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

/** Status suffix appended to chat system prompts. */
const STATUS_SUFFIX = `

When you finish, end your response with exactly one of these status lines:
STATUS: DONE
STATUS: DONE_WITH_CONCERNS — [brief explanation of what concerns you]
STATUS: NEEDS_CONTEXT — [what information is missing]
STATUS: BLOCKED — [what is preventing completion]`;

const MAX_ROUNDS_DEFAULT = 7;
const MAX_ROUNDS_CODING = 15;

/** Confirmation words from the user (Spanish + English). */
const CONFIRM_PATTERN =
  /^(s[ií]|confirmo|dale|ok|yes|hazlo|adelante|proceed|confirm|bórrala|bórralas|elimínalas?|go ahead)(\s|$|[.,!?])/i;
/** Pattern in assistant messages that indicates a deletion confirmation was requested. */
const DELETION_ASK_PATTERN =
  /(?:delete_item|eliminar|borrar|¿confirmo|confirmas|¿(?:lo|la|los|las)\s+(?:elimino|borro)|quieres que (?:elimine|borre)|want me to delete)/i;

/**
 * Check conversation history for a confirmed deletion request.
 * Returns true if an assistant asked about deletion AND the user confirmed after.
 */
export function hasUserConfirmedDeletion(
  history: { role: string; content: string }[],
): boolean {
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
 * WordPress tools that perform write actions — if the response claims WP success
 * but none of these were called, it's a partial hallucination.
 */
const WP_WRITE_TOOLS = [
  "wp_publish",
  "wp_media_upload",
  "wp_delete",
  "wp_raw_api",
  "wp_plugins",
  "wp_settings",
];

/** Patterns that indicate the response claims a WP write action happened. */
const WP_SUCCESS_CLAIMS = [
  // Spanish
  /(?:publicad[oa]|republicad[oa]|actualizado|subid[oa]|eliminad[oa]|configurad[oa]|instalad[oa]|activad[oa]|desactivad[oa])\s+(?:en|el|la|los|las|exitosamente|correctamente|con éxito)/i,
  /art[ií]culo.*(?:publicad[oa]|actualizado|creado)/i,
  /(?:imagen|media|archivo).*(?:subid[oa]|upload)/i,
  /(?:plugin|tema|theme).*(?:instalad[oa]|activad[oa]|desactivad[oa])/i,
  /(?:post|entrada|artículo).*(?:status|estado).*(?:cambiad[oa]|actualizado|publish)/i,
  // English
  /(?:published|updated|uploaded|deleted|installed|activated|deactivated)\s+(?:successfully|to|on|the|in)/i,
  /article.*(?:published|updated|created)/i,
  /(?:image|media|file).*(?:uploaded|created)/i,
  /post.*(?:status|state).*(?:changed|updated|set to)/i,
];

/**
 * Detect hallucinated tool execution — LLM narrates actions without calling tools.
 *
 * Three detection layers:
 * 1. Full hallucination: success marker + concrete claim + zero tools
 * 2. Partial hallucination: claims WP write success but no WP write tool was called
 * 3. Legacy narration patterns (processing steps, FTP claims, etc.)
 *
 * Returns true if the response looks like it's simulating execution.
 */
export function detectsHallucinatedExecution(
  text: string,
  toolsCalled: string[],
): boolean {
  // --- Layer 1: Structural detection (zero tools) ---
  // If response has a success indicator AND claims a concrete outcome (URL, file, ID)
  // but no tools were called, it's almost certainly hallucinated.
  if (toolsCalled.length === 0) {
    const hasSuccessMarker =
      /✅|🚀|EXITOSAMENTE|SUCCESSFULLY|COMPLETADO|STATUS:\s*DONE\b/i.test(text);
    const claimsConcrete =
      // Claims a URL was created/uploaded
      /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|html|php)/i.test(text) ||
      // Claims a file path
      /\/(?:wp-content|tmp|var|home|workspace)\//i.test(text) ||
      // Claims FTP/SSH action
      /(?:vía|via|through)\s+(?:FTP|SSH|SFTP)/i.test(text) ||
      // Narrates processing steps with ellipsis (*(Procesando...)*)
      /\*[^*]*\.\.\.\*/.test(text) ||
      // Claims a completed action with EXITOSAMENTE/correctamente
      /(?:EXITOSAMENTE|correctamente|con éxito|successfully)/i.test(text);
    if (hasSuccessMarker && claimsConcrete) return true;
  }

  // --- Layer 2: Partial hallucination (WP-specific) ---
  // LLM called SOME tools (e.g. wp_list_posts) but narrated WP write actions
  // (publish, upload) without actually calling the corresponding write tool.
  const calledWpWrite = toolsCalled.some((t) => WP_WRITE_TOOLS.includes(t));
  if (!calledWpWrite) {
    const claimsWpSuccess = WP_SUCCESS_CLAIMS.some((p) => p.test(text));
    if (claimsWpSuccess) {
      console.log(
        `[fast-runner] Partial hallucination: response claims WP write success but no WP write tool called. Tools: [${toolsCalled.join(", ")}]`,
      );
      return true;
    }
  }

  // --- Layer 3: Specific narration patterns (legacy, still useful) ---
  // These fire regardless of toolsCalled — narrating processing steps is always wrong.
  const hallucinationPatterns = [
    // Narrated processing steps
    /\*?\((?:Procesando|Ejecutando|Conectando|Subiendo|Descargando|Verificando|Generando|Escaneando|Publicando|Guardando)[^)]*\.\.\.\)\*?/i,
    /\*?\((?:Processing|Executing|Connecting|Uploading|Downloading|Verifying|Generating|Scanning|Publishing|Saving)[^)]*\.\.\.\)\*?/i,
    // Spanish narrated completion
    /(?:Conexión exitosa|Handshake completado|Upload exitoso)/i,
    /(?:he verificado|acabo de verificar|confirmado en tiempo real)/i,
    /acabo de (?:ejecutar|publicar|subir|crear|guardar|actualizar|inyectar|instalar|configurar)/i,
    /(?:ya está|ya queda)\s+(?:live|publicado|en línea|activo|guardado)/i,
    // Connection narration
    /(?:Conexión\s+(?:FTP|SSH|SFTP)).*(?:exitosa|establecida|OK)/i,
    /(?:FTP\s+connection|SSH\s+connection|SFTP\s+connection).*(?:successful|established|OK)/i,
    // English narrated completion
    /(?:just (?:executed|published|uploaded|created|saved|updated|verified))/i,
    /(?:is now live|is now published|has been published)/i,
  ];

  return hallucinationPatterns.some((p) => p.test(text));
}

/** Correction message injected when hallucination is detected. */
const HALLUCINATION_CORRECTION = `SYSTEM OVERRIDE: Your previous response was REJECTED because you narrated tool execution without actually calling tools. This is a critical violation.

WHAT WENT WRONG: You claimed to have performed an action (publish, upload, update, etc.) but your response contained ZERO tool_calls for that action. The system mechanically verifies every response — narrating success without calling tools is always detected and rejected.

RULES FOR THIS RETRY:
1. You MUST call the actual tools (wp_publish, wp_media_upload, etc.) to perform actions
2. If you cannot perform an action, say "No puedo hacer X porque..." — do NOT pretend it worked
3. Confirmation rules STILL APPLY for destructive tools (delete_item, gmail_send, gdrive_share)
4. Your response will be verified AGAIN — do not narrate execution

Respond to the user's request NOW using real tool calls.`;

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

    // Use higher round limit when coding tools are available (file_edit, grep, glob)
    const codingTools = ["file_edit", "grep", "glob"];
    const hasCodingTools = input.tools
      ? input.tools.some((t) => codingTools.includes(t))
      : false;
    const maxRounds = hasCodingTools ? MAX_ROUNDS_CODING : MAX_ROUNDS_DEFAULT;

    // Reset destructive locks, then unlock if user already confirmed in history.
    toolRegistry.resetDestructiveLocks();
    if (
      input.conversationHistory &&
      hasUserConfirmedDeletion(input.conversationHistory)
    ) {
      toolRegistry.unlockDestructive("commit__delete_item");
      console.log(
        "[fast-runner] Destructive tool unlocked: commit__delete_item (user confirmed in history)",
      );
    }

    try {
      const result = await inferWithTools(
        messages,
        definitions,
        (name, args) => toolRegistry.execute(name, args),
        maxRounds,
        undefined, // onTextChunk
        undefined, // signal
        tierToProvider(input.modelTier),
      );

      let parsed = parseRunnerStatus(result.content);

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

      // Extract tool names actually called during execution
      const toolsCalled: string[] = [];
      for (const msg of result.messages) {
        if (msg.role === "assistant" && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.function?.name && !toolsCalled.includes(tc.function.name)) {
              toolsCalled.push(tc.function.name);
            }
          }
        }
      }

      // Hallucination guard: if the LLM narrated tool execution without calling
      // the right tools, inject a correction and retry with CLEAN context.
      // Uses clean context (not poisoned history) to prevent the LLM from
      // repeating its own hallucinated output.
      // Applies to ALL task types — hallucinations happen in both chat and non-chat.
      if (detectsHallucinatedExecution(parsed.cleanContent, toolsCalled)) {
        console.log(
          `[fast-runner] Hallucination detected — tools claimed but not called. Actual tools: [${toolsCalled.join(", ")}]. Retrying with clean context.`,
        );

        // Build CLEAN retry context: strip the hallucinated assistant response
        // and all its tool results. Keep system + conversation history + last
        // user message, then inject the correction as a fresh user message.
        // This prevents the LLM from pattern-matching on its own hallucination.
        const cleanMessages: ChatMessage[] = [];
        for (const msg of messages) {
          cleanMessages.push(msg);
        }
        cleanMessages.push({ role: "user", content: HALLUCINATION_CORRECTION });

        const retryResult = await inferWithTools(
          cleanMessages,
          definitions,
          (name, args) => toolRegistry.execute(name, args),
          maxRounds,
          undefined,
          undefined,
          tierToProvider(input.modelTier),
        );

        const retryParsed = parseRunnerStatus(retryResult.content);

        // Collect tools from retry
        const retryToolsCalled: string[] = [];
        for (const msg of retryResult.messages) {
          if (msg.role === "assistant" && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (
                tc.function?.name &&
                !retryToolsCalled.includes(tc.function.name)
              ) {
                retryToolsCalled.push(tc.function.name);
              }
            }
          }
        }

        // Check if retry ALSO hallucinated.
        // BUT: if the retry actually called tools (even read-only ones like
        // wp_list_posts), it wasn't hallucinating — it just ran out of rounds.
        // The wrap-up response (which has tools=0) shouldn't be penalized for
        // mentioning WP success when it's summarizing what tools accomplished.
        const retryCalledTools = retryToolsCalled.length > 0;
        const retryAlsoHallucinated =
          !retryCalledTools &&
          detectsHallucinatedExecution(
            retryParsed.cleanContent,
            retryToolsCalled,
          );

        if (retryAlsoHallucinated) {
          console.log(
            `[fast-runner] Retry also hallucinated (zero tools called). Returning error.`,
          );
          // Return an explicit failure instead of the hallucinated content
          parsed = {
            cleanContent:
              "No pude completar la acción solicitada. El sistema detectó que la ejecución no se realizó correctamente. Por favor intenta de nuevo o verifica que las herramientas necesarias estén disponibles.",
            status: "DONE_WITH_CONCERNS",
            concerns: [
              "Hallucination detected on both attempts — action was NOT performed",
            ],
          };
          toolsCalled.length = 0;
          toolsCalled.push(...retryToolsCalled);
        } else {
          // Retry succeeded — use its results
          parsed = retryParsed;
          toolsCalled.length = 0;
          toolsCalled.push(...retryToolsCalled);
        }

        result.totalUsage.prompt_tokens += retryResult.totalUsage.prompt_tokens;
        result.totalUsage.completion_tokens +=
          retryResult.totalUsage.completion_tokens;
      }

      return {
        success:
          parsed.status === "DONE" || parsed.status === "DONE_WITH_CONCERNS",
        status: parsed.status,
        concerns: parsed.concerns,
        output: {
          text: parsed.cleanContent,
          toolCalls: toolsCalled,
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
    }
  },
};

// Auto-register on import
registerRunner(fastRunner);
