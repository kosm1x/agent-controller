/**
 * Feedback signal detection — analyzes short follow-up messages
 * to determine implicit user satisfaction signals.
 *
 * Signals:
 * - positive: "gracias", "perfecto", "exacto", etc.
 * - negative: "no", "incorrecto", "mal", "otra vez", etc.
 * - rephrase: short message that overlaps significantly with previous (>40% words)
 * - neutral: no detectable signal
 *
 * Short feedback-like messages (< 15 words with a signal) can be intercepted
 * by the router to avoid spawning a full task for a simple "gracias".
 */

const POSITIVE_PATTERNS = /^(excelente)\b/i;

const NEGATIVE_PATTERNS =
  /^(no[, ]|no$|incorrecto|mal\b|error\b|otra vez|no es\b|equivocado|eso no|tampoco|nope)/i;

/** Strip WhatsApp group metadata prefix "[Grupo: ..., De: ...]\n" from message text. */
function stripGroupPrefix(text: string): string {
  return text.replace(/^\[Grupo:.*?\]\n?/i, "").trim();
}

/** Explicit feedback signals detected from user message text. */
export type FeedbackSignal = "positive" | "negative" | "rephrase" | "neutral";

/** All feedback signal types including implicit (scope-transition-based). */
export type AnyFeedbackSignal =
  | FeedbackSignal
  | "implicit_positive"
  | "implicit_rephrase";

/**
 * Detect feedback signal from message text.
 */
export function detectFeedbackSignal(
  text: string,
  previousMessage?: string,
): FeedbackSignal {
  const trimmed = stripGroupPrefix(text);

  if (POSITIVE_PATTERNS.test(trimmed)) return "positive";
  if (NEGATIVE_PATTERNS.test(trimmed)) return "negative";

  // Check for rephrase: high word overlap with previous message
  if (previousMessage && isRephrase(trimmed, previousMessage)) {
    return "rephrase";
  }

  return "neutral";
}

/**
 * Is this message short enough and signal-bearing to be pure feedback
 * rather than a new command? If true, the router can skip task creation.
 */
export function isFeedbackMessage(text: string): boolean {
  const trimmed = stripGroupPrefix(text);
  const wordCount = trimmed.split(/\s+/).length;

  // Only intercept very short messages with clear signal
  if (wordCount > 8) return false;

  return POSITIVE_PATTERNS.test(trimmed) || NEGATIVE_PATTERNS.test(trimmed);
}

/**
 * Detect implicit satisfaction by comparing scope transitions between messages.
 *
 * - Topic change → implicit positive (user moved on, previous task was satisfactory)
 * - Same topic continuation → implicit positive (user is building on the result)
 * - Rephrase of same request → implicit negative (user is retrying)
 *
 * Returns a signal only when confidence is high enough. "neutral" = no inference.
 */
export function detectImplicitFeedback(
  currentGroups: Set<string>,
  previousGroups: Set<string>,
  currentMessage: string,
  previousMessage: string,
): FeedbackSignal {
  // Skip if either has no scope (generic messages)
  if (currentGroups.size === 0 || previousGroups.size === 0) return "neutral";

  // Rephrase check (highest priority — user is retrying the same thing)
  if (isRephrase(currentMessage, previousMessage)) return "rephrase";

  // Topic change: current groups have NO overlap with previous → implicit positive
  const hasOverlap = [...currentGroups].some((g) => previousGroups.has(g));
  if (!hasOverlap) return "positive";

  // Same topic continuation without complaint → stay neutral
  // (explicit positive/negative detection in detectFeedbackSignal handles the rest)
  return "neutral";
}

/** Check if text is a rephrase of previous (>40% word overlap, both short). */
function isRephrase(current: string, previous: string): boolean {
  const curWords = new Set(
    current
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const prevWords = new Set(
    previous
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  if (curWords.size < 3 || prevWords.size < 3) return false;

  let overlap = 0;
  for (const w of curWords) {
    if (prevWords.has(w)) overlap++;
  }

  return overlap / Math.min(curWords.size, prevWords.size) > 0.4;
}
