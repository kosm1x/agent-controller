/**
 * In-memory IP-keyed rate limiter for public /api/* routes.
 *
 * Sec9 round-1 fix (docs/audit/2026-04-22-security.md): /api/* was X-Api-Key
 * gated but had zero rate limit. A single leaked / misused key could drive
 * unlimited request volume through Jarvis's task / admin endpoints. This
 * middleware caps per-IP request rate as defense-in-depth.
 *
 * Pattern mirrors src/api/mcp-server/rate-limit.ts (sliding window) but keys
 * on client IP instead of mcpToken.id so it works for a single shared API key.
 *
 * Simple array-of-timestamps implementation — fine at Jarvis's scale
 * (one owner + local dashboard). Swap for Redis if ever horizontally scaled.
 */

import type { MiddlewareHandler } from "hono";

export interface ApiRateLimitOptions {
  windowMs: number;
  maxPerWindow: number;
}

/**
 * Extract the client IP.
 *
 * Sec9 round-2 fix: server binds `0.0.0.0:8080` by default and UFW exposes
 * that port publicly, so an attacker can hit us directly *and* rotate
 * `X-Forwarded-For` per request to defeat per-IP rate-limiting. XFF is
 * only trusted when `TRUST_FORWARDED_FOR=true` env is set AND the socket
 * remote address is localhost (the Caddy reverse-proxy topology). Otherwise
 * we ignore XFF entirely and use the socket's remoteAddress.
 */
function clientIp(headers: Headers, socketAddr: string | undefined): string {
  const trustXff =
    process.env.TRUST_FORWARDED_FOR === "true" &&
    (socketAddr === "127.0.0.1" ||
      socketAddr === "::1" ||
      socketAddr === "::ffff:127.0.0.1");

  if (trustXff) {
    const xff = headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const xreal = headers.get("x-real-ip");
    if (xreal) return xreal.trim();
  }

  return socketAddr ?? "unknown";
}

/**
 * Safety cap on the Map size — Sec9 round-2 W4 fix. Under XFF spoofing or
 * a botnet of many real IPs the Map can grow faster than the eviction
 * drains. Past this size, wholesale-evict all idle entries before insert
 * to bound memory.
 */
const MAX_TRACKED_IPS = 10_000;

export function apiRateLimit(options: ApiRateLimitOptions): MiddlewareHandler {
  const { windowMs, maxPerWindow } = options;
  const windows = new Map<string, number[]>();

  return async (c, next) => {
    // Extract remote socket address from the underlying node-server request.
    // Hono's node adapter attaches `incoming` on the env context.
    const socketAddr = (
      c.env as { incoming?: { socket?: { remoteAddress?: string } } }
    )?.incoming?.socket?.remoteAddress;
    const ip = clientIp(c.req.raw.headers, socketAddr);
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = windows.get(ip) ?? [];
    const recent = hits.filter((t) => t > cutoff);

    if (recent.length >= maxPerWindow) {
      const oldest = recent[0]!;
      const retryAfterSec = Math.ceil((oldest + windowMs - now) / 1000);
      c.header("Retry-After", String(Math.max(1, retryAfterSec)));
      windows.set(ip, recent);
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
    windows.set(ip, recent);

    // Idle-window eviction: sweep one idle OTHER IP per request. Keeps map
    // bounded proportional to currently-active IPs.
    for (const [otherIp, otherHits] of windows) {
      if (otherIp === ip) continue;
      const hasActive = otherHits.some((t) => t > cutoff);
      if (!hasActive) {
        windows.delete(otherIp);
        break;
      }
    }

    // W4 wholesale eviction under growth pressure.
    if (windows.size > MAX_TRACKED_IPS) {
      for (const [otherIp, otherHits] of windows) {
        if (otherIp === ip) continue;
        const hasActive = otherHits.some((t) => t > cutoff);
        if (!hasActive) windows.delete(otherIp);
      }
    }

    await next();
    return;
  };
}
