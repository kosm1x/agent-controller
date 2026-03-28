/**
 * COMMIT AI endpoint — Jarvis as intelligence backend for COMMIT.
 *
 * POST /api/commit-ai
 * Body: { function: string, input: Record<string, unknown>, context?: { user_id, language } }
 * Returns: { content: string | null, enriched: boolean, error?: string }
 *
 * Called by COMMIT's ai-proxy Edge Function. Falls back to Groq if Jarvis
 * returns content: null or is unreachable.
 */

import { Hono } from "hono";
import {
  dispatchCommitAI,
  type CommitAIRequest,
} from "../../commit-ai/dispatcher.js";

export const commitAI = new Hono();

commitAI.post("/", async (c) => {
  let body: CommitAIRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ content: null, error: "Invalid JSON" }, 400);
  }

  if (!body.function || !body.input) {
    return c.json(
      { content: null, error: "Missing required fields: function, input" },
      400,
    );
  }

  try {
    const result = await dispatchCommitAI(body);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ content: null, enriched: false, error: message }, 500);
  }
});
