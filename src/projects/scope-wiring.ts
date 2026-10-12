/**
 * S6 WS3 — the ONE boot wiring of record-derived scope groups
 * (`deriveProjectScopeGroups`) into the classifier, the regex fallback, the
 * scope-miss group list and the tool assembly. Runs once in `src/index.ts`
 * after the projector and the tool sources (the MCP tools exist by then).
 */

import { VALID_GROUPS, registerProjectClassifierGroups } from "../messaging/scope-classifier.js";
import { DEFAULT_SCOPE_PATTERNS, registerProjectScopeGroups } from "../messaging/scope.js";
import { ALL_SCOPE_GROUPS } from "../messaging/scope-miss.js";
import { MIN_ALIAS_CHARS, deriveProjectScopeGroups, type DerivedProjectScope } from "./scope-groups.js";

export function wireProjectScopeGroups(
  rows: ReadonlyArray<{ slug: string; status: string; config: Record<string, unknown> }>,
  serverIdsBySlug: ReadonlyMap<string, readonly string[]>,
  toolNames: () => readonly string[],
): DerivedProjectScope {
  const inputs = rows
    .filter((r) => r.status === "active")
    .map((r) => {
      const routing = r.config.routing as { summary?: unknown } | undefined;
      return {
        slug: r.slug,
        aliases: Array.isArray(r.config.aliases)
          ? (r.config.aliases as unknown[]).filter((a): a is string => typeof a === "string")
          : undefined,
        routing: typeof routing?.summary === "string" ? { summary: routing.summary } : undefined,
        serverIds: serverIdsBySlug.get(r.slug) ?? [],
      };
    });
  const reserved = new Set([...VALID_GROUPS, ...DEFAULT_SCOPE_PATTERNS.map((p) => p.group)]);
  const derived = deriveProjectScopeGroups(inputs, reserved);
  for (const { slug, dropped } of derived.shortAliases) {
    console.warn(
      `[scope] ${slug}: ${dropped} alias(es) shorter than ${MIN_ALIAS_CHARS} characters left out of its scope regex`,
    );
  }
  if (derived.groups.length === 0) return derived;
  const names = derived.groups.map((g) => g.name);
  registerProjectClassifierGroups(names, derived.promptLines);
  registerProjectScopeGroups(derived.groups, derived.regexes, toolNames);
  for (const n of names) (ALL_SCOPE_GROUPS as Set<string>).add(n);
  return derived;
}
