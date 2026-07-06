/**
 * 4-way heuristic task classifier.
 *
 * Scores a task description and metadata to determine the optimal runner type.
 * Explicit agent_type override always wins.
 *
 * Score ranges:
 *   0-2  → fast       (single-step, well-defined)
 *   3-5  → nanoclaw   (needs isolation or extended tools)
 *   6-8  → heavy      (multi-step, planning required)
 *   9+   → swarm      (large scope, parallelizable)
 */

import type { AgentType } from "../runners/types.js";
import {
  queryRunnerStats,
  queryOutcomesByKeywords,
  queryFeedbackQuality,
} from "../db/task-outcomes.js";
import { extractKeywords } from "./keywords.js";

/**
 * Patterns that signal a high-stakes data prompt — i.e. one where the model
 * MUST hit the live DENUE analyzer / DB rather than fabricate from training
 * data + web search. Exported so fast-runner.ts can re-check the same signal
 * and inject a guard system message at prompt-build time.
 *
 * Keep this list small and additive only — each pattern broadens the scope
 * of "must hit the API" prompts and costs prompt tokens for the guard.
 */
export const HIGH_STAKES_DATA_PATTERNS_EXPORTED: readonly RegExp[] = [
  /\bdenue\b/i, // any DENUE Analyzer mention activates routing guard
  /\bsite[- ]selection\b/i,
  /\bgreenfield\b/i,
  /\bscoring\b/i,
  /\bscorer\b/i,
  /\branking de\b/i, // ES: "ranking de farmacias"
  /\btop \d+/i,
  /\bmás densidad de\b/i, // ES: "más densidad de [grupo]"
  /\bmayor (densidad|porcentaje|proporción|concentración) de\b/i,
  /\bmejores (ubicaciones|locales)\b/i,
  /\boportunidades?\b/i,
  /\bdónde (abrir|poner)\b/i,
  /\bqué (ageb|municipio|colonia|manzana|bloque)\b/i,
];

export function hasHighStakesDataSignal(text: string): boolean {
  return HIGH_STAKES_DATA_PATTERNS_EXPORTED.some((p) => p.test(text));
}

export type ModelTier = "flash" | "standard" | "capable";

export interface ClassificationInput {
  title: string;
  description: string;
  tags?: string[];
  priority?: string;
  agentType?: string;
  /**
   * Pre-lowercased slugs/names of registered NON-mission-control projects.
   * The dispatcher resolves these from the `projects` table so a coding task
   * that NAMES a sibling project (without a literal `/root/claude/<repo>` path)
   * still routes to a host runner instead of the mission-control-only nanoclaw
   * sandbox. Optional + defaults to none, so callers/tests that omit it keep the
   * prior behavior. See `referencesForeignProject`.
   */
  foreignProjectNames?: string[];
  /**
   * Full, UNTRUNCATED text to run runner-detection against for messaging tasks.
   * Chat `title`s are truncated to 60 chars for display (router.ts), and a
   * mid-word cut can forge a spurious coding signal (e.g. "precio"→"pr" matching
   * \bPR\b) that misroutes a plain question into the nanoclaw sandbox. When set,
   * the messaging branch detects on this instead of `title`. Falls back to
   * `title` when absent, so non-messaging callers/tests are unaffected. See
   * feedback_truncated_title_pr_misroute.
   */
  detectionText?: string;
}

export interface ClassificationResult {
  agentType: AgentType;
  score: number;
  reason: string;
  explicit: boolean;
  /** Recommended model tier based on task complexity. */
  modelTier: ModelTier;
}

const VALID_AGENT_TYPES = new Set<AgentType>([
  "fast",
  "nanoclaw",
  "heavy",
  "swarm",
  "a2a",
]);

// Patterns and their score contributions
const MULTI_STEP_PATTERNS = [
  /\barchitect\b/i,
  /\bredesign\b/i,
  /\bmigration\b/i,
  /\brefactor\s+(?:the\s+)?entire\b/i,
  /\banalyze\s+and\s+(?:fix|improve|refactor)\b/i,
  /\bplan\s+and\s+(?:execute|implement)\b/i,
];

const PARALLEL_PATTERNS = [
  /\bmultiple\s+(?:files|modules|services|components)\b/i,
  /\bacross\s+(?:all|multiple|every)\s+\w+/i,
  /\bfull\s+audit\b/i,
  /\beach\s+(?:module|service|component)\s+independently\b/i,
  /\bin\s+parallel\b/i,
];

const ISOLATION_PATTERNS = [
  /\bcontainer\b/i,
  /\bisolated?\b/i,
  /\bsandbox\b/i,
  /\bpersistent\s+session\b/i,
];

/**
 * Compute model tier for messaging tasks.
 * Title is "Chat: <user message (60 chars)>" — more reliable than description
 * (inflated with persona + context memories).
 */
