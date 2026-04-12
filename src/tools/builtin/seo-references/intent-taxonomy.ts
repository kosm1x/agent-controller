/**
 * Search intent taxonomy — pure rules for classifying keywords by user intent.
 *
 * Four categories (Google's classic model):
 * - informational: user wants to learn something
 * - navigational: user wants to reach a specific site/brand
 * - commercial: user is researching before a purchase
 * - transactional: user is ready to buy/sign up/download
 *
 * Adapted from nowork-studio/toprank keyword-intent-taxonomy.md (MIT).
 */

export type SearchIntent =
  | "informational"
  | "navigational"
  | "commercial"
  | "transactional";

interface IntentSignal {
  /** Regex that matches the intent. Tested against the lowercased full keyword. */
  pattern: RegExp;
  /** Relative weight (higher = stronger signal). */
  weight: number;
}

/** Signal words per intent (English + Spanish). Order matters within category. */
export const INTENT_SIGNALS: Record<SearchIntent, IntentSignal[]> = {
  informational: [
    { pattern: /\b(what|why|how|when|where|who)\b/i, weight: 3 },
    {
      pattern: /\b(qu[eé]|por qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eé]n)\b/i,
      weight: 3,
    },
    {
      pattern: /\b(guide|tutorial|learn|examples?|definition|meaning)\b/i,
      weight: 2,
    },
    {
      pattern:
        /\b(gu[ií]a|tutorial|aprender|ejemplos?|definici[oó]n|significado)\b/i,
      weight: 2,
    },
    {
      pattern: /\b(vs\.?|versus|difference between|diferencia entre)\b/i,
      weight: 2,
    },
    { pattern: /\b(ideas?|tips?|consejos?|trucos?)\b/i, weight: 1 },
  ],
  navigational: [
    { pattern: /\b(login|sign in|iniciar sesi[oó]n)\b/i, weight: 3 },
    { pattern: /\b(official|oficial|homepage|website)\b/i, weight: 2 },
    { pattern: /\b(app|download app|descargar app)\b/i, weight: 2 },
    {
      pattern:
        /\b(contact|contacto|support|soporte|help center|centro de ayuda)\b/i,
      weight: 2,
    },
  ],
  commercial: [
    { pattern: /\b(best|top|review|comparison|comparing)\b/i, weight: 3 },
    {
      pattern: /\b(mejor(?:es)?|top|rese[ñn]a|comparaci[oó]n|comparativa)\b/i,
      weight: 3,
    },
    {
      pattern: /\b(alternatives?|competitors?|alternativas?|competidores?)\b/i,
      weight: 2,
    },
    {
      pattern:
        /\b(features?|pricing|plans?|caracter[ií]sticas|precios?|planes)\b/i,
      weight: 2,
    },
    { pattern: /\b(worth it|vale la pena|is it good|es bueno)\b/i, weight: 2 },
  ],
  transactional: [
    { pattern: /\b(buy|purchase|order|comprar|ordenar|pedido)\b/i, weight: 3 },
    {
      pattern: /\b(price|precio|cost|costo|cu[aá]nto cuesta|how much)\b/i,
      weight: 3,
    },
    {
      pattern: /\b(discount|coupon|deal|descuento|cup[oó]n|oferta|promo)\b/i,
      weight: 3,
    },
    { pattern: /\b(for sale|en venta|near me|cerca de m[ií])\b/i, weight: 2 },
    {
      pattern: /\b(free trial|free download|prueba gratis|descarga gratis)\b/i,
      weight: 2,
    },
    {
      pattern: /\b(subscribe|signup|sign up|suscribirse|registrarse)\b/i,
      weight: 2,
    },
  ],
} as const;

/**
 * Classify a single keyword into a search intent by summing weighted signal matches.
 * Returns the winning intent + confidence (0-1) or "informational" as safe default.
 */
export function classifyIntent(keyword: string): {
  intent: SearchIntent;
  confidence: number;
  matched_signals: string[];
} {
  const scores: Record<SearchIntent, number> = {
    informational: 0,
    navigational: 0,
    commercial: 0,
    transactional: 0,
  };
  const matchedSignals: string[] = [];

  for (const [intent, signals] of Object.entries(INTENT_SIGNALS) as Array<
    [SearchIntent, IntentSignal[]]
  >) {
    for (const signal of signals) {
      if (signal.pattern.test(keyword)) {
        scores[intent] += signal.weight;
        matchedSignals.push(`${intent}:${signal.pattern.source}`);
      }
    }
  }

  // Pick the highest-scoring intent (default informational).
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { intent: "informational", confidence: 0, matched_signals: [] };
  }

  let winner: SearchIntent = "informational";
  let winnerScore = 0;
  for (const [intent, score] of Object.entries(scores) as Array<
    [SearchIntent, number]
  >) {
    if (score > winnerScore) {
      winner = intent;
      winnerScore = score;
    }
  }

  return {
    intent: winner,
    confidence: Math.min(winnerScore / 6, 1), // 6+ points = max confidence
    matched_signals: matchedSignals,
  };
}

/** Classify a batch of keywords at once. */
export function classifyIntents(
  keywords: string[],
): Array<{ keyword: string; intent: SearchIntent; confidence: number }> {
  return keywords.map((keyword) => {
    const result = classifyIntent(keyword);
    return {
      keyword,
      intent: result.intent,
      confidence: result.confidence,
    };
  });
}
