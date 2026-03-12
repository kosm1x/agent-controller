/**
 * DefaultAdapter — Base implementation of `FrameworkAdapter`.
 *
 * Consolidates the duplicated logic that was previously copy-pasted across
 * GenericAdapter, CrewAIAdapter, LangGraphAdapter, AutoGenAdapter,
 * ClaudeSdkAdapter, and OpenClawAdapter. Subclasses override the protected
 * `transform*` and lifecycle hook methods to inject framework-specific behavior.
 */

import { eventBus } from "../event-bus.js";
import { getDatabase } from "../db.js";
import type {
  FrameworkAdapter,
  FrameworkMetadata,
  AgentRegistration,
  HeartbeatPayload,
  TaskReport,
  Assignment,
  AdapterEvent,
} from "./types";
import {
  AgentStatus,
  AssignmentPriority,
  AdapterLifecycleEvent,
} from "./types";

// ---------------------------------------------------------------------------
// Internal row type returned by the pending-assignments query
// ---------------------------------------------------------------------------

interface PendingTaskRow {
  id: number;
  title: string;
  description: string | null;
  priority: string;
  due_date: number | null;
}

// ---------------------------------------------------------------------------
// Broadcast payload shapes (passed to eventBus.broadcast)
// ---------------------------------------------------------------------------

/** Shape broadcast on `agent.created`. */
export interface AgentCreatedPayload {
  id: string;
  name: string;
  framework: string;
  status: string;
  model?: string;
  capabilities?: unknown;
  [key: string]: unknown;
}

/** Shape broadcast on `agent.status_changed`. */
export interface AgentStatusPayload {
  id: string;
  status: string;
  framework: string;
  metrics?: Record<string, unknown>;
  timestamp?: string;
  [key: string]: unknown;
}

/** Shape broadcast on `task.updated`. */
export interface TaskUpdatedPayload {
  id: string;
  agentId: string;
  progress: number;
  status: string;
  framework: string;
  output?: unknown;
  phase?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// DefaultAdapter
// ---------------------------------------------------------------------------

/**
 * Base adapter that all framework adapters should extend.
 *
 * Provides the full `FrameworkAdapter` contract. Subclasses customize behavior
 * by overriding the protected `transform*` and `on*` methods rather than
 * reimplementing the public API methods.
 *
 * @example
 * ```ts
 * class MyAdapter extends DefaultAdapter {
 *   constructor() {
 *     super('my-framework', '1.0.0', 'My custom framework', ['custom-feature']);
 *   }
 *   protected transformRegistration(agent, base) {
 *     return { ...base, myField: agent.metadata?.myField };
 *   }
 * }
 * ```
 */
export class DefaultAdapter implements FrameworkAdapter {
  public readonly framework: string;
  public readonly metadata: FrameworkMetadata;

  /**
   * @param framework  - Unique framework identifier (e.g. "generic", "crewai").
   * @param version    - Semantic version of this adapter.
   * @param description - Human-readable adapter description.
   * @param features   - Feature flags this adapter supports.
   */
  constructor(
    framework: string,
    version: string = "1.0.0",
    description?: string,
    features: string[] = [],
  ) {
    this.framework = framework;
    this.metadata = Object.freeze({
      name: framework,
      version,
      description: description ?? `${framework} framework adapter`,
      features: Object.freeze([...features]),
    });
  }

  // -----------------------------------------------------------------------
  // Public API — delegates to protected hooks for customization
  // -----------------------------------------------------------------------

