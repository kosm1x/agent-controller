/**
 * A2A (Agent-to-Agent) protocol types.
 *
 * Implements the A2A specification for agent interoperability.
 * JSON-RPC 2.0 over HTTP + SSE for streaming.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// A2A-specific error codes
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;

// ---------------------------------------------------------------------------
// Agent Card (Discovery)
// ---------------------------------------------------------------------------

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: A2ASkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export type A2ATaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: string;
}

// ---------------------------------------------------------------------------
// Message & Parts
// ---------------------------------------------------------------------------

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
  messageId?: string;
}

export type A2APart =
  | { type: "text"; text: string }
  | { type: "data"; data: unknown; mimeType?: string }
  | { type: "file"; file: { data: string; mimeType: string } };

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export interface A2AArtifact {
  id: string;
  name?: string;
  parts: A2APart[];
}

// ---------------------------------------------------------------------------
// SSE Events
// ---------------------------------------------------------------------------

export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  status: A2ATaskStatus;
  final: boolean;
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  artifact: A2AArtifact;
  append?: boolean;
}

// ---------------------------------------------------------------------------
// Status Mapping (MC -> A2A)
// ---------------------------------------------------------------------------

export const MC_TO_A2A_STATUS: Record<string, A2ATaskState> = {
  pending: "submitted",
  classifying: "submitted",
  queued: "submitted",
  running: "working",
  completed: "completed",
  failed: "failed",
  cancelled: "canceled",
};

export const A2A_TERMINAL_STATES = new Set<A2ATaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
