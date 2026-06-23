/**
 * XPostRouter — orders backends and routes post/probe across them. Pure control
 * logic (no network of its own), so it's fully unit-testable with fake backends.
 *
 * post(): try each CONFIGURED backend in order, return on the first success.
 *   If every attempt failed with auth-expiry, flag `allAuthExpired` so the caller
 *   surfaces the refresh-cookies guidance instead of letting the model flail
 *   (the 2026-05-15 "12 cosmetic script variants" failure mode).
 * probe(): probe every configured backend; healthy iff ≥1 reports ok.
 */

import type { XBackend, RouterPost, RouterProbe, PostResult } from "./types.js";

export class XPostRouter {
  /** Backends in priority order. Default: cookie (primary) → api (fallback). */
  constructor(private readonly backends: readonly XBackend[]) {}

  private configured(): XBackend[] {
    return this.backends.filter((b) => b.isConfigured());
  }

  async probe(): Promise<RouterProbe> {
    const active = this.configured();
    if (active.length === 0) {
      return { healthy: false, unconfigured: true, results: [] };
    }
    const results = await Promise.all(active.map((b) => b.probe()));
    return {
      healthy: results.some((r) => r.ok),
      unconfigured: false,
      results,
    };
  }

  async post(text: string, replyToId?: string): Promise<RouterPost> {
    const active = this.configured();
    if (active.length === 0) {
      return {
        ok: false,
        allAuthExpired: false,
        unconfigured: true,
        attempts: [],
      };
    }
    const attempts: PostResult[] = [];
    for (const backend of active) {
      const res = await backend.post(text, replyToId);
      attempts.push(res);
      if (res.ok) {
        return {
          ok: true,
          backend: res.backend,
          tweetId: res.tweetId,
          allAuthExpired: false,
          unconfigured: false,
          attempts,
        };
      }
    }
    return {
      ok: false,
      allAuthExpired: attempts.every((a) => a.authExpired === true),
      unconfigured: false,
      attempts,
    };
  }
}
