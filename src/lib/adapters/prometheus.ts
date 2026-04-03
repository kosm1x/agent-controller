/**
 * Prometheus-specific framework adapter.
 *
 * Extends `DefaultAdapter` with Prometheus framework concepts:
 * - Three-phase loop tracking (Plan / Execute / Reflect)
 * - Hierarchical goal graph decomposition
 * - Three-tier memory system metadata
 * - Structured execution traces
 * - Skill quality metrics and auto-suggestions
 * - Error recovery event tracking
 *
 * This adapter is auto-registered with the global `adapterRegistry` on import.
 */

import { getDatabase } from "../../db/index.js";
import {
  DefaultAdapter,
  type AgentCreatedPayload,
  type AgentStatusPayload,
  type TaskUpdatedPayload,
} from "./base";
import type {
  AgentRegistration,
  HeartbeatPayload,
  TaskReport,
  Assignment,
  TaskPhase,
} from "./types";
import { adapterRegistry } from "./registry";

// ---------------------------------------------------------------------------
// Prometheus-specific types
// ---------------------------------------------------------------------------

/** Status of a goal within the goal graph. */
export type GoalStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "failed";

/** A single node in the hierarchical goal graph. */
export interface GoalNode {
  /** Unique goal identifier (e.g. "g-001-a"). */
  readonly id: string;
  /** Human-readable goal description. */
  readonly description: string;
  /** Current goal status. */
  readonly status: GoalStatus;
  /** IDs of goals this goal depends on. */
  readonly dependsOn: ReadonlyArray<string>;
  /** Testable completion criteria. */
  readonly completionCriteria: ReadonlyArray<string>;
  /** Child sub-goals (max depth 3). */
  readonly children: ReadonlyArray<GoalNode>;
}

/** Summary of the current goal graph state. */
export interface GoalGraphSummary {
  /** Root goal ID. */
  readonly rootGoalId: string;
  /** Total number of goals across all levels. */
  readonly totalGoals: number;
  /** Number of completed goals. */
  readonly completedGoals: number;
  /** Number of blocked goals. */
  readonly blockedGoals: number;
  /** Number of failed goals. */
  readonly failedGoals: number;
  /** Completion percentage (0-100). */
  readonly completionPercent: number;
  /** The current goal being worked on, if any. */
  readonly activeGoalId?: string;
}

/** A structured execution trace entry. */
export interface TraceEntry {
  /** Unique trace ID. */
  readonly traceId: string;
  /** Agent that produced this trace. */
  readonly agentId: string;
  /** Phase during which this trace was recorded. */
  readonly phase: TaskPhase;
  /** ISO-8601 start timestamp. */
  readonly startedAt: string;
  /** ISO-8601 end timestamp, if completed. */
  readonly endedAt?: string;
  /** Duration in milliseconds. */
  readonly durationMs?: number;
  /** Tool calls made during this trace span. */
  readonly toolCalls: ReadonlyArray<string>;
  /** Whether the trace completed successfully. */
  readonly success: boolean;
  /** Error message if the trace failed. */
  readonly error?: string;
  /** Associated goal ID, if any. */
  readonly goalId?: string;
}

/** Skill usage quality metrics (mirrors FRAMEWORK.md skill quality scoring). */
export interface SkillUsageMetrics {
  /** Skill slug / identifier. */
  readonly skillSlug: string;
  /** Number of times the skill has been used. */
  readonly timesUsed: number;
  /** Success rate as a fraction (0.0 - 1.0). */
  readonly successRate: number;
  /** Average turns saved compared to without the skill. */
  readonly avgTurnsSaved: number;
  /** ISO-8601 date of last usage. */
  readonly lastUsed: string;
  /** Confidence level derived from usage volume. */
  readonly confidence: "low" | "medium" | "high";
}

