/**
 * In-memory sliding-window rate limiter for the Jarvis MCP server.
 *
 * Per-token, 100 requests per 60s by default. Simple array-of-timestamps
 * implementation — fine at the v7.7 scale (one owner, one or two
 * concurrent clients). If this ever needs to scale, swap for a proper
 * token bucket or move to Redis.
 *
 * Must be installed AFTER mcpAuth() so `c.get("mcpToken")` is populated.
 */

import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Sliding window duration in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per window per token id. */
  maxPerWindow: number;
}

export function mcpRateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { windowMs, maxPerWindow } = options;
  const windows = new Map<number, number[]>();

  return async (c, next) => {
    const token = c.get("mcpToken");
    if (!token) {
      // Should not happen — middleware is mounted after mcpAuth. Defensive.
      return c.json({ error: "rate_limit_missing_auth_context" }, 500);
    }

    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = windows.get(token.id) ?? [];
    const recent = hits.filter((t) => t > cutoff);

    if (recent.length >= maxPerWindow) {
      const oldest = recent[0];
      const retryAfterSec = Math.ceil((oldest + windowMs - now) / 1000);
      c.header("Retry-After", String(Math.max(1, retryAfterSec)));
      return c.json(
        {
          error: "rate_limit_exceeded",
          windowMs,
          maxPerWindow,
          retryAfterSec,
        },
        429,
      );
    }

    recent.push(now);
    windows.set(token.id, recent);
    await next();
    return;
  };
}
