/**
 * Task API routes.
 *
 * POST /tasks          — Submit a task
 * GET  /tasks          — List tasks (filter by status, agent_type, parent)
 * GET  /tasks/:id      — Task detail with runs and sub-tasks
 * POST /tasks/:id/cancel — Cancel a task (cascades to sub-tasks)
 */

import { Hono } from "hono";
import {
  submitTask,
  listTasks,
  getTaskWithRuns,
  cancelTask,
} from "../../dispatch/dispatcher.js";

const tasks = new Hono();

// Submit a new task
tasks.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const {
    title,
    description,
    priority,
    agent_type,
    tags,
    tools,
    input,
    conversationHistory,
  } = body;

  if (!title || typeof title !== "string") {
    return c.json({ error: "title is required (string)" }, 400);
  }
  if (!description || typeof description !== "string") {
    return c.json({ error: "description is required (string)" }, 400);
  }

  const result = await submitTask({
    title,
    description,
    priority,
    agentType: agent_type,
    tags,
    tools,
    input,
    // Passing conversationHistory from the body routes this task through the
    // chat branch in fast-runner, which triggers KB injection (always-read +
    // enforce + conditional files + project README auto-injection). Without
    // it, the non-chat branch runs a generic system prompt with no KB — so
    // any integration test that needs to exercise project-specific context
    // must supply this field, even with a single-turn [{role:"user", ...}]
    // array.
    conversationHistory,
  });

  return c.json(
    {
      task_id: result.taskId,
      agent_type: result.agentType,
      classification: result.classification,
      status: "queued",
    },
    201,
  );
});

// List tasks
tasks.get("/", (c) => {
  const status = c.req.query("status");
  const agentType = c.req.query("agent_type");
  const parent = c.req.query("parent");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);

  const results = listTasks({
    status: status || undefined,
    agentType: agentType || undefined,
    parentTaskId: parent || undefined,
    limit: Math.min(limit, 200),
    offset,
  });

  return c.json({ tasks: results, count: results.length });
});

// Task detail
tasks.get("/:id", (c) => {
  const taskId = c.req.param("id");
  const result = getTaskWithRuns(taskId);

  if (!result) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json(result);
});

// Cancel a task
tasks.post("/:id/cancel", (c) => {
  const taskId = c.req.param("id");
  const cancelled = cancelTask(taskId);

  if (!cancelled) {
    return c.json(
      { error: "Task not found or already in terminal state" },
      404,
    );
  }

  return c.json({ task_id: taskId, status: "cancelled" });
});

export { tasks };
