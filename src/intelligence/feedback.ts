/**
 * Feedback signal detection — analyzes short follow-up messages
 * to determine implicit user satisfaction signals.
 *
 * Signals:
 * - positive: "excelente" — the operator's SINGLE eval word (contract below)
 * - negative: "no", "incorrecto", "mal", "otra vez", etc.
 * - rephrase: short message that overlaps significantly with previous (>40% words)
 * - neutral: no detectable signal
 *
 * OPERATOR CONTRACT (ruled 2026-07-12): "excelente" — alone or embedded in
 * any message — is praise for Jarvis's work and reinforces the pattern that
 * produced it. It is the ONLY eval word the operator uses; do not treat other
 * praise vocabulary ("perfecto", "gracias", "genial") as an eval signal.
 * Detection is therefore anywhere-in-message, not prefix-anchored.
 *
 * Interception (skip task creation) is a SEPARATE, stricter gate: only
 * messages that are exclusively praise get swallowed — "Excelente. Ahora haz
 * X" must record the positive signal AND still execute the instruction
 * (intercept-and-swallow lesson, feedback_never_silent_reply_floor #4).
 */

const POSITIVE_PATTERNS = /\bexcelente\b/i;

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
  FeedbackSignal | "implicit_positive" | "implicit_rephrase";

/**
 * Detect feedback signal from message text.
 */
export function detectFeedbackSignal(
  text: string,
  previousMessage?: string,
): FeedbackSignal {
  const trimmed = stripGroupPrefix(text);

  // Negative first: with anywhere-matching on "excelente", a leading negation
  // ("no quedó excelente") must win over the embedded praise word.
  if (NEGATIVE_PATTERNS.test(trimmed)) return "negative";
  if (POSITIVE_PATTERNS.test(trimmed)) return "positive";

  // Check for rephrase: high word overlap with previous message
  if (previousMessage && isRephrase(trimmed, previousMessage)) {
    return "rephrase";
  }

  return "neutral";
}

/**
 * Praise vocabulary that can accompany "excelente" without turning the
 * message into a command ("excelente trabajo", "muy bien, excelente").
 */
const PRAISE_ADJUNCTS =
  /\b(excelente|trabajo|muy|bien|bueno|buen[íi]simo|gracias|perfecto|genial|bravo|crack|as[íi]|eso|es)\b/gi;

/** Articles/determiners that carry no command meaning ("excelente el fix"). */
const STOPWORDS =
  /\b(el|la|lo|los|las|un|una|unos|unas|de|del|al|ese|esa|este|esta|esto|que|qu[eé]|con|por|para|tu|su|mi)\b/gi;

/**
 * True when the message is praise and nothing else: after removing the
 * praise vocabulary and all non-letters (punctuation, emoji, digits), at
 * most one stray word remains ("excelente el fix" → "fix" → still praise).
 * Two or more leftover words = there is a payload beyond praise; the
 * message must NOT be intercepted.
 */
export function isExclusivelyPraise(text: string): boolean {
  if (!POSITIVE_PATTERNS.test(stripGroupPrefix(text))) return false;
  const leftover = stripGroupPrefix(text)
    .replace(PRAISE_ADJUNCTS, " ")
    .replace(STOPWORDS, " ")
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
  return leftover === "" || leftover.split(/\s+/).length <= 1;
}

/**
 * Is this message short enough and signal-bearing to be pure feedback
 * rather than a new command? If true, the router can skip task creation.
 *
 * Positive branch: exclusively-praise messages only (see contract above) —
 * an embedded instruction alongside "excelente" falls through to normal
 * processing while the feedback window still records the positive signal.
 */
export function isFeedbackMessage(text: string): boolean {
  const trimmed = stripGroupPrefix(text);
  const wordCount = trimmed.split(/\s+/).length;

  if (isExclusivelyPraise(trimmed)) return true;

  // Negative signals keep the original short-message gate.
  if (wordCount > 8) return false;
  return NEGATIVE_PATTERNS.test(trimmed);
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
