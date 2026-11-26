/**
 * Fast Runner — In-process LLM + tool loop.
 *
 * Sends a task description to the LLM with available tools. The LLM calls tools,
 * results are appended, and it loops until a text-only response or max rounds.
 * Fastest runner type — no containers, no planning overhead.
 */

import {
  inferWithTools,
  inferWithToolsLastline,
  lastlineEligible,
  sdkLastline,
} from "../inference/adapter.js";
import type { ChatMessage, ToolCall } from "../inference/adapter.js";
import { toolRegistry, writeTargetKeys } from "../tools/registry.js";
import { registerRunner } from "../dispatch/dispatcher.js";
import { parseRunnerStatus } from "./status.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";
import {
  runnerExecutionContext,
  runWithExecutionContext,
} from "../inference/execution-context.js";
import { createTaskExecutor } from "../tools/task-executor.js";
import { externalToolGuard } from "../tools/external-tool-guard.js";
import {
  recordToolExecution,
  recordToolRepairs,
} from "../intelligence/scope-telemetry.js";
import { recordFastRetryOutcome } from "../observability/prometheus.js";
import { isReadOnlyTool } from "../inference/guards.js";
import { terminationFromExit } from "./termination.js";
import { writeCheckpoint } from "./checkpoint.js";
import { dumpPrompt } from "./prompt-dump.js";
import { conditionMatches } from "../messaging/kb-injection.js";
import { buildConfirmRegex } from "../messaging/confirmation-verbs.js";
import { getConfig } from "../config.js";
import {
  queryClaudeSdk,
  toolSearchEnabled,
  type ClaudeSdkImage,
} from "../inference/claude-sdk.js";
import {
  WRITE_TOOLS,
  classifyToolError,
  detectsHallucinatedExecution,
} from "./hallucination-guard.js";
import {
  denueGuardText,
  highStakesGuardVariant,
  mentionsDenue,
} from "./denue-guard.js";

// Re-export for back-compat with existing imports (e.g. tests).
export { conditionMatches };
// Defined in modules of their own that never import the fast runner;
// re-exported here so existing importers keep working.
export { WRITE_TOOLS, classifyToolError, detectsHallucinatedExecution };
export { denueGuardText, highStakesGuardVariant, mentionsDenue };

/**
 * Split system messages into the cache-aware (stable) and cache-bypass
 * (variable) buckets per the `ChatMessage.cacheable` hint. Stable parts are
 * destined for the SDK's `systemPrompt` (single `cache_control` marker at
 * end); variable parts are routed to the head of the user-message blob so
 * per-task byte-drift doesn't invalidate the cached systemPrompt prefix.
 *
 * Used by the fast-runner SDK path. `flattenMessagesForSdk` applies the same
 * `cacheable === false` routing rule with its own loop (it does not call this
 * helper), so a change to the rule must be made in both places.
 */
export function splitSystemMessagesByCache(messages: ChatMessage[]): {
  stable: string[];
  variable: string[];
} {
  const stable: string[] = [];
  const variable: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text) continue;
    if (m.cacheable === false) variable.push(text);
    else stable.push(text);
  }
  return { stable, variable };
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

import {
  MAX_ROUNDS_DEFAULT,
  MAX_ROUNDS_CODING,
  MAX_ROUNDS_BROWSER,
  LOOP_MAX_TURNS,
  TOKEN_BUDGET_FAST,
  TOKEN_BUDGET_CODING,
  TOKEN_BUDGET_BROWSER,
  HALLUCINATION_RETRY_HEADROOM,
} from "../config/constants.js";
import { errMsg } from "../lib/err-msg.js";
import { getEventBus } from "../lib/event-bus.js";
import { emitTraceEvent } from "../observability/task-trace.js";
import { buildFastRunnerMessages } from "./fast-runner-messages.js";
// Moved with the message assembly; re-exported so existing importers keep working.
export { GENERIC_SYSTEM_PROMPT, STATUS_SUFFIX } from "./fast-runner-messages.js";

/** Confirmation words from the user — built from the shared vocabulary in
 * `messaging/confirmation-verbs.ts` so this regex stays in lockstep with
 * `messaging/confirmations.ts`. Two parallel regexes diverged before v7.6
 * Spine 1; the unified vocabulary prevents future drift. F5 audit fix.
 *
 * Uses **strict** mode because `hasUserConfirmedDeletion` is inherently a
 * destructive flow — accepting `súbelo`/`créalo` for a deletion two-step
 * would be the exact verb/op-mismatch the strict mode was designed to
 * prevent. C3 audit fix (round 2, 2026-05-08). */
const CONFIRM_PATTERN = buildConfirmRegex("strict");

/** Phase 4.3: auth-class provider failures — expired/revoked OAuth or API
 *  key. Matched against the run's final content, which carries the SDK's
 *  error marker on the error path. `authentication_failed` is the SDK's typed
 *  class and `OAuth session expired` the CLI's dead-login text — the 09-19
 *  outage matched neither of the older alternatives. */
const AUTH_ERROR_RE =
  /\b401\b|authentication_error|authentication_failed|invalid x-api-key|OAuth token.{0,40}(expired|revoked)|OAuth session expired|token (expirad|revocad)/i;

type LoopUsage = Awaited<ReturnType<typeof inferWithTools>>["totalUsage"];

/** Usage of two legs of one run, summed field by field: every leg's tokens
 *  reach the ledger. An optional cache count stays absent when neither leg
 *  reported it (the OpenAI path has no prompt cache). */
function sumLoopUsage(a: LoopUsage, b: LoopUsage): LoopUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    ...((a.cache_read_tokens !== undefined ||
      b.cache_read_tokens !== undefined) && {
      cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0),
    }),
    ...((a.cache_creation_tokens !== undefined ||
      b.cache_creation_tokens !== undefined) && {
      cache_creation_tokens:
        (a.cache_creation_tokens ?? 0) + (b.cache_creation_tokens ?? 0),
    }),
  };
}

/** An SDK leg's usage in the tool loop's field names. A cache count is
 *  emitted only when nonzero, as the SDK's own loop mapping does, so an
 *  absent field stays absent. */
function sdkUsageAsLoop(u: {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): LoopUsage {
  return {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    ...(u.cacheReadTokens > 0 && { cache_read_tokens: u.cacheReadTokens }),
    ...(u.cacheCreationTokens > 0 && {
      cache_creation_tokens: u.cacheCreationTokens,
    }),
  };
}

/** A tool result the openai path counts as a failed call: a tool-level
 *  error object or an argument fault, not any text that mentions "error". */
function isToolErrorContent(content: string): boolean {
  return (
    content.startsWith('{"error"') ||
    content.startsWith('{"error":') ||
    content.includes("Tool call truncated") ||
    content.includes("Invalid arguments for")
  );
}

/** A tool result that positively reports success: present, not an error by
 *  this runner's rule nor by the registry's (it mirrors `isErrorResult` in
 *  tools/registry.ts: a leading `{"error"`, `Error` or ❌ after optional
 *  whitespace), not a JSON object whose `success` or `ok` is false, and not
 *  a deferred-tool schema expansion (a schema shown, not a write done). */
function isPositiveToolResult(content: string): boolean {
  if (content.trim() === "" || isToolErrorContent(content)) return false;
  if (/^\s*(\{\s*"error"|Error\b|❌)/.test(content)) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (o.success === false || o.ok === false) return false;
      if (o.deferred_expansion === true) return false;
    }
  } catch {
    // Not JSON: the text tests above decide.
  }
  return true;
}

