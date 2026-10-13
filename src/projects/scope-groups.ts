/**
 * S6 WS3 — scope groups derived from project records (spec
 * docs/planning/s6-project-contract-spec-2026-10-11.md §3 "Scope"), replacing
 * the per-server hand edits (`VALID_GROUPS`, a classifier-prompt line, a
 * regex in `DEFAULT_SCOPE_PATTERNS`, a `*_TOOLS` list).
 *
 * One group per active record that declares `capabilities.mcp[]` (a loaded
 * server) or `routing.summary`, named after its slug. The classifier-prompt
 * line comes from `routing.summary` — model-facing text: with no declaring
 * record nothing is emitted and the prompt is byte-identical to the code's;
 * the first real record owes the paid eval gate.
 */

import { MCP_NAMESPACE_SEP } from "../mcp/types.js";

/** What derivation reads from one active project row. */
export interface ProjectScopeInput {
  slug: string;
  aliases?: readonly string[];
  routing?: { summary?: string };
  /** Ids of this record's LOADED servers (trusted, not refused). */
  serverIds: readonly string[];
}

export interface ProjectScopeGroup {
  /** The group name = the slug. */
  name: string;
  /** `<id>__` per server: the group's tools are every registered name under one. */
  prefixes: string[];
}

export interface DerivedProjectScope {
  groups: ProjectScopeGroup[];
  /** One classifier-prompt GROUPS line per record with `routing.summary`. */
  promptLines: string[];
  /** Regex-fallback patterns (the scope.ts xpoz pattern shape). */
  regexes: Array<{ pattern: RegExp; group: string }>;
  /** Slugs not registered because their name is already a group. */
  skipped: string[];
  /** Aliases shorter than MIN_ALIAS_CHARS left out of a group's regex, counted per slug. */
  shortAliases: Array<{ slug: string; dropped: number }>;
}

/**
 * An alias shorter than this matches too much text on the regex-fallback
 * path (`["a","de"]` hits nearly every Spanish message; audit R1 W6).
 */
export const MIN_ALIAS_CHARS = 4;

/** An alias's length as the scope regex measures it: NFC, trimmed, code points. */
export const aliasChars = (t: string): number => [...t.normalize("NFC").trim()].length;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pure. `reserved` = every group name that already exists (a slug equal to
 * one is skipped, never merged into it).
 */
export function deriveProjectScopeGroups(
  records: readonly ProjectScopeInput[],
  reserved: ReadonlySet<string>,
): DerivedProjectScope {
  const out: DerivedProjectScope = {
    groups: [],
    promptLines: [],
    regexes: [],
    skipped: [],
    shortAliases: [],
  };
  const seen = new Set<string>();
  for (const r of [...records].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    const summary = r.routing?.summary?.replace(/\s+/g, " ").trim() ?? "";
    if (r.serverIds.length === 0 && !summary) continue;
    if (reserved.has(r.slug) || seen.has(r.slug)) {
      out.skipped.push(r.slug);
      continue;
    }
    seen.add(r.slug);
    const prefixes = r.serverIds.map((id) => `${id}${MCP_NAMESPACE_SEP}`);
    out.groups.push({ name: r.slug, prefixes });
    if (summary) out.promptLines.push(`- ${r.slug}: ${summary}`);
    // Lookarounds, not \b: an accented alias edge has no ASCII word boundary.
    const aliases = (r.aliases ?? []).map((t) => t.normalize("NFC").trim()).filter((t) => t.length > 0);
    const kept = aliases.filter((t) => aliasChars(t) >= MIN_ALIAS_CHARS);
    if (kept.length < aliases.length) {
      out.shortAliases.push({ slug: r.slug, dropped: aliases.length - kept.length });
    }
    const terms = [r.slug.normalize("NFC"), ...kept].map(escapeRe);
    const tools = prefixes.map((p) => `${escapeRe(p)}[a-z0-9_]+`);
    out.regexes.push({
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${[...terms, ...tools].join("|")})(?![\\p{L}\\p{N}_])`,
        "iu",
      ),
      group: r.slug,
    });
  }
  return out;
}

/**
 * Deferred-head rule (CLAUDE.md §Infrastructure) for a server with no call
 * distribution yet: it may defer some tools, never all — when every tool is
 * deferred the first one (the server's own order) stays eager. Pure.
 */
export function applyDeferredHeadRule(
  toolNames: readonly string[],
  deferred: ReadonlySet<string>,
): Set<string> {
  const out = new Set(deferred);
  if (toolNames.length > 0 && toolNames.every((n) => out.has(n))) {
    out.delete(toolNames[0]!);
  }
  return out;
}
