/**
 * Which Knowledge Base rows an EXTERNAL caller (jarvis-pull: a CRM agent)
 * may see — through KB injection and through the jarvis_file_* tools.
 *
 * OPT-IN ONLY. A row is visible when its `tags` contain `external` (the
 * operator exposes a row with `jarvis_file_update` → tags; the tag is added
 * only on an operator chat root — background agents, scheduled, API, A2A and
 * external runs are refused, jarvis-files.ts) or its path starts
 * with one of the seed prefixes below. Everything else is operator-private.
 * Enforce rows reach an external prompt only when listed in
 * EXTERNAL_ENFORCE_PATHS.
 */

export const EXTERNAL_KB_TAG = "external";

/**
 * Plain string prefixes (a file or a directory). TV / media-market domain
 * docs only. No project path is seeded (people, dev logs, security findings,
 * Drive links), nor the confidential comparisons or the DENUE docs (another
 * business's content) — the operator widens by tagging a row `external`.
 */
export const EXTERNAL_KB_SEED_PREFIXES = [
  "knowledge/domain/tv-",
  "knowledge/domain/media-market-",
  "knowledge/domain/grupo-imagen-",
  "knowledge/domain/imagen-multimedia-",
] as const;

/** The only `enforce` rows injected on the external path. */
export const EXTERNAL_ENFORCE_PATHS = [
  "directives/repo-authorization.md",
] as const;

/**
 * KB paths are exact-match keys; anything path-like beyond a plain relative
 * key (non-string, traversal, backslash) is refused outright.
 */
export function isExternalKbPathShapeOk(path: unknown): path is string {
  if (typeof path !== "string" || path === "") return false;
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return !path.includes("\\");
}

/** Stored tags are a JSON array string; tool output carries a string[]. */
export function hasExternalTag(tags: unknown): boolean {
  let list: unknown = tags;
  if (typeof tags === "string") {
    try {
      list = JSON.parse(tags);
    } catch {
      return false;
    }
  }
  return Array.isArray(list) && list.includes(EXTERNAL_KB_TAG);
}

export interface ExternalKbRowRef {
  path: unknown;
  tags?: unknown;
}

/** A row is external-visible: tagged `external`, or under a seed prefix. */
export function isExternalKbRowAllowed(row: ExternalKbRowRef): boolean {
  if (!isExternalKbPathShapeOk(row.path)) return false;
  const path = row.path;
  return (
    hasExternalTag(row.tags) ||
    EXTERNAL_KB_SEED_PREFIXES.some((p) => path.startsWith(p))
  );
}

/** KB injection on the external path: allow-listed enforce rows + visible rows. */
export function isExternalKbInjectable(
  row: ExternalKbRowRef & { qualifier?: string },
): boolean {
  if (row.qualifier === "enforce") {
    return (EXTERNAL_ENFORCE_PATHS as readonly unknown[]).includes(row.path);
  }
  return isExternalKbRowAllowed(row);
}