  /**
   * Register an agent.
   *
   * 1. Validates the registration payload via `validateAgent()`.
   * 2. Builds the broadcast payload via `transformRegistration()`.
   * 3. Upserts the agent row in the database.
   * 4. Broadcasts an `agent.created` event.
   * 5. Calls the `onConnect()` lifecycle hook.
   * 6. Emits an `AdapterLifecycleEvent.AgentRegistered` event.
   *
   * @throws {Error} If validation fails.
   */
  async register(agent: AgentRegistration): Promise<void> {
    const validationError = this.validateAgent(agent);
    if (validationError) {
      this.emitLifecycleEvent(
        AdapterLifecycleEvent.ValidationFailed,
        agent.agentId,
        {
          reason: validationError,
        },
      );
      throw new Error(
        `Agent validation failed for "${agent.agentId}": ${validationError}`,
      );
    }

    const basePayload: AgentCreatedPayload = {
      id: agent.agentId,
      name: agent.name,
      framework: agent.framework || this.framework,
      status: AgentStatus.Online,
      model: agent.model,
      capabilities: agent.capabilities,
    };

    const payload = this.transformRegistration(agent, basePayload);

    this.upsertAgent(agent);

    eventBus.broadcast("agent.created", payload);

    await this.onConnect(agent);

    this.emitLifecycleEvent(
      AdapterLifecycleEvent.AgentRegistered,
      agent.agentId,
    );
  }

  /**
   * Process a heartbeat from an agent.
   *
   * 1. Builds the status-change payload via `transformHeartbeat()`.
   * 2. Updates the agent's `last_seen` in the database.
   * 3. Broadcasts an `agent.status_changed` event.
   * 4. Emits an `AdapterLifecycleEvent.HeartbeatReceived` event.
   */
  async heartbeat(payload: HeartbeatPayload): Promise<void> {
    const basePayload: AgentStatusPayload = {
      id: payload.agentId,
      status: payload.status,
      metrics: payload.metrics ? { ...payload.metrics } : {},
      framework: this.framework,
      timestamp: payload.timestamp,
    };

    const transformed = this.transformHeartbeat(payload, basePayload);

    this.touchAgentLastSeen(payload.agentId, payload.status);

    eventBus.broadcast("agent.status_changed", transformed);

    this.emitLifecycleEvent(
      AdapterLifecycleEvent.HeartbeatReceived,
      payload.agentId,
    );
  }

  /**
   * Process a task progress report.
   *
   * 1. Builds the task-update payload via `transformTaskReport()`.
   * 2. Updates the task row in the database.
   * 3. Broadcasts a `task.updated` event.
   * 4. Emits an `AdapterLifecycleEvent.TaskReported` event.
   */
  async reportTask(report: TaskReport): Promise<void> {
    const basePayload: TaskUpdatedPayload = {
      id: report.taskId,
      agentId: report.agentId,
      progress: report.progress,
      status: report.status,
      framework: this.framework,
      output: report.output,
      phase: report.phase,
      errorMessage: report.errorMessage,
    };

    const transformed = this.transformTaskReport(report, basePayload);

    this.updateTaskProgress(report);

    eventBus.broadcast("task.updated", transformed);

    this.emitLifecycleEvent(
      AdapterLifecycleEvent.TaskReported,
      report.agentId,
      {
        taskId: report.taskId,
        progress: report.progress,
      },
    );
  }

  /**
   * Get pending task assignments for an agent.
   *
   * Queries the `tasks` table for rows assigned to (or unassigned from) the
   * given agent, ordered by priority then due date.
   */
  async getAssignments(agentId: string): Promise<Assignment[]> {
    return this.queryPendingAssignments(agentId);
  }

  /**
   * Disconnect an agent.
   *
   * 1. Marks the agent offline in the database.
   * 2. Broadcasts an `agent.status_changed` event with status `offline`.
   * 3. Calls the `onDisconnect()` lifecycle hook.
   * 4. Emits an `AdapterLifecycleEvent.AgentDisconnected` event.
   */
  async disconnect(agentId: string): Promise<void> {
    this.markAgentOffline(agentId);

    eventBus.broadcast("agent.status_changed", {
      id: agentId,
      status: AgentStatus.Offline,
      framework: this.framework,
    });

    await this.onDisconnect(agentId);

    this.emitLifecycleEvent(AdapterLifecycleEvent.AgentDisconnected, agentId);
  }