const CAPABLE_MSG_PATTERNS = [
  /\b(architect|redesign|review|design|audit|anali[zs]|investigar?|research)\b/i,
  /\b(compara|evalúa|estrategia|planifica)\b/i,
];

function computeMessagingTier(title: string, _description: string): ModelTier {
  const text = title.replace(/^Chat:\s*/, "");
  const wordCount = text.split(/\s+/).length;

  // Research/architecture signals in the user message → capable
  // Only check title (user text), not description (inflated system prompt)
  if (CAPABLE_MSG_PATTERNS.some((p) => p.test(text))) return "capable";

  // Very short messages → flash (greetings, confirmations, single-word)
  if (wordCount <= 5) return "flash";

  return "standard";
}

/**
 * Runner routing for coding vs challenging-reasoning tasks (2026-06-19).
 *
 * Two orthogonal axes drive non-fast routing, detected from the user's own words:
 *   1. CODING tasks (write/modify/ship code) → `nanoclaw` — the SAME Prometheus
 *      plan-execute-reflect loop as heavy, but **containerized** (sandboxed),
 *      with the repo mounted + coding tools. INVARIANT: every coding task runs
 *      sandboxed, so the coding check takes precedence over everything else.
 *   2. CHALLENGING non-coding requests (architecture, deep research/analysis,
 *      strategy, multi-option evaluation) → `heavy` — in-process PER reasoning;
 *      hard, but no sandbox needed.
 *   Everything else → `fast`.
 *
 * For messaging the detection text is the TITLE (the clean user message; the
 * description is persona/memory-inflated and false-positives). Bilingual EN/ES.
 *
 * History: task 6511 (a chat coding task) landed on `fast` — under-provisioned
 * AND un-sandboxed. First fix escalated build/ship chats to heavy; this revision
 * routes ALL coding to the nanoclaw sandbox and reserves heavy for hard
 * non-coding reasoning. Kill switch (messaging only):
 * MESSAGING_HEAVY_ESCALATION=false → messaging reverts to fast-for-all.
 */

// Plan→ship lifecycle markers — a "plan ... and execute/commit" chat is a code
// change even with no code noun (task 6511).
const PLAN_PATTERNS: readonly RegExp[] = [
  /\bplan\s+(and|para|to|y)\b/i, // "plan and execute", "plan para el cambio"
  /\bhaz\s+un\s+plan\b/i, // ES imperative "haz un plan ..."
];
// Ship/lifecycle verbs. A LONE "commit and push" operates on the HOST working
// tree (which nanoclaw mounts read-only), so ship verbs only mark coding via the
// plan→ship co-occurrence below — never on their own.
const MSG_SHIP_PATTERNS: readonly RegExp[] = [
  /\bexecute\b|\bej[eé]c[uú]ta/i, // execute / ejecuta / ejécuta / ejecútalo
  /\bcommit(?:s|ted|ting|ea|eo|ear)?\b/i, // NOT ES "comité"/"comitiva"/"commitment"
  /\bpush\b/i,
  /\bdeploy\b|\bdespliega/i,
  /\bship[- ]?it\b/i,
];

// "codebase"/"código" unambiguously name source code — a strong noun. But it is
// verb-BLIND: it marks AUTHORING only alongside an authoring action. A task that
// READS / EXTRACTS / EXPLAINS / TRANSLATES-to-a-human-language code is research,
// NOT authoring, and must NOT reach the authoring-only nanoclaw sandbox (see
// `isCodeReadOrExplainTask`). Kept as its OWN const so that guard can exclude it
// from the "is there an authoring signal?" check. (Misroute 2026-06-26: "Extrae
// el código y traduce al español lo que se visualiza" → nanoclaw → 0 output.)
const CODE_NOUN_STRONG = /\b(codebase|c[oó]digo)\b/i;

// Any single strong signal means "this is code-authoring work".
const STRONG_CODING_PATTERNS: readonly RegExp[] = [
  /\b(refactor|refactoriza|debug|depura|hotfix)\b/i,
  /\bship[- ]?it\b/i,
  // git is unambiguous; "merge" only with a code context (NOT "merge the cells")
  /\bgit\b|\bpull request\b|\bmerge\s+(branch|conflict|request|main|master|rama)\b/i,
  // "PR" (pull-request abbreviation) is matched CASE-SENSITIVELY on its own —
  // NOT folded into the /i pattern above. With /i, a 60-char-truncated Spanish
  // word ("precio"→"pr", "propuesta"→"pr", "primero"→"pr") false-matches \bPR\b
  // and misroutes a plain chat to the mission-control-only nanoclaw sandbox,
  // which then fails it (UUUU investment-thesis question → "[Task failed]",
  // 2026-07-06). Real pull requests are written "PR"; lowercase "pr" is never a
  // coding signal. See feedback_truncated_title_pr_misroute.
  /\bPR\b/,
  // A LONE "repo"/"repositorio" is NOT here: in chat, "guarda esto en el repo"
  // means save to the KB/project store (host-only jarvis_file_write), not
  // authoring code — forcing it to nanoclaw (no KB tools) silently evaporated the
  // save (task 6548, 2026-06-20). "repo" stays in CODING_NOUN, so a verb×noun
  // pairing ("fix the repo", "edit the repo config") still routes coding correctly.
  CODE_NOUN_STRONG,
];
// A source-file path/name → almost certainly code work regardless of the verb
// ("tighten the regex in scope.ts", "edit users.sql"). Robust against the
// verb/noun lists missing a synonym.
const FILENAME_PATTERN =
  /[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|sql|json|ya?ml|sh)\b/i;
