/**
 * @module events/types
 *
 * Event type hierarchy for Mission Control's persistent event bus.
 * Every event flowing through the system — task lifecycle, agent fleet
 * changes, chat messages, audit logs — is typed here.
 *
 * Design principles:
 * - Discriminated unions: `category` + `type` uniquely identify the payload shape.
 * - Every event gets an envelope with correlation_id for distributed tracing.
 * - Payloads are strongly typed; no `any` in public API surfaces.
 */

// ---------------------------------------------------------------------------
// Event Categories
// ---------------------------------------------------------------------------

/**
 * Top-level event categories. Each category groups related event types.
 * Used for subscription filtering and storage partitioning.
 */
export type EventCategory =
  | "task"
  | "agent"
  | "chat"
  | "notification"
  | "activity"
  | "audit"
  | "security"
  | "fleet"
  | "reaction";

// ---------------------------------------------------------------------------
// Event Types per Category
// ---------------------------------------------------------------------------

/** Task lifecycle events. */
export type TaskEventType =
  | "task.created"
  | "task.assigned"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.reassigned"
  | "task.blocked"
  | "task.unblocked";

/** Agent lifecycle events. */
export type AgentEventType =
  | "agent.registered"
  | "agent.heartbeat"
  | "agent.status_changed"
  | "agent.disconnected"
  | "agent.error"
  | "agent.phase_changed";

/** Chat/messaging events. */
export type ChatEventType =
  | "chat.message_sent"
  | "chat.message_received"
  | "chat.broadcast";

/** UI/user notification events. */
export type NotificationEventType =
  | "notification.info"
  | "notification.warning"
  | "notification.error"
  | "notification.success";

/** Activity log events (user/system actions). */
export type ActivityEventType =
  | "activity.user_action"
  | "activity.system_action"
  | "activity.config_changed";

/** Audit trail events for compliance/debugging. */
export type AuditEventType =
  | "audit.access"
  | "audit.modification"
  | "audit.dispatch"
  | "audit.escalation";

/** Security events. */
export type SecurityEventType =
  | "security.auth_success"
  | "security.auth_failure"
  | "security.rate_limited"
  | "security.suspicious_activity";

/** Fleet-wide coordination events. */
export type FleetEventType =
  | "fleet.scaling"
  | "fleet.rebalance"
  | "fleet.health_check"
  | "fleet.capacity_warning";

/** Reaction engine events. */
export type ReactionEventType =
  | "reaction.triggered"
  | "reaction.completed"
  | "reaction.suppressed"
  | "reaction.escalated";

/** Union of all event types. */
export type EventType =
  | TaskEventType
  | AgentEventType
  | ChatEventType
  | NotificationEventType
  | ActivityEventType
  | AuditEventType
  | SecurityEventType
  | FleetEventType
  | ReactionEventType;

// ---------------------------------------------------------------------------
// Event Payloads
// ---------------------------------------------------------------------------

/** Payload for task.created */
export interface TaskCreatedPayload {
  task_id: string;
  title: string;
  description: string;
  priority: string;
  tags: string[];
  created_by: string;
}

/** Payload for task.assigned */
export interface TaskAssignedPayload {
  task_id: string;
  agent_id: string;
  assigned_by: string;
  reason: string;
}

/** Payload for task.started */
export interface TaskStartedPayload {
  task_id: string;
  agent_id: string;
}

/** Payload for task.progress */
export interface TaskProgressPayload {
  task_id: string;
  agent_id: string;
  progress: number;
  phase: string;
  message: string;
}

/** Payload for task.completed */
export interface TaskCompletedPayload {
  task_id: string;
  agent_id: string;
  result: unknown;
  duration_ms: number;
}

/** Payload for task.failed */
export interface TaskFailedPayload {
  task_id: string;
  agent_id: string;
  error: string;
  recoverable: boolean;
  attempts: number;
}

/** Payload for task.cancelled */
export interface TaskCancelledPayload {
  task_id: string;
  cancelled_by: string;
  reason: string;
}

/** Payload for task.reassigned */
export interface TaskReassignedPayload {
  task_id: string;
  from_agent_id: string;
  to_agent_id: string;
  reason: string;
}

/** Payload for task.blocked / task.unblocked */
export interface TaskBlockedPayload {
  task_id: string;
  agent_id: string;
  blocked_by: string;
  reason: string;
}

/** Payload for agent.registered */
export interface AgentRegisteredPayload {
  agent_id: string;
  name: string;
  capabilities: string[];
  model: string;
}

/** Payload for agent.heartbeat */
export interface AgentHeartbeatPayload {
  agent_id: string;
  status: string;
  phase: string;
  goal_summary: Record<string, number> | null;
}

/** Payload for agent.status_changed */
export interface AgentStatusChangedPayload {
  agent_id: string;
  previous_status: string;
  new_status: string;
  reason: string;
}

/** Payload for agent.disconnected */
export interface AgentDisconnectedPayload {
  agent_id: string;
  reason: string;
  last_heartbeat: string;
}

/** Payload for agent.error */
export interface AgentErrorPayload {
  agent_id: string;
  error: string;
  context: Record<string, unknown>;
  fatal: boolean;
}

/** Payload for agent.phase_changed */
export interface AgentPhaseChangedPayload {
  agent_id: string;
  previous_phase: string;
  new_phase: string;
  task_id: string | null;
}

/** Payload for chat events. */
export interface ChatMessagePayload {
  message_id: string;
  from_agent: string;
  to_agent: string;
  content: unknown;
  message_type: string;
}

