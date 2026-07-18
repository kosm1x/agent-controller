/**
 * Task dispatcher.
 *
 * Manages the full task lifecycle: creation, classification, runner routing,
 * concurrency control, and status updates. All state is persisted to SQLite.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "../db/index.js";
import { getEventBus } from "../lib/event-bus.js";
import { classify } from "./classifier.js";
import { getConfig } from "../config.js";
import { checkoutTask } from "./checkout.js";
import {
  isAnyWindowExceeded,
  getThreeWindowStatus,
  recordCost,
} from "../budget/service.js";
import { taskStarted, taskCompleted } from "../observability/prometheus.js";
import { emitTraceEvent } from "../observability/task-trace.js";
import type { AgentType, RunnerInput, Runner } from "../runners/types.js";
import { createLogger } from "../lib/logger.js";
import { stripCacheMarker } from "../messaging/router.js";
import { SONNET_MODEL_ID } from "../inference/claude-sdk.js";
import { ritualContext } from "../tools/flailing-guard.js";
import { getMemoryService } from "../memory/index.js";
import type { MemoryBank } from "../memory/types.js";
import { errMsg } from "../lib/err-msg.js";
import { extractDeliverableText } from "../lib/deliverable.js";

// Per-window soft-cap warn timestamps. Rate-limits the warn log so an
// operator over budget for the rest of the month doesn't get 60+ warn
// lines/hour burying other warnings in journalctl. One warn per window
// per WARN_INTERVAL_MS, separately tracked for hourly/daily/monthly.
const SOFT_CAP_WARN_INTERVAL_MS = 60_000;
const lastSoftCapWarnAt: Record<string, number> = {};

const log = createLogger("dispatch");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSubmission {
  title: string;
  description: string;
  priority?: "critical" | "high" | "medium" | "low";
  agentType?: string;
  tags?: string[];
  tools?: string[];
  input?: unknown;
  /**
   * Full, UNTRUNCATED user text for runner-classification of messaging tasks.
   * `title` is truncated to 60 chars for display and a mid-word cut can forge a
   * coding signal ("precio"→"pr") that misroutes a chat into the nanoclaw sandbox
   * (2026-07-06). Chat callers set this to the raw inbound message; the classifier
   * detects on it instead of the truncated title. See ClassificationInput.
   */
  detectionText?: string;
  parentTaskId?: string;
  spawnType?: "root" | "subtask" | "user-background";
  /** Prior conversation turns for thread continuity (chat tasks). */
  conversationHistory?: import("../runners/types.js").ConversationTurn[];
  /** Tools that MUST appear in toolCalls for the task to be considered successful. */
  requiredTools?: string[];
  /** Streaming callback — receives text chunks as the LLM generates them. */
  onTextChunk?: (text: string) => void;
  /** Abort controller for task cancellation (v6.2 S2). Caller creates and retains it. */
  abortController?: AbortController;
  /** Whether the task has an interactive user who can confirm high-risk actions.
   *  Defaults to true. Scheduled tasks, rituals set this to false. */
  interactive?: boolean;
  /** @internal Set by dispatcher on auto-retry to prevent infinite retry loops. */
  _isRequiredToolRetry?: boolean;
  /**
   * @internal Set on a retry submission so the new task's `retry_count`
   * column starts at the predecessor's value + 1. Used by both the
   * dispatcher's _isRequiredToolRetry path AND the swarm-retry-policy
   * to enforce the shared per-sub-task retry budget (queue #231).
   * Defaults to 0 for fresh submissions.
   */
  retryCount?: number;
  /**
   * Ritual identifier (e.g. "evolution-log", "morning-briefing"). Set by the
   * scheduler for scheduled-ritual tasks. When present, dispatchWithSlot
   * wraps `runner.execute()` in `ritualContext.run({ ritualId })` so the
   * flailing-guard short-circuits across the runner's tool-call loop. Any
   * sub-task spawned by this runner inherits the exemption via ALS — see
   * the head comment in flailing-guard.ts for the rationale. See P1+P2 in
   * the 2026-05-24 /diagnose run: ritual SELECT/curl chains were tripping
   * FLAILING strikes and steering Jarvis to write "API unreachable" in
   * EVOLUTION-LOG.md even when the API was healthy.
   */
  ritualId?: string;
  /**
   * Deterministic output persistence for rituals (skill-evolution /diagnose,
   * 2026-06-28). When set, the dispatcher stores the runner's report text to
   * memory in CODE on completion — instead of relying on the agent to call
   * `memory_store` itself. The old skill-evolution ritual gated success on a
   * final discretionary `memory_store` call the model skipped ~100% of the
   * time on Sonnet (0/10), failing the ritual for 9 straight days. Persisting
   * here removes the dependency on the agent's tool choice. Stores on a normal
   * completion whether the reflector judged it success or failure; never blocks
   * completion. NOTE: the required-tools-missing early returns short-circuit
   * before this point, so a submission that sets BOTH `requiredTools` and
   * `persistResult` would not persist on that specific failure — fine for
   * rituals (they set `tools`, not `requiredTools`).
   */
  persistResult?: { bank: MemoryBank; tags: string[] };
}

export interface TaskRow {
  id: number;
  task_id: string;
  parent_task_id: string | null;
  spawn_type: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  agent_type: string | null;
  classification: string | null;
  assigned_to: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  progress: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
}

