/**
 * S6 WS3: a project's status as record MCP servers see it at call time,
 * cached ≤ PROJECT_STATUS_TTL_MS. `updateProject`/`deleteProject` invalidate
 * the slug's entry (audit R1 rec b), so a status change is seen at once.
 */

export const PROJECT_STATUS_TTL_MS = 60_000;

const cache = new Map<string, { status: string; at: number }>();

/** Cached status of `slug`; `read` runs on a miss or an expired entry (its error propagates). */
export function cachedProjectStatus(slug: string, read: () => string): string {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at <= PROJECT_STATUS_TTL_MS) return hit.status;
  const status = read();
  cache.set(slug, { status, at: Date.now() });
  return status;
}

export function invalidateProjectStatus(slug: string): void {
  cache.delete(slug);
}
