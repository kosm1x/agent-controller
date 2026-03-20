/**
 * Simple keyword extraction for outcome-based classifier feedback.
 * No external deps — just stopword filtering and deduplication.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "it",
  "to",
  "in",
  "for",
  "of",
  "on",
  "at",
  "and",
  "or",
  "but",
  "not",
  "with",
  "from",
  "by",
  "as",
  "be",
  "was",
  "are",
  "been",
  "were",
  "has",
  "had",
  "have",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "how",
  "all",
  "each",
  "every",
  "any",
  "some",
  "no",
  "more",
  "most",
  "such",
  "than",
  "too",
  "very",
  "just",
  "about",
  "into",
  "over",
  "after",
  "before",
  "between",
  "through",
  "during",
  "without",
  "also",
  "then",
  "them",
  "their",
  "there",
  "here",
  "when",
  "where",
  "why",
  "its",
  "our",
  "your",
  "his",
  "her",
  "out",
  "up",
  "down",
  "new",
  "old",
  "get",
  "set",
  "use",
  "make",
  "need",
  "want",
  "please",
  "help",
]);

/**
 * Extract meaningful keywords from task title and description.
 * Returns up to 8 lowercase, deduplicated, non-stopword terms (3+ chars).
 */
export function extractKeywords(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const word of words) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    result.push(word);
    if (result.length >= 8) break;
  }

  return result;
}
