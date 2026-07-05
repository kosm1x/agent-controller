/**
 * Reflection runner — V8.1 Phase 4 (Proactive Context Engine, spec §4/§7).
 *
 * NOT a sixth runner (anti-mission: no new runner). `runReflection` is a thin
 * wrapper that invokes the existing `fastRunner` with reflection-specific
 * config: a reflection system-prompt template, a bounded-diff scope rendered
 * into one user turn, a read-only tool allowlist, and the Letta role-reframe
 * `<system-reminder>` that stops the reflector collapsing into Jarvis's
 * identity (`feedback_sonnet_identity_drift`).
 *
 * PHASE 4 IS THE HARNESS. Judgment construction and the `proposed_briefings`
 * write path are V8.1 Phase 6 — the prompt below is an honest placeholder and
 * the tool allowlist is read-only-only. `runReflection` now FIRES in production
 * via the Phase-7 triggers (n-turn.ts + idle-detect.ts) — so it runs live on the
 * Phase-6 placeholder judgment prompt below until Phase 6 ships real judgment
 * construction. (Updated 2026-07-05: the prior "nothing triggers it yet" note
 * drifted once the triggers were wired.)
 *
 * Cursor contract: a successful pass advances the cursor to the scope's
 * `lastProcessedEventId`; a failed pass leaves it, so the next pass retries
 * the same delta.
 */

import { fastRunner } from "../runners/fast-runner.js";
import type { RunnerInput, RunnerOutput } from "../runners/types.js";
import { recordReflectionCost } from "../budget/service.js";
import { SONNET_MODEL_ID } from "../inference/claude-sdk.js";
import { advanceCursor, type ReflectionCursorName } from "./cursors.js";
import {
  buildReflectionScope,
  type ReflectionScope,
  type ReflectionTrigger,
} from "./scope.js";
import { errMsg } from "../lib/err-msg.js";

/**
 * Read-only tool allowlist for the reflection pass. PHASE 6 adds the
 * `proposed_briefings` write tool here; until then the reflector can only
 * read. Must be non-empty — `fastRunner` rejects a zero-tool input.
 */
export const REFLECTION_TOOLS: readonly string[] = [
  "memory_search",
  "task_history",
] as const;

/**
 * Letta role-reframe (spec §7, near-verbatim). Injected as a
 * `<system-reminder>`-style block at the top of the reflector's user turn so
 * it does not adopt Jarvis's first-person identity — the events below are
 * records of the PRIMARY agent, not the reflector's own actions.
 */
export const ROLE_REFRAME =
  "You are a background reflector for the primary Jarvis agent. The task and " +
  "conversation records below are records of the primary agent's interactions " +
  "with Fede — they are NOT your own actions. Your job is to construct " +
  "judgments about state, momentum, and risk from these records. You do NOT " +
  "speak to Fede directly; your output is reviewed and either promoted or " +
  "discarded by the morning surface.";

/**
 * Phase 4 reflection system-prompt template. Phase 6 replaces this with the
 * real judgment prompt.
 *
 * The trailing status-line instruction is load-bearing, not cosmetic:
 * `fastRunner` appends `STATUS_SUFFIX` and gates `output.success` on the
 * model emitting a `STATUS:` line (`parseRunnerStatus`). A reflection that
 * produces good text but omits the footer would read as `success:false` →
 * `runner-failed` → the cursor never advances → the same delta is
 * re-processed forever (audit W4). Phase 6's real prompt MUST keep an
 * explicit status-line contract.
 */
const REFLECTION_SYSTEM_PROMPT =
  "You are a background reflection process for a personal AI agent system. " +
  "You receive a bounded set of recent task records and reason about them. " +
  "Be concise and factual. Do not invent records that are not shown to you. " +
  "End your response with a line `STATUS: DONE`.";

export interface RunReflectionOptions {
  cursorName: ReflectionCursorName;
  trigger: ReflectionTrigger;
}

export interface RunReflectionResult {
  /** False when the delta was empty — no inference was invoked. */
  ran: boolean;
  /** Why the pass did not run, or why it ran but did not advance the cursor. */
  reason?: "empty-delta" | "runner-failed";
  scope: ReflectionScope;
  output?: RunnerOutput;
  /** The cursor value after the pass, when it was advanced. */
  cursorAdvancedTo?: number;
}

/**
 * Render the bounded-diff scope into the reflector's user turn: role-reframe
 * `<system-reminder>` + the delta task list + the Phase-4 task instruction.
 * Pure — exported so the role-reframe contract is unit-testable.
 */
