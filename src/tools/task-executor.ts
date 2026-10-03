/**
 * Per-task tool executor — wraps toolRegistry.execute() with context-aware
 * destructive lock checks.
 *
 * The toolRegistry becomes a read-only singleton for tool definitions,
 * validation, and fuzzy matching. Mutable per-task state (destructive locks,
 * memory rate limits) lives in the TaskExecutionContext.
 *
 * v5.0 S2: enables safe concurrent task execution.
 */

import type { TaskExecutionContext } from "../inference/execution-context.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolExecutor } from "../inference/adapter.js";
import { createLogger } from "../lib/logger.js";
import { emitTraceEvent } from "../observability/task-trace.js";
import { classifyMutation, recordMutation } from "../db/task-mutations.js";

import { existsSync } from "fs";

const log = createLogger("task-executor");

// ---------------------------------------------------------------------------
// Pre-flight verification (v6.4 H2)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Check preconditions before executing a critical tool.
 * Returns an error string if precondition fails, null if OK.
 */
function checkPreflight(
  name: string,
  args: Record<string, unknown>,
): string | null {
  switch (name) {
    case "gmail_send": {
      const to = args.to as string | undefined;
      const body = args.body as string | undefined;
      if (to && !EMAIL_RE.test(to)) {
        return `Pre-flight failed: invalid email address "${to}"`;
      }
      if (body && body.length < 20) {
        return `Pre-flight failed: email body too short (${body.length} chars). Likely truncated or incomplete.`;
      }
      return null;
    }
    case "git_push":
    case "git_commit": {
      const cwd = args.cwd as string | undefined;
      if (cwd && !existsSync(cwd)) {
        return `Pre-flight failed: working directory "${cwd}" does not exist`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * CCP9: Generate a lightweight fingerprint from tool args for scope-bounded approval.
 * Deterministic: sorted keys, first 64 chars. Used to scope destructive unlocks
 * to the specific target the user approved.
 */
export function argsFingerprint(args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}:${String(args[k] ?? "").slice(0, 20)}`)
    .join("|");
  return sorted.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Confirmation gate (CCP5+CCP9) — the ONE implementation. Called by the
// per-task executor below (openai path) and by the Claude SDK MCP bridge
// (`wrapTool` in inference/claude-sdk.ts, the production path).
// ---------------------------------------------------------------------------

/**
 * google_workspace_cli read methods (operator ruling R2, 2026-09-29): the
 * tool's `method` arg is the Discovery method name (`list`, `get`,
 * `searchContacts`, `getBatchGet`, …). An ALLOW-list — any other method,
 * a missing one, or `--help` spelled differently asks.
 */
const GWS_READ_METHOD_RE =
  /^(?:--help|(?:list|get|search|batchGet)(?:[A-Z][A-Za-z]*)?)$/;

/** A plain gws command word — never a flag (`--x`) or helper (`+send`). */
const GWS_SEGMENT_RE = /^[a-z][A-Za-z0-9]*$/;

/**
 * A google_workspace_cli call is a read only when EVERY argv word it builds
 * is plain: `service` and each `resource.split(".")` segment become argv
 * words BEFORE `method` (audit 2026-09-30 C1: `resource:"+send.--space…"`
 * with `method:"list"` posts a message), and a `json` body is a write.
 * An empty resource adds no word (service-level `--help`).
 */
function isGwsReadCall(args: Record<string, unknown>): boolean {
  const { service, resource, method } = args;
  return (
    typeof method === "string" &&
    GWS_READ_METHOD_RE.test(method) &&
    typeof service === "string" &&
    GWS_SEGMENT_RE.test(service) &&
    typeof resource === "string" &&
    (resource === "" ||
      resource.split(".").every((seg) => GWS_SEGMENT_RE.test(seg))) &&
    args.json === undefined
  );
}

/**
 * Per-tool "does THIS call need the operator's yes" predicates for high-risk
 * tools whose read calls are harmless. A tool without an entry always asks.
 */
const CONFIRMATION_PREDICATES: Readonly<
  Record<string, (args: Record<string, unknown>) => boolean>
> = {
  google_workspace_cli: (args) => !isGwsReadCall(args),
};

/**
 * Declared tools that hand THEIR runs a tool set the caller picks, so a
 * low tier says nothing about what those runs can reach: `schedule_task`
 * (a new schedule with any tools) and `batch_decompose` (sub-tasks with
 * any tools, inheriting the run's interactive=false).
 */
const TOOL_SET_CARRIERS: ReadonlySet<string> = new Set([
  "schedule_task",
  "batch_decompose",
]);

/**
 * A tool whose runs can reach ANY tool, so its tier says nothing: a declared
 * tool-set carrier, or a name the registry does not know (an MCP tool whose
 * server has not loaded, a typo, a future tool — its tier is unknown).
 */
export function isToolSetCarrier(
  registry: Pick<ToolRegistry, "has">,
  name: string,
): boolean {
  return TOOL_SET_CARRIERS.has(name) || !registry.has(name);
}

/** High-risk by tier, or a carrier / unregistered name (see above). */
export function isUnattendedRisky(
  registry: Pick<ToolRegistry, "getEffectiveRiskTier" | "has">,
  name: string,
): boolean {
  return (
    registry.getEffectiveRiskTier(name) === "high" ||
    isToolSetCarrier(registry, name)
  );
}

/**
 * The risky tools a `schedule_task` call would hand to its unattended
 * runs: the declared `tools`, plus `gmail_send` when it delivers by email
 * (dynamic.ts adds it to every email/both run), each judged by the
 * registry's risk tier — never by the prompt text. Also risky whatever
 * their tier: a tool-set carrier, and any name that is not registered
 * (re-audit 2026-10-03: not only MCP-shaped `server__tool` names — an
 * unknown name's tier is unknown).
 */
export function highRiskScheduledTools(
  registry: Pick<ToolRegistry, "getEffectiveRiskTier" | "has">,
  args: Record<string, unknown>,
): string[] {
  const declared = Array.isArray(args.tools)
    ? args.tools.filter((t): t is string => typeof t === "string")
    : [];
  if (args.delivery === "email" || args.delivery === "both") {
    declared.push("gmail_send");
  }
  return [...new Set(declared)].filter((t) => isUnattendedRisky(registry, t));
}

/**
 * The reverse of CONFIRMATION_PREDICATES: a tool that is NOT high-risk asks
 * for THIS call (operator ruling 2026-10-01: a schedule carrying a high-risk
 * tool asks once, at creation; its runs stay unattended). Each entry returns
 * the risky tools it found (empty = no escalation). A Map, so only a listed
 * tool name can match.
 */
const CONFIRMATION_ESCALATIONS: ReadonlyMap<
  string,
  (
    args: Record<string, unknown>,
    registry: Pick<ToolRegistry, "getEffectiveRiskTier" | "has">,
  ) => string[]
> = new Map([
  ["schedule_task", (args, registry) => highRiskScheduledTools(registry, args)],
]);

/**
 * A background run (scheduled, ritual, batch child, API interactive:false)
 * cannot create a schedule carrying a risky tool: nobody is there to say
 * "sí", and the schedule would run it unattended from then on.
 */
export function noConfirmBackgroundScheduleError(tools: string[]): string {
  return `Un schedule que usa herramientas de alto riesgo (${tools.join(", ")}) solo puede crearse desde la conversación del operador, donde se confirma. Esta tarea en segundo plano no puede crearlo. No se ejecutó.`;
}

/**
 * Re-audit should-fix (2026-10-03): an API task (interactive, no chat, not
 * A2A) asked to create a schedule carrying a risky tool. Not "en segundo
 * plano" (it is not a background run) and no `interactive: false` hint —
 * resubmitting that way is refused too (`noConfirmBackgroundScheduleError`).
 */
export function noConfirmApiScheduleError(tools: string[]): string {
  return `Un schedule que usa herramientas de alto riesgo (${tools.join(", ")}) solo puede crearse desde la conversación del operador, donde se confirma. Esta tarea no tiene esa conversación, así que no puede crearlo (tampoco como tarea no interactiva). No se ejecutó.`;
}

/**
 * Operator ruling 2026-10-03 (batch_decompose): a sub-task of a background
 * run used a high-risk tool or a carrier that run's schedule did not declare.
 */
export function undeclaredToolError(tool: string): string {
  return `La herramienta ${tool} es de alto riesgo y el schedule de esta tarea en segundo plano no la declaró, así que esta sub-tarea no puede usarla. No se ejecutó.`;
}

/**
 * Operator ruling R6: an interactive task that cannot ask (API/A2A task —
 * no chat) is refused; the hint tells the API caller how to run it.
 */
export const NO_CONFIRM_CHANNEL_ERROR =
  "Esta acción de alto riesgo requiere confirmación del operador y esta tarea no tiene una conversación donde pedirla. No se ejecutó. Pídela en una conversación directa con Jarvis, o envía la tarea como no interactiva (interactive: false).";

/**
 * The same refusal for a run that answers a chat but cannot ask (non-owner
 * sender, sub-task, retry): no API hint — it can reach any sender (S3).
 */
export const NO_CONFIRM_IN_CHAT_ERROR =
  "Esta acción de alto riesgo requiere la confirmación del operador y no puede pedirse desde aquí. No se ejecutó.";

/**
 * The same refusal for an A2A task (round 3): a peer agent cannot resubmit
 * with `interactive: false`, so no API hint.
 */
export const NO_CONFIRM_A2A_ERROR =
  "Esta acción de alto riesgo requiere la confirmación del operador y una tarea A2A no tiene dónde pedirla. No se ejecutó.";

export type ConfirmationGateDecision =
  | { action: "proceed" }
  | { action: "confirm" }
  | { action: "refuse"; error: string; reason?: "undeclared_tool" };

/**
 * Decide whether a tool call may run now.
 * - non-interactive run (scheduled, ritual, reflection): proceed — the
 *   schedule itself is the prior authorization — except a new schedule
 *   carrying a risky tool, which nobody authorized: refuse.
 * - not high-risk (unless CONFIRMATION_ESCALATIONS says this call is — a
 *   schedule carrying a high-risk tool), a read call of a mixed tool (R2),
 *   or already unlocked: proceed.
 * - the context can ask (fast runner on a router-tracked operator root):
 *   confirm (ask first).
 * - anything else cannot ask — API/A2A task, non-owner sender, sub-task,
 *   retry, a runner that does not surface the ask: refuse (R6, audit
 *   2026-09-30 C2/W3).
 * No text matching on the operator's message — an instruction in the
 * request is never a confirmation (R3).
 */
export function confirmationGate(
  registry: Pick<ToolRegistry, "getEffectiveRiskTier" | "has">,
  context: Pick<
    TaskExecutionContext,
    "interactive" | "isDestructiveUnlocked" | "canAskOperator" | "chatOrigin"
  > &
    Partial<Pick<TaskExecutionContext, "a2aOrigin" | "inheritedDeclaredTools">>,
  name: string,
  args: Record<string, unknown>,
): ConfirmationGateDecision {
  if (!context.interactive) {
    // Operator ruling 2026-10-03: a sub-task of a background run (batch
    // child) may not reach a risky tool its run did not declare. A read
    // call of a mixed tool (CONFIRMATION_PREDICATES) is not risky.
    const declared = context.inheritedDeclaredTools;
    if (
      declared !== undefined &&
      !declared.includes(name) &&
      isUnattendedRisky(registry, name) &&
      CONFIRMATION_PREDICATES[name]?.(args) !== false
    ) {
      return {
        action: "refuse",
        error: undeclaredToolError(name),
        reason: "undeclared_tool",
      };
    }
    const risky = CONFIRMATION_ESCALATIONS.get(name)?.(args, registry) ?? [];
    return risky.length > 0
      ? { action: "refuse", error: noConfirmBackgroundScheduleError(risky) }
      : { action: "proceed" };
  }
  let escalated: string[] = [];
  if (registry.getEffectiveRiskTier(name) !== "high") {
    escalated = CONFIRMATION_ESCALATIONS.get(name)?.(args, registry) ?? [];
    if (!escalated.length) return { action: "proceed" };
  }
  const predicate = CONFIRMATION_PREDICATES[name];
  if (predicate && !predicate(args)) return { action: "proceed" };
  if (context.isDestructiveUnlocked(name, argsFingerprint(args))) {
    return { action: "proceed" };
  }
  if (!context.canAskOperator) {
    return {
      action: "refuse",
      error: context.chatOrigin
        ? NO_CONFIRM_IN_CHAT_ERROR
        : context.a2aOrigin
          ? NO_CONFIRM_A2A_ERROR
          : escalated.length > 0
            ? // An escalated schedule: `interactive: false` is refused too.
              noConfirmApiScheduleError(escalated)
            : NO_CONFIRM_CHANNEL_ERROR,
    };
  }
  return { action: "confirm" };
}

/**
 * Operator ruling 2026-10-03: record an undeclared-tool refusal on the run
 * (the dispatcher fails the run from it) and put it on the trace timeline.
 */
export function noteUndeclaredRefusal(
  context: Pick<TaskExecutionContext, "taskId" | "recordUndeclaredRefusal">,
  name: string,
  origin?: string,
): void {
  context.recordUndeclaredRefusal(name);
  emitTraceEvent({
    taskId: context.taskId,
    name: "tool.gated",
    tool: name,
    attrs: {
      decision: "refused_undeclared",
      ...(origin !== undefined && { origin }),
    },
  });
}

/**
 * Create a per-task executor that delegates to toolRegistry but uses the
 * task's own execution context for destructive lock checks and memory
 * rate limiting.
 */
export function createTaskExecutor(
  registry: ToolRegistry,
  context: TaskExecutionContext,
): ToolExecutor {
  return async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    // CCP5+CCP9: HIGH-risk tools (requiresConfirmation) require user approval.
    // Multi-turn confirmation flow: tool returns CONFIRMATION_REQUIRED →
    // LLM asks user → task completes → pending stored → user confirms →
    // router executes directly on next message. Pattern from Executor.
    // Bypass: non-interactive tasks (scheduled, rituals) have no user to confirm —
    // the schedule itself serves as prior authorization.
    const gate = confirmationGate(registry, context, name, args);
    if (gate.action === "refuse" && gate.reason === "undeclared_tool") {
      noteUndeclaredRefusal(context, name);
    }
    if (gate.action === "refuse") {
      log.info(
        { tool: name, taskId: context.taskId },
        "high-risk tool refused — no conversation to confirm in",
      );
      return JSON.stringify({ error: gate.error });
    }
    if (gate.action === "confirm") {
      // Store the pending operation so the router can execute it on confirmation
      context.setPendingConfirmation(name, args);
      log.info(
        { tool: name, taskId: context.taskId },
        "high-risk tool requires confirmation — pausing for user approval",
      );
      return JSON.stringify({
        error: "CONFIRMATION_REQUIRED",
        message:
          "Esta acción requiere confirmación del usuario. " +
          "Presenta lo que vas a hacer y pregunta: '¿Procedo?' o '¿Lo envío?' " +
          "El usuario confirmará en el siguiente mensaje y la acción se ejecutará automáticamente.",
        tool: name,
      });
    }

    // Memory store rate limiting via context
    if (name === "memory_store") {
      if (!context.tryMemoryStore()) {
        return JSON.stringify({
          warning: `Memory store limit reached (${context.getMemoryStoreLimit()}/task). Prioritize quality over quantity — store only the most valuable observation.`,
        });
      }
    }

    // v6.4 H2: Pre-flight verification on critical tools.
    // Check preconditions BEFORE execution to prevent cryptic failures.
    const preflightError = checkPreflight(name, args);
    if (preflightError) {
      log.warn({ tool: name, taskId: context.taskId }, preflightError);
      return JSON.stringify({ error: preflightError });
    }

    // Delegate actual execution to the registry (read-only singleton)
    const result = await registry.execute(name, args);

    // v6.2 S3: Record file mutations after successful tool execution.
    // Centralized here so individual tool handlers don't need modification.
    // Only records if the tool is a file-mutating tool and didn't return an error.
    try {
      // Detect error results — don't record failed mutations (C1 audit fix).
      // "Error:" prefix = MCP-passthrough leg: MCP servers' plain-text outputs
      // aren't ours to converge. Builtin tools no longer return "Error:"
      // strings (converged on {error} JSON, 2026-07-05).
      let isError = result.startsWith("Error:");
      if (!isError) {
        try {
          const parsed = JSON.parse(result);
          // {error: ...} is THE builtin failure convention. The
          // `success === false` leg survives only for the remaining dynamic
          // envelope producers: jarvis_files_batch_* (`success: errors === 0`,
          // documented partial-error contract) and gemini_upload
          // (`success: state === "ACTIVE"`). No literal {success:false}
          // failure sites remain in src/tools.
          if (parsed.error || parsed.success === false) isError = true;
        } catch {
          // Non-JSON result — not an error
        }
      }
      if (!isError) {
        const mutation = classifyMutation(name, args);
        if (mutation) {
          recordMutation(
            context.taskId,
            name,
            mutation.operation,
            mutation.filePath,
          );
        }
      }
    } catch {
      // Non-fatal — mutation log is best-effort
    }

    return result;
  };
}