/** The keys a write call targets, each tagged with its tool: the artifact
 *  keys `writeTargetKeys` derives from its arguments, else the arguments
 *  themselves in key-sorted form so that equal values match in any order.
 *  Unparseable arguments give no key, so such a call never matches. */
function writeCallKeys(tc: ToolCall): string[] {
  const name = tc.function?.name;
  if (!name) return [];
  let args: unknown;
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    return [];
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const targets = writeTargetKeys(name, args as Record<string, unknown>);
  if (targets.length > 0) {
    return targets.map((t) => JSON.stringify([name, "target", t]));
  }
  const sorted = JSON.stringify(args, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
  return [JSON.stringify([name, "args", sorted])];
}

/** SDK built-ins that can land in a run's toolCalls and change nothing:
 *  `queryClaudeSdk` admits only `ToolSearch` (`tools: ["ToolSearch"]` when
 *  armed; every other built-in is disabled). A fresh leg must re-run it to
 *  load deferred schemas, so it never counts as already-done work. */
const SDK_READ_ONLY_BUILTINS = new Set(["ToolSearch"]);

/** SDK API-error classes meaning "the Anthropic side is unavailable" — the
 *  only ones the SDK last line answers. Request faults (invalid_request,
 *  max_output_tokens, model_not_found) are excluded: a wrong model id or an
 *  oversized prompt must fail loudly, not degrade to another provider;
 *  authentication_failed keeps its own retry path. */
const LASTLINE_API_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "overloaded",
  "rate_limit",
  "server_error",
  "unknown",
  "account_on_hold",
  "billing_error",
  "oauth_org_not_allowed",
  "verification_required",
  "cloud_credential_error",
]);

/** Cut `text` at `i`, together with the newline run right before it. */
function cutWithLeadingNewlines(text: string, i: number): string {
  let k = i;
  while (k > 0 && text[k - 1] === "\n") k--;
  return text.slice(0, k);
}

/** ≡ `text.replace(/\n*STATUS: DONE_WITH_CONCERNS[^]*$/, "")`, linear (the
 *  regex is quadratic on long blank-line runs). Exported for tests. */
export function stripConcernsTrailer(text: string): string {
  const i = text.indexOf("STATUS: DONE_WITH_CONCERNS");
  return i < 0 ? text : cutWithLeadingNewlines(text, i);
}

/** ≡ `text.replace(/\n*STATUS:[^\n]*$/, "")` — the first `STATUS:` on the
 *  final line and the newline run before it — linear. Exported for tests. */
export function stripFinalStatusLine(text: string): string {
  const i = text.indexOf("STATUS:", text.lastIndexOf("\n") + 1);
  return i < 0 ? text : cutWithLeadingNewlines(text, i);
}

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

const READ_HALLUCINATION_RE =
  /(?:he revisado|leyendo|revisando|ENLACE|ENCONTRADO|no contiene.*enlace)/i;

/** Map classifier model tier to inference provider name. */
function tierToProvider(tier?: string): string | undefined {
  // All tool-calling tasks use primary (qwen3.5-plus). kimi-k2.5 (fallback)
  // freezes with 20+ tool schemas — only suitable for wrap-up/extraction.
  if (tier === "capable") return "primary";
  return "primary";
}

/**
 * Map classifier model tier to a reasoning effort: flash → low, standard →
 * medium, capable → high; any other tier, or none, → undefined. The value is
 * passed to the `runInfer` calls below (main, auto-resume, auth retry, write
 * retry), which run `inferWithToolsViaOpenAi` (through `inferWithTools` or
 * `inferWithToolsLastline`); that loop does not read it. The `queryClaudeSdk`
 * legs are deliberately not given it (a ruled choice, revisited at model
 * upgrades).
 */
function tierToEffort(tier?: string): "low" | "medium" | "high" | undefined {
  if (tier === "flash") return "low";
  if (tier === "standard") return "medium";
  if (tier === "capable") return "high";
  return undefined;
}

/** Most names an own tool list may have and still be loaded up front. */
const OWN_LIST_UP_FRONT_MAX = 12;

/**
 * On the other model path, a run submitted as not interactive (no operator to
 * confirm in), with its own tool list and no conversation history, gets every
 * tool of a short list loaded up front, so the model calls a deferred one
 * without searching first. The length counted is the list as the run carries
 * it: the same names the call receives.
 */
function loadsOwnListUpFront(input: RunnerInput): boolean {
  return (
    input.interactive === false &&
    input.tools !== undefined &&
    input.tools.length > 0 &&
    !input.conversationHistory?.length &&
    input.tools.length <= OWN_LIST_UP_FRONT_MAX
  );
}