// Coding verb + code-noun co-occurrence: "fix the login flow" / "rename the
// function" / "bump the dependency" → code; "write an email" / "build a
// strategy" → not. Lists are broad — incremental edits use many verbs/nouns.
const CODING_VERB =
  /\b(implement|implementa|code|codifica|programa|write|escribe|edit|edita|add|a[ñn]ade|agrega|create|crea|build|construye|fix|arregla|corrige|develop|desarrolla|update|actualiza|rename|renombra|modify|modifica|change|cambia|remove|elimina|quita|delete|borra|bump|tighten|ajusta|wire|optimi[sz]e|optimiza|configure|configura|port|migrate|migra|rewrite|reescribe|extend|extiende|parse|parsea|handle|maneja|patch|parchea)\b/i;
// NOTE: "repo"/"repositorio" is deliberately NOT a coding noun. In chat it is
// ambiguous between a git repository and the KB/project store, so a verb×repo
// pairing ("agrega esto al repo", "add this to the repo") is just as likely a
// host-only KB save as code work — routing it to the nanoclaw sandbox (which
// can't reach the KB) silently loses the save (task 6548, 2026-06-20). Genuine
// code work carries a more specific noun (function/file/bug/test/branch/…) or a
// strong signal (git/refactor/filename). "branch"/"rama" stay — they're code-only.
const CODING_NOUN =
  /\b(function|funci[oó]n|method|m[eé]todo|class|clase|file|archivo|script|module|m[oó]dulo|component|componente|endpoint|api|route|ruta|tests?|prueba|bug|branch|rama|migration|migraci[oó]n|schema|esquema|feature|funcionalidad|patch|parche|dependenc\w*|service|servicio|flow|flujo|column|columna|field|campo|hook|handler|query|consulta|validation|validaci[oó]n|regex|import|config|configuraci[oó]n|table|tabla|interface|interfaz|enum|constant\w*|constante|variable|helper|util\w*|hash|webhook|linter|pipeline|vulnerabilit\w*)\b/i;

/** True when the user's text is a coding task (→ sandboxed nanoclaw). */
export function isCodingTask(text: string): boolean {
  const t = text.replace(/^Chat:\s*/, "");
  return (
    STRONG_CODING_PATTERNS.some((p) => p.test(t)) ||
    FILENAME_PATTERN.test(t) ||
    (CODING_VERB.test(t) && CODING_NOUN.test(t)) ||
    (PLAN_PATTERNS.some((p) => p.test(t)) &&
      MSG_SHIP_PATTERNS.some((p) => p.test(t)))
  );
}

// A coding task that names a sibling repo under /root/claude — anything other than
// the mission-control checkout — cannot run in the nanoclaw sandbox. That container
// only mounts /root/claude/mission-control (read-only) and clones IT to /workspace,
// so git/file ops on e.g. /root/claude/thewilliamsradar-journal hit a path that isn't
// in the container: they fail outright ("Read-only file system") or, worse, "succeed"
// against the throwaway clone without ever landing on the host. Such tasks must stay
// on a HOST runner (fast/heavy/swarm), where the repo physically exists and
// shell_exec / git_* are allowlisted for it. (Williams Journal publish regression,
// 2026-06-20 — the W25 commit was routed to nanoclaw and silently never landed.)
// The leading [a-z0-9] guard makes a bare "/root/claude/..." ellipsis NOT match.
// The lookahead only exempts `mission-control` followed by `/`, whitespace, or EOL,
// so a hypothetical `/root/claude/mission-control-worktree` would read as foreign —
// the SAFE direction (it just loses the sandbox and runs on a host runner that can
// still reach it), and no such sibling dir exists today.
const FOREIGN_REPO_PATH =
  /\/root\/claude\/(?!mission-control(?:[/\s]|$))[a-z0-9][a-z0-9._-]*/i;

/**
 * True when the text references a `/root/claude/<repo>` path that is NOT the
 * mission-control checkout — i.e. a repo the nanoclaw sandbox cannot reach.
 */
export function targetsForeignRepo(text: string): boolean {
  return FOREIGN_REPO_PATH.test(text);
}