/** Memory tier utilization for the 3-tier memory system. */
export interface MemoryTierStatus {
  /** Tier 1: Working memory (in-context window). */
  readonly working: {
    readonly usedTokens: number;
    readonly maxTokens: number;
    readonly utilizationPercent: number;
  };
  /** Tier 2: Session memory (MEMORY.md / USER.md text files). */
  readonly session: {
    readonly usedChars: number;
    readonly maxChars: number;
    readonly lastUpdated?: string;
  };
  /** Tier 3: Long-term memory (vector store). */
  readonly longTerm: {
    readonly totalEntries: number;
    readonly lastIndexed?: string;
  };
}

/** Error recovery event recorded during execution. */
export interface ErrorRecoveryEvent {
  /** The error that triggered recovery. */
  readonly error: string;
  /** Category: transient, tool_failure, complexity, unknown. */
  readonly category: "transient" | "tool_failure" | "complexity" | "unknown";
  /** Strategy applied: retry, alternative, decompose, escalate. */
  readonly strategy: "retry" | "alternative" | "decompose" | "escalate";
  /** Whether recovery succeeded. */
  readonly recovered: boolean;
  /** Number of retries attempted. */
  readonly retriesUsed: number;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
}

/**
 * Extended metadata that Prometheus agents include in their registration.
 */
export interface PrometheusRegistrationMetadata {
  /** Model identifier (e.g. "claude-opus-4-20250514"). */
  readonly model?: string;
  /** Memory tier configuration. */
  readonly memoryTiers?: MemoryTierStatus;
  /** Persona file reference. */
  readonly persona?: string;
  /** Orchestrator configuration overrides. */
  readonly orchestratorConfig?: Readonly<Record<string, unknown>>;
}

/**
 * Extended metrics that Prometheus agents include in heartbeats.
 */
export interface PrometheusHeartbeatMetrics {
  /** Current phase in the Plan-Execute-Reflect loop. */
  readonly phase?: TaskPhase;
  /** Summary of the current goal graph. */
  readonly goalGraph?: GoalGraphSummary;
  /** Memory tier utilization. */
  readonly memoryUtilization?: MemoryTierStatus;
  /** Active goal being worked on. */
  readonly activeGoalId?: string;
  /** Number of tool calls in the current session. */
  readonly toolCallCount?: number;
  /** Remaining retry budget for the current goal. */
  readonly retryBudget?: number;
}

// ---------------------------------------------------------------------------
// Prometheus Adapter
// ---------------------------------------------------------------------------

/** Prometheus framework adapter version. */
const PROMETHEUS_VERSION = "1.0.0";

/**
 * Adapter for the Prometheus autonomous agent framework.
 *
 * Adds Plan-Execute-Reflect loop tracking, goal graph management,
 * three-tier memory awareness, execution tracing, and skill quality
 * metrics on top of the standard `DefaultAdapter` functionality.
 */
export class PrometheusAdapter extends DefaultAdapter {
  constructor() {
    super(
      "prometheus",
      PROMETHEUS_VERSION,
      "Prometheus autonomous agent framework adapter",
      [
        "plan-execute-reflect",
        "goal-graph",
        "three-tier-memory",
        "execution-traces",
        "skill-quality-metrics",
        "error-recovery",
        "multi-agent-collaboration",
      ],
    );
  }

  // -----------------------------------------------------------------------
  // Transform overrides
  // -----------------------------------------------------------------------

  /**
   * Enrich the registration payload with Prometheus-specific data.
   *
   * Extracts capabilities, memory tier configuration, model info,
   * and persona from the agent's metadata.
   */
  protected override transformRegistration(
    agent: AgentRegistration,
    base: AgentCreatedPayload,
  ): AgentCreatedPayload {
    const meta = (agent.metadata ??
      {}) as Partial<PrometheusRegistrationMetadata>;

    return {
      ...base,
      model: agent.model ?? meta.model,
      capabilities: agent.capabilities ?? {
        builtins: ["planning", "coding", "research", "review"],
        custom: [],
      },
      memoryTiers: meta.memoryTiers,
      persona: meta.persona,
      orchestratorConfig: meta.orchestratorConfig,
      frameworkVersion: PROMETHEUS_VERSION,
    };
  }