interface RunRow {
  id: number;
  run_id: string;
  task_id: string;
  agent_type: string;
  status: string;
  phase: string | null;
  trace: string | null;
  goal_graph: string | null;
  input: string;
  output: string | null;
  error: string | null;
  token_usage: string | null;
  duration_ms: number | null;
  container_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Runner registry
// ---------------------------------------------------------------------------

const runners = new Map<AgentType, Runner>();

/** Register a runner implementation. Called at startup by each runner module. */
export function registerRunner(runner: Runner): void {
  runners.set(runner.type, runner);
}

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------

let activeContainers = 0;
let maxContainers = 5;

export function setMaxContainers(max: number): void {
  maxContainers = max;
}

function acquireContainerSlot(): boolean {
  if (activeContainers >= maxContainers) return false;
  activeContainers++;
  return true;
}

function releaseContainerSlot(): void {
  if (activeContainers > 0) activeContainers--;
  drainContainerQueue();
}

/** Returns true if the runner type requires a container slot. */
function needsContainer(agentType: AgentType): boolean {
  if (agentType === "nanoclaw") return true;
  if (agentType === "heavy") return getConfig().heavyRunnerContainerized;
  return false;
}

// ---------------------------------------------------------------------------
// Container queue — retries queued tasks when a slot frees up
// ---------------------------------------------------------------------------

interface QueuedContainerTask {
  taskId: string;
  agentType: AgentType;
  submission: TaskSubmission;
}

const containerQueue: QueuedContainerTask[] = [];

function enqueueContainerTask(
  taskId: string,
  agentType: AgentType,
  submission: TaskSubmission,
): void {
  containerQueue.push({ taskId, agentType, submission });
  log.info(
    { taskId, queueLength: containerQueue.length },
    "task queued for container slot",
  );
}

function drainContainerQueue(): void {
  while (containerQueue.length > 0) {
    const next = containerQueue[0];
    if (!acquireContainerSlot()) break;
    containerQueue.shift();
    log.info(
      { taskId: next.taskId },
      "dequeued task — container slot acquired",
    );
    dispatchWithSlot(next.taskId, next.agentType, next.submission).catch(
      (err) => {
        log.error({ err, taskId: next.taskId }, "queued task failed");
        updateTaskStatus(next.taskId, "failed", undefined, String(err));
        releaseContainerSlot();
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------

/**
 * Slugs + names of registered projects that are NOT mission-control. Fed to the
 * classifier so a coding task that NAMES a sibling project (e.g. "termina la
 * landing de EurekaMS") routes to a host runner instead of the
 * mission-control-only nanoclaw sandbox — the path-literal `targetsForeignRepo`
 * guard alone misses name references (2026-06-24 EurekaMS-Landing incident).
 * Cheap (small table), recomputed per submission so newly-registered projects
 * take effect immediately. Length-gated ≥4 to avoid spurious short-slug matches.
 * Never throws — routing must not break on a project-table read.
 */
// TTL cache (2026-07-05 efficiency audit): this fed the classifier's
// foreign-repo guard with a synchronous SELECT on EVERY task-creating message,
// over a ≤30-row table that changes rarely (project add/rename). 30s staleness
// is acceptable — a just-registered project's misroute window is one refresh.
const FOREIGN_PROJECTS_TTL_MS = 30_000;
let foreignProjectsCache: { at: number; names: string[] } | null = null;

function getForeignProjectNames(db: ReturnType<typeof getDatabase>): string[] {
  if (
    foreignProjectsCache &&
    Date.now() - foreignProjectsCache.at < FOREIGN_PROJECTS_TTL_MS
  ) {
    return foreignProjectsCache.names;
  }
  try {
    const rows = db
      .prepare(
        `SELECT slug, name, config FROM projects
         WHERE lower(slug) NOT IN ('mission-control', 'agent-controller', 'jarvis')
           AND lower(COALESCE(status, 'active')) NOT IN ('archived', 'completed')`,
      )
      .all() as Array<{
      slug: string | null;
      name: string | null;
      config: string | null;
    }>;
    const out = new Set<string>();
    for (const r of rows) {
      const slug = r.slug?.trim();
      const name = r.name?.trim();
      if (slug && slug.length >= 4) out.add(slug);
      if (name && name.length >= 4) out.add(name);
      // config.aliases: user-facing shorthand that names the project without
      // its slug/name — e.g. "el Journal W29" targets williams-entry-radar's
      // journal repo but contains neither "williams" nor "radar". The W29
      // misroute (task cf40a528, 2026-07-18) sailed past this guard into the
      // nanoclaw sandbox on exactly that gap.
      try {
        const aliases = JSON.parse(r.config ?? "{}")?.aliases;
        if (Array.isArray(aliases)) {
          for (const a of aliases) {
            if (typeof a === "string" && a.trim().length >= 4) {
              out.add(a.trim());
            }
          }
        }
      } catch {
        // Malformed config JSON — slug/name coverage still applies.
      }
    }
    foreignProjectsCache = { at: Date.now(), names: [...out] };
    return foreignProjectsCache.names;
  } catch {
    // Don't cache the failure — retry on the next message.
    return [];
  }
}

/**
 * Submit a new task. Classifies it, persists it, and dispatches to the
 * appropriate runner asynchronously.
 */
export async function submitTask(submission: TaskSubmission): Promise<{
  taskId: string;
  agentType: AgentType;
  classification: { score: number; reason: string; explicit: boolean };
}> {
  const db = getDatabase();
  const taskId = randomUUID();

  // v8 S1: strip cache-break marker for persistence + classifier + events.
  // The marker is preserved on `submission.description` for the in-memory
  // RunnerInput path (line ~360) so the fast-runner chat branch still splits
  // on it. DB / dashboards / mc-ctl / classifier / event listeners see clean
  // text. Retries fetched from DB will lack the marker — they fall back
  // gracefully (whole description treated as stable, no cache benefit on
  // retry, no functional break).
  const cleanDescription = stripCacheMarker(submission.description);

  // Classify
  const classification = classify({
    title: submission.title,
    description: cleanDescription,
    tags: submission.tags,
    priority: submission.priority,
    agentType: submission.agentType,
    // Full untruncated inbound for messaging detection (chat titles are truncated
    // to 60 chars → a mid-word cut can forge a coding signal). See classifier.
    detectionText: submission.detectionText,
    // Sibling projects named (not just path-referenced) keep a coding task off
    // the mission-control-only nanoclaw sandbox. Resolved fresh per submission.
    foreignProjectNames: getForeignProjectNames(db),
  });

  // Insert task. retry_count defaults to 0 for fresh submissions; the
  // _isRequiredToolRetry path at line ~471 and the swarm-retry-policy
  // pass retryCount=predecessor.retry_count+1 to budget the per-sub-task
  // retry window (queue #231).
  db.prepare(
    `
    INSERT INTO tasks (task_id, parent_task_id, spawn_type, title, description, priority, status, agent_type, classification, input, metadata, retry_count)
    VALUES (@taskId, @parentTaskId, @spawnType, @title, @description, @priority, 'queued', @agentType, @classification, @input, @metadata, @retryCount)
  `,
  ).run({
    taskId,
    parentTaskId: submission.parentTaskId ?? null,
    spawnType: submission.spawnType ?? "root",
    title: submission.title,
    description: cleanDescription,
    priority: submission.priority ?? "medium",
    agentType: classification.agentType,
    classification: JSON.stringify(classification),
    input: submission.input ? JSON.stringify(submission.input) : null,
    // Persist metadata when ANY of tags/tools/ritualId is set. The earlier
    // `tags ? {tags, tools} : null` shape silently dropped `tools` for
    // submissions that had tools but no tags (e.g. ritual factories like
    // createEvolutionRitual). On retry, the reactions manager couldn't
    // recover the original tool subset because it was never persisted —
    // the retry then went through the classifier with no hints and landed
    // on the wrong runner. ritualId is also persisted so reaction-retried
    // rituals inherit the flailing-guard exemption (yesterday's Fix 1).
    metadata:
      submission.tags || submission.tools || submission.ritualId
        ? JSON.stringify({
            ...(submission.tags && { tags: submission.tags }),
            ...(submission.tools && { tools: submission.tools }),
            ...(submission.ritualId && { ritualId: submission.ritualId }),
          })
        : null,
    retryCount: submission.retryCount ?? 0,
  });

  // Emit event
  try {
    getEventBus().emitEvent("task.created", {
      task_id: taskId,
      title: submission.title,
      description: cleanDescription,
      priority: submission.priority ?? "medium",
      tags: submission.tags ?? [],
      created_by: "api",
    });
  } catch {
    // Event bus emission should not block task creation
  }

  // Dispatch asynchronously
  dispatchTask(taskId, classification.agentType, submission).catch((err) => {
    log.error({ err, taskId }, "failed to dispatch task");
    updateTaskStatus(taskId, "failed", undefined, String(err));
  });

  return {
    taskId,
    agentType: classification.agentType,
    classification: {
      score: classification.score,
      reason: classification.reason,
      explicit: classification.explicit,
    },
  };
}

/**
 * Dispatch a task to its runner. Handles concurrency for container-based runners.
 */
async function dispatchTask(
  taskId: string,
  agentType: AgentType,
  submission: TaskSubmission,
): Promise<void> {
  const runner = runners.get(agentType);
  if (!runner) {
    updateTaskStatus(
      taskId,
      "failed",
      undefined,
      `No runner registered for type: ${agentType}`,
    );
    return;
  }

  // Budget gate. Soft-cap mode by default (log + emit but don't block);
  // hard-enforce when config.budgetEnforce is true. Either way, requires
  // config.budgetEnabled to fire at all — if disabled, no warn, no block.
  // See P6 from 2026-05-24 /diagnose: operator chose soft-cap so spend
  // is observable without surprising task-blocking.
  const config = getConfig();
  if (config.budgetEnabled && isAnyWindowExceeded()) {
    const windows = getThreeWindowStatus();
    const exceededWindow = windows.hourly.exceeded
      ? {
          name: "hourly",
          spend: windows.hourly.spend,
          limit: windows.hourly.limit,
        }
      : windows.daily.exceeded
        ? {
            name: "daily",
            spend: windows.daily.spend,
            limit: windows.daily.limit,
          }
        : {
            name: "monthly",
            spend: windows.monthly.spend,
            limit: windows.monthly.limit,
          };
    const exceededLabel = `${exceededWindow.name} ($${exceededWindow.spend.toFixed(2)} / $${exceededWindow.limit.toFixed(2)})`;

    if (config.budgetEnforce) {
      log.info(
        { taskId, exceeded: exceededLabel, enforce: true },
        "task blocked: budget exceeded",
      );
      updateTaskStatus(
        taskId,
        "blocked",
        undefined,
        `Budget exceeded: ${exceededWindow.name} limit reached`,
      );
      return;
    }

    // Soft-cap: log warn (rate-limited per window) so the breach is
    // visible in journalctl without burying every other warning when
    // the operator is over budget for the rest of the month. The
    // /health endpoint exposes the live per-window state for dashboards.
    const now = Date.now();
    const lastWarnAt = lastSoftCapWarnAt[exceededWindow.name] ?? 0;
    if (now - lastWarnAt >= SOFT_CAP_WARN_INTERVAL_MS) {
      log.warn(
        {
          taskId,
          exceeded: exceededLabel,
          enforce: false,
        },
        "budget soft-cap exceeded (tracking only, task proceeds)",
      );
      lastSoftCapWarnAt[exceededWindow.name] = now;
    }
    // Fall through to dispatch.
  }

  // Container concurrency check
  if (needsContainer(agentType)) {
    if (!acquireContainerSlot()) {
      enqueueContainerTask(taskId, agentType, submission);
      return;
    }
  }

  await dispatchWithSlot(taskId, agentType, submission);
}

/**
 * Pull the human-readable report text out of a runner's output object for
 * `TaskSubmission.persistResult`. Prefers `finalAnswer` — the agent's actual
 * report (heavy-runner derives it from the goal answers via collectFinalAnswer).
 * `content` is the REFLECTOR's 1-3 sentence meta-summary, NOT what the agent
 * produced, so it is only a last-resort fallback. Falls back across the shapes
 * the router's `extractResultText` reads, then to null when nothing is usable.
 */
export function extractPersistText(output: unknown): string | null {
  // V8.5 Phase 4.2: delegates to the canonical extractor — this used to be
  // a divergent copy with its own preference order (content SECOND, ahead
  // of text), the exact smell that produced the 07-11/07-12 meta-summary
  // deliveries on the router side. One order, one module.
  return extractDeliverableText(output)?.trim() || null;
}

/**
 * Execute a task that already has any required container slot acquired.
 * Releases the slot on completion.
 */
async function dispatchWithSlot(
  taskId: string,
  agentType: AgentType,
  submission: TaskSubmission,
): Promise<void> {
  const runner = runners.get(agentType);
  if (!runner) {
    updateTaskStatus(
      taskId,
      "failed",
      undefined,
      `No runner registered for type: ${agentType}`,
    );
    return;
  }

  const db = getDatabase();
  const runId = randomUUID();

  // Create run row
  db.prepare(
    `
    INSERT INTO runs (run_id, task_id, agent_type, status, input)
    VALUES (@runId, @taskId, @agentType, 'running', @input)
  `,
  ).run({
    runId,
    taskId,
    agentType,
    // v8 S1: persisted input shape stays clean (no marker text). RunnerInput
    // below preserves marker for the runner's split-on-marker logic.
    input: JSON.stringify({
      title: submission.title,
      description: stripCacheMarker(submission.description),
    }),
  });

  // Atomic checkout: queued → running (CAS prevents double-dispatch)
  const claimId = `runner:${agentType}:${runId}`;
  const checkout = checkoutTask(taskId, claimId);
  if (!checkout.success) {
    log.info({ taskId, reason: checkout.reason }, "task checkout failed");
    // Roll back the run row we just created
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    if (needsContainer(agentType)) releaseContainerSlot();
    return;
  }

  const input: RunnerInput = {
    taskId,
    runId,
    title: submission.title,
    description: submission.description,
    tools: submission.tools,
    input: submission.input,
    parentTaskId: submission.parentTaskId,
    modelTier: getModelTierFromTask(taskId),
    conversationHistory: submission.conversationHistory,
    onTextChunk: submission.onTextChunk,
    signal: submission.abortController?.signal,
    interactive: submission.interactive,
  };

  taskStarted(agentType);
  // V8.5 Phase 6: forensic timeline start. Best-effort by contract.
  emitTraceEvent({
    taskId,
    runId,
    name: "task.started",
    attrs: {
      agent_type: agentType,
      title: submission.title.slice(0, 120),
      ...(input.modelTier && { tier: input.modelTier }),
    },
  });
  // The runner that ultimately ANSWERS this task. Starts as the classified type
  // but is re-stamped to "fast" if the nanoclaw→fast misroute fallback below
  // succeeds, so cost + outcome are attributed to the runner that actually ran
  // (not the sandbox that failed). See the fallback block for the rationale.
  let effectiveAgentType: AgentType = agentType;
  // W2: the caller acquired a container slot for a container runner; normally the
  // `finally` releases it. The fallback releases it EARLY (before the container-
  // less fast re-run) and sets this so the `finally` doesn't double-release.
  let containerSlotReleased = false;
  try {
    const start = Date.now();
    // Ritual tasks: wrap the runner's entire async execution in ritualContext
    // so the flailing-guard short-circuits across all shell_exec calls inside
    // the LLM loop. Non-ritual submissions skip the wrap entirely, preserving
    // the original process-global guard behavior for normal traffic.
    const ritualId = submission.ritualId;
    let result = await (ritualId
      ? ritualContext.run({ ritualId }, () => runner.execute(input))
      : runner.execute(input));

    // Fast-fallback for a chat that misrouted to the nanoclaw coding sandbox and
    // failed there WITHOUT an error. The sandbox mounts ONLY mission-control, so a
    // plain question — or any non-mc-coding chat that slips classification — has
    // nothing to author and self-assesses failure (success:false, no error). We
    // re-run ONCE on the fast runner IN-PROCESS: the taskId is unchanged, so the
    // router's pending reply still delivers, and `input` (persona + messaging
    // tools + history) is already assembled. The classifier fix (detectionText,
    // 2026-07-06) prevents the truncation misroute at the source; this is the net
    // for any OTHER no-op nanoclaw chat failure. R1: gated on `!result.error` so
    // an ERROR-bearing nanoclaw failure (container crash, real coding error)
    // surfaces honestly instead of being masked by a confident fast non-answer.
    // Loop-free: a single inline fast.execute, gated on agentType==='nanoclaw'.
    if (
      !result.success &&
      !result.error &&
      agentType === "nanoclaw" &&
      (submission.tags ?? []).includes("messaging")
    ) {
      const fastRunner = runners.get("fast");
      if (fastRunner) {
        log.warn(
          { taskId },
          "nanoclaw chat failed (no-op/scope) — falling back to fast runner",
        );
        emitTraceEvent({
          taskId,
          runId,
          name: "task.fallback",
          attrs: { from: "nanoclaw", to: "fast" },
        });
        // W2: the nanoclaw container already spawned + exited inside the runner;
        // free the scarce container slot before the container-less fast re-run so
        // other queued nanoclaw tasks aren't blocked by the extra round-trip.
        if (needsContainer(agentType) && !containerSlotReleased) {
          releaseContainerSlot();
          containerSlotReleased = true;
        }
        // W1: record the failed nanoclaw attempt's own token spend before `result`
        // is overwritten, so it isn't dropped from the cost ledger. Same phantom-
        // zero guard as the main cost block (skip aborted/zero-usage rows).
        if (result.tokenUsage && !isPhantomZeroCostRow(result)) {
          try {
            recordCost({
              runId,
              taskId,
              agentType: "nanoclaw",
              model: result.tokenUsage.actualModel ?? getModelFromTask(taskId),
              promptTokens: result.tokenUsage.promptTokens,
              completionTokens: result.tokenUsage.completionTokens,
              ...(result.tokenUsage.actualCostUsd !== undefined && {
                costUsdOverride: result.tokenUsage.actualCostUsd,
              }),
            });
          } catch {
            // Cost recording must never block completion
          }
        }
        // Restart the stuck-task clock for the fallback attempt: the watchdog
        // fails any running task with started_at older than 15 min, and the
        // dead nanoclaw attempt may have eaten most of that window (task
        // fda02e04: 14 min in the sandbox left the fast fallback 2 minutes
        // before the watchdog killed it mid-work).
        db.prepare(
          "UPDATE tasks SET started_at = datetime('now') WHERE task_id = ? AND status = 'running'",
        ).run(taskId);
        try {
          const fb = await fastRunner.execute(input);
          if (fb.success) {
            result = fb;
            // W1: attribute the rescued task to the runner that actually answered.
            // Without this, the outcome tracker books a fast success as a nanoclaw
            // success, and the classifier's outcome signal then nudges future
            // similar chats BACK toward the sandbox — a self-reinforcing misroute.
            effectiveAgentType = "fast";
            db.prepare(
              "UPDATE tasks SET agent_type = 'fast' WHERE task_id = ?",
            ).run(taskId);
          }
        } catch (err) {
          log.error({ err, taskId }, "fast-runner fallback threw");
        }
      }
    }

    const durationMs = Date.now() - start;

    // Update run
    db.prepare(
      `
      UPDATE runs SET
        status = @status,
        runner_status = @runnerStatus,
        output = @output,
        error = @error,
        token_usage = @tokenUsage,
        goal_graph = @goalGraph,
        trace = @trace,
        tool_calls = @toolCalls,
        duration_ms = @durationMs,
        completed_at = datetime('now')
      WHERE run_id = @runId
    `,
    ).run({
      runId,
      status: result.success ? "completed" : "failed",
      runnerStatus: result.status ?? null,
      output: result.output ? JSON.stringify(result.output) : null,
      error: result.error ?? null,
      tokenUsage: result.tokenUsage ? JSON.stringify(result.tokenUsage) : null,
      goalGraph: result.goalGraph ? JSON.stringify(result.goalGraph) : null,
      trace: result.trace ? JSON.stringify(result.trace) : null,
      // queue #231: persist bare tool names for the swarm-retry classifier.
      // Defensive JSON-encode of an empty array if toolCalls is missing —
      // null distinguishes "no run completed" from "ran but called no tools".
      toolCalls: result.toolCalls ? JSON.stringify(result.toolCalls) : "[]",
      durationMs,
    });

    // Map runner status to task status
    let taskStatus: string;
    if (result.success) {
      taskStatus =
        result.status === "DONE_WITH_CONCERNS"
          ? "completed_with_concerns"
          : "completed";
    } else {
      if (result.status === "NEEDS_CONTEXT") taskStatus = "needs_context";
      else if (result.status === "BLOCKED") taskStatus = "blocked";
      else taskStatus = "failed";
    }

    // Required tool validation: check that critical tools were actually called
    if (submission.requiredTools?.length && result.success) {
      const calledTools = result.toolCalls ?? [];
      const missing = submission.requiredTools.filter(
        (t) => !calledTools.includes(t),
      );
      if (missing.length > 0) {
        if (submission._isRequiredToolRetry) {
          // Retry also failed — alert and give up
          log.error(
            { taskId, missingTools: missing },
            "required tools still missing after retry",
          );
          try {
            getEventBus().emitEvent("notification.warning", {
              title: "Required tools not called",
              message: `Task "${submission.title}" completed without calling: ${missing.join(", ")} (even after retry)`,
              source: "dispatcher",
              context: { taskId, missing },
            });
          } catch {
            /* event emission should not block */
          }
          updateTaskStatus(
            taskId,
            "failed",
            result.output,
            `Required tools not called after retry: ${missing.join(", ")}`,
          );
          emitTraceEvent({
            taskId,
            runId,
            name: "task.failed",
            latencyMs: durationMs,
            attrs: {
              error: `required tools missing after retry: ${missing.join(", ")}`,
            },
          });
          return;
        }

        // First attempt — auto-retry once with explicit instruction.
        // The `...submission` spread preserves agentType, tools, ritualId,
        // and every other field automatically — if this block is ever
        // refactored to explicit field forwarding, remember to include
        // ritualId so reaction-retried rituals keep the flailing-guard
        // exemption (commit `ef5b04e`).
        log.warn(
          { taskId, missingTools: missing },
          "required tools missing, auto-retrying once",
        );
        const retrySubmission: TaskSubmission = {
          ...submission,
          description: `${submission.description}\n\nCRITICAL: You MUST call the following tools before completing this task: ${missing.join(", ")}. The previous attempt completed without calling them. Do not skip these tools.`,
          _isRequiredToolRetry: true,
          // queue #231: shared retry budget with swarm-retry-policy. The
          // resubmitted task gets retry_count=1; if swarm-retry-policy then
          // tries to retry this same lineage on a downstream failure, it
          // sees retry_count>=MAX_RETRIES_PER_GOAL(=1) and gives up.
          retryCount: 1,
        };
        submitTask(retrySubmission).catch((err) => {
          log.error({ err, taskId }, "required-tool retry failed");
        });
        // Mark original as failed with clear reason
        updateTaskStatus(
          taskId,
          "failed",
          result.output,
          `Required tools not called: ${missing.join(", ")}`,
        );
        emitTraceEvent({
          taskId,
          runId,
          name: "task.failed",
          latencyMs: durationMs,
          attrs: {
            error: `required tools missing (auto-retrying): ${missing.join(", ")}`,
          },
        });
        return;
      }
    }

    updateTaskStatus(taskId, taskStatus, result.output, result.error);

    // Deterministic ritual-output persistence (skill-evolution /diagnose,
    // 2026-06-28). Rituals that declare `persistResult` get their report
    // stored to memory HERE, in code — not by the agent voluntarily calling
    // memory_store, which it skipped ~100% of the time on Sonnet. Stores
    // whether the reflector judged success or failure: the analysis report has
    // value even when the score is docked. Never blocks completion. (The
    // required-tools early returns above short-circuit before this — see the
    // persistResult docstring; moot for rituals, which set tools not
    // requiredTools.)
    if (submission.persistResult) {
      try {
        const report = extractPersistText(result.output);
        if (report) {
          await getMemoryService().retain(report, {
            bank: submission.persistResult.bank,
            tags: submission.persistResult.tags,
            async: true,
            trustTier: 3,
            source: "ritual",
          });
        }
      } catch (err) {
        log.warn(
          { taskId, err: errMsg(err) },
          "ritual persistResult: failed to store report",
        );
      }
    }

    // Record cost in ledger (if budget feature is available and we have token
    // data). Phantom-zero guard (open since 2026-05-23): an aborted/timed-out
    // SDK query that streamed no assistant turn yields all-zero usage with no
    // authoritative cost; recording it writes a $0.00 / tokens=0 row that
    // pollutes cost accounting. Skip it — but preserve legitimate $0 rows from
    // real no-op tasks (success=true). See isPhantomZeroCostRow.
    if (result.tokenUsage && isPhantomZeroCostRow(result)) {
      log.info(
        { taskId, runId, agentType, status: result.status ?? null },
        "cost-ledger: skipping phantom zero-cost row (aborted run, zero usage)",
      );
    } else if (result.tokenUsage) {
      try {
        // Prefer the model ID the inference layer actually invoked over the
        // config-derived label — under claude-sdk, cfg.inferencePrimaryModel
        // is an unused/stale string and would mislabel every row.
        const model = result.tokenUsage.actualModel ?? getModelFromTask(taskId);
        recordCost({
          runId,
          taskId,
          // effectiveAgentType so a nanoclaw→fast rescue books its cost as "fast"
          // (the failed nanoclaw attempt's cost was already recorded separately).
          agentType: effectiveAgentType,
          model,
          promptTokens: result.tokenUsage.promptTokens,
          completionTokens: result.tokenUsage.completionTokens,
          // Prefer provider-reported cost. The Anthropic SDK reports $0 under
          // Max auth (accurate) where calculateCost() would overstate using a
          // generic API rate card. Falls back to the pricing-table compute
          // when actualCostUsd is undefined (openai path, older callers).
          ...(result.tokenUsage.actualCostUsd !== undefined && {
            costUsdOverride: result.tokenUsage.actualCostUsd,
          }),
          // v8 S4: persist cache breakdown for cache-hit ratio observability.
          // claude-sdk path sets these; openai/qwen path leaves undefined and
          // the ledger defaults to 0.
          ...(result.tokenUsage.cacheReadTokens !== undefined && {
            cacheReadTokens: result.tokenUsage.cacheReadTokens,
          }),
          ...(result.tokenUsage.cacheCreationTokens !== undefined && {
            cacheCreationTokens: result.tokenUsage.cacheCreationTokens,
          }),
        });
      } catch {
        // Cost recording should never block task completion
      }
    }

    // V8.5 Phase 6: terminal trace event. For a failed task the last
    // tool.called row before this one names the terminal round/tool; here we
    // carry the aggregate (tokens, cost, wall-clock) and the mapped status.
    emitTraceEvent({
      taskId,
      runId,
      name: result.success ? "task.completed" : "task.failed",
      tokensIn: result.tokenUsage?.promptTokens,
      tokensOut: result.tokenUsage?.completionTokens,
      costUsd: result.tokenUsage?.actualCostUsd,
      latencyMs: durationMs,
      ...(result.toolCalls?.length && {
        tool: result.toolCalls[result.toolCalls.length - 1],
      }),
      attrs: {
        status: taskStatus,
        agent_type: effectiveAgentType,
        tool_calls: result.toolCalls?.length ?? 0,
        ...(result.error && { error: result.error.slice(0, 300) }),
      },
    });

    // Emit completion event
    try {
      if (result.success) {
        getEventBus().emitEvent("task.completed", {
          task_id: taskId,
          agent_id: effectiveAgentType,
          result: result.output,
          duration_ms: durationMs,
        });
      } else {
        getEventBus().emitEvent("task.failed", {
          task_id: taskId,
          agent_id: agentType,
          error: result.error ?? "Unknown error",
          recoverable: false,
          attempts: 1,
          // NEEDS_CONTEXT/BLOCKED runners still produced text (the clarifying
          // question / blocker description) — carry it so the router can
          // deliver it instead of the generic failure message.
          result: result.output,
        });
      }
    } catch {
      // Event emission should not block
    }
  } catch (err) {
    const errorMsg = errMsg(err);
    db.prepare(
      `
      UPDATE runs SET status = 'failed', error = @error, completed_at = datetime('now')
      WHERE run_id = @runId
    `,
    ).run({ runId, error: errorMsg });

    updateTaskStatus(taskId, "failed", undefined, errorMsg);
    emitTraceEvent({
      taskId,
      runId,
      name: "task.failed",
      attrs: { error: errorMsg.slice(0, 300), thrown: true },
    });
  } finally {
    taskCompleted(agentType);
    // The fast-fallback may have already released the container slot early (W2);
    // guard against a double-release.
    if (needsContainer(agentType) && !containerSlotReleased) {
      releaseContainerSlot();
    }
  }
}

// ---------------------------------------------------------------------------
// Model tier helper
// ---------------------------------------------------------------------------

/** Extract modelTier from the task's persisted classification JSON. */
function getModelTierFromTask(taskId: string): string | undefined {
  const task = getTask(taskId);
  if (!task?.classification) return undefined;
  try {
    const parsed = JSON.parse(task.classification);
    return parsed.modelTier;
  } catch {
    return undefined;
  }
}

/**
 * Extract the inference model name used for a task (for cost tracking).
 *
 * Called only as a fallback — callers prefer `result.tokenUsage.actualModel`
 * when the inference layer reports one. This function handles older paths
 * that don't thread actualModel through.
 *
 * Under `inferencePrimaryProvider='claude-sdk'`, `cfg.inferencePrimaryModel`
 * is typically empty string or a stale qwen-era value (the SDK auths via
 * ~/.claude/.credentials.json and picks its own model). Labeling every SDK
 * row with that stale string mislabels Sonnet traffic as qwen. Returning the
 * canonical Sonnet ID keeps `cost_ledger.model` attribution coherent.
 */
function getModelFromTask(taskId: string): string {
  const cfg = getConfig();
  if (cfg.inferencePrimaryProvider === "claude-sdk") {
    return SONNET_MODEL_ID;
  }
  const tier = getModelTierFromTask(taskId);
  if (tier === "capable" || tier === "standard")
    return cfg.inferencePrimaryModel;
  if (tier === "flash" && cfg.inferenceFallbackModel)
    return cfg.inferenceFallbackModel;
  return cfg.inferencePrimaryModel;
}

/**
 * True when a run's cost row would be a phantom zero-cost entry that pollutes
 * cost accounting instead of recording real spend.
 *
 * Open since 2026-05-23: an SDK query that ABORTS / TIMES OUT before any
 * assistant message streams leaves `usage` at all-zeros and `costAuthoritative`
 * false — the shim then omits `actualCostUsd`, so `recordCost` falls back to
 * `calculateCost(model, 0, 0)` = $0 and writes a `$0.00 / tokens=0` row despite
 * real subprocess work having happened. The 2026-05-23 `costAuthoritative`
 * mechanism only fixed aborts that streamed PARTIAL usage (nonzero tokens →
 * a real calculateCost); the zero-usage abort still slips through to a phantom
 * row. This predicate catches exactly that residue.
 *
 * Phantom iff ALL hold:
 *   - the run did NOT complete normally (`success === false`), AND
 *   - both token counts are zero, AND
 *   - no provider-authoritative cost was reported (`actualCostUsd === undefined`
 *     — the abort/timeout catch path; a legitimate Max-auth $0 sets it to 0).
 *
 * A real no-op task (`success === true`, zero tokens) is NOT phantom — its $0
 * row is legitimate and is preserved.
 */
export function isPhantomZeroCostRow(result: {
  success: boolean;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    actualCostUsd?: number;
  };
}): boolean {
  const tu = result.tokenUsage;
  if (!tu) return false;
  return (
    !result.success &&
    tu.promptTokens === 0 &&
    tu.completionTokens === 0 &&
    tu.actualCostUsd === undefined
  );
}

// ---------------------------------------------------------------------------
// Task status helpers
// ---------------------------------------------------------------------------

function updateTaskStatus(
  taskId: string,
  status: string,
  output?: unknown,
  error?: string,
): void {
  const db = getDatabase();

  // C2 fix (queue #7 audit, 2026-05-07): once a task reaches a terminal
  // status (cancelled / completed / failed) it should NEVER be flipped to
  // a different terminal status by a runner that finishes after the user
  // already cancelled. The `AND status NOT IN (...)` guards make terminal
  // updates idempotent at the DB layer. Event emission still fires from
  // the caller — the deeper "stop emitting after cancel" fix is queued
  // separately (router.ts handlers should also fresh-read status).
  if (status === "running") {
    db.prepare(
      `UPDATE tasks SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE task_id = ? AND status NOT IN ('cancelled','completed','failed','completed_with_concerns')`,
    ).run(taskId);
  } else if (status === "completed") {
    db.prepare(
      `UPDATE tasks SET status = 'completed', progress = 100, output = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ? AND status NOT IN ('cancelled','completed','failed','completed_with_concerns')`,
    ).run(output ? JSON.stringify(output) : null, taskId);
  } else if (status === "completed_with_concerns") {
    db.prepare(
      `UPDATE tasks SET status = 'completed_with_concerns', progress = 100, output = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ? AND status NOT IN ('cancelled','completed','failed','completed_with_concerns')`,
    ).run(output ? JSON.stringify(output) : null, taskId);
  } else if (status === "needs_context" || status === "blocked") {
    db.prepare(
      `UPDATE tasks SET status = ?, error = ?, updated_at = datetime('now') WHERE task_id = ? AND status NOT IN ('cancelled','completed','failed','completed_with_concerns')`,
    ).run(status, error ?? null, taskId);
  } else if (status === "failed") {
    db.prepare(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ? AND status NOT IN ('cancelled','completed','failed','completed_with_concerns')`,
    ).run(error ?? null, taskId);
  } else {
    // Round-2 audit W2 fix (2026-05-07): guard the generic UPDATE too so
    // any future caller passing a non-enumerated status (e.g. "claimed",
    // "queued") cannot flip a row out of a terminal state. Same exclusion
    // list as the terminal branches above.
    db.prepare(
      `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE task_id = ? AND status NOT IN ('cancelled','completed','failed','completed_with_concerns')`,
    ).run(status, taskId);
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function getTask(taskId: string): TaskRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as TaskRow) ?? null
  );
}

/**
 * Read the bare tool names from the most-recent run for a task. Used by
 * the swarm-retry-policy classifier to compute side-effect taint
 * (queue #231). Returns [] when the task has no completed run yet or the
 * tool_calls column is NULL (legacy rows pre-migration). Safe to call on
 * any task_id; legitimately empty array means "ran but called no tools".
 */
export function getRunToolCalls(taskId: string): string[] {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT tool_calls FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(taskId) as { tool_calls: string | null } | undefined;
  if (!row || !row.tool_calls) return [];
  try {
    const parsed = JSON.parse(row.tool_calls) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * List-view projection of TaskRow: everything EXCEPT the fat payload columns
 * (description/input/output/metadata — `output` alone averages ~1.6 KB, max
 * ~21 KB). A 50-row page of SELECT * pulled up to ~1 MB nobody rendered; the
 * single-row getTask/getTaskWithRuns detail paths keep the full row.
 */
export type TaskListRow = Omit<
  TaskRow,
  "description" | "input" | "output" | "metadata"
>;

const TASK_LIST_COLUMNS =
  "id, task_id, parent_task_id, spawn_type, title, priority, status, " +
  "agent_type, classification, assigned_to, error, progress, " +
  "created_at, updated_at, started_at, completed_at, retry_count";

export function listTasks(filters: {
  status?: string;
  agentType?: string;
  parentTaskId?: string;
  limit?: number;
  offset?: number;
}): TaskListRow[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.status) {
    conditions.push("status = @status");
    params.status = filters.status;
  }
  if (filters.agentType) {
    conditions.push("agent_type = @agentType");
    params.agentType = filters.agentType;
  }
  if (filters.parentTaskId) {
    conditions.push("parent_task_id = @parentTaskId");
    params.parentTaskId = filters.parentTaskId;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  return db
    .prepare(
      `SELECT ${TASK_LIST_COLUMNS} FROM tasks ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as TaskListRow[];
}

export function getTaskWithRuns(
  taskId: string,
): { task: TaskRow; runs: RunRow[]; subtasks: TaskRow[] } | null {
  const task = getTask(taskId);
  if (!task) return null;

  const db = getDatabase();
  const runs = db
    .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC")
    .all(taskId) as RunRow[];
  const subtasks = db
    .prepare(
      "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
    )
    .all(taskId) as TaskRow[];

  return { task, runs, subtasks };
}

/**
 * Cancel a task and all its sub-tasks (cascade).
 */
export function cancelTask(taskId: string): boolean {
  const db = getDatabase();
  const task = getTask(taskId);
  if (!task) return false;
  if (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  ) {
    return false;
  }

  // Atomic cancel: task + runs + subtask cascade in one transaction
  db.transaction(() => {
    db.prepare(
      `UPDATE tasks SET status = 'cancelled', updated_at = datetime('now'), completed_at = datetime('now') WHERE task_id = ?`,
    ).run(taskId);

    db.prepare(
      `UPDATE runs SET status = 'cancelled', completed_at = datetime('now') WHERE task_id = ? AND status = 'running'`,
    ).run(taskId);

    const subtasks = db
      .prepare(
        "SELECT task_id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
      )
      .all(taskId) as { task_id: string }[];
    for (const sub of subtasks) {
      cancelTask(sub.task_id);
    }
  })();

  try {
    getEventBus().emitEvent("task.cancelled", {
      task_id: taskId,
      cancelled_by: "api",
      reason: "User requested cancellation",
    });
  } catch {
    // Event emission should not block
  }

  return true;
}
