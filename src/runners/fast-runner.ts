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

/**
 * Detect hallucinated tool execution — LLM narrates actions without calling tools.
 * Returns true if the response looks like it's simulating execution.
 */
function detectsHallucinatedExecution(
  text: string,
  toolsCalled: string[],
): boolean {
  if (toolsCalled.length > 0) return false; // Tools were actually called

  // --- Layer 1: Structural detection ---
  // If response has a success indicator AND claims a concrete outcome (URL, file, ID)
  // but no tools were called, it's almost certainly hallucinated.
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

  // --- Layer 2: Specific narration patterns (legacy, still useful) ---
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
const HALLUCINATION_CORRECTION = `SYSTEM OVERRIDE: Your previous response narrated tool execution WITHOUT actually calling any tools. This is FORBIDDEN.

You MUST use your available tools (function calls) to perform actions. Do NOT describe or narrate execution. Either:
1. Call the appropriate tool NOW, or
2. Explain honestly that you cannot perform the action and what is needed.

Respond again to the user's last message. USE TOOLS, do not narrate.`;

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
      // any tools, inject a correction and retry ONCE. This prevents the model from
      // claiming it "uploaded", "published", or "connected" when it didn't.
      // Applies to ALL task types — hallucinations happen in both chat and non-chat.
      if (detectsHallucinatedExecution(parsed.cleanContent, toolsCalled)) {
        console.log(
          "[fast-runner] Hallucination detected — narrated execution without tool calls. Retrying with correction.",
        );

        // Append the hallucinated response + correction, then re-run
        const retryMessages: ChatMessage[] = [
          ...result.messages,
          { role: "user", content: HALLUCINATION_CORRECTION },
        ];

        const retryResult = await inferWithTools(
          retryMessages,
          definitions,
          (name, args) => toolRegistry.execute(name, args),
          maxRounds,
          undefined,
          undefined,
          tierToProvider(input.modelTier),
        );

        parsed = parseRunnerStatus(retryResult.content);

        // Collect tools from retry
        for (const msg of retryResult.messages) {
          if (msg.role === "assistant" && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              if (
                tc.function?.name &&
                !toolsCalled.includes(tc.function.name)
              ) {
                toolsCalled.push(tc.function.name);
              }
            }
          }
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
