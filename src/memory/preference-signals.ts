/**
 * Preference signals — behavioral corrections in operator turns.
 *
 * Memory-architecture plan v2.0, Track 2 (2026-08-28). JME already extracts
 * preferences Fede STATES; it never remembered that he CORRECTED a reply
 * ("muy largo", "dame la tabla", "profundiza"), because the turns carrying
 * the correction are consumed by the nightly consolidator. `writeEpisodic`
 * runs `detectPreferenceSignal` over every USER turn and records a hit in
 * `jme_signals` (migration v5), which survives turn deletion. The rate of
 * signals per chat turn is the track's ADVISORY readout
 * (`mc-ctl jme-preferences`) — not a gate: see below for why the counter
 * over-admits, and read the stored snippets before drawing a conclusion.
 *
 * A signal is a SHORT follow-up. Long turns are task briefs — "haz un deep
 * search … resúmelo" instructs a new artifact, it corrects nothing (qa-audit
 * R1 C1: all 5 hits of the first calibration were briefs, 0 corrections) —
 * so anything over SIGNAL_MAX_TURN_CHARS is never a signal, which also keeps
 * pasted documents out of the counter. Vocabulary still cannot tell "dame
 * una lista de X" (opener) from "dame la lista" (correction of a reply):
 * replay of 5,075 distinct operator messages (`conversations`
 * source='router', untruncated) = 41 hits, 0.8%, most of them task openers.
 * The second discriminator lives in `writeEpisodic`: a signal must follow a
 * Jarvis reply within SIGNAL_FOLLOWUP_WINDOW_MS. The counter therefore
 * approximates "format/length/depth asks that follow a reply" — read the
 * snippets in `mc-ctl jme-preferences`, do not treat the number as exact.
 *
 * Pure module — no DB access, so the regex set is unit-testable on its own.
 */

export const PREFERENCE_SIGNAL_KINDS = [
  "length",
  "format",
  "depth",
  "explicit",
] as const;

export type PreferenceSignalKind = (typeof PREFERENCE_SIGNAL_KINDS)[number];

/** Turns longer than this are briefs, not corrections — never a signal. */
export const SIGNAL_MAX_TURN_CHARS = 240;

/** Stored snippet cap — enough to read the correction, not the whole turn. */
export const SIGNAL_SNIPPET_MAX = 200;

/**
 * Ordered by specificity: an explicit statement ("prefiero que me lo des en
 * una tabla") wins over the format/length words it happens to contain.
 *
 * Vocabulary comes from the operator's real correction phrasing (replay of
 * `conversations` source='router', 5,700 messages, 2026-08-28): plurals and
 * clitic forms are spelled out because `\b` treats accented letters as
 * non-word characters, so a bare stem would miss "más cortos" / "resúmelos".
 * "más contexto" / "more context" were dropped — they fire when Fede GIVES
 * context — and "elaborate" is also an adjective.
 */
const PATTERNS: ReadonlyArray<readonly [PreferenceSignalKind, RegExp]> = [
  [
    "explicit",
    /\b(?:prefiero|siempre (?:dame|quiero|pon|usa)|nunca (?:me des|pongas|uses)|de ahora en adelante|i prefer|always (?:give me|use)|never (?:give me|use)|from now on)\b/i,
  ],
  [
    "length",
    /\b(?:muy largos?|demasiado largos?|m[aá]s cortos?|m[aá]s breve|s[eé] breve|res[uú]me(?:me)?(?:l[oa]s?)?(?!\s+the\b)|en una l[ií]nea|too long|shorter|tl;?dr|too verbose)\b/i,
  ],
  [
    "format",
    /\b(?:dame (?:la|una) (?:tabla|lista)|haz una lista|en (?:una )?tablas?|en formato tabla|sin tablas?|en bullets|sin bullets|en prosa|(?:en|como) lista|as a table|in a table|use bullets|no bullets|in prose|as a list)\b/i,
  ],
  [
    "depth",
    /\b(?:profund[ií]za(?:l[oa]s?)?|profundizar|m[aá]s (?:detalles?|detallad[oa]s?|profundo)|expande|expl[ií]ca(?:me|lo)? m[aá]s|go deeper|more detail)\b/i,
  ],
];

/**
 * Returns the signal kind a USER turn carries, or null for a plain message
 * or a turn too long to be a correction.
 */
export function detectPreferenceSignal(
  text: string,
): PreferenceSignalKind | null {
  if (text.length > SIGNAL_MAX_TURN_CHARS) return null;
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) return kind;
  }
  return null;
}

/** The part of the turn that is stored alongside the signal. */
export function signalSnippet(text: string): string {
  return text.trim().slice(0, SIGNAL_SNIPPET_MAX);
}