  /**
   * Enrich the heartbeat payload with Prometheus phase and goal graph data.
   *
   * Extracts the current Plan-Execute-Reflect phase and a summary of the
   * goal graph from the agent's metrics.
   */
  protected override transformHeartbeat(
    payload: HeartbeatPayload,
    base: AgentStatusPayload,
  ): AgentStatusPayload {
    const metrics = (payload.metrics ??
      {}) as Partial<PrometheusHeartbeatMetrics>;

    return {
      ...base,
      phase: metrics.phase,
      goalGraph: metrics.goalGraph,
      memoryUtilization: metrics.memoryUtilization,
      activeGoalId: metrics.activeGoalId,
      toolCallCount: metrics.toolCallCount,
      retryBudget: metrics.retryBudget,
    };
  }

  /**
   * Enrich the task report payload with Prometheus trace and recovery data.
   *
   * Includes trace IDs, goal progress summaries, and error recovery events
   * from the task report's output payload.
   */
  protected override transformTaskReport(
    report: TaskReport,
    base: TaskUpdatedPayload,
  ): TaskUpdatedPayload {
    const output = (report.output ?? {}) as Readonly<Record<string, unknown>>;

    return {
      ...base,
      traceId: output.traceId as string | undefined,
      goalProgress: output.goalProgress as GoalGraphSummary | undefined,
      errorRecoveryEvents: output.errorRecoveryEvents as
        | ReadonlyArray<ErrorRecoveryEvent>
        | undefined,
      phase: report.phase,
    };
  }

  /**
   * Validate Prometheus-specific registration requirements.
   *
   * In addition to the base validation, ensures the framework field
   * is set to "prometheus" when explicitly provided.
   */
  protected override validateAgent(agent: AgentRegistration): string | null {
    const baseError = super.validateAgent(agent);
    if (baseError) return baseError;

    if (agent.framework && agent.framework !== "prometheus") {
      return `Expected framework "prometheus" but got "${agent.framework}"`;
    }

    return null;
  }

  /**
   * Lifecycle hook: initialize Prometheus-specific state on connection.
   *
   * Ensures the agent has a trace and goal-graph storage row in the DB.
   */
  protected override async onConnect(agent: AgentRegistration): Promise<void> {
    this.ensurePrometheusSchema(agent.agentId);
  }

  /**
   * Lifecycle hook: clean up Prometheus-specific state on disconnect.
   *
   * Marks any in-progress goals as blocked and flushes pending traces.
   */
  protected override async onDisconnect(agentId: string): Promise<void> {
    this.markGoalsBlocked(agentId);
  }

  // -----------------------------------------------------------------------
  // Override getAssignments to add skill suggestions and complexity
  // -----------------------------------------------------------------------

  /**
   * Get pending assignments with Prometheus-specific enrichments.
   *
   * Augments each assignment with:
   * - `suggestedSkills`: skills that may help with the task
   * - `complexityEstimate`: estimated task complexity (low/medium/high)
   */
  override async getAssignments(agentId: string): Promise<Assignment[]> {
    const base = await super.getAssignments(agentId);

    return base.map((assignment) => ({
      ...assignment,
      metadata: {
        ...assignment.metadata,
        suggestedSkills: this.suggestSkills(assignment.description),
        complexityEstimate: this.estimateComplexity(assignment.description),
      },
    }));
  }

  // -----------------------------------------------------------------------
  // Prometheus-specific public methods
  // -----------------------------------------------------------------------

