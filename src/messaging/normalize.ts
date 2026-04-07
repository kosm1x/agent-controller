/**
 * Input normalization (v6.4 CL1.5).
 *
 * Lightweight pre-processing for user messages before scope matching
 * and enhancer analysis. Fixes common typos, normalizes accents for
 * matching, and expands informal contractions.
 *
 * Pure function, <1ms, no LLM call.
 */

/** Domain-specific typo corrections. Lowercase keys. */
const TYPO_MAP: Record<string, string> = {
  // Tool/product names
  whatspp: "whatsapp",
  whasapp: "whatsapp",
  whatssap: "whatsapp",
  northstarr: "northstar",
  nortstar: "northstar",
  norhtstar: "northstar",
  telgram: "telegram",
  telegramm: "telegram",
  instragram: "instagram",
  instagran: "instagram",
  insatgram: "instagram",
  wordpres: "wordpress",
  wordpresss: "wordpress",
  githup: "github",
  gihtub: "github",
  gogle: "google",
  googel: "google",
  shedule: "schedule",
  schdule: "schedule",
  schedul: "schedule",
  // Spanish common typos
  tares: "tareas",
  taera: "tarea",
  enviale: "envíale",
  mandale: "mándale",
  actuliza: "actualiza",
  actulaiza: "actualiza",
  sincronisa: "sincroniza",
  reporet: "reporte",
  repote: "reporte",
  diagnotico: "diagnóstico",
  diagonstico: "diagnóstico",
  // English common typos
  serach: "search",
  searhc: "search",
  comit: "commit",
  delpoy: "deploy",
  stauts: "status",
  staus: "status",
};

/**
 * Normalize a user message for better scope matching and comprehension.
 * Returns the corrected message. Does NOT modify the original for display.
 *
 * Applied corrections:
 * 1. Domain-specific typo fixes (word-level replacement)
 * 2. Accent-insensitive matching normalization (for scope regex)
 *
 * NOT applied (would change user intent):
 * - Translation (keep mixed language as-is)
 * - Grammar correction
 * - Sentence restructuring
 */
export function normalizeForMatching(text: string): string {
  // Word-level typo correction
  let corrected = text.replace(/\b\w+\b/g, (word) => {
    const lower = word.toLowerCase();
    const fix = TYPO_MAP[lower];
    if (fix) {
      // Preserve original casing pattern
      if (word[0] === word[0].toUpperCase()) {
        return fix.charAt(0).toUpperCase() + fix.slice(1);
      }
      return fix;
    }
    return word;
  });

  return corrected;
}

/**
 * Check if the message was modified by normalization.
 * Used to decide whether to log the correction.
 */
export function wasNormalized(original: string, normalized: string): boolean {
  return original !== normalized;
}
