/**
 * A2A JSON-RPC server.
 *
 * Handles the A2A protocol methods: sendMessage, getTask, cancelTask,
 * sendStreamingMessage. Mounted at /a2a.
 */

import { Hono } from "hono";
import { getEventBus } from "../lib/event-bus.js";
import {
  submitTask,
  getTaskWithRuns,
  cancelTask,
} from "../dispatch/dispatcher.js";
import {
  mcTaskToA2ATask,
  a2aMessageToSubmission,
  mcEventToA2AStatusEvent,
  resolveContext,
  createContext,
  newContextId,
} from "./mapper.js";
import type { JsonRpcRequest, JsonRpcResponse, A2AMessage } from "./types.js";
import {
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_INVALID_PARAMS,
  A2A_TASK_NOT_FOUND,
  A2A_TASK_NOT_CANCELABLE,
} from "./types.js";
import type { Event } from "../lib/events/types.js";

export const a2a = new Hono();

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function jsonRpcResult(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", result, id };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", error: { code, message, data }, id };
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

a2a.post("/", async (c) => {
  let body: JsonRpcRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"));
  }

  // Validate envelope
  if (
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string" ||
    body.id === undefined
  ) {
    return c.json(
      jsonRpcError(
        body?.id ?? null,
        JSON_RPC_INVALID_REQUEST,
        "Invalid JSON-RPC request",
      ),
    );
  }

  switch (body.method) {
    case "sendMessage":
      return handleSendMessage(c, body);
    case "sendStreamingMessage":
      return handleStreamingMessage(c, body);
    case "getTask":
      return handleGetTask(c, body);
    case "cancelTask":
      return handleCancelTask(c, body);
    default:
      return c.json(
        jsonRpcError(
          body.id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method not found: ${body.method}`,
        ),
      );
  }
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

async function handleSendMessage(
  c: import("hono").Context,
  req: JsonRpcRequest,
): Promise<Response> {
  const params = req.params as
    | {
        message?: A2AMessage;
        contextId?: string;
      }
    | undefined;

  if (!params?.message?.parts || !Array.isArray(params.message.parts)) {
    return c.json(
      jsonRpcError(
        req.id,
        JSON_RPC_INVALID_PARAMS,
        "Missing or invalid message",
      ),
    );
  }

  // Check for existing context
  let existingTaskId: string | null = null;
  if (params.contextId) {
    existingTaskId = resolveContext(params.contextId);
  }

  // Convert message to submission
  const submission = a2aMessageToSubmission(params.message);

  // Submit task
  const result = await submitTask(submission);

  // Create context mapping
  const contextId = params.contextId ?? newContextId();
  if (!existingTaskId) {
    createContext(contextId, result.taskId);
  }

  // Get the task we just created and convert to A2A format
  const taskData = getTaskWithRuns(result.taskId);
  if (!taskData) {
    return c.json(
      jsonRpcError(req.id, A2A_TASK_NOT_FOUND, "Task created but not found"),
    );
  }

  const a2aTask = mcTaskToA2ATask(taskData.task, taskData.runs);
  // Ensure contextId matches what we assigned
  a2aTask.contextId = contextId;

  return c.json(jsonRpcResult(req.id, a2aTask));
}

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

async function handleGetTask(
  c: import("hono").Context,
  req: JsonRpcRequest,
): Promise<Response> {
  const params = req.params as { taskId?: string } | undefined;

  if (!params?.taskId) {
    return c.json(
      jsonRpcError(req.id, JSON_RPC_INVALID_PARAMS, "Missing taskId"),
    );
  }

  const taskData = getTaskWithRuns(params.taskId);
  if (!taskData) {
    return c.json(
      jsonRpcError(
        req.id,
        A2A_TASK_NOT_FOUND,
        `Task not found: ${params.taskId}`,
      ),
    );
  }

  const a2aTask = mcTaskToA2ATask(taskData.task, taskData.runs);
  return c.json(jsonRpcResult(req.id, a2aTask));
}

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

async function handleCancelTask(
  c: import("hono").Context,
  req: JsonRpcRequest,
): Promise<Response> {
  const params = req.params as { taskId?: string } | undefined;

  if (!params?.taskId) {
    return c.json(
      jsonRpcError(req.id, JSON_RPC_INVALID_PARAMS, "Missing taskId"),
    );
  }

  const cancelled = cancelTask(params.taskId);
  if (!cancelled) {
    // Either not found or already in terminal state
    const taskData = getTaskWithRuns(params.taskId);
    if (!taskData) {
      return c.json(
        jsonRpcError(
          req.id,
          A2A_TASK_NOT_FOUND,
          `Task not found: ${params.taskId}`,
        ),
      );
    }
    return c.json(
      jsonRpcError(
        req.id,
        A2A_TASK_NOT_CANCELABLE,
        "Task is already in a terminal state",
      ),
    );
  }

  // Return updated task
  const taskData = getTaskWithRuns(params.taskId);
  if (!taskData) {
    return c.json(
      jsonRpcError(req.id, A2A_TASK_NOT_FOUND, "Task cancelled but not found"),
    );
  }

  const a2aTask = mcTaskToA2ATask(taskData.task, taskData.runs);
  return c.json(jsonRpcResult(req.id, a2aTask));
}

// ---------------------------------------------------------------------------
// sendStreamingMessage
// ---------------------------------------------------------------------------

async function handleStreamingMessage(
  c: import("hono").Context,
  req: JsonRpcRequest,
): Promise<Response> {
  const params = req.params as
    | {
        message?: A2AMessage;
        contextId?: string;
      }
    | undefined;

  if (!params?.message?.parts || !Array.isArray(params.message.parts)) {
    return c.json(
      jsonRpcError(
        req.id,
        JSON_RPC_INVALID_PARAMS,
        "Missing or invalid message",
      ),
    );
  }

  // Submit the task (same as sendMessage)
  const submission = a2aMessageToSubmission(params.message);
  const result = await submitTask(submission);

  const contextId = params.contextId ?? newContextId();
  createContext(contextId, result.taskId);
  const taskId = result.taskId;

  // Set SSE headers
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return c.body(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        function send(eventType: string, data: unknown): void {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            closed = true;
          }
        }

        // Send initial submitted status
        send("task.status", {
          jsonrpc: "2.0",
          result: {
            taskId,
            status: { state: "submitted" },
            final: false,
          },
          id: req.id,
        });

        const bus = getEventBus();
        const sub = bus.subscribe("task.*", (event: Event) => {
          const a2aEvent = mcEventToA2AStatusEvent(
            {
              type: event.type,
              data: event.data as unknown as Record<string, unknown>,
            },
            taskId,
          );
          if (!a2aEvent) return;

          send("task.status", {
            jsonrpc: "2.0",
            result: a2aEvent,
            id: req.id,
          });

          // If terminal, send artifact (if any) and close
          if (a2aEvent.final) {
            const taskData = getTaskWithRuns(taskId);
            if (taskData) {
              const a2aTask = mcTaskToA2ATask(taskData.task, taskData.runs);
              if (a2aTask.artifacts && a2aTask.artifacts.length > 0) {
                for (const artifact of a2aTask.artifacts) {
                  send("task.artifact", {
                    jsonrpc: "2.0",
                    result: { taskId, artifact },
                    id: req.id,
                  });
                }
              }
            }
            closed = true;
            sub.unsubscribe();
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }
        });

        // Keepalive
        const keepalive = setInterval(() => {
          if (closed) {
            clearInterval(keepalive);
            return;
          }
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
            sub.unsubscribe();
            closed = true;
          }
        }, 30_000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          sub.unsubscribe();
          closed = true;
        });
      },
    }),
  );
}