/**
 * True when the text mentions a registered NON-mission-control project by slug
 * or name. Operators reference a sibling repo by name far more often than by
 * literal path — "termina la landing de EurekaMS", not
 * "/root/claude/EurekaMS-Landing" — so `targetsForeignRepo` (path-only) misses
 * them and the coding task wrongly routes to the mission-control-only nanoclaw
 * sandbox, where the agent confabulates edits to mc's OWN source (2026-06-24
 * EurekaMS-Landing incident). This catches the named case; the runner-side
 * sandbox-scope guard catches the rest. `names` are pre-lowercased slugs/names
 * of non-mc projects (length-gated ≥4 by the resolver) — matched on a
 * non-alphanumeric word boundary so "eurekams" does not match inside
 * "eurekamsxyz".
 */
export function referencesForeignProject(
  text: string,
  names: readonly string[] | undefined,
): boolean {
  if (!names || names.length === 0) return false;
  const t = text.toLowerCase();
  return names.some((raw) => {
    const name = raw.trim().toLowerCase();
    if (name.length < 4) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(t);
  });
}

// An EXTERNAL / out-of-sandbox web target. Two families: a URL/web-domain, and
// rendered-content phrasing ("lo que se visualiza", "del sitio", "de la página").
// The nanoclaw sandbox mounts ONLY mission-control, so a coding task whose subject
// is code FROM an external website has nothing to author there.
const WEB_URL_OR_DOMAIN =
  /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]{2,}\.(io|com|net|org|app|dev|ai|co|cloud|xyz|info|site|mx|es)\b/i;