// The branches (SDK, last line / OpenAI loop, thrown error). Callers go
// through `fastRunner`, which applies the cancellation rule to every one.
const fastRunnerBranches = {
  async execute(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();
    // Get tool definitions for the run's tools.
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
    //
    // A declared EMPTY list is no tools (the run's declared set); no list is
    // every registered tool.
    const declaresNone = input.tools?.length === 0;
    const allDefinitions = declaresNone
      ? []
      : toolRegistry.getDefinitions(input.tools);
    const totalTools = allDefinitions.length;
    const skipDeferral = totalTools <= 6;
    const definitions = skipDeferral
      ? allDefinitions
      : toolRegistry.getDefinitions(input.tools, true);
    // On the claude-sdk path with tool search armed, the SDK advertises the
    // deferred tools itself; the text catalog duplicated them and told the
    // model to call them by name (audit 2026-09-22 context-04).
    const sdkToolSearch =
      getConfig().inferencePrimaryProvider === "claude-sdk" &&
      toolSearchEnabled();
    const deferredCatalog =
      skipDeferral || sdkToolSearch
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
    if (totalTools === 0 && !declaresNone) {
      return {
        success: false,
        error: "No tools available. Register tools before running fast tasks.",
        durationMs: Date.now() - start,
      };
    }

    const messages = await buildFastRunnerMessages(input, deferredCatalog);

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
    // `/loop` (operator-instructed): the cap is lifted for THIS task only.
    const scopeMaxRounds = hasPlaywright
      ? MAX_ROUNDS_BROWSER
      : hasCodingTools
        ? MAX_ROUNDS_CODING
        : MAX_ROUNDS_DEFAULT;
    const maxRounds = input.unlimited
      ? LOOP_MAX_TURNS
      : input.external
        ? Math.min(scopeMaxRounds, input.external.maxRounds)
        : scopeMaxRounds;

    // Per-task execution context: isolates destructive locks + memory rate limits
    // Non-interactive tasks (scheduled, rituals) bypass the confirmation gate.
    // Takes the dispatcher's confirmation facts for this task: it may ask
    // only on a router-tracked operator root (it surfaces the pending below).
    const taskContext = runnerExecutionContext(
      input.taskId,
      input.interactive !== false,
      input.external ? (input.tools ?? []) : undefined,
    );
    // External request: the SDK path is guarded through taskContext
    // (claude-sdk wrapTool); the OpenAI path through this executor wrapper.
    const taskExecutor = input.external
      ? externalToolGuard(
          createTaskExecutor(toolRegistry, taskContext),
          input.tools ?? [],
        )
      : createTaskExecutor(toolRegistry, taskContext);

    // Liveness heartbeat. The stuck watchdog (reactions/manager.ts) keys on
    // tasks.updated_at, which only task.progress refreshes; fast tasks emitted
    // none, so any run past 15 min was failed as "stuck" while still working
    // and its finished answer was then discarded by the terminal-status
    // guard (3 on record, 3.3-4.0 KB each). Mirrors the 60 s container
    // heartbeat in container.ts. Started right before the try so the
    // finally always clears it — earlier returns/throws leaked it (audit
    // 2026-09-22).
    const heartbeat = setInterval(() => {
      try {
        getEventBus().emitEvent("task.progress", {
          task_id: input.taskId,
          agent_id: "fast",
          progress: Number.NaN,
          phase: "execute",
          message: "Fast-runner heartbeat",
        });
      } catch {
        // Best-effort — the bus may be uninitialised (tests).
      }
    }, 60_000);
    heartbeat.unref();

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
        // Phase 4 R1 audit R4: short imperatives are TASKS, not chit-chat —
        // "manda el reporte" must keep its auto-resume (and its nudge).
        !/\?|busca|crea|haz|envía|envia|manda|agenda|programa|genera|analiz|revis|actualiz|configur|escrib|dime|dame|traduce|calcula|publica|corre|lista|muestra|borra|elimina|verifica|checa|consulta|resume|apaga|prende|sube|baja|instala|arregla|corrige/i.test(
          rawUserMsg,
        );

      // PROMPT_DUMP_DIR (queue 3v): the assembled array, before either
      // provider path reshapes it. Never throws.
      const promptDumpDir = getConfig().promptDumpDir;
      if (promptDumpDir) dumpPrompt(promptDumpDir, input.taskId, messages);

      // SDK last line (2026-10-23): set when the SDK leg(s) failed and the
      // fallback provider is armed (sdkLastline) — `break sdkPath` then runs
      // the request on the openai path below, with its post-processing.
      let lastline: { model: string } | null = null;
      // Usage of the SDK attempts the last line abandons: those legs run
      // unmetered (costLedger: false), so the reported total must carry them.
      let abandonedSdkUsage: LoopUsage | null = null;
      // One journal line + one trace event per engagement (emitTraceEvent
      // never throws — tracing must not break the traced task).
      const engageLastline = (
        armed: { model: string },
        reason: "throw" | "auth" | "api_error",
        errorClass?: string,
        cause?: string,
      ): { model: string } => {
        console.warn(
          `[fast-runner] sdk last line engaged task=${input.taskId} reason=${reason}${errorClass ? ` class=${errorClass}` : ""} model=${armed.model}${cause ? ` err=${cause}` : ""}`,
        );
        emitTraceEvent({
          taskId: input.taskId,
          runId: input.runId,
          name: "inference.lastline",
          attrs: {
            provider: "fallback",
            model: armed.model,
            reason,
            ...(errorClass && { errorClass }),
          },
        });
        return armed;
      };

      // ---------------------------------------------------------------
      // Claude SDK path: delegate to Agent SDK when configured.
      // All prompt building above is reused; we just extract the parts
      // the SDK needs and bypass inferWithTools entirely.
      // ---------------------------------------------------------------
      sdkPath: if (getConfig().inferencePrimaryProvider === "claude-sdk") {
        // Route `cacheable:false` system messages to the user-prompt prefix
        // so per-task byte-drift doesn't invalidate the cached systemPrompt.
        // Variable text lands FIRST in userParts below so the model still
        // sees it before the user turn.
        const { stable: stableSystemParts, variable: variableSystemParts } =
          splitSystemMessagesByCache(messages);
        const systemPrompt = stableSystemParts.join("\n\n");

        // Extract user prompt + any vision payloads. Multimodal user messages
        // contain an array of {type:"text"|"image_url"} blocks; we pull text
        // into the prompt string and convert image data URLs to the SDK's
        // base64 image format so the model actually sees the pixels.
        // Variable system content (from the cacheable:false routing above)
        // lands FIRST so the model still sees it before the user turn but
        // its byte-drift doesn't touch the cached systemPrompt.
        const userParts: string[] = [...variableSystemParts];
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
        const loadToolsUpFront = loadsOwnListUpFront(input);

        console.log(
          `[fast-runner] Claude SDK path: ${allToolNames.length} tools, maxTurns=${input.unlimited ? "unlimited (/loop)" : maxRounds}` +
            (sdkImages.length > 0 ? `, images=${sdkImages.length}` : ""),
        );

        // The confirmation gate on the SDK path reads this context (wrapTool →
        // confirmationGate); entered around every queryClaudeSdk leg below.
        let sdkResult: Awaited<ReturnType<typeof queryClaudeSdk>>;
        try {
          sdkResult = await runWithExecutionContext(taskContext, () =>
            queryClaudeSdk({
              prompt: userPrompt,
              systemPrompt,
              toolNames: allToolNames,
              loadToolsUpFront,
              maxTurns: maxRounds,
              unlimited: input.unlimited,
              abortSignal: input.signal,
              // Metered by the dispatcher aggregate over result.tokenUsage (and
              // by recordReflectionCost when reflection invokes this runner
              // directly) — seam recording here would double-count. (3.3)
              costLedger: false,
              // Phase 6: per-turn/per-tool timeline correlated to this task.
              // Reflection invokes execute() without a real task row — those
              // emits still land and prune with the 30d window; harmless.
              trace: { taskId: input.taskId, runId: input.runId },
              ...(sdkImages.length > 0 && { images: sdkImages }),
            }),
          );
        } catch (sdkErr) {
          const armed = lastlineEligible(sdkErr) ? sdkLastline() : null;
          if (!armed) throw sdkErr;
          lastline = engageLastline(
            armed,
            "throw",
            undefined,
            // One journal line, bounded: a stack or a CLI dump stays out.
            errMsg(sdkErr).replace(/\s+/g, " ").slice(0, 200),
          );
          break sdkPath;
        }

        // ── Phase 4.3 on the PRODUCTION path (R1 audit C1: the first cut
        // lived only on the openai branch, which this box never runs). ──
        //
        // Cap detection uses the SDK's own terminal markers: queryClaudeSdk
        // embeds `[error_max_turns — …]` / `[error_max_budget_usd — …]` on
        // the error path. A BLOCKED without a marker is a confirmation
        // prompt, NOT a cap — it must never trigger a resume. `[timeout` is
        // deliberately NOT a trigger (R2 audit W4): the SDK timeout is 900s
        // while the router abandons the pendingReply at 660s, so a resume
        // after a timeout burns a full leg into a reply nobody delivers.
        const sdkCapped = (text: string): boolean =>
          /\[(error_max_turns|error_max_budget_usd)\b/.test(text);
        const sdkAuthFailed = (text: string): boolean =>
          AUTH_ERROR_RE.test(text) && /\[error_|API Error/i.test(text);
        const mergeSdkLegs = (
          first: typeof sdkResult,
          second: typeof sdkResult,
        ): typeof sdkResult => ({
          ...second,
          toolCalls: [...new Set([...first.toolCalls, ...second.toolCalls])],
          ...(first.toolCallsWithArgs || second.toolCallsWithArgs
            ? {
                toolCallsWithArgs: [
                  ...(first.toolCallsWithArgs ?? []),
                  ...(second.toolCallsWithArgs ?? []),
                ],
              }
            : {}),
          numTurns: first.numTurns + second.numTurns,
          usage: {
            promptTokens: first.usage.promptTokens + second.usage.promptTokens,
            completionTokens:
              first.usage.completionTokens + second.usage.completionTokens,
            cacheReadTokens:
              first.usage.cacheReadTokens + second.usage.cacheReadTokens,
            cacheCreationTokens:
              first.usage.cacheCreationTokens +
              second.usage.cacheCreationTokens,
          },
          costUsd: first.costUsd + second.costUsd,
          costAuthoritative:
            first.costAuthoritative && second.costAuthoritative,
          durationMs: first.durationMs + second.durationMs,
        });

        // Calls the confirmation gate stopped never executed — drop them from
        // every "already ran" record (resume prompt, run output, telemetry).
        const withoutGated = (calls: string[]): string[] => {
          const gated = [...taskContext.getGatedCalls()];
          return calls.filter((name) => {
            const i = gated.indexOf(name);
            if (i === -1) return true;
            gated.splice(i, 1);
            return false;
          });
        };

        // A recovery leg's prompt: the original request, leg 1's progress and
        // the tools leg 1 already ran (shared by the resume and auth legs).
        const continuationPrompt = (
          reason: string,
          progress: string,
          ranNames: string[],
        ): string =>
          `${userPrompt}\n\n[AVANCE PREVIO — la ejecución anterior ${reason} antes de terminar]\n` +
          `${progress.slice(0, 4000)}\n\n` +
          // R2 audit C2: the claim must carry the evidence — name the
          // tools that ALREADY ran so mutating calls (send/write/post)
          // are not repeated.
          `Herramientas YA ejecutadas (NO las repitas sobre el mismo objetivo): ${ranNames.join(", ") || "ninguna"}.\n` +
          `CONTINÚA AUTOMÁTICO: retoma el último paso pendiente y TERMINA la tarea. Tu respuesta final debe INCLUIR todo el contenido entregable (incorpora el avance previo) — no solo el cierre. Entrega el resultado con su STATUS.`;
        // Leg 1's text without the SDK error marker and the partial trailer.
        const leg1BodyOf = (text: string): string =>
          stripConcernsTrailer(
            text.replace(/^\[[^\]]*\]\s*(Partial response below[^\n]*)?\n*/, ""),
          ).trim();
        // R2 audit C2: leg-1's streamed work must survive when leg-2 returns
        // only a thin closer — the partial IS the deliverable.
        const keepLeg1Partial = (firstText: string, secondText: string): string | null => {
          const leg2Body = stripFinalStatusLine(secondText).trim();
          if (leg2Body.length >= 200) return null;
          const leg1Body = leg1BodyOf(firstText);
          return leg1Body.length >= 200 ? `${leg1Body}\n\n${secondText}` : null;
        };

        let sdkAutoResumed = false;
        // R3 audit W2: set BEFORE the await — a resume that THROWS must
        // still count as the run's one recovery leg, or a capped partial
        // containing "401" fires a third full-size leg via the auth gate.
        let recoveryLegUsed = false;
        // Queue 3r: a pending confirmation ends the run's turn — no recovery
        // leg (cap resume or auth retry) runs after it in this context.
        const turnEnded = (): boolean =>
          taskContext.getPendingConfirmation() !== null;
        // Replay guard, not provenance (EVIDENCE_TOOL_RE decides evidence):
        // a tool declaring readOnlyHint changes nothing, so redoing it is
        // safe — and leg 2 never saw its result. Unknown or unhinted (MCP)
        // tools count as side-effecting. Leg 1's value — shared by the
        // api_error last line below and the auth retry.
        const sideEffectsOf = (calls: string[]): string[] =>
          withoutGated(calls).filter(
            (name) =>
              !SDK_READ_ONLY_BUILTINS.has(name) &&
              toolRegistry.get(name)?.readOnlyHint !== true,
          );
        const sideEffecting = sideEffectsOf(sdkResult.toolCalls);
        const ranTools = sideEffecting.length > 0;

        // Leg 1 ended on an allow-listed API error (Anthropic unavailable):
        // the last line, unless it is auth-class (that keeps its own retry
        // below), a confirmation ended the turn, or leg 1 ran a
        // side-effecting tool (never replayed on another provider).
        if (
          sdkResult.errorClass !== undefined &&
          LASTLINE_API_ERROR_CLASSES.has(sdkResult.errorClass) &&
          !sdkAuthFailed(sdkResult.text) &&
          !turnEnded() &&
          !ranTools
        ) {
          const armed = sdkLastline();
          if (armed) {
            lastline = engageLastline(armed, "api_error", sdkResult.errorClass);
            abandonedSdkUsage = sdkUsageAsLoop(sdkResult.usage);
            break sdkPath;
          }
        }

        if (
          sdkCapped(sdkResult.text) &&
          !(rawUserMsg.length > 0 && isConversational) &&
          !turnEnded()
        ) {
          console.log(
            `[recovery] auto-resume after cap, ${sdkResult.numTurns} turns (task ${input.taskId})`,
          );
          recoveryLegUsed = true;
          try {
            const firstLegText = sdkResult.text;
            emitTraceEvent({
              taskId: input.taskId,
              name: "recovery.leg_started",
              attrs: { kind: "auto_resume", path: "sdk" },
            });
            const resumeLeg = await runWithExecutionContext(taskContext, () =>
              queryClaudeSdk({
                prompt: continuationPrompt(
                  "alcanzó su límite de turnos/presupuesto",
                  firstLegText,
                  withoutGated(sdkResult.toolCalls),
                ),
                systemPrompt,
                toolNames: allToolNames,
                loadToolsUpFront,
                // R1 audit W4: bounded — half the rounds finishes a nearly-done
                // task; anything needing more re-caps into checkpoint + ¿Sigo?.
                maxTurns: input.unlimited
                  ? LOOP_MAX_TURNS
                  : Math.max(4, Math.ceil(maxRounds / 2)),
                unlimited: input.unlimited,
                abortSignal: input.signal,
                costLedger: false,
                trace: { taskId: input.taskId, runId: input.runId },
                // A capped vision task keeps its image on resume (R2 info).
                ...(sdkImages.length > 0 && { images: sdkImages }),
              }),
            );
            sdkResult = mergeSdkLegs(sdkResult, resumeLeg);
            const kept = keepLeg1Partial(firstLegText, resumeLeg.text);
            if (kept) sdkResult = { ...sdkResult, text: kept };
            sdkAutoResumed = true;
            console.log(
              `[recovery] auto-resume finished (task ${input.taskId})`,
            );
          } catch (resumeErr) {
            console.warn(
              `[recovery] auto-resume failed, delivering first-leg partial: ${errMsg(resumeErr)}`,
            );
            emitTraceEvent({
              taskId: input.taskId,
              name: "recovery.leg_failed",
              attrs: { kind: "auto_resume", path: "sdk" },
            });
          }
        }

        // Auth-class failure: retry once (credentials are re-read per call —
        // an operator rotation mid-run heals), then escalate in clean
        // Spanish. Never both legs (≤1 extra call per run — gated on the
        // BEFORE-await flag, R3 audit W2).
        if (
          !recoveryLegUsed &&
          sdkAuthFailed(sdkResult.text) &&
          !turnEnded()
        ) {
          console.log(
            `[recovery] auth-class failure detected, retrying once (task ${input.taskId})`,
          );
          // Tools leg 1 already ran must not be replayed: the retry continues
          // from them (resume-leg wording) instead of restarting the request.
          // Leg 1's error marker is stripped so the 401 text is not echoed
          // back and misread as a second auth failure.
          const firstLegText = sdkResult.text;
          try {
            emitTraceEvent({
              taskId: input.taskId,
              name: "recovery.leg_started",
              attrs: { kind: "auth_retry", path: "sdk" },
            });
            const authLeg = await runWithExecutionContext(taskContext, () =>
              queryClaudeSdk({
                prompt: ranTools
                  ? continuationPrompt(
                      "falló por un error de autenticación",
                      leg1BodyOf(firstLegText),
                      sideEffecting,
                    )
                  : userPrompt,
                systemPrompt,
                toolNames: allToolNames,
                loadToolsUpFront,
                maxTurns: maxRounds,
                unlimited: input.unlimited,
                abortSignal: input.signal,
                costLedger: false,
                trace: { taskId: input.taskId, runId: input.runId },
                ...(sdkImages.length > 0 && { images: sdkImages }),
              }),
            );
            if (!sdkAuthFailed(authLeg.text)) {
              sdkResult = mergeSdkLegs(sdkResult, authLeg);
              const kept = ranTools && keepLeg1Partial(firstLegText, authLeg.text);
              if (kept) sdkResult = { ...sdkResult, text: kept };
              console.log(
                `[recovery] auth retry succeeded (task ${input.taskId})`,
              );
            } else {
              // Last line only when NEITHER leg ran a side-effecting tool
              // (side effects are never replayed on another provider) and no
              // confirmation ended the turn during the auth leg.
              const authLegRanTools =
                sideEffectsOf(authLeg.toolCalls).length > 0;
              const armed =
                ranTools || authLegRanTools || turnEnded()
                  ? null
                  : sdkLastline();
              if (armed) {
                lastline = engageLastline(armed, "auth");
                abandonedSdkUsage = sdkUsageAsLoop(
                  mergeSdkLegs(sdkResult, authLeg).usage,
                );
                break sdkPath;
              }
              sdkResult = {
                ...mergeSdkLegs(sdkResult, authLeg),
                text: "⚠️ Credenciales del proveedor de inferencia inválidas, expiradas o revocadas. Reintenté una vez sin éxito — no reintentaré más. Operador: `claude /login` en el VPS (o rotar el token).\n\nSTATUS: DONE_WITH_CONCERNS — fallo de autenticación, tarea no ejecutada.",
              };
              emitTraceEvent({
                taskId: input.taskId,
                name: "answer.replaced",
                attrs: { kind: "auth_escalation", path: "sdk" },
              });
              console.warn(
                `[recovery] auth retry still failing — escalating (task ${input.taskId})`,
              );
            }
          } catch (authErr) {
            console.warn(`[recovery] auth retry threw: ${errMsg(authErr)}`);
            emitTraceEvent({
              taskId: input.taskId,
              name: "recovery.leg_failed",
              attrs: { kind: "auth_retry", path: "sdk" },
            });
          }
        }

        sdkResult = {
          ...sdkResult,
          toolCalls: withoutGated(sdkResult.toolCalls),
        };

        // Map SDK result to RunnerOutput
        let parsed = parseRunnerStatus(sdkResult.text);

        // Double cap (resume also hit the limit): deliver the partial, ask
        // the ONE allowed short question, and leave a checkpoint so
        // "continúa" resumes through the existing seam. Closes the SDK
        // branch's pre-existing no-checkpoint gap for exactly this case.
        // Never for an external caller: the operator's "continúa" must not
        // resume a CRM request.
        if (!input.external && sdkAutoResumed && sdkCapped(sdkResult.text)) {
          if (!parsed.cleanContent.includes("¿Sigo?")) {
            parsed = {
              ...parsed,
              cleanContent: `${parsed.cleanContent}\n\n¿Sigo?`,
            };
          }
          try {
            writeCheckpoint({
              taskId: input.taskId,
              title: input.title,
              userMessage: rawUserMsg || input.title,
              toolsCalled: sdkResult.toolCalls,
              scopeGroups: [],
              exitReason: "max_rounds",
              roundsCompleted: sdkResult.numTurns,
              maxRounds,
              responseText: parsed.cleanContent,
            });
          } catch {
            // Non-fatal — checkpoint is best-effort
          }
        }

        // Safety net: if the LLM returned substantial content but reported
        // BLOCKED/NEEDS_CONTEXT (e.g. a confirmation prompt for a destructive
        // action), promote to DONE_WITH_CONCERNS so the content gets delivered.
        // Mirrors the OpenAI path's safety net below. Without this,
        // confirmation prompts from the claude-sdk path get silently dropped
        // because result.success=false → dispatcher marks the task failed and
        // the messaging router sends a generic failure message instead of the
        // text.
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

        // A high-risk call is waiting for the operator (confirmation gate):
        // the run must complete so the router stores the pending action and
        // the reply asks for it — a short BLOCKED reply would route to
        // handleTaskFailed, and an empty one would store nothing.
        const pendingConfirmation = taskContext.getPendingConfirmation();
        if (pendingConfirmation) {
          // Queue 4l: the card may hold several gated calls (`items`).
          const pendingNames = pendingConfirmation.items
            .map((i) => i.toolName)
            .join(", ");
          if (
            parsed.status === "BLOCKED" ||
            parsed.status === "NEEDS_CONTEXT"
          ) {
            parsed = {
              ...parsed,
              status: "DONE_WITH_CONCERNS",
              concerns: [
                `Original status: ${parsed.status}. Awaiting operator confirmation for ${pendingNames}.`,
              ],
            };
          }
          if (parsed.cleanContent.trim() === "") {
            parsed = {
              ...parsed,
              cleanContent:
                pendingConfirmation.items.length > 1
                  ? `Estas ${pendingConfirmation.items.length} acciones requieren tu confirmación: ${pendingNames}. ¿Procedo?`
                  : `Esta acción requiere tu confirmación: ${pendingNames}. ¿Procedo?`,
            };
            emitTraceEvent({
              taskId: input.taskId,
              name: "answer.replaced",
              attrs: { kind: "confirmation_prompt", path: "sdk" },
            });
          }
        }

        // Scope telemetry — record tool execution on the SDK path. The
        // openai-path records it further below (its own `recordToolExecution` call),
        // but the SDK branch returns early so a separate record call is
        // required. Without this, scope_telemetry.tools_called is always
        // "[]" for Sonnet-routed tasks, and deferred-tool activation
        // yield metrics (audit probe E3) are unmeasurable.
        //
        // Sprint 1 R-1 (2026-05-23): supply fallback context so tasks
        // that bypassed `router.ts` (scheduled / ritual / direct-API) get
        // a synthetic scope_telemetry row inserted. T-02 baseline showed
        // 27% of fast tasks were silently missing from telemetry. The
        // fallback INSERTs `active_groups=[]` for these, which is itself
        // a signal worth tracking ("unscoped" dispatch).
        try {
          recordToolExecution(input.taskId, sdkResult.toolCalls, [], {
            message: input.description,
            activeGroups: [],
            toolsInScope: allToolNames,
          });
        } catch {
          // Non-fatal — telemetry never blocks execution
        }

        return {
          success:
            parsed.status === "DONE" || parsed.status === "DONE_WITH_CONCERNS",
          status: parsed.status,
          concerns: parsed.concerns,
          output: {
            text: parsed.cleanContent,
            toolCalls: sdkResult.toolCalls,
            // V8.4: how the terminal status was obtained (explicit STATUS
            // line vs the DONE default) — measured via tasks.output.
            statusSource: parsed.statusSource,
            // Read by the router (handleTaskCompleted) to ask the operator.
            ...(pendingConfirmation && { pendingConfirmation }),
          },
          toolCalls: sdkResult.toolCalls,
          // qa-audit 2026-09-12 C-2: this branch returned before the field
          // was set, so 100 % of live (claude-sdk) traffic reported a turn or
          // dollar cap as "completed". The SDK surfaces caps as text markers.
          terminationReason: /\[error_max_turns\b/.test(sdkResult.text)
            ? "max_rounds"
            : /\[error_max_budget_usd\b/.test(sdkResult.text)
              ? "budget_exhausted"
              : terminationFromExit(
                  "stop",
                  parsed.status,
                  parsed.status === "DONE" ||
                    parsed.status === "DONE_WITH_CONCERNS",
                ),
          tokenUsage: {
            promptTokens: sdkResult.usage.promptTokens,
            completionTokens: sdkResult.usage.completionTokens,
            cacheReadTokens: sdkResult.usage.cacheReadTokens,
            cacheCreationTokens: sdkResult.usage.cacheCreationTokens,
            actualModel: sdkResult.model,
            // qa-audit C2 fold (2026-05-23): gate on costAuthoritative so the
            // abort/timeout path (where costUsd stayed at its initial 0) does
            // NOT override the dispatcher's calculateCost() fallback. Without
            // this gate, the `costUsdOverride` optional-spread in
            // `recordRunCost` (dispatch/dispatcher.ts) sees `0 !==
            // undefined` and writes a phantom-$0 row to cost_ledger over the
            // accumulated per-turn tokens we just preserved (see #225 fix in
            // claude-sdk.ts).
            ...(sdkResult.costAuthoritative && {
              actualCostUsd: sdkResult.costUsd,
            }),
          },
          durationMs: sdkResult.durationMs || Date.now() - start,
        };
      }

      // Under the last line every leg below (main, resume, auth retry,
      // narration retry) runs on the fallback provider, never back on the SDK.
      const runInfer = lastline ? inferWithToolsLastline : inferWithTools;
      let result = await runInfer(messages, definitions, taskExecutor, {
        maxRounds,
        providerName,
        effort: tierToEffort(input.modelTier),
        tokenBudget,
        onTextChunk: input.onTextChunk,
        signal: input.signal,
        exemptAnalysisParalysis: hasEmailDelivery,
        taskId: input.taskId,
        skipToolNudge: isConversational,
        // Dispatcher aggregate meters this run — see the SDK-path opt-out. (3.3)
        costLedger: false,
      });

      // Phase 4.3: ONE automatic checkpoint-resume before delivering a
      // capped partial. The operator should never have to type "continúa"
      // for a limit the harness can see (plan 4.3/4.5 — "turn budget is the
      // harness's problem"). Structurally once: no loop, and the resume leg
      // itself is never resumed. A capped CONVERSATIONAL turn is a wedge,
      // not an unfinished task — but only when there IS a user message to
      // judge: scheduled/background tasks have no history and must resume.
      const skipAutoResume = rawUserMsg.length > 0 && isConversational;
      let autoResumed = false;
      if (
        (result.exitReason === "max_rounds" ||
          result.exitReason === "token_budget") &&
        !skipAutoResume
      ) {
        console.log(
          `[recovery] auto-resume after ${result.exitReason} round ${result.roundsCompleted}/${maxRounds} (task ${input.taskId})`,
        );
        try {
          emitTraceEvent({
            taskId: input.taskId,
            name: "recovery.leg_started",
            attrs: {
              kind: "auto_resume",
              path: "openai",
              reason: result.exitReason,
            },
          });
          const resumeResult = await runInfer(
            [
              ...result.messages,
              {
                role: "user" as const,
                content:
                  "CONTINÚA AUTOMÁTICO: la ejecución alcanzó su límite de rondas/presupuesto antes de terminar. NO repitas trabajo ya hecho (revisa las herramientas ya llamadas arriba). Retoma en el último paso pendiente y TERMINA la tarea. Si ya no falta nada, entrega el resultado final con su STATUS.",
              },
            ],
            definitions,
            taskExecutor,
            {
              // R1 audit W4: bounded — a full-size second leg can outlive
              // the router's 660s abandon budget. Half the rounds finishes
              // a nearly-done task; a task needing more re-caps into the
              // checkpoint + ¿Sigo? path.
              maxRounds: Math.max(4, Math.ceil(maxRounds / 2)),
              providerName,
              effort: tierToEffort(input.modelTier),
              tokenBudget,
              // No onTextChunk: leg-2 chunks would append onto leg-1's
              // partial in the stream placeholder (R1 audit W4); the final
              // text arrives whole at completion.
              signal: input.signal,
              taskId: input.taskId,
              // Resume leg of the same dispatched run — same aggregate. (3.3)
              costLedger: false,
            },
          );
          autoResumed = true;
          result = {
            ...resumeResult,
            roundsCompleted:
              result.roundsCompleted + resumeResult.roundsCompleted,
            totalUsage: sumLoopUsage(result.totalUsage, resumeResult.totalUsage),
          };
          console.log(
            `[recovery] auto-resume finished: ${result.exitReason} (task ${input.taskId})`,
          );
        } catch (resumeErr) {
          // The first leg's partial is still deliverable — never trade a
          // partial for an error.
          console.warn(
            `[recovery] auto-resume failed, delivering first-leg partial: ${errMsg(resumeErr)}`,
          );
          emitTraceEvent({
            taskId: input.taskId,
            name: "recovery.leg_failed",
            attrs: { kind: "auto_resume", path: "openai" },
          });
        }
      }

      // Phase 4.3: auth-class failure (expired/revoked OAuth) — retry ONCE
      // (credentials are re-read per call, so an operator rotation mid-run
      // heals), then escalate in clean Spanish instead of delivering the
      // raw 401 (the #4× "401 revoked" delivery class). Skipped when a
      // resume leg already ran — at most one extra leg per run.
      // R1 audit W5: gated on PROVIDER-error exits only — a task whose
      // ANSWER discusses a 401 (debugging someone's API) exits max_rounds/
      // natural and must never lose its content to the canned escalation.
      if (
        !autoResumed &&
        (result.exitReason === "provider_failure" ||
          result.exitReason === "wrapup_failed") &&
        AUTH_ERROR_RE.test(result.content)
      ) {
        console.log(
          `[recovery] auth-class failure detected, retrying once (task ${input.taskId})`,
        );
        try {
          emitTraceEvent({
            taskId: input.taskId,
            name: "recovery.leg_started",
            attrs: { kind: "auth_retry", path: "openai" },
          });
          const authRetry = await runInfer(
            messages,
            definitions,
            taskExecutor,
            {
              maxRounds,
              providerName,
              effort: tierToEffort(input.modelTier),
              tokenBudget,
              onTextChunk: input.onTextChunk,
              signal: input.signal,
              taskId: input.taskId,
              costLedger: false,
            },
          );
          if (!AUTH_ERROR_RE.test(authRetry.content)) {
            // R1 audit W6: sum both legs' usage — the first leg still
            // consumed tokens the ledger must see.
            result = {
              ...authRetry,
              totalUsage: sumLoopUsage(result.totalUsage, authRetry.totalUsage),
            };
            console.log(
              `[recovery] auth retry succeeded (task ${input.taskId})`,
            );
          } else {
            result = {
              ...result,
              totalUsage: sumLoopUsage(result.totalUsage, authRetry.totalUsage),
              content:
                "⚠️ Credenciales del proveedor de inferencia inválidas o revocadas (401). Reintenté una vez sin éxito — no reintentaré más. Necesitas rotar el token (operator).\n\nSTATUS: DONE_WITH_CONCERNS — fallo de autenticación, tarea no ejecutada.",
            };
            emitTraceEvent({
              taskId: input.taskId,
              name: "answer.replaced",
              attrs: { kind: "auth_escalation", path: "openai" },
            });
            console.warn(
              `[recovery] auth retry still failing — escalating (task ${input.taskId})`,
            );
          }
        } catch (authErr) {
          console.warn(`[recovery] auth retry threw: ${errMsg(authErr)}`);
          emitTraceEvent({
            taskId: input.taskId,
            name: "recovery.leg_failed",
            attrs: { kind: "auth_retry", path: "openai" },
          });
        }
      }

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

      // Scope telemetry — record tool execution + repairs.
      // Sprint 1 R-1: same fallback context as the SDK path so direct-API
      // and scheduled tasks that route through the openai-compat path also
      // get a synthetic row when no `recordScopeDecision` insert preceded.
      try {
        recordToolExecution(
          input.taskId,
          toolsCalled,
          [...failedToolCalls.keys()],
          {
            message: input.description,
            activeGroups: [],
            toolsInScope: definitions.map((d) => d.function.name),
          },
        );
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

      // The hallucination retry leg's own messages (empty when no retry ran)
      // and the failed leg-1 write calls it resolved; the write verification
      // below reads both.
      let retryLegMessages: ChatMessage[] = [];
      const resolvedLeg1CallIds = new Set<string>();

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
        // The failed writes the retry did not then complete; without a
        // retry, every leg-1 failure.
        let unresolvedWriteTools = failedWriteTools;
        // Whether the retry leg ended aborted; read by its outcome event.
        let retryLegAborted = false;

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

          // Sprint 1 R-5 (2026-05-23): pre-classified per-tool retry message.
          // Previously the message asked the LLM to classify the error itself
          // ("if the error is permanent, ..."). We already classified each
          // error in Step 2 via `classifyToolError` — passing the result
          // directly removes a source of LLM variance and tells the model
          // EXACTLY which tool to retry vs which to skip.
          //
          // Scope: openai-compat path only. The SDK production-default path
          // (INFERENCE_PRIMARY_PROVIDER=claude-sdk) never enters this block
          // — the SDK manages tool execution server-side and our retry
          // protocol does not apply. R-1 audit W1 documents the divergence.
          let retryContent: string;
          if (isReadHallucination) {
            retryContent =
              "ALTO: Narraste una verificación sin llamar herramientas. DEBES llamar wp_read_post o file_read para leer el contenido REAL del artículo antes de reportar si contiene enlaces o no. NO inventes resultados.";
          } else if (hasToolErrors) {
            const breakdown = failedWriteTools.map((t) => {
              const err = failedToolCalls.get(t) ?? "(unknown error)";
              return { tool: t, error: err, cls: classifyToolError(err) };
            });
            const permanentLines = breakdown
              .filter((b) => b.cls === "permanent")
              .map(
                (b) =>
                  `  - ${b.tool}: ${b.error.slice(0, 150)} (PERMANENTE — no reintentar la misma llamada)`,
              );
            const transientLines = breakdown
              .filter((b) => b.cls !== "permanent")
              .map(
                (b) =>
                  `  - ${b.tool}: ${b.error.slice(0, 150)} (TRANSITORIO — reintentar con mismos argumentos)`,
              );
            const parts: string[] = [
              "ALTO: Las siguientes herramientas FALLARON.",
            ];
            if (permanentLines.length > 0) {
              parts.push(
                "",
                "ERRORES PERMANENTES — NO reintentes la misma llamada. Usa una alternativa o reporta al usuario:",
                ...permanentLines,
              );
            }
            if (transientLines.length > 0) {
              parts.push(
                "",
                "ERRORES TRANSITORIOS — reintenta UNA VEZ con los MISMOS argumentos:",
                ...transientLines,
              );
            }
            parts.push("", `Herramientas disponibles: [${writeToolHint}].`);
            retryContent = parts.join("\n");
          } else {
            retryContent = `ALTO: Narraste acciones de escritura sin llamar las herramientas correctas. Solo llamaste: [${toolsCalled.join(", ")}]. Herramientas de escritura disponibles: [${writeToolHint}]. Llama a la correcta AHORA. NO narres — EJECUTA.`;
          }
          retryMessages.push({ role: "user", content: retryContent });

          emitTraceEvent({
            taskId: input.taskId,
            name: "recovery.leg_started",
            attrs: {
              kind: "write_retry",
              path: "openai",
              failedWrites: failedWriteTools.length,
            },
          });
          const retryResult = await runInfer(
            retryMessages,
            definitions,
            taskExecutor,
            {
              maxRounds: 5,
              providerName: tierToProvider(input.modelTier),
              effort: tierToEffort(input.modelTier),
              tokenBudget,
              signal: input.signal,
              taskId: input.taskId,
              // Retry leg of the same dispatched run — same aggregate. (3.3)
              costLedger: false,
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

          // An aborted retry resolves nothing and is never the answer: its
          // text is the abort placeholder or an unfinished partial.
          const retryAborted = retryResult.exitReason === "aborted";
          retryLegAborted = retryAborted;
          // The retry leg's own calls: its messages repeat leg 1's as a
          // prefix, so a call belongs to the retry only when its id is
          // non-empty and leg 1 never carried it, and its result is read
          // only after that shared prefix.
          const leg1CallIds = new Set(
            result.messages.flatMap(
              (m) => m.tool_calls?.map((tc) => tc.id) ?? [],
            ),
          );
          const isRetryCallId = (id: string | undefined): boolean =>
            !!id && !leg1CallIds.has(id);
          let prefixLen = 0;
          while (
            prefixLen < result.messages.length &&
            retryResult.messages[prefixLen] === result.messages[prefixLen]
          ) {
            prefixLen++;
          }
          retryLegMessages = retryAborted
            ? []
            : retryResult.messages.slice(prefixLen).flatMap((m) => {
                if (m.role === "tool") {
                  return isRetryCallId(m.tool_call_id) ? [m] : [];
                }
                const calls =
                  m.tool_calls?.filter((tc) => isRetryCallId(tc.id)) ?? [];
                return calls.length > 0 ? [{ ...m, tool_calls: calls }] : [];
              });
          // A failed leg-1 write call is resolved only by retry calls of the
          // same tool to the same target, and only when the LAST of them
          // returned a present, positive result. A retry that completes the
          // write under other arguments for the same target counts; one sent
          // to another target does not, and the user is told the first
          // target was not completed.
          // Each call reads the first result after its own message, so an id
          // the provider repeats cannot borrow an earlier call's result.
          const lastOutcome = new Map<string, boolean>();
          for (let ri = 0; ri < retryLegMessages.length; ri++) {
            for (const tc of retryLegMessages[ri].tool_calls ?? []) {
              const res = retryLegMessages
                .slice(ri + 1)
                .find((r) => r.role === "tool" && r.tool_call_id === tc.id);
              const ok = isPositiveToolResult(
                typeof res?.content === "string" ? res.content : "",
              );
              for (const key of writeCallKeys(tc)) lastOutcome.set(key, ok);
            }
          }
          // A tool stays unresolved while any of its failed calls is, or
          // when no failed call of it can be found.
          const unresolvedNames = new Set<string>();
          const failedCallNames = new Set<string>();
          for (let fi = 0; fi < result.messages.length; fi++) {
            for (const tc of result.messages[fi].tool_calls ?? []) {
              const name = tc.function?.name;
              if (!name || !failedWriteTools.includes(name)) continue;
              const fRes = result.messages
                .slice(fi + 1)
                .find((m) => m.role === "tool" && m.tool_call_id === tc.id);
              if (
                !isToolErrorContent(
                  typeof fRes?.content === "string" ? fRes.content : "",
                )
              ) {
                continue;
              }
              failedCallNames.add(name);
              const keys = writeCallKeys(tc);
              if (
                keys.length > 0 &&
                keys.every((k) => lastOutcome.get(k) === true)
              ) {
                resolvedLeg1CallIds.add(tc.id);
              } else {
                unresolvedNames.add(name);
              }
            }
          }
          unresolvedWriteTools = failedWriteTools.filter(
            (t) => unresolvedNames.has(t) || !failedCallNames.has(t),
          );

          const retryCalledWrite = retryToolsCalled.some((t) =>
            WRITE_TOOLS.has(t),
          );
          if (retryCalledWrite && !retryAborted) {
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
            unresolvedWriteTools,
          )
        ) {
          // Retry fixed it — skip replacement.
          // Sprint 1 R-1: record retry outcome counter for R-5's measurement.
          // Only count "success" when we actually ran the retry (not when no
          // hallucination existed in the first place — that path is excluded
          // by the outer `!hasVision && detectsHallucinatedExecution(...)` condition).
          if (shouldRetry) {
            recordFastRetryOutcome("success");
            emitTraceEvent({
              taskId: input.taskId,
              name: "recovery.write_retry_outcome",
              attrs: {
                outcome: "success",
                unresolved: unresolvedWriteTools.length,
                aborted: retryLegAborted,
              },
            });
          }
        } else {
          // Sprint 1 R-1: record retry outcome. "fail" means a retry ran but
          // still hallucinated; "skipped" means we decided against retry
          // entirely (permanent errors or no token headroom).
          recordFastRetryOutcome(shouldRetry ? "fail" : "skipped");
          // A skipped retry ran no leg, so it has no outcome event.
          if (shouldRetry) {
            emitTraceEvent({
              taskId: input.taskId,
              name: "recovery.write_retry_outcome",
              attrs: {
                outcome: "fail",
                unresolved: unresolvedWriteTools.length,
                aborted: retryLegAborted,
              },
            });
          }
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
            hasToolErrors && unresolvedWriteTools.length > 0
              ? `\n\n**Errores de herramientas**:\n${unresolvedWriteTools
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
            statusSource: parsed.statusSource,
          };
          emitTraceEvent({
            taskId: input.taskId,
            name: "answer.replaced",
            attrs: {
              kind: readHalluc ? "read_not_verified" : "not_completed",
              path: "openai",
            },
          });
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
          emitTraceEvent({
            taskId: input.taskId,
            name: "answer.replaced",
            attrs: { kind: "tool_result", path: "openai" },
          });
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
      const verifyMessages = [...result.messages, ...retryLegMessages];
      // Concerns before the write verification; the ones after it are its own.
      const qpBeforeVerify = qpConcerns.length;
      for (let vi = 0; vi < verifyMessages.length; vi++) {
        const msg = verifyMessages[vi];
        if (msg.role !== "assistant" || !msg.tool_calls) continue;
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (!name || !WRITE_VERIFICATION[name]) continue;
          if (!toolsCalled.includes(name)) continue; // already flagged as failed
          // A failed leg-1 call the retry completed is not a silent failure.
          if (resolvedLeg1CallIds.has(tc.id)) continue;
          // A retry-leg call reads the first result after its own message,
          // so a repeated id cannot borrow an earlier call's marker; leg 1's
          // calls keep their whole-list lookup.
          const toolResultMsg = verifyMessages
            .slice(vi < result.messages.length ? 0 : vi + 1)
            .find((m) => m.role === "tool" && m.tool_call_id === tc.id);
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
      // How many concerns the verification added — never which tool.
      if (qpConcerns.length > qpBeforeVerify) {
        emitTraceEvent({
          taskId: input.taskId,
          name: "write.verification_concern",
          attrs: { concerns: qpConcerns.length - qpBeforeVerify },
        });
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
        !input.external &&
        (result.exitReason === "max_rounds" ||
          result.exitReason === "token_budget")
      ) {
        // Phase 4.3: reaching here WITH autoResumed means both legs capped —
        // deliver the partial and ask ONE short question (the only case the
        // plan allows a "¿Sigo?").
        if (autoResumed && !parsed.cleanContent.includes("¿Sigo?")) {
          parsed = {
            ...parsed,
            cleanContent: `${parsed.cleanContent}\n\n¿Sigo?`,
          };
        }
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

      const reportedUsage = abandonedSdkUsage
        ? sumLoopUsage(abandonedSdkUsage, result.totalUsage)
        : result.totalUsage;
      return {
        success:
          parsed.status === "DONE" || parsed.status === "DONE_WITH_CONCERNS",
        status: parsed.status,
        concerns: parsed.concerns,
        output: {
          text: parsed.cleanContent,
          toolCalls: toolsCalled,
          statusSource: parsed.statusSource,
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
        terminationReason: terminationFromExit(
          result.exitReason,
          parsed.status,
          parsed.status === "DONE" || parsed.status === "DONE_WITH_CONCERNS",
        ),
        tokenUsage: {
          promptTokens: reportedUsage.prompt_tokens,
          completionTokens: reportedUsage.completion_tokens,
          ...(reportedUsage.cache_read_tokens !== undefined && {
            cacheReadTokens: reportedUsage.cache_read_tokens,
          }),
          ...(reportedUsage.cache_creation_tokens !== undefined && {
            cacheCreationTokens: reportedUsage.cache_creation_tokens,
          }),
          // 2026-05-10 cutover audit C1: actualModel from inferWithTools
          // surfaces SDK-routed Haiku/Opus correctly; absent on OpenAI path.
          ...(result.model !== undefined && { actualModel: result.model }),
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: errMsg(err),
        terminationReason: "error",
        durationMs: Date.now() - start,
      };
    } finally {
      clearInterval(heartbeat);
      // TaskExecutionContext is GC'd with the task — no global cleanup needed
    }
  },
};

/**
 * A cancelled run is never reported as completed, on any branch: when the
 * caller's signal is aborted, or the loop stopped on the abort, the run failed
 * as cancelled, whatever partial text or status the branch produced. Output
 * and token usage stay so the spend is still booked. The exit-reason check is
 * a second line of defence: the loop's abort comes from the same signal, so
 * the two always coincide and no test can separate them.
 */
function cancelledOutcome(
  input: RunnerInput,
  out: RunnerOutput,
): RunnerOutput {
  const exitReason =
    out.output && typeof out.output === "object"
      ? (out.output as { exitReason?: unknown }).exitReason
      : undefined;
  if (!input.signal?.aborted && exitReason !== "aborted") return out;
  return {
    ...out,
    success: false,
    status: undefined,
    terminationReason: "aborted",
    error: "cancelled",
  };
}

export const fastRunner: Runner = {
  type: "fast",

  async execute(input: RunnerInput): Promise<RunnerOutput> {
    return cancelledOutcome(input, await fastRunnerBranches.execute(input));
  },
};

// Auto-register on import
registerRunner(fastRunner);
