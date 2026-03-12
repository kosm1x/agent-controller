/**
 * Adapter system entry point.
 *
 * Re-exports the registry singleton, convenience functions, base adapter,
 * Prometheus adapter, and all shared types. Importing this module
 * auto-registers all built-in adapters including Prometheus.
 *
 * @example
 * ```ts
 * import { getAdapter, listAdapters, PrometheusAdapter } from '@/lib/adapters';
 *
 * const adapter = getAdapter('prometheus');
 * await adapter.register({ agentId: 'a1', name: 'Scout', framework: 'prometheus' });
 * ```
 */

// -- Types (all shared interfaces, enums, and type aliases) -----------------
export {
  AgentStatus,
  AssignmentPriority,
  AdapterLifecycleEvent,
} from "./types";

export type {
  BuiltinCapability,
  AgentCapabilities,
  AgentRegistration,
  HeartbeatPayload,
  Assignment,
  TaskPhase,
  TaskReport,
  AdapterEvent,
  FrameworkMetadata,
  FrameworkAdapter,
} from "./types";

// -- Base adapter -----------------------------------------------------------
export { DefaultAdapter } from "./base";
export type {
  AgentCreatedPayload,
  AgentStatusPayload,
  TaskUpdatedPayload,
} from "./base";

// -- Registry ---------------------------------------------------------------
export {
  AdapterRegistry,
  adapterRegistry,
  getAdapter,
  listAdapters,
} from "./registry";
export type { AdapterPlugin } from "./registry";

// -- Prometheus adapter (auto-registers on import) --------------------------
// Side-effect import: registers "prometheus" with the global registry.
import "./prometheus";

export { PrometheusAdapter } from "./prometheus";
export type {
  GoalStatus,
  GoalNode,
  GoalGraphSummary,
  TraceEntry,
  SkillUsageMetrics,
  MemoryTierStatus,
  ErrorRecoveryEvent,
  PrometheusRegistrationMetadata,
  PrometheusHeartbeatMetrics,
} from "./prometheus";