  // -----------------------------------------------------------------------
  // Protected hooks — override in subclasses
  // -----------------------------------------------------------------------

  /**
   * Transform the registration payload before broadcasting.
   *
   * Override this to inject framework-specific fields (e.g. memory tiers,
   * model configuration, persona data).
   *
   * @param agent - The original registration from the agent.
   * @param base  - The default broadcast payload built by the base class.
   * @returns The (possibly augmented) payload to broadcast.
   */
  protected transformRegistration(
    _agent: AgentRegistration,
    base: AgentCreatedPayload,
  ): AgentCreatedPayload {
    return base;
  }

  /**
   * Transform the heartbeat payload before broadcasting.
   *
   * Override this to add framework-specific metrics (e.g. current phase,
   * goal graph summary, memory utilization).
   *
   * @param payload - The original heartbeat from the agent.
   * @param base    - The default broadcast payload built by the base class.
   * @returns The (possibly augmented) payload to broadcast.
   */
  protected transformHeartbeat(
    _payload: HeartbeatPayload,
    base: AgentStatusPayload,
  ): AgentStatusPayload {
    return base;
  }

  /**
   * Transform the task report payload before broadcasting.
   *
   * Override this to add framework-specific data (e.g. trace IDs,
   * goal progress, error recovery events).
   *
   * @param report - The original task report from the agent.
   * @param base   - The default broadcast payload built by the base class.
   * @returns The (possibly augmented) payload to broadcast.
   */
  protected transformTaskReport(
    _report: TaskReport,
    base: TaskUpdatedPayload,
  ): TaskUpdatedPayload {
    return base;
  }

  /**
   * Validate an agent registration payload.
   *
   * Override this to add framework-specific validation (e.g. required metadata
   * fields, capability checks).
   *
   * @returns `null` if valid, or a string error message if invalid.
   */
  protected validateAgent(agent: AgentRegistration): string | null {
    if (!agent.agentId || typeof agent.agentId !== "string") {
      return "agentId is required and must be a non-empty string";
    }
    if (!agent.name || typeof agent.name !== "string") {
      return "name is required and must be a non-empty string";
    }
    if (agent.agentId.length > 256) {
      return "agentId must not exceed 256 characters";
    }
    if (agent.name.length > 256) {
      return "name must not exceed 256 characters";
    }
    return null;
  }

  /**
   * Lifecycle hook called after a successful agent registration.
   * Override to perform framework-specific initialization.
   */
  protected async onConnect(_agent: AgentRegistration): Promise<void> {
    // No-op by default
  }

  /**
   * Lifecycle hook called after an agent disconnects.
   * Override to perform framework-specific cleanup.
   */
  protected async onDisconnect(_agentId: string): Promise<void> {
    // No-op by default
  }

  // -----------------------------------------------------------------------
  // Database helpers (protected so subclasses can extend)
  // -----------------------------------------------------------------------

