/**
 * X-Api-Key authentication middleware for Hono.
 */

import type { Context, Next } from "hono";
import { getConfig } from "../config.js";

/**
 * Middleware that validates the X-Api-Key header.
 * Returns 401 if missing, 403 if invalid.
 */
export async function apiKeyAuth(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const key = c.req.header("X-Api-Key");
  if (!key) {
    return c.json({ error: "Missing X-Api-Key header" }, 401);
  }
  if (key !== getConfig().apiKey) {
    return c.json({ error: "Invalid API key" }, 403);
  }
  await next();
}
