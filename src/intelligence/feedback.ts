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

export const POSITIVE_PATTERNS = /\bexcelente\b/i;

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
 * Negation vocabulary that can accompany the leading negative without
 * turning the message into an instruction. Each word, and why it is here:
 * - no, nope, tampoco — the negation itself ("no", "No, tampoco").
 * - incorrecto/incorrecta, equivocado/equivocada, mal, error — the verdict
 *   words NEGATIVE_PATTERNS anchors on, both genders ("está mal").
 * - "otra vez" — as a phrase only (another failed attempt); a lone "otra"
 *   picks an option ("No, otra") and must survive.
 * - eso, es, está, así, fue — the copula/demonstrative frame of a bare
 *   verdict ("eso no", "no es así", "no fue eso").
 * - excelente — the eval word negated ("no quedó excelente"): a verdict, and
 *   the broadcast-rating gate (router.ts broadcastRatingTarget) requires it
 *   to pass isFeedbackMessage.
 * Deliberately NOT here: "otro"/"ese"/"esto" (they pick an item), "todo"
 * ("No, todo" is an answer), and any verb or noun — a command word must
 * survive to count as payload.
 * Unicode-aware boundaries: `\b` is ASCII-only and never fires next to "á"/"í".
 */
const NEGATIVE_ADJUNCTS =
  /(?<!\p{L})(no|nope|tampoco|incorrect[oa]|equivocad[oa]|mal|error|otra\s+vez|eso|es|est[áa]|as[íi]|fue|excelente)(?!\p{L})/giu;

/**
 * Stopwords for the negative path: articles, prepositions and possessives
 * only. Unlike STOPWORDS it keeps the demonstratives (ese/esa/este/esta/esto:
 * "No, ese" picks an item) and "para" ("No, para" is a stop command).
 */
const NEGATIVE_STOPWORDS =
  /(?<!\p{L})(el|la|lo|los|las|un|una|unos|unas|de|del|al|qu[eé]|con|por|tu|su|mi)(?!\p{L})/giu;

/**
 * The closed list of single words that may remain after a negation and still
 * leave it a pure verdict. Anything else — an option ("B", "2"), a name, a
 * verb ("cancela", "sigue"), a time ("ayer") — is an answer or an instruction.
 * - sirve, funciona — "no sirve", "no funciona": the result does not work.
 * - gracias — "no gracias": a decline, nothing to run.
 * - quedó, quedo — "no quedó (excelente)": the result fell short.
 * - era — "no, eso no era": the result was not what was meant.
 * - pedí, pedi — "no es lo que pedí": the result missed the request.
 * - bien — "no está bien": a verdict on the result.
 * - así, asi — "no así": a verdict on the manner (with or without accent).
 * Compared lowercased after the accent-stripping that NFD input undergoes
 * (the combining mark is not a letter), hence both spellings.
 */
const VERDICT_WORDS = new Set([
  "sirve",
  "funciona",
  "gracias",
  "quedó",
  "quedo",
  "era",
  "pedí",
  "pedi",
  "bien",
  "así",
  "asi",
]);

/**
 * True when the message is a negation and nothing else: after removing the
 * negation vocabulary, the articles/prepositions and everything but letters
 * and digits, nothing remains, or one word from VERDICT_WORDS ("no, eso no
 * era" → "era" → still pure). Any other leftover = an answer or an
 * instruction rides on the "no" ("No encontré el archivo. Entonces A.",
 * "No, B", "No, cancela"); the message must NOT be intercepted.
 */
export function isExclusivelyNegative(text: string): boolean {
  const trimmed = stripGroupPrefix(text);
  if (!NEGATIVE_PATTERNS.test(trimmed)) return false;
  const leftover = trimmed
    .replace(NEGATIVE_ADJUNCTS, " ")
    .replace(NEGATIVE_STOPWORDS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (leftover === "") return true;
  const words = leftover.split(/\s+/);
  return words.length <= 1 && VERDICT_WORDS.has(words[0].toLowerCase());
}

/**
 * Is this message short enough and signal-bearing to be pure feedback
 * rather than a new command? If true, the router can skip task creation.
 *
 * Positive branch: exclusively-praise messages only (see contract above) —
 * an embedded instruction alongside "excelente" falls through to normal
 * processing while the feedback window still records the positive signal.
 * Negative branch: same rule via isExclusivelyNegative — "No, hazlo con B"
 * runs; the feedback window still records the negative signal upstream.
 */
export function isFeedbackMessage(text: string): boolean {
  const trimmed = stripGroupPrefix(text);
  const wordCount = trimmed.split(/\s+/).length;

  if (isExclusivelyPraise(trimmed)) return true;

  // Negative signals: the 8-word cap stays as an outer bound.
  if (wordCount > 8) return false;
  return isExclusivelyNegative(trimmed);
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