  /**
   * Fetch the current goal graph decomposition for an agent.
   *
   * Reads the latest goal graph snapshot from the agent's metadata
   * stored in the database.
   *
   * @param agentId - The agent to query.
   * @returns The goal graph, or `null` if no graph exists.
   */
  getGoalGraph(agentId: string): GoalNode | null {
    try {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT config FROM agents WHERE name = ? AND workspace_id = 1`,
        )
        .get(agentId) as { config: string | null } | undefined;

      if (!row?.config) return null;

      const config = JSON.parse(row.config) as Record<string, unknown>;
      const goalGraph = config.goalGraph as GoalNode | undefined;
      return goalGraph ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch recent execution traces for an agent.
   *
   * Reads trace entries from the agent's activity log. Traces are stored
   * as activity records with type `prometheus.trace`.
   *
   * @param agentId - The agent to query.
   * @param limit   - Maximum number of traces to return (default 20).
   * @returns Array of trace entries, newest first.
   */
  getTraces(agentId: string, limit: number = 20): TraceEntry[] {
    try {
      const db = getDatabase();
      const clampedLimit = Math.min(Math.max(1, limit), 100);

      const rows = db
        .prepare(
          `SELECT data FROM activities
           WHERE actor = ? AND type = 'prometheus.trace'
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(agentId, clampedLimit) as Array<{ data: string | null }>;

      return rows
        .filter((row) => row.data !== null)
        .map((row) => {
          try {
            return JSON.parse(row.data!) as TraceEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is TraceEntry => entry !== null);
    } catch {
      return [];
    }
  }

  /**
   * Fetch skill usage quality metrics for an agent.
   *
   * Reads skill quality scores from the agent's configuration store.
   * Skills are tracked per-agent to allow personalized recommendations.
   *
   * @param agentId - The agent to query.
   * @returns Array of skill usage metrics.
   */
  getSkillUsage(agentId: string): SkillUsageMetrics[] {
    try {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT config FROM agents WHERE name = ? AND workspace_id = 1`,
        )
        .get(agentId) as { config: string | null } | undefined;

      if (!row?.config) return [];

      const config = JSON.parse(row.config) as Record<string, unknown>;
      const skillMetrics = config.skillMetrics as
        | SkillUsageMetrics[]
        | undefined;

      if (!Array.isArray(skillMetrics)) return [];

      return skillMetrics.map((metric) => ({
        skillSlug: String(metric.skillSlug ?? ""),
        timesUsed: Number(metric.timesUsed ?? 0),
        successRate: Math.min(1, Math.max(0, Number(metric.successRate ?? 0))),
        avgTurnsSaved: Number(metric.avgTurnsSaved ?? 0),
        lastUsed: String(metric.lastUsed ?? new Date().toISOString()),
        confidence: this.deriveConfidence(Number(metric.timesUsed ?? 0)),
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Ensure Prometheus-specific database schema extensions exist.
   *
   * Creates the agent config entry if it doesn't exist, with empty
   * Prometheus-specific fields for goal graph and skill metrics.
   */
  private ensurePrometheusSchema(agentId: string): void {
    try {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT id, config FROM agents WHERE name = ? AND workspace_id = 1`,
        )
        .get(agentId) as { id: number; config: string | null } | undefined;

      if (!row) return;

      const existing = row.config ? JSON.parse(row.config) : {};

      // Only set defaults if these keys don't already exist
      let updated = false;
      if (!existing.goalGraph) {
        existing.goalGraph = null;
        updated = true;
      }
      if (!existing.skillMetrics) {
        existing.skillMetrics = [];
        updated = true;
      }
      if (!existing.frameworkVersion) {
        existing.frameworkVersion = PROMETHEUS_VERSION;
        updated = true;
      }

      if (updated) {
        db.prepare(`UPDATE agents SET config = ? WHERE id = ?`).run(
          JSON.stringify(existing),
          row.id,
        );
      }
    } catch {
      // Non-critical — adapter still works without these schema extensions.
    }
  }

  /**
   * Mark all in-progress goals as blocked when an agent disconnects.
   *
   * This prevents stale "in_progress" goals from lingering when the
   * agent is no longer available to work on them.
   */
  private markGoalsBlocked(agentId: string): void {
    try {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT id, config FROM agents WHERE name = ? AND workspace_id = 1`,
        )
        .get(agentId) as { id: number; config: string | null } | undefined;

      if (!row?.config) return;

      const config = JSON.parse(row.config) as Record<string, unknown>;
      const goalGraph = config.goalGraph as GoalNode | undefined;
      if (!goalGraph) return;

      // Recursively mark in_progress goals as blocked
      const updated = this.markInProgressGoalsBlocked(goalGraph);
      config.goalGraph = updated;

      db.prepare(`UPDATE agents SET config = ? WHERE id = ?`).run(
        JSON.stringify(config),
        row.id,
      );
    } catch {
      // Non-critical cleanup.
    }
  }

  /**
   * Recursively traverse a goal tree and change `in_progress` to `blocked`.
   */
  private markInProgressGoalsBlocked(goal: GoalNode): GoalNode {
    const newStatus: GoalStatus =
      goal.status === "in_progress" ? "blocked" : goal.status;

    const newChildren = goal.children.map((child) =>
      this.markInProgressGoalsBlocked(child),
    );

    return {
      ...goal,
      status: newStatus,
      children: newChildren,
    };
  }

  /**
   * Suggest skills that might help with a task based on keyword matching.
   *
   * This is a lightweight heuristic. In production, this would be replaced
   * with vector similarity search against the skill registry.
   */
  private suggestSkills(description: string): string[] {
    const lower = description.toLowerCase();
    const suggestions: string[] = [];

    const skillPatterns: ReadonlyArray<{ pattern: RegExp; skill: string }> = [
      { pattern: /docker|container|compose/i, skill: "docker-debug" },
      { pattern: /test|spec|assert|expect/i, skill: "test-writing" },
      { pattern: /deploy|ci\/cd|pipeline/i, skill: "deployment" },
      { pattern: /refactor|clean|restructur/i, skill: "refactoring" },
      { pattern: /debug|error|fix|bug/i, skill: "debugging" },
      { pattern: /security|auth|vulnerab/i, skill: "security-audit" },
      { pattern: /api|endpoint|route/i, skill: "api-design" },
      { pattern: /database|sql|migration/i, skill: "database-ops" },
      { pattern: /document|readme|jsdoc/i, skill: "documentation" },
      { pattern: /performance|optimi[sz]/i, skill: "performance-tuning" },
    ];

    for (const { pattern, skill } of skillPatterns) {
      if (pattern.test(lower)) {
        suggestions.push(skill);
      }
    }

    return suggestions;
  }

  /**
   * Estimate task complexity based on description length and keyword signals.
   *
   * Returns "low", "medium", or "high". This is a heuristic placeholder;
   * a real implementation would use historical data and ML models.
   */
  private estimateComplexity(description: string): "low" | "medium" | "high" {
    const lower = description.toLowerCase();
    const wordCount = description.split(/\s+/).length;

    // High-complexity signals
    const highSignals = [
      /architect/i,
      /redesign/i,
      /migration/i,
      /from scratch/i,
      /full rewrite/i,
      /multi.?service/i,
      /distributed/i,
    ];
    if (highSignals.some((re) => re.test(lower))) return "high";

    // Medium-complexity by word count or moderate signals
    const mediumSignals = [
      /refactor/i,
      /integrate/i,
      /implement/i,
      /add feature/i,
    ];
    if (wordCount > 50 || mediumSignals.some((re) => re.test(lower)))
      return "medium";

    return "low";
  }

  /**
   * Derive a confidence level from usage count.
   */
  private deriveConfidence(timesUsed: number): "low" | "medium" | "high" {
    if (timesUsed >= 10) return "high";
    if (timesUsed >= 3) return "medium";
    return "low";
  }
}

// ---------------------------------------------------------------------------
// Auto-register with the global adapter registry
// ---------------------------------------------------------------------------

adapterRegistry.register({
  name: "prometheus",
  version: PROMETHEUS_VERSION,
  description: "Prometheus autonomous agent framework adapter",
  factory: () => new PrometheusAdapter(),
});