  /**
   * Upsert an agent row in the database.
   *
   * Inserts if the agent doesn't exist, otherwise updates the existing row.
   * Uses the agent's name as the lookup key within the default workspace.
   */
  protected upsertAgent(agent: AgentRegistration): void {
    try {
      const db = getDatabase();
      const now = Math.floor(Date.now() / 1000);

      const existing = db
        .prepare("SELECT id FROM agents WHERE name = ? AND workspace_id = 1")
        .get(agent.name) as { id: number } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE agents
           SET status = ?, last_seen = ?, updated_at = ?,
               config = COALESCE(?, config)
           WHERE id = ?`,
        ).run(
          "idle",
          now,
          now,
          agent.metadata ? JSON.stringify(agent.metadata) : null,
          existing.id,
        );
      } else {
        db.prepare(
          `INSERT INTO agents (name, role, status, last_seen, created_at, updated_at, workspace_id, config)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        ).run(
          agent.name,
          agent.framework || this.framework,
          "idle",
          now,
          now,
          now,
          agent.metadata ? JSON.stringify(agent.metadata) : null,
        );
      }
    } catch {
      // Database may not be available in all environments (e.g. tests).
      // Registration still succeeds via the event bus broadcast.
    }
  }

  /**
   * Update agent `last_seen` and `status` on heartbeat.
   */
  protected touchAgentLastSeen(
    agentId: string,
    status: AgentStatus | string,
  ): void {
    try {
      const db = getDatabase();
      const now = Math.floor(Date.now() / 1000);
      const dbStatus =
        status === AgentStatus.Busy
          ? "busy"
          : status === AgentStatus.Error
            ? "error"
            : "idle";

      db.prepare(
        `UPDATE agents SET status = ?, last_seen = ?, updated_at = ? WHERE name = ? AND workspace_id = 1`,
      ).run(dbStatus, now, now, agentId);
    } catch {
      // Silently ignore — heartbeats should not crash the system.
    }
  }

  /**
   * Mark an agent as offline in the database.
   */
  protected markAgentOffline(agentId: string): void {
    try {
      const db = getDatabase();
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `UPDATE agents SET status = 'offline', last_seen = ?, updated_at = ? WHERE name = ? AND workspace_id = 1`,
      ).run(now, now, agentId);
    } catch {
      // Silently ignore — disconnect should not crash.
    }
  }

  /**
   * Update task progress in the database from a task report.
   */
  protected updateTaskProgress(report: TaskReport): void {
    try {
      const db = getDatabase();
      const now = Math.floor(Date.now() / 1000);

      // Map report status to DB task status if it matches a known value
      const knownStatuses = new Set([
        "inbox",
        "assigned",
        "in_progress",
        "review",
        "quality_review",
        "done",
      ]);
      const dbStatus = knownStatuses.has(report.status)
        ? report.status
        : undefined;

      if (dbStatus) {
        const completedAt = dbStatus === "done" ? now : null;
        db.prepare(
          `UPDATE tasks SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
           WHERE id = ?`,
        ).run(dbStatus, now, completedAt, Number(report.taskId));
      }
    } catch {
      // Silently ignore — report still broadcasts via event bus.
    }
  }

  /**
   * Query pending task assignments for an agent.
   *
   * Returns up to 5 tasks ordered by priority (critical first), then due date,
   * then creation time.
   */
  protected queryPendingAssignments(agentId: string): Assignment[] {
    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT id, title, description, priority, due_date
           FROM tasks
           WHERE (assigned_to = ? OR assigned_to IS NULL)
             AND status IN ('assigned', 'inbox')
           ORDER BY
             CASE priority
               WHEN 'critical' THEN 0
               WHEN 'high'     THEN 1
               WHEN 'medium'   THEN 2
               WHEN 'low'      THEN 3
               ELSE 4
             END ASC,
             due_date ASC,
             created_at ASC
           LIMIT 5`,
        )
        .all(agentId) as PendingTaskRow[];

      return rows.map((row) => ({
        taskId: String(row.id),
        description:
          row.title + (row.description ? `\n${row.description}` : ""),
        priority: this.mapPriority(row.priority),
        dueDate: row.due_date
          ? new Date(row.due_date * 1000).toISOString()
          : undefined,
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Map a priority string to the `AssignmentPriority` enum. */
  private mapPriority(priority: string): AssignmentPriority {
    switch (priority) {
      case "critical":
        return AssignmentPriority.Critical;
      case "high":
        return AssignmentPriority.High;
      case "medium":
        return AssignmentPriority.Medium;
      case "low":
      default:
        return AssignmentPriority.Low;
    }
  }

  /** Emit a structured adapter lifecycle event. */
  private emitLifecycleEvent(
    event: AdapterLifecycleEvent,
    agentId: string,
    detail?: Record<string, unknown>,
  ): void {
    const adapterEvent: AdapterEvent = {
      event,
      framework: this.framework,
      agentId,
      timestamp: Date.now(),
      detail,
    };

    // Use a generic event key so consumers can subscribe to all adapter events
    eventBus.emit("adapter-event", adapterEvent);
  }
}
