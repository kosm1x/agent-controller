/**
 * Scope-miss resolver — Phase 1.2 of
 * docs/planning/jarvis-usability-plan-2026-08-22.md ("kill the magic-word
 * protocol").
 *
 * Tool scoping is decided per message, so a turn can plan the whole job and
 * then discover the tool it needs is not in its list. Until now the model
 * asked the USER to retype the message with a keyword ("pídeme con «usa
 * shell_exec»") — 37 such replies and ~25–32 user incantations in 45 days,
 * and 3 times the phrase was typed and still refused. The router now detects
 * that reply, maps the requested tool back to its scope group, widens the
 * thread's scope and re-runs the SAME turn once, silently. The user never
 * reads a tool name.
 *
 * Pure helpers — no I/O. The router owns the re-run.
 */

import { VALID_GROUPS } from "./scope-classifier.js";
import {
  DEFAULT_SCOPE_PATTERNS,
  scopeToolsForMessage,
  type ScopeOptions,
} from "./scope.js";

/**
 * Every group the assembler knows: the classifier's list ∪ the groups named
 * by the regex patterns (finance, paper, pm_*, skills, diagram, … are
 * regex-only — R2 audit W2: 43 tools were unreachable through VALID_GROUPS).
 */
export const ALL_SCOPE_GROUPS: ReadonlySet<string> = new Set([
  ...VALID_GROUPS,
  ...DEFAULT_SCOPE_PATTERNS.map((p) => p.group),
]);

/**
 * The shapes the model uses to push tool activation back to the user. The
 * R1 audit (2026-08-23) replayed 392 delivered replies: the dominant real
 * shapes are "No tengo `X` en este scope", connective-less "Pídeme/Dime «usa
 * X»", "¿Me lo habilitas con «usa X»?", "Activa X y continúo" and "Necesito
 * shell_exec para …" mid-paragraph — none of which the first cut matched.
 * Each alternation below is tied to at least one corpus exchange id.
 */