/** Payload for notification events. */
export interface NotificationPayload {
  title: string;
  message: string;
  source: string;
  context: Record<string, unknown>;
}

/** Payload for activity events. */
export interface ActivityPayload {
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

/** Payload for audit events. */
export interface AuditPayload {
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown>;
  ip_address: string | null;
}

/** Payload for security events. */
export interface SecurityPayload {
  actor: string;
  action: string;
  outcome: string;
  details: Record<string, unknown>;
  ip_address: string | null;
}

/** Payload for fleet events. */
export interface FleetPayload {
  action: string;
  affected_agents: string[];
  reason: string;
  details: Record<string, unknown>;
}

/** Payload for reaction events. */
export interface ReactionPayload {
  reaction_id: string;
  trigger: string;
  source_task_id: string;
  spawned_task_id: string | null;
  action: string;
  attempt: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Payload Type Map (for type-safe event creation)
// ---------------------------------------------------------------------------

/**
 * Maps each event type string to its strongly-typed payload.
 * Used by the event bus to enforce type safety at emit time.
 */
export interface EventPayloadMap {
  "task.created": TaskCreatedPayload;
  "task.assigned": TaskAssignedPayload;
  "task.started": TaskStartedPayload;
  "task.progress": TaskProgressPayload;
  "task.completed": TaskCompletedPayload;
  "task.failed": TaskFailedPayload;
  "task.cancelled": TaskCancelledPayload;
  "task.reassigned": TaskReassignedPayload;
  "task.blocked": TaskBlockedPayload;
  "task.unblocked": TaskBlockedPayload;
  "agent.registered": AgentRegisteredPayload;
  "agent.heartbeat": AgentHeartbeatPayload;
  "agent.status_changed": AgentStatusChangedPayload;
  "agent.disconnected": AgentDisconnectedPayload;
  "agent.error": AgentErrorPayload;
  "agent.phase_changed": AgentPhaseChangedPayload;
  "chat.message_sent": ChatMessagePayload;
  "chat.message_received": ChatMessagePayload;
  "chat.broadcast": ChatMessagePayload;
  "notification.info": NotificationPayload;
  "notification.warning": NotificationPayload;
  "notification.error": NotificationPayload;
  "notification.success": NotificationPayload;
  "activity.user_action": ActivityPayload;
  "activity.system_action": ActivityPayload;
  "activity.config_changed": ActivityPayload;
  "audit.access": AuditPayload;
  "audit.modification": AuditPayload;
  "audit.dispatch": AuditPayload;
  "audit.escalation": AuditPayload;
  "security.auth_success": SecurityPayload;
  "security.auth_failure": SecurityPayload;
  "security.rate_limited": SecurityPayload;
  "security.suspicious_activity": SecurityPayload;
  "fleet.scaling": FleetPayload;
  "fleet.rebalance": FleetPayload;
  "fleet.health_check": FleetPayload;
  "fleet.capacity_warning": FleetPayload;
  "reaction.triggered": ReactionPayload;
  "reaction.completed": ReactionPayload;
  "reaction.suppressed": ReactionPayload;
  "reaction.escalated": ReactionPayload;
}

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

/**
 * The universal event envelope. Every event in the system is wrapped in this.
 * The `type` field is a dot-separated string (e.g., "task.created").
 * The `category` is derived from the prefix (e.g., "task").
 *
 * @typeParam T - The event type string literal for type-safe payloads.
 */
export interface Event<T extends EventType = EventType> {
  /** Unique event identifier (UUIDv4). */
  id: string;
  /** Dot-separated event type (e.g., "task.created"). */
  type: T;
  /** Top-level category derived from type prefix. */
  category: EventCategory;
  /** ISO 8601 timestamp of when the event was created. */
  timestamp: string;
  /** Workspace/tenant identifier for multi-tenancy. */
  workspace_id: string;
  /** Strongly-typed event payload. */
  data: EventPayloadMap[T];
  /**
   * Correlation ID for tracing related events across services.
   * Events triggered by the same root cause share a correlation_id.
   */
  correlation_id: string;
  /** Optional: ID of the event that caused this one. */
  causation_id?: string;
  /** Monotonically increasing sequence number (set by the event bus). */
  sequence?: number;
}

// ---------------------------------------------------------------------------
// Subscription & Filter Types
// ---------------------------------------------------------------------------

/**
 * Pattern for subscribing to events.
 * Supports exact match ("task.created") or prefix wildcard ("task.*").
 */
export type EventPattern = EventType | `${EventCategory}.*` | "*";

/**
 * Filter criteria for event replay / query.
 */
export interface EventFilter {
  /** Filter by category. */
  categories?: EventCategory[];
  /** Filter by exact event types. */
  types?: EventType[];
  /** Filter by workspace. */
  workspace_id?: string;
  /** Filter by correlation ID. */
  correlation_id?: string;
  /** Maximum number of events to return. */
  limit?: number;
}

/**
 * Handler function for event subscriptions.
 */
export type EventHandler<T extends EventType = EventType> = (
  event: Event<T>,
) => void | Promise<void>;

/**
 * Subscription handle returned when subscribing.
 * Call unsubscribe() to remove the listener.
 */
export interface Subscription {
  /** Unique subscription identifier. */
  id: string;
  /** The pattern this subscription matches. */
  pattern: EventPattern;
  /** Remove this subscription. */
  unsubscribe: () => void;
}
