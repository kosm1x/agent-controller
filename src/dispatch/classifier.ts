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

export function classify(input: ClassificationInput): ClassificationResult {
  // Explicit override always wins
  if (input.agentType && input.agentType !== "auto") {
    if (VALID_AGENT_TYPES.has(input.agentType as AgentType)) {
      return {
        agentType: input.agentType as AgentType,
        score: -1,
        reason: `Explicit override: ${input.agentType}`,
        explicit: true,
      };
    }
  }

  // Messaging tasks always route to fast — they use MCP tools, not containers.
  // The description is inflated by persona + conversation memories, which would
  // cause false-positive complexity scoring.
  const tags = new Set((input.tags ?? []).map((t) => t.toLowerCase()));
  if (tags.has("messaging")) {
    return {
      agentType: "fast",
      score: 0,
      reason: "messaging task → fast",
      explicit: false,
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

  return {
    agentType,
    score,
    reason: reasons.length > 0 ? reasons.join("; ") : "simple task (score 0)",
    explicit: false,
  };
}
