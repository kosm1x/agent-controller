/**
 * Variant code fingerprint (2026-09-12, agents-best-practices gap 2).
 *
 * A tuning variant overrides scope-pattern GROUPS. It was scored against
 * the code defaults of those groups as they were on the night it was
 * generated; when the code moves on, the variant's assumptions are stale
 * but it kept activating at every boot (the April-2026 variant ran for
 * five months over defaults it had never seen). The fingerprint is a
 * sha256 over the pristine code patterns of exactly the groups the
 * variant overrides. Stored on the row at generation, recomputed at
 * activation: mismatch = drift = do not activate.
 *
 * Tool-description overrides are NOT fingerprinted: activation runs
 * inside initDatabase, before any tool source registers, so those
 * overrides have never applied at boot (see activation.ts).
 */

import { createHash } from "crypto";
import { CODE_SCOPE_PATTERNS } from "../messaging/scope.js";
import type { ScopePattern } from "./types.js";

export function scopeFingerprint(
  groups: Iterable<string>,
  codePatterns: ReadonlyArray<Readonly<ScopePattern>> = CODE_SCOPE_PATTERNS,
): string {
  const wanted = [...new Set(groups)].sort();
  const payload = wanted.map((group) => [
    group,
    codePatterns.filter((p) => p.group === group).map((p) => String(p.pattern)),
  ]);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Groups a sandbox config overrides (empty when it carries no scope surface). */
export function overriddenGroups(
  overrides: ReadonlyArray<{ group: string }> | undefined,
): string[] {
  return [...new Set((overrides ?? []).map((p) => p.group))].sort();
}