export function buildReflectionMessage(scope: ReflectionScope): string {
  const lines = scope.deltaEvents.map(
    (e) =>
      `- [event ${e.eventId}] ${e.title} — status=${e.status}` +
      `${e.agentType ? `, agent=${e.agentType}` : ""} ` +
      `(created ${e.createdAt}, updated ${e.updatedAt})`,
  );
  return `<system-reminder>
${ROLE_REFRAME}
</system-reminder>

## Bounded diff — ${scope.trigger}: ${scope.deltaEvents.length} task(s) since event ${scope.priorStateSnapshot.asOfEventId}

${lines.join("\n")}

---
PHASE 4 HARNESS — judgment construction and the proposed_briefings write path
arrive in V8.1 Phase 6. For now, produce a brief plain-text summary of the
delta above: state, momentum, and anything notable.`;
}

/**
 * Run one reflection pass over the bounded diff for `cursorName` / `trigger`.
 *
 * An empty delta is a no-op — no inference, no cursor move. Otherwise the
 * scope is rendered into a `fastRunner` invocation; on success the cursor
 * advances to `scope.lastProcessedEventId`.
 */
export async function runReflection(
  opts: RunReflectionOptions,
): Promise<RunReflectionResult> {
  const scope = buildReflectionScope(opts.cursorName, opts.trigger);

  if (scope.deltaEvents.length === 0) {
    // Nothing new since the cursor — skip inference entirely.
    return { ran: false, reason: "empty-delta", scope };
  }

  const reflectionId = crypto.randomUUID();
  const input: RunnerInput = {
    taskId: `reflect-${reflectionId}`,
    runId: `reflect-run-${reflectionId}`,
    title: `reflection:${opts.trigger}`,
    // fastRunner's chat path uses `description` as the system prompt and the
    // conversationHistory turns as the exchange — exactly the reflection
    // shape: reflection template = system, the rendered scope = the one turn.
    // PHASE 6 NOTE (audit W3): the chat path also injects mc-jarvis essential
    // identity facts as a second system message via getEssentialFacts(). The
    // role-reframe below competes against that. Phase 6 must verify the
    // reflector does not collapse into Jarvis's first person.
    description: REFLECTION_SYSTEM_PROMPT,
    conversationHistory: [
      { role: "user", content: buildReflectionMessage(scope) },
    ],
    tools: [...REFLECTION_TOOLS],
    interactive: false,
  };

  let output: RunnerOutput;
  try {
    output = await fastRunner.execute(input);
  } catch (err) {
    // fastRunner converts most failures into {success:false}, but a throw
    // before its internal try (tool-registry resolution, zero-tools branch)
    // would escape. Map it to the same failed-pass shape so the
    // cursor-retry contract is self-contained, not dependent on fastRunner's
    // internal structure (audit W1).
    return {
      ran: true,
      reason: "runner-failed",
      scope,
      output: {
        success: false,
        error: errMsg(err),
        durationMs: 0,
      },
    };
  }

  // §13 instrumentation: tag this pass's inference cost as
  // `reflection:<trigger>` so the activation gate can measure it.
  // `fastRunner.execute` ran outside the dispatcher, so the dispatcher's own
  // recordCost never fired. Recorded for ANY completed inference round-trip —
  // success OR a non-thrown failure (a failed pass still spent tokens and hit
  // the cache; the §13 ratio must cover all reflection inference, audit R1).
  // The thrown-error path above synthesizes an output with no `tokenUsage`,
  // so it correctly records nothing.
  if (output.tokenUsage) {
    recordReflectionCost({
      surface: opts.trigger,
      taskId: input.taskId,
      model: output.tokenUsage.actualModel ?? SONNET_MODEL_ID,
      promptTokens: output.tokenUsage.promptTokens,
      completionTokens: output.tokenUsage.completionTokens,
      costUsd: output.tokenUsage.actualCostUsd,
      cacheReadTokens: output.tokenUsage.cacheReadTokens,
      cacheCreationTokens: output.tokenUsage.cacheCreationTokens,
    });
  }

  if (output.success) {
    advanceCursor(opts.cursorName, scope.lastProcessedEventId);
    return {
      ran: true,
      scope,
      output,
      cursorAdvancedTo: scope.lastProcessedEventId,
    };
  }

  // Failed pass — leave the cursor so the next pass retries the same delta.
  return { ran: true, reason: "runner-failed", scope, output };
}
