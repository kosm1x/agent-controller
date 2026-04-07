/**
 * Mechanical Post-Filter (v6.3 W1.5)
 *
 * Regex-based scan for AI writing patterns BEFORE delivery to Telegram.
 * No LLM inference — pure string matching. Fast and deterministic.
 *
 * Scans for:
 * - Tier 1 AI words (most egregious 20)
 * - Chatbot artifacts ("I hope this helps!", "Great question!")
 * - Reasoning chain leaks ("Let me think step by step")
 */

// ---------------------------------------------------------------------------
// Patterns to detect (not auto-replace — just flag)
// ---------------------------------------------------------------------------

const TIER1_WORDS: RegExp[] = [
  /\bdelve\b/gi,
  /\btapestry\b/gi,
  /\blandscape\b/gi,
  /\brealm\b/gi,
  /\bparadigm\b/gi,
  /\bembark\b/gi,
  /\bbeacon\b/gi,
  /\btestament to\b/gi,
  /\bseamless(?:ly)?\b/gi,
  /\bgame.changer\b/gi,
  /\bholistic(?:ally)?\b/gi,
  /\bactionable\b/gi,
  /\bimpactful\b/gi,
  /\bsynerg(?:y|ies)\b/gi,
  /\bmeticulous(?:ly)?\b/gi,
  /\bcutting.edge\b/gi,
  /\bpivotal\b/gi,
  /\brobust\b/gi,
  /\bcomprehensive\b/gi,
  /\bleverage\b/gi,
];

const CHATBOT_ARTIFACTS: RegExp[] = [
  /I hope this helps/gi,
  /Great question/gi,
  /Certainly!/gi,
  /Absolutely!/gi,
  /Feel free to reach out/gi,
  /Let me know if you need anything/gi,
  /In this article, we will explore/gi,
  /Let's dive in/gi,
  /You're absolutely right/gi,
];

const REASONING_LEAKS: RegExp[] = [
  /Let me think step by step/gi,
  /Breaking this down/gi,
  /Here's my thought process/gi,
  /First, let's consider/gi,
  /To approach this systematically/gi,
  /Step \d+:/gi,
];

const TRANSITION_FILLER: RegExp[] = [
  /\bMoreover\b/g,
  /\bFurthermore\b/g,
  /\bAdditionally\b/g,
  /\bIn conclusion\b/gi,
  /\bIn summary\b/gi,
  /\bTo summarize\b/gi,
  /\bIt's worth noting that\b/gi,
  /\bNotably\b/g,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PostFilterResult {
  /** Number of AI patterns found. */
  flagCount: number;
  /** List of matched patterns. */
  flags: string[];
  /** Original text (unmodified — filter is detect-only). */
  text: string;
}

/**
 * Scan text for AI writing patterns. Returns flag count + matched patterns.
 * Does NOT modify the text — detection only. Fast (no LLM).
 */
export function scanForAIPatterns(text: string): PostFilterResult {
  const flags: string[] = [];

  for (const re of TIER1_WORDS) {
    re.lastIndex = 0; // reset regex state
    if (re.test(text)) {
      flags.push(`Tier1: ${re.source.replace(/\\b/g, "")}`);
    }
  }

  for (const re of CHATBOT_ARTIFACTS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      flags.push(`Artifact: ${re.source}`);
    }
  }

  for (const re of REASONING_LEAKS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      flags.push(`Reasoning leak: ${re.source}`);
    }
  }

  for (const re of TRANSITION_FILLER) {
    re.lastIndex = 0;
    if (re.test(text)) {
      flags.push(`Filler: ${re.source.replace(/\\b/g, "")}`);
    }
  }

  return { flagCount: flags.length, flags, text };
}

/**
 * Log AI pattern flags if any detected (for monitoring).
 * Call before sending messages to Telegram.
 */
export function logAIPatterns(text: string, channel: string): void {
  const result = scanForAIPatterns(text);
  if (result.flagCount > 0) {
    console.log(
      `[post-filter] ${result.flagCount} AI patterns in ${channel}: ${result.flags.slice(0, 5).join(", ")}`,
    );
  }
}
