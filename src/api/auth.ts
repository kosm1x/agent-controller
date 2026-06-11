/**
 * X-Api-Key authentication middleware for Hono.
 */

import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getConfig } from "../config.js";

/** Constant-time string comparison — no early-exit timing oracle. */
function safeKeyCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length leak is unavoidable with timingSafeEqual (it throws on mismatched
  // lengths); comparing against a same-length self keeps timing flat while
  // still rejecting.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

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
  if (!safeKeyCompare(key, getConfig().apiKey)) {
    return c.json({ error: "Invalid API key" }, 403);
  }
  await next();
}

/**
 * Whether the request's TCP peer is a loopback or RFC1918/ULA private
 * address. Used to keep internal scrapers (mc-prometheus runs in Docker and
 * arrives from the 172.16/12 bridge) and localhost tooling working without a
 * key, while the public internet — port 8080 is UFW-open — gets gated.
 * Socket address only; X-Forwarded-For is deliberately ignored here (it's
 * attacker-controlled on a directly-exposed port).
 */
export function isPrivatePeer(c: Context): boolean {
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
    ?.incoming?.socket?.remoteAddress;
  if (!addr) return false;
  const ip = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^(fc|fd)/i.test(ip)) return true; // IPv6 ULA
  return false;
}

/** Non-middleware check: did the request present a valid X-Api-Key? */
export function hasValidApiKey(c: Context): boolean {
  const key = c.req.header("X-Api-Key");
  if (!key) return false;
  try {
    return safeKeyCompare(key, getConfig().apiKey);
  } catch {
    return false;
  }
}

/**
 * Auth gate for internal observability surfaces (/metrics, detailed /health):
 * private/loopback peers pass without a key; everyone else needs X-Api-Key.
 */
export async function privateOrApiKeyAuth(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (isPrivatePeer(c)) {
    await next();
    return;
  }
  return apiKeyAuth(c, next);
}