const RENDERED_CONTENT =
  /\blo que se (visualiza|ve|muestra|renderiza|despliega)\b|\ben pantalla\b|\bdel sitio\b|\bde la (p[áa]gina|web)\b|\bsitio web\b|\bla demo\b|\bwhat(?:'s| is) (displayed|shown|rendered)\b|\bon the (site|page|website)\b/i;
// Bare code NOUN — stripped before the authoring-verb test so EN "code" (a noun
// here) is not mistaken for the verb "code" in `CODING_VERB`.
const CODE_NOUN_BARE = /\b(c[oó]digo|codebase|code)\b/gi;
// Authoring verbs that `CODING_VERB` misses: JS `\b` is ASCII-only so accented
// Spanish clitic imperatives don't match the bare stems (arréglalo/corrígelo/
// optimízalo/…), plus a few list gaps (mejora/simplifica/convierte/improve). Stem
// + `\w*` so the clitic suffix (-lo/-melo) is absorbed. (qa-W1, 2026-06-26.)
const AUTHORING_VERB_EXTRA =
  /\b(arr[ée]gl|corr[íi]g|ed[íi]t|optim[íi]z|modif[íi]c|ren[óo]mbr|reescrib|parch|simplif|mejor|conv[ie]rt|improv|convert)\w*/i;

/**
 * True when a coding task's subject is code FROM an EXTERNAL website — a target
 * the nanoclaw sandbox (mission-control-only) cannot reach. Keyed on the
 * OUT-OF-SANDBOX TARGET, NOT on read-vs-author: reading/explaining mission-
 * control's OWN code is fine on nanoclaw, so this fires only on an external
 * signal. An exclusion on the nanoclaw gate, exactly like `targetsForeignRepo` /
 * `referencesForeignProject`. (Misroute 2026-06-26: "Extrae el código y traduce
 * al español lo que se visualiza" re wilab.io → nanoclaw → 0 output; the message
 * carried no `/root/claude` path or project name, so the foreign guards could
 * not fire.)
 *
 * Precision (the danger is a false-positive that strips the sandbox from real
 * authoring): it fires ONLY with an external signal AND no local source-file/path
 * AND no authoring verb — so "implementa un cliente para https://stripe.com"
 * (write LOCAL code that calls an external API) stays on nanoclaw, and a filename
 * INSIDE a web URL doesn't count as a local file.
 */
export function referencesExternalWebTarget(text: string): boolean {
  const t = text.replace(/^Chat:\s*/, "");
  const hasWebUrl = WEB_URL_OR_DOMAIN.test(t);
  if (!hasWebUrl && !RENDERED_CONTENT.test(t)) return false;
  // A LOCAL source-file path (or foreign /root/claude path) ⇒ "edit local code"
  // = real authoring — UNLESS a web URL/domain is present (a filename inside it,
  // e.g. example.com/app.js, is part of the target, not a local file — qa-W2).
  if (!hasWebUrl && (FILENAME_PATTERN.test(t) || FOREIGN_REPO_PATH.test(t))) {
    return false;
  }
  // An authoring verb ⇒ write LOCAL code (e.g. a client for that API) → keep
  // nanoclaw. Strip the bare code-noun first so EN "code" (noun) ≠ verb "code".
  const stripped = t.replace(CODE_NOUN_BARE, " ");
  const authoring =
    STRONG_CODING_PATTERNS.some((p) => p !== CODE_NOUN_STRONG && p.test(t)) ||
    CODING_VERB.test(stripped) ||
    AUTHORING_VERB_EXTRA.test(t) ||
    MSG_SHIP_PATTERNS.some((p) => p.test(t));
  return !authoring;
}

// GENUINELY challenging non-coding work that needs heavy's PER loop. Deliberately
// TIGHTER than CAPABLE_MSG_PATTERNS (which tiers up the model for any research
// keyword): a bare "investiga X" / "analiza Y" stays on fast — only architecture,
// strategy, deep/comprehensive work, or explicit multi-step "analyze→recommend" /
// "compare options" reasoning escalates the RUNNER. Bilingual EN/ES.
const HEAVY_REASONING_PATTERNS: readonly RegExp[] = [
  /\barchitect\w*\b|\barquitect\w*\b/i,
  /\bredesign\b|\bredise[ñn]\w*\b/i,
  /\bdeep[- ]?(dive|analysis|research)\b|\bcomprehensive\b|\bexhaustiv\w*\b|\bthorough(ly)?\b|\ba fondo\b|\ben profundidad\b/i,
  /\bstrateg\w*\b|\bestrateg\w*\b|\broadmap\b|\bhoja de ruta\b/i,
  // multi-step: "analyze/research X and recommend/synthesize/decide/prioritize"
  /\b(analy[sz]e|anali[zc]a|evaluate|eval[uú]a|research|investiga|assess|val[oó]ra)\b[^.!?]*\b(and|y|then|luego|para)\b[^.!?]*\b(recommend|recomienda|propose|propon|decide|synthesi\w*|sinteti\w*|conclu\w*|prioriti\w*|prioriza)\b/i,
  // "compare/evaluate options/approaches/alternatives/trade-offs"
  /\b(compare|compara|evaluate|eval[uú]a|weigh|sopesa)\b[^.!?]*\b(options|opciones|approaches|enfoques|alternativ\w*|trade[- ]?offs?)\b/i,
];

/**
 * True when a NON-coding request is challenging enough to need heavy's PER loop.
 * Coding is filtered first, so e.g. "redesign" here means a non-code redesign.
 */
export function needsHeavyReasoning(text: string): boolean {
  const t = text.replace(/^Chat:\s*/, "");
  return HEAVY_REASONING_PATTERNS.some((p) => p.test(t));
}

// Fan-out detection (2026-06-20): a chat that asks to PRODUCE one artifact PER
// item of a collection ("un archivo para cada prospecto", "a report for each
// chain") is an N-way fan-out. On `fast` a single agent runs the N items
// sequentially and can exhaust its turn/token budget mid-list → silent PARTIAL
// delivery. Such tasks route to `swarm` (Prometheus decomposes the goal graph and
// fans the independent items out in parallel — validated end-to-end 2026-06-20).
//
// Requires BOTH an artifact-PRODUCE verb AND an explicit per-item quantifier, so:
//   - read/summarize "each" ("explícame cada función", "dame un resumen de cada
//     reunión") stays on fast — those verbs aren't producers;
//   - a single save with no quantifier ("guarda el reporte en el repo", task 6550)
//     stays on fast;
//   - a single artifact COVERING a collection ("crea un resumen de todos los
//     puntos") stays on fast — "todos los" is deliberately NOT a quantifier here.
// Analysis verbs (analiza/investiga/research) are excluded: they're read-leaning
// and already escalate via needsHeavyReasoning, so they go to heavy, not a 10-agent
// swarm. Title-only (messaging detection text). Bilingual EN/ES.
const FANOUT_PRODUCE_VERB =
  /\b(crea|crear|abre|abrir|genera|generar|escribe|escribir|guarda|guardar|haz|hacer|arma|armar|prepara|preparar|redacta|redactar|construye|construir|elabora|elaborar|create|open|generate|write|save|make|build|draft|compile|produce|prepare)\b/i;
const FANOUT_QUANTIFIER =
  /\b((para|por)\s+cada\b|for\s+each\b|cada\s+uno\s+de\b|uno\s+(por|para)\s+cada\b|one\s+(per|for\s+each)\b|every\s+single\b)/i;

/** True when the text asks to produce one artifact per item of a collection. */
export function isFanOutTask(text: string): boolean {
  const t = text.replace(/^Chat:\s*/, "");
  return FANOUT_PRODUCE_VERB.test(t) && FANOUT_QUANTIFIER.test(t);
}

export function classify(input: ClassificationInput): ClassificationResult {
  // Explicit override always wins
  if (input.agentType && input.agentType !== "auto") {
    if (VALID_AGENT_TYPES.has(input.agentType as AgentType)) {
      return {
        agentType: input.agentType as AgentType,
        score: -1,
        reason: `Explicit override: ${input.agentType}`,
        explicit: true,
        modelTier: "standard",
      };
    }
  }

  const tags = new Set((input.tags ?? []).map((t) => t.toLowerCase()));
  const isMessaging = tags.has("messaging");
  // Detection text: messaging uses the clean, FULL user message — `detectionText`
  // (the untruncated inbound) when the router supplies it, else the `title`. The
  // title is truncated to 60 chars for display and a mid-word cut can forge a
  // coding signal ("precio"→"pr"), so detecting on it misroutes chats to the
  // nanoclaw sandbox (2026-07-06). Description is deliberately NOT used for
  // messaging (inflated by persona + memories → false positives). Non-messaging
  // uses title+description as before.
  const messagingText = input.detectionText ?? input.title;
  const detectText = isMessaging
    ? messagingText
    : `${input.title} ${input.description}`;
  // Kill switch scoped to messaging: MESSAGING_HEAVY_ESCALATION=false reverts
  // messaging to fast-for-all. Non-messaging routing is always active (rituals
  // set agentType explicitly and never reach here).
  const advancedRouting = process.env.MESSAGING_HEAVY_ESCALATION !== "false";

  // INVARIANT: every coding task runs in the nanoclaw sandbox (containerized
  // Prometheus PER + repo mount + coding tools). Takes precedence over the
  // messaging/score routing below so coding can never land on an in-process
  // runner. Messaging is gated by the kill switch.
  if (
    (!isMessaging || advancedRouting) &&
    isCodingTask(detectText) &&
    !referencesExternalWebTarget(detectText) &&
    !targetsForeignRepo(detectText) &&
    !referencesForeignProject(detectText, input.foreignProjectNames)
  ) {
    return {
      agentType: "nanoclaw",
      score: 4,
      reason: "coding task → nanoclaw (containerized sandbox)",
      explicit: false,
      modelTier: "capable",
    };
  }
  // A coding task whose subject is code from an EXTERNAL website
  // (`referencesExternalWebTarget`) can't be served by the mission-control-only
  // sandbox — it falls through to the HOST runners below (web/file tools).
  // (Misroute 2026-06-26.)
  // Coding task that targets a sibling repo (not mission-control) — by literal
  // path (`targetsForeignRepo`) OR by registered project name
  // (`referencesForeignProject`): the nanoclaw sandbox can't reach it, so fall
  // through to the HOST runners below (score-based → fast/heavy/swarm) where the
  // repo and git_*/shell_exec actually exist.

  if (isMessaging) {
    // Detect fan-out / heavy-reasoning / tier on the full message (`messagingText`),
    // not the truncated title — a fan-out quantifier or heavy-reasoning cue can sit
    // past char 60, and the title cut can also forge signals (see detectText above).
    const isFanOut = isFanOutTask(messagingText);
    // A per-item fan-out ("un archivo para cada prospecto") parallelizes cleanly:
    // swarm decomposes the goal graph and runs the independent items concurrently,
    // avoiding fast's silent-partial-on-budget-exhaustion (validated end-to-end
    // 2026-06-20). Killable independently via MESSAGING_SWARM_ESCALATION=false —
    // then a fan-out still escalates to heavy below (better than fast for N items).
    const swarmEnabled = process.env.MESSAGING_SWARM_ESCALATION !== "false";
    if (advancedRouting && isFanOut && swarmEnabled) {
      return {
        agentType: "swarm",
        score: 9,
        reason: "messaging fan-out → swarm (parallel per-item)",
        explicit: false,
        modelTier: "capable",
      };
    }
    // Non-coding chat: a genuinely challenging request — or a fan-out when swarm is
    // disabled — gets heavy's PER loop; everything else stays on fast (MCP tools,
    // no container).
    if (advancedRouting && (needsHeavyReasoning(messagingText) || isFanOut)) {
      return {
        agentType: "heavy",
        score: 6,
        reason: isFanOut
          ? "messaging fan-out → heavy (swarm disabled)"
          : "messaging task: challenging reasoning → heavy",
        explicit: false,
        modelTier: "capable",
      };
    }
    return {
      agentType: "fast",
      score: 0,
      reason: "messaging task → fast",
      explicit: false,
      modelTier: computeMessagingTier(messagingText, input.description),
    };
  }

  let score = 0;
  const reasons: string[] = [];
  const text = `${input.title} ${input.description}`;
  const wordCount = text.split(/\s+/).length;

  // Word count scoring
  if (wordCount > 200) {
    score += 4;
    reasons.push(`long description (${wordCount} words, +4)`);
  } else if (wordCount > 100) {
    score += 2;
    reasons.push(`medium description (${wordCount} words, +2)`);
  } else if (wordCount > 50) {
    score += 1;
    reasons.push(`moderate description (${wordCount} words, +1)`);
  }

  // Multi-step patterns (+2 each)
  for (const pattern of MULTI_STEP_PATTERNS) {
    if (pattern.test(text)) {
      score += 2;
      reasons.push(`multi-step keyword (${pattern.source}, +2)`);
    }
  }

  // Parallelism patterns (+3 each)
  for (const pattern of PARALLEL_PATTERNS) {
    if (pattern.test(text)) {
      score += 3;
      reasons.push(`parallelism keyword (${pattern.source}, +3)`);
    }
  }

  // Isolation patterns (+2 each)
  for (const pattern of ISOLATION_PATTERNS) {
    if (pattern.test(text)) {
      score += 2;
      reasons.push(`isolation keyword (${pattern.source}, +2)`);
    }
  }

  // Tag-based scoring
  if (tags.has("complex") || tags.has("research")) {
    score += 2;
    reasons.push("tag: complex/research (+2)");
  }
  if (tags.has("swarm") || tags.has("parallel")) {
    score += 3;
    reasons.push("tag: swarm/parallel (+3)");
  }

  // Priority boost
  if (input.priority === "critical") {
    score += 1;
    reasons.push("priority: critical (+1)");
  }

  // Outcome-based adjustment (multi-signal feedback from historical results)
  const outcomeAdj = getOutcomeAdjustments(input);
  if (outcomeAdj.score !== 0) {
    score += outcomeAdj.score;
    reasons.push(...outcomeAdj.reasons);
  }

  // Map score to agent type
  let agentType: AgentType;
  if (score >= 9) {
    agentType = "swarm";
  } else if (score >= 6) {
    agentType = "heavy";
  } else if (
    score >= 3 &&
    !referencesExternalWebTarget(detectText) &&
    !targetsForeignRepo(detectText) &&
    !referencesForeignProject(detectText, input.foreignProjectNames)
  ) {
    agentType = "nanoclaw";
  } else if (score >= 3) {
    // A task that scored into the sandbox range but targets a sibling
    // repo/project (by path OR name) must NOT land in the mission-control-only
    // nanoclaw sandbox — the same single-check gap the coding gate above had,
    // closed on the score path too (qa W1, 2026-06-24). Keep it on a HOST runner.
    agentType = "heavy";
  } else {
    agentType = "fast";
  }

  // Be "very aware" of challenging requests: a non-coding task with hard-
  // reasoning signals (architecture / deep research / strategy / multi-option
  // eval) that only scored into fast or nanoclaw is bumped to heavy's PER loop.
  // Coding was already routed to the sandbox above, so this is non-coding work.
  if (
    (agentType === "fast" || agentType === "nanoclaw") &&
    needsHeavyReasoning(text)
  ) {
    agentType = "heavy";
    reasons.push("challenging reasoning → heavy");
  }

  // Determine model tier based on task complexity signals
  const ARCHITECTURE_PATTERNS = [
    /\barchitect/i,
    /\bredesign/i,
    /\breview/i,
    /\bdesign/i,
    /\baudit/i,
  ];
  // High-stakes data tasks where flash-tier fabrication has burned us before.
  // 2026-05-06 task b59dbab6: a 52-word ranking question routed to flash and
  // produced 1,500 words of fabricated farmacia rankings (zero DB queries).
  // These prompts get tiered up to "capable" regardless of word count.
  // Keep the array small — each entry costs prompt tokens at runtime.
  // Exported for fast-runner.ts to inject a guard system message that forces
  // analyzer endpoint usage before web_search (regression task 9ec29034:
  // capable tier alone wasn't enough — better prose, same fabrication).
  const HIGH_STAKES_DATA_PATTERNS = HIGH_STAKES_DATA_PATTERNS_EXPORTED;
  const hasArchSignal = ARCHITECTURE_PATTERNS.some((p) => p.test(text));
  const hasHighStakesData = HIGH_STAKES_DATA_PATTERNS.some((p) => p.test(text));

  let modelTier: ModelTier;
  if (
    hasArchSignal ||
    hasHighStakesData ||
    agentType === "heavy" ||
    agentType === "swarm"
  ) {
    modelTier = "capable";
  } else if (wordCount > 100 || score >= 3) {
    modelTier = "standard";
  } else {
    modelTier = "flash";
  }
  if (hasHighStakesData) {
    reasons.push("high-stakes data prompt → tier=capable");
  }

  return {
    agentType,
    score,
    reason: reasons.length > 0 ? reasons.join("; ") : "simple task (score 0)",
    explicit: false,
    modelTier,
  };
}

/**
 * Multi-signal outcome-based adjustment for the classifier.
 *
 * Signals:
 *   1. Per-runner success rates (not just fast)
 *   2. Duration anomaly (heavy finishing too fast → over-classified)
 *   3. Cost-efficiency (expensive + low success → penalize)
 *   4. Keyword similarity (similar tasks that succeeded on a specific runner)
 *
 * Guard: returns 0 with <10 total outcomes (insufficient data).
 * Clamped to [-3, +4] to prevent wild swings.
 */
interface OutcomeAdjustment {
  score: number;
  reasons: string[];
}

function getOutcomeAdjustments(input: ClassificationInput): OutcomeAdjustment {
  const ZERO: OutcomeAdjustment = { score: 0, reasons: [] };
  try {
    const stats = queryRunnerStats(30);
    const totalOutcomes = stats.reduce((sum, s) => sum + s.total, 0);
    if (totalOutcomes < 5) return ZERO;

    let adj = 0;
    const reasons: string[] = [];

    // Signal 1: Per-runner success rates
    for (const s of stats) {
      if (s.total < 3) continue;

      if (s.ran_on === "fast") {
        if (s.success_rate > 0.85) {
          adj -= 1;
          reasons.push(
            `fast success ${(s.success_rate * 100).toFixed(0)}% → prefer fast (-1)`,
          );
        } else if (s.success_rate < 0.5) {
          adj += 2;
          reasons.push(
            `fast success ${(s.success_rate * 100).toFixed(0)}% → try heavier (+2)`,
          );
        }
      }
      if (s.ran_on === "heavy") {
        if (s.success_rate > 0.9) {
          adj += 1;
          reasons.push(
            `heavy success ${(s.success_rate * 100).toFixed(0)}% → heavy works well (+1)`,
          );
        } else if (s.success_rate < 0.4) {
          adj -= 1;
          reasons.push(
            `heavy success ${(s.success_rate * 100).toFixed(0)}% → heavy struggling (-1)`,
          );
        }
      }
    }

    // Signal 2: Duration anomaly — heavy tasks finishing very fast may be over-classified
    const heavyStats = stats.find((s) => s.ran_on === "heavy");
    if (
      heavyStats &&
      heavyStats.total >= 5 &&
      heavyStats.avg_duration_ms < 15000
    ) {
      adj -= 1;
      reasons.push(
        `heavy avg ${Math.round(heavyStats.avg_duration_ms)}ms → may be over-classified (-1)`,
      );
    }

    // Signal 3: Cost-efficiency — expensive AND low success = penalize that direction
    for (const s of stats) {
      if (s.total < 5 || s.avg_cost_usd === 0) continue;
      if (s.success_rate < 0.5 && s.avg_cost_usd > 0.05) {
        const direction = s.ran_on === "fast" ? 1 : -1;
        adj += direction;
        reasons.push(
          `${s.ran_on} costly ($${s.avg_cost_usd.toFixed(3)}/task) + low success (${direction > 0 ? "+" : ""}${direction})`,
        );
      }
    }

    // Signal 4: Keyword similarity — bias toward runner that historically succeeds on similar tasks
    const keywords = extractKeywords(input.title, input.description);
    if (keywords.length > 0) {
      const similar = queryOutcomesByKeywords(keywords, 30, 20);
      if (similar.length >= 3) {
        const runnerHits = new Map<string, { ok: number; total: number }>();
        for (const o of similar) {
          const entry = runnerHits.get(o.ran_on) ?? { ok: 0, total: 0 };
          entry.total++;
          if (o.success) entry.ok++;
          runnerHits.set(o.ran_on, entry);
        }
        // If a runner dominates success for similar tasks, gentle nudge
        for (const [runner, { ok, total }] of runnerHits) {
          if (total >= 3 && ok / total > 0.8) {
            const target = runnerScoreCenter(runner);
            if (target !== null) {
              // Nudge +-1 toward that runner's score range
              const nudge = target > 4 ? 1 : -1;
              adj += nudge;
              reasons.push(
                `similar tasks succeed on ${runner} (${ok}/${total}) (${nudge > 0 ? "+" : ""}${nudge})`,
              );
              break; // Only one keyword nudge
            }
          }
        }
      }
    }

    // Signal 5: Feedback quality — high negative rate on a tier → nudge away
    try {
      const fbStats = queryFeedbackQuality(30);
      for (const fb of fbStats) {
        if (
          fb.ran_on === "fast" &&
          fb.model_tier === "flash" &&
          fb.negative_rate > 0.15
        ) {
          adj += 1;
          reasons.push(
            `fast+flash negative ${(fb.negative_rate * 100).toFixed(0)}% → tier upgrade (+1)`,
          );
          break;
        }
      }
    } catch {
      /* non-fatal — model_tier column may not exist yet */
    }

    // Clamp to prevent wild swings
    const clamped = Math.max(-3, Math.min(4, adj));
    return { score: clamped, reasons };
  } catch {
    return ZERO;
  }
}

/** Map runner type to the center of its score range. */
function runnerScoreCenter(runner: string): number | null {
  switch (runner) {
    case "fast":
      return 1;
    case "nanoclaw":
      return 4;
    case "heavy":
      return 7;
    case "swarm":
      return 10;
    default:
      return null;
  }
}
