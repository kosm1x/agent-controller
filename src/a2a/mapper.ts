/**
 * Bidirectional MC <-> A2A conversion.
 *
 * Converts between Mission Control's internal task model and the A2A protocol
 * types. Handles status mapping, message parsing, artifact construction,
 * and context ID management.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "../db/index.js";
import { stripCacheMarker } from "../messaging/router.js";
import type { TaskSubmission, TaskRow } from "../dispatch/dispatcher.js";
import type {
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2APart,
  A2AArtifact,
  A2ATaskStatusUpdateEvent,
} from "./types.js";
import { MC_TO_A2A_STATUS, A2A_TERMINAL_STATES } from "./types.js";

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** Convert MC task status to A2A task state. */
export function mcStatusToA2A(status: string): A2ATaskState {
  return MC_TO_A2A_STATUS[status] ?? "submitted";
}

// ---------------------------------------------------------------------------
// MC Task -> A2A Task
// ---------------------------------------------------------------------------

interface RunRow {
  run_id: string;
  agent_type: string;
  status: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
}

/**
 * Convert an MC task (with optional runs) to an A2A task.
 */
export function mcTaskToA2ATask(task: TaskRow, runs?: RunRow[]): A2ATask {
  const a2aState = mcStatusToA2A(task.status);

  // Build status
  const statusMessage =
    task.status === "failed" ? (task.error ?? "Task failed") : undefined;

  // Build artifacts from output
  const artifacts: A2AArtifact[] = [];
  if (task.output) {
    let outputParts: A2APart[];
    try {
      const parsed = JSON.parse(task.output);
      if (typeof parsed === "string") {
        outputParts = [{ type: "text", text: parsed }];
      } else {
        outputParts = [{ type: "data", data: parsed }];
      }
    } catch {
      outputParts = [{ type: "text", text: task.output }];
    }
    artifacts.push({
      id: `artifact-${task.task_id}`,
      name: "result",
      parts: outputParts,
    });
  }

  // Build history from input + output
  const history: A2AMessage[] = [];

  // User message from task input.
  // v8 S1: strip cache-break marker — A2A clients shouldn't see internal
  // mc cache-optimization markers in task descriptions.
  const userParts: A2APart[] = [
    {
      type: "text",
      text: `${task.title}\n\n${stripCacheMarker(task.description)}`,
    },
  ];
  if (task.input) {
    try {
      const parsed = JSON.parse(task.input);
      userParts.push({ type: "data", data: parsed });
    } catch {
      // Ignore unparseable input
    }
  }
  history.push({ role: "user", parts: userParts });

  // Agent messages from runs
  if (runs) {
    for (const run of runs) {
      if (run.output) {
        let agentParts: A2APart[];
        try {
          const parsed = JSON.parse(run.output);
          if (typeof parsed === "string") {
            agentParts = [{ type: "text", text: parsed }];
          } else {
            agentParts = [{ type: "data", data: parsed }];
          }
        } catch {
          agentParts = [{ type: "text", text: run.output }];
        }
        history.push({ role: "agent", parts: agentParts });
      }
    }
  }

  // Resolve contextId from DB or use task_id as fallback
  const contextId = resolveContextByTaskId(task.task_id) ?? task.task_id;

  return {
    id: task.task_id,
    contextId,
    status: {
      state: a2aState,
      message: statusMessage,
    },
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    history,
  };
}

// ---------------------------------------------------------------------------
// A2A Message -> MC TaskSubmission
// ---------------------------------------------------------------------------

/**
 * Convert an A2A message into an MC TaskSubmission.
 * Extracts title from first line of first text part, rest as description.
 */
export function a2aMessageToSubmission(message: A2AMessage): TaskSubmission {
  let title = "A2A Task";
  let description = "";
  let input: unknown = undefined;

  // Extract text from text parts
  const textParts = message.parts.filter(
    (p): p is Extract<A2APart, { type: "text" }> => p.type === "text",
  );
  if (textParts.length > 0) {
    const fullText = textParts.map((p) => p.text).join("\n");
    const lines = fullText.split("\n");
    title = lines[0].trim() || "A2A Task";
    description = lines.slice(1).join("\n").trim();
  }

  // Extract data from data parts
  const dataParts = message.parts.filter(
    (p): p is Extract<A2APart, { type: "data" }> => p.type === "data",
  );
  if (dataParts.length === 1) {
    input = dataParts[0].data;
  } else if (dataParts.length > 1) {
    input = dataParts.map((p) => p.data);
  }

  const submission: TaskSubmission = {
    title,
    description: description || title,
  };
  if (input !== undefined) {
    submission.input = input;
  }

  return submission;
}

// ---------------------------------------------------------------------------
// Event -> A2A SSE event
// ---------------------------------------------------------------------------

interface MCEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Convert an MC event bus event to an A2A task status update event.
 * Returns null if the event is not relevant to A2A streaming.
 */
export function mcEventToA2AStatusEvent(
  event: MCEvent,
  taskId: string,
): A2ATaskStatusUpdateEvent | null {
  const eventTaskId = event.data.task_id as string | undefined;
  if (eventTaskId !== taskId) return null;

  let state: A2ATaskState | null = null;
  let message: string | undefined;

  switch (event.type) {
    case "task.created":
      state = "submitted";
      break;
    case "task.started":
      state = "working";
      break;
    case "task.progress":
      state = "working";
      message = event.data.message as string | undefined;
      break;
    case "task.completed":
      state = "completed";
      break;
    case "task.failed":
      state = "failed";
      message = event.data.error as string | undefined;
      break;
    case "task.cancelled":
      state = "canceled";
      break;
    default:
      return null;
  }

  return {
    taskId,
    status: { state, message },
    final: A2A_TERMINAL_STATES.has(state),
  };
}

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

/** Look up task_id by A2A contextId. */
export function resolveContext(contextId: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT task_id FROM a2a_contexts WHERE context_id = ?")
    .get(contextId) as { task_id: string } | undefined;
  return row?.task_id ?? null;
}

/** Look up contextId by task_id. */
function resolveContextByTaskId(taskId: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT context_id FROM a2a_contexts WHERE task_id = ?")
    .get(taskId) as { context_id: string } | undefined;
  return row?.context_id ?? null;
}

/** Store a contextId -> task_id mapping. */
export function createContext(contextId: string, taskId: string): void {
  const db = getDatabase();
  db.prepare(
    "INSERT OR REPLACE INTO a2a_contexts (context_id, task_id) VALUES (?, ?)",
  ).run(contextId, taskId);
}

/** Generate a new context ID. */
export function newContextId(): string {
  return randomUUID();
}
