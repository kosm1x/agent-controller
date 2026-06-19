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

// Any single strong signal means "this is code-authoring work".
const STRONG_CODING_PATTERNS: readonly RegExp[] = [
  /\b(refactor|refactoriza|debug|depura|hotfix)\b/i,
  /\bship[- ]?it\b/i,
  // git is unambiguous; "merge" only with a code context (NOT "merge the cells")
  /\bgit\b|\bpull request\b|\bPR\b|\bmerge\s+(branch|conflict|request|main|master|rama)\b/i,
  /\b(codebase|c[oó]digo|repo|repositor\w*)\b/i,
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
const CODING_NOUN =
  /\b(function|funci[oó]n|method|m[eé]todo|class|clase|file|archivo|script|module|m[oó]dulo|component|componente|endpoint|api|route|ruta|tests?|prueba|bug|repo|branch|rama|migration|migraci[oó]n|schema|esquema|feature|funcionalidad|patch|parche|dependenc\w*|service|servicio|flow|flujo|column|columna|field|campo|hook|handler|query|consulta|validation|validaci[oó]n|regex|import|config|configuraci[oó]n|table|tabla|interface|interfaz|enum|constant\w*|constante|variable|helper|util\w*|hash|webhook|linter|pipeline|vulnerabilit\w*)\b/i;

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
  // Detection text: messaging uses the clean TITLE (description is inflated by
  // persona + memories → false positives); non-messaging uses title+description.
  const detectText = isMessaging
    ? input.title
    : `${input.title} ${input.description}`;
  // Kill switch scoped to messaging: MESSAGING_HEAVY_ESCALATION=false reverts
  // messaging to fast-for-all. Non-messaging routing is always active (rituals
  // set agentType explicitly and never reach here).
  const advancedRouting = process.env.MESSAGING_HEAVY_ESCALATION !== "false";

  // INVARIANT: every coding task runs in the nanoclaw sandbox (containerized
  // Prometheus PER + repo mount + coding tools). Takes precedence over the
  // messaging/score routing below so coding can never land on an in-process
  // runner. Messaging is gated by the kill switch.
  if ((!isMessaging || advancedRouting) && isCodingTask(detectText)) {
    return {
      agentType: "nanoclaw",
      score: 4,
      reason: "coding task → nanoclaw (containerized sandbox)",
      explicit: false,
      modelTier: "capable",
    };
  }

  if (isMessaging) {
    // Non-coding chat: a genuinely challenging request gets heavy's PER loop;
    // everything else stays on fast (MCP tools, no container).
    if (advancedRouting && needsHeavyReasoning(input.title)) {
      return {
        agentType: "heavy",
        score: 6,
        reason: "messaging task: challenging reasoning → heavy",
        explicit: false,
        modelTier: "capable",
      };
    }
    return {
      agentType: "fast",
      score: 0,
      reason: "messaging task → fast",
      explicit: false,
      modelTier: computeMessagingTier(input.title, input.description),
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
  } else if (score >= 3) {
    agentType = "nanoclaw";
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
