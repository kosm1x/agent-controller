/**
 * Per-task model tiering for Prometheus (planner / executor / reflector).
 *
 * Historically every Prometheus step of every task ran the Opus-first complex
 * path — so a trivial coding chat ("clamp a percentage", ~$7 in a container)
 * paid the same as a deep architecture task. This module assesses a task's
 * complexity from its description so the orchestrator can pick Sonnet for
 * confidently-simple work and keep Opus for everything else.
 *
 * Design constraints:
 * - **Keyword-driven, NOT length-driven.** nanoclaw appends a ~600-char
 *   `[ENVIRONMENT]` note to the prompt before orchestrate() sees it; a length
 *   threshold would mis-read every sandboxed coding task as "big". Signal words
 *   decide, so the appended boilerplate is inert.
 * - **Opus is the safe default.** Only a *confident* simple signal (with no
 *   competing complex signal) downgrades to Sonnet. Anything ambiguous stays
 *   on Opus so nothing silently regresses in quality.
 * - **Complex wins ties.** "rename the entire auth system across all services"
 *   carries both a simple verb (`rename`) and complex scope (`entire`,
 *   `across all`) — it must stay Opus, so complex is checked first.
 */

/**
 * Signals that a task needs deep reasoning → Opus. Broad scope, architecture,
 * strategy, multi-system work, research/audit. Checked BEFORE simple signals so
 * a task carrying both lands on Opus.
 */
const COMPLEX_PATTERNS: RegExp[] = [
  /\barchitect(?:ure|ing|ural)?\b/i,
  /\bre-?architect/i,
  /\bre-?design/i,
  /\brefactor/i,
  /\bmigrat(?:e|ion|ing)\b/i,
  /\boverhaul\b/i,
  /\bfrom scratch\b/i,
  /\bend[-\s]?to[-\s]?end\b/i,
  /\b(?:whole|entire|across (?:all|the|multiple)|multiple)\b/i,
  /\b(?:codebase|subsystem|architecture)\b/i,
  /\bstrateg(?:y|ic|ize)\b/i,
  /\broadmap\b/i,
  /\bdeep[-\s]?dive\b/i,
  /\bcomprehensive\b/i,
  /\bthorough(?:ly)?\b/i,
  /\baudit\b/i,
  /\binvestigat(?:e|ion)\b/i,
  /\bswarm\b/i,
  /\bcompare\b.*\boptions?\b/i,
  /\btrade[-\s]?offs?\b/i,
  /\bmulti[-\s]?step\b/i,
  /\bnew (?:service|feature|system|module|runner|pipeline|integration)\b/i,
  /\bdesign (?:a|an|the) (?:system|architecture|schema|api)\b/i,
];

/**
 * Signals that a task is bounded and mechanical → eligible for Sonnet. Single
 * edits, renames, typos, small additions. Only downgrades when NO complex
 * signal is also present.
 */
const SIMPLE_PATTERNS: RegExp[] = [
  /\btypo\b/i,
  // Only the bounded identifier-swap form ("rename X to Y") — NOT bare
  // "rename", which can mean a wide-blast-radius rename ("rename the column
  // and backfill 2M rows", "rename the integration and re-point all webhooks").
  // Those carry no other signal, so dropping bare `rename` lets them fall
  // through to the Opus default rather than silently downgrading to Sonnet.
  /\brename\b[^.!?\n]{0,50}\bto\b/i,
  /\bbump\b/i,
  /\bclamp\b/i,
  /\bone[-\s]?line(?:r)?\b/i,
  /\bformat(?:ting)?\b/i,
  /\blint\b/i,
  /\bsmall (?:fix|change|tweak|edit)\b/i,
  /\badd (?:a |an )?(?:test|comment|log|field|column|flag|getter|helper)\b/i,
  /\bfix (?:the |a |an )?(?:typo|import|lint|test|comment)\b/i,
  // Cosmetic value/string edits only. "default" is deliberately EXCLUDED here
  // and below — "change/update the default X" is usually a behavior change, not
  // a cosmetic one, so it should default to Opus.
  /\bupdate (?:the |a )?(?:version|comment|string|copy|label|message)\b/i,
  /\bchange (?:the |a )?(?:value|label|string|constant|copy)\b/i,
  /\btweak\b/i,
];

/**
 * Assess a task's complexity from its description. Pure — no env, no I/O — so
 * it is trivially unit-testable. Returns `"complex"` whenever a complex signal
 * is present OR no signal is found (Opus is the safe default); `"simple"` only
 * when a simple signal is present and no complex signal competes with it.
 */
export function assessTaskComplexity(
  taskDescription: string,
): "simple" | "complex" {
  const text = taskDescription ?? "";
  if (COMPLEX_PATTERNS.some((re) => re.test(text))) return "complex";
  if (SIMPLE_PATTERNS.some((re) => re.test(text))) return "simple";
  // No signal either way — default to Opus so quality never silently drops.
  return "complex";
}

/**
 * Resolve whether a Prometheus task should run on Opus, applying the economy
 * kill switch. `PROMETHEUS_ECONOMY_MODEL=false` disables tiering entirely
 * (every task back on Opus-first — the pre-tiering behavior); any other value
 * (incl. unset) keeps tiering active.
 */
export function resolveUseOpus(taskDescription: string): boolean {
  if (process.env.PROMETHEUS_ECONOMY_MODEL === "false") return true;
  return assessTaskComplexity(taskDescription) === "complex";
}
