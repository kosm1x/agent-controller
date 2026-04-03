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

  // Messaging tasks always route to fast — they use MCP tools, not containers.
  // The description is inflated by persona + conversation memories, which would
  // cause false-positive complexity scoring. Model tier IS dynamic though.
  const tags = new Set((input.tags ?? []).map((t) => t.toLowerCase()));
  if (tags.has("messaging")) {
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

  // Determine model tier based on task complexity signals
  const ARCHITECTURE_PATTERNS = [
    /\barchitect/i,
    /\bredesign/i,
    /\breview/i,
    /\bdesign/i,
    /\baudit/i,
  ];
  const hasArchSignal = ARCHITECTURE_PATTERNS.some((p) => p.test(text));

  let modelTier: ModelTier;
  if (hasArchSignal || agentType === "heavy" || agentType === "swarm") {
    modelTier = "capable";
  } else if (wordCount > 100 || score >= 3) {
    modelTier = "standard";
  } else {
    modelTier = "flash";
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