const SCOPE_ASK_RE =
  /no (?:la |lo |las |los )?tengo(?: `?[a-z_]+`?(?: ni `?[a-z_]+`?)*)? (?:en (?:este |el |mi )?scope|activ[ao]s?|disponibles?)|en (?:este|mi) scope(?: actual)?|no est[áa]n? en (?:el |mi )?scope|fuera del scope|scope activo|no aparecen? en (?:mi|tu|la) lista(?: de herramientas)?|no est[áa]n? disponibles? en est[ae] (?:turno|ronda|sesi[oó]n|scope)|(?:p[íi]deme(?:lo)?|d[íi]me(?:lo)?|p[íi]delo|puedes pedirme|dame acceso|habil[ií]t(?:a|as|es|ame|alo|ala)|act[ií]va(?:lo|la|me)?(?:s)?)(?:[\s:*]{0,4}(?:con|diciendo|escribiendo))?[\s:*"«“']{0,6}usa [a-z_]+|necesito que (?:me )?(?:la |lo |las |los )?(?:digas|pidas|actives|habilites)|en cuanto (?:me )?(?:la |lo |las |los )?habilites|necesito `?[a-z]+(?:_+[a-z]+)+`?|act[ií]va(?:la|lo)? (?:`?[a-z]+(?:_+[a-z]+)+`?) y (?:contin[uú]o|sigo|lo (?:corro|hago))|not (?:in|available in) (?:my |the )?(?:current )?(?:scope|tool list)/i;

/**
 * R1 audit W1: an ask buried mid-reply that the model then worked around
 * (exchange 12243: ask at char 949 of 2845, full deliverable followed) must
 * not discard the deliverable. The ask counts only when it sits in the
 * TAIL of the reply — the last TAIL_WINDOW characters — i.e. the turn ended
 * on it (12243's ask sat 1,896 chars from the end; 12021's "lo que haré en
 * cuanto los tenga" plan after the ask fits in 1,500 — R2 audit W1).
 */
const TAIL_WINDOW = 700;

/** Keyword → tool the operator's incantations have historically meant. */
const KEYWORD_TOOLS: ReadonlyArray<[RegExp, string]> = [
  [/\bshell(?:_exec)?\b/i, "shell_exec"],
  [/\bgemini(?:_image|_research|_upload)?\b/i, "gemini_image"],
  [/\bschedule(?:_task)?\b|\bschedul/i, "schedule_task"],
  [/\btweet(?:_post)?\b/i, "tweet_post"],
  [/\bfile_edit\b/i, "file_edit"],
  [/\bfile_write\b/i, "file_write"],
  [/\bgit_(?:commit|push)\b/i, "git_commit"],
  [/\bgdocs?_\w+\b/i, "gdocs_write"],
  [/\bgsheets?_\w+\b/i, "gsheets_write"],
  [/\bwp_\w+\b/i, "wp_create_post"],
];

export interface ScopeMiss {
  /** Tool names the reply asked for, resolved against the registry. */
  requestedTools: string[];
  /** The matched ask phrase (for logs). */
  phrase: string;
  /**
   * The tail contains an explicit request for activation ("necesito",
   * "pídeme", "habilita", "no tengo X", "no aparece en mi lista") — not just
   * a scope mention ("no tengo OCR en este scope" beside a tool it has,
   * corpus 11723). A hallucinated ask is re-run only when strong.
   */
  strong: boolean;
}

const STRONG_ASK_RE =
  /necesito (?:`?[a-z]+(?:_+[a-z]+)+|que )|p[íi]de(?:me|lo)|d[íi]me(?:lo)?\b[^\n]{0,12}usa |habilit|act[ií]va(?:lo|la|me|s)?\b|no aparecen? en|no tengo `?[a-z]+(?:_+[a-z]+)+|lista de herramientas|dame acceso/i;

/**
 * Detect a scope-ask reply. Returns null for ordinary replies — including
 * ones that merely mention a tool name in passing — because the ASK phrase
 * must be present, not just the identifier.
 */
export function detectScopeMiss(
  text: string,
  knownTools: Iterable<string>,
): ScopeMiss | null {
  const tail = text.slice(-TAIL_WINDOW);
  const m = SCOPE_ASK_RE.exec(tail);
  if (!m) return null;
  const known = new Set(knownTools);
  const found = new Set<string>();
  // 1. exact identifiers in backticks / quotes / bare snake_case — harvested
  //    from the tail only, so a tool merely mentioned earlier in the reply
  //    is not "requested" (R1 audit C3/W1).
  // Identifiers: snake_case, MCP `mcp__server__tool` / `browser__goto`
  // (double underscore), and hyphenated servers like `graphify-code__search`
  // (R2 audit W3).
  for (const id of tail.match(/\b[a-z][a-z0-9-]*(?:_+[a-z0-9-]+)+\b/g) ?? []) {
    if (known.has(id)) found.add(id);
  }
  // 2. the operator's keyword vocabulary ("usa shell", "usa gemini")
  if (found.size === 0) {
    for (const [re, tool] of KEYWORD_TOOLS) {
      if (re.test(tail) && known.has(tool)) found.add(tool);
    }
  }
  if (found.size === 0) return null;
  return {
    requestedTools: [...found],
    phrase: m[0],
    strong: STRONG_ASK_RE.test(tail),
  };
}

/**
 * Which scope group(s) would have put `tool` in the list? Computed against
 * the real assembly function so it cannot drift from scope.ts: activate one
 * group at a time and look for the tool.
 */
export function groupsForTool(
  tool: string,
  options: ScopeOptions,
  groups: Iterable<string> = ALL_SCOPE_GROUPS,
): string[] {
  // R1 audit C3: an always-on tool appears under EVERY group — subtract the
  // baseline (no groups active) so only groups that actually ADD the tool
  // count. Sorted most-specific first (fewest tools) so the router widens by
  // the narrowest group that supplies the tool, not the union of all.
  const baseline = new Set(
    scopeToolsForMessage("", [], DEFAULT_SCOPE_PATTERNS, options, new Set()),
  );
  if (baseline.has(tool)) return [];
  const hits: Array<{ g: string; size: number }> = [];
  for (const g of groups) {
    const tools = scopeToolsForMessage(
      "",
      [],
      DEFAULT_SCOPE_PATTERNS,
      options,
      new Set([g]),
    );
    if (tools.includes(tool)) hits.push({ g, size: tools.length });
  }
  return hits.sort((a, b) => a.size - b.size).map((h) => h.g);
}

/**
 * Delivered instead of a scope-ask when no silent re-run can fix it. Never a
 * keyword to retype, and (R1 audit W7) never a promise of a widening that
 * did not happen.
 */
export type ScopeMissFallbackReason = "rerun_missed" | "no_rerun" | "error";

export function scopeMissFallbackLine(
  reason: ScopeMissFallbackReason,
): string {
  switch (reason) {
    case "rerun_missed":
      return "No pude usar la herramienta que esto necesita ni al reintentar. ¿Quieres que lo intente de otra forma?";
    case "no_rerun":
      return "Esta tarea necesita una herramienta que no está disponible en este contexto.";
    case "error":
      return "No pude reintentar este turno. ¿Lo vuelvo a intentar?";
  }
}
