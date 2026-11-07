/**
 * FTS term helpers shared by the recall floor (sqlite-backend.ts) and the
 * tombstones (tombstones.ts): keywords, FTS5 unicode61 tokens, rare-term
 * candidates, contiguous token-run matching, and the one database read both
 * share, keywordDocFrequency.
 */

import { getDatabase } from "../db/index.js";
import { extractContentTokens } from "./recall-utility.js";

/** Extract meaningful keywords from a query string for SQLite LIKE matching. */
export function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "de",
    "del",
    "en",
    "con",
    "por",
    "para",
    "que",
    "es",
    "y",
    "o",
    "a",
    "al",
    "se",
    "no",
    "su",
    "mi",
    "me",
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "in",
    "on",
    "of",
    "and",
    "or",
    "to",
    "for",
    "it",
    "at",
    "by",
    "do",
    "be",
    "he",
    "she",
    "we",
    "you",
    "what",
    "how",
    "who",
    "when",
    "where",
    "this",
    "that",
    "my",
    "your",
    "user",
    "jarvis",
    "fede",
  ]);

  // FTS5 reserved operators must be excluded — they cause syntax errors in MATCH
  const fts5Operators = new Set(["and", "or", "not", "near"]);

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w) && !fts5Operators.has(w))
    .slice(0, 6); // Cap at 6 keywords to keep queries fast
}

/** A keyword is rare when at most this share of the bank's rows contain it. */
export const RARE_DOC_SHARE = 0.02;

/** The rare-keyword document count for a bank of `bankRows` rows (never below 1). */
export function rareDocThreshold(bankRows: number): number {
  return Math.max(1, Math.ceil(RARE_DOC_SHARE * bankRows));
}

/** Tokens as the FTS5 unicode61 tokeniser cuts them: case and diacritics folded, split on anything not a letter or digit. */
export function ftsTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** At most this many code / figure candidates per query (each is one capped count). */
const MAX_CODE_TERMS = 6;

/**
 * The query's code / figure candidates, at most MAX_CODE_TERMS: every
 * whitespace-separated chunk that holds a digit or is an upper-case code
 * ("KVX-482", "3.847.215", "IVA"), of 3+ letters and digits, kept whole as
 * one phrase of its FTS tokens ("kvx 482", "3 847 215", "iva"), so a code or
 * figure is judged as itself and not by its 3-digit parts. A one-token chunk
 * that is a stop-word does not count.
 */
export function codeTermCandidates(query: string): string[] {
  const codes: string[] = [];
  for (const chunk of query.split(/\s+/)) {
    const toks = ftsTokens(chunk);
    if (toks.join("").length < 3) continue;
    const bare = chunk.replace(/[^\p{L}\p{N}]/gu, "");
    if (!/\p{N}/u.test(bare) && !/^\p{Lu}[\p{Lu}\p{N}]+$/u.test(bare)) continue;
    const one = toks.length === 1 ? toks[0] : null;
    if (one && (extractKeywords(one).length === 0 || (one.length >= 4 && extractContentTokens(one).size === 0))) continue;
    codes.push(toks.join(" "));
  }
  return codes.slice(0, MAX_CODE_TERMS);
}

/**
 * The query's candidate rare terms, each a space-joined run of FTS tokens:
 * the content tokens of the query keywords (4+ chars, stop-words out), then
 * its codeTermCandidates.
 */
export function rareTermCandidates(query: string): string[] {
  const out = new Set<string>(extractContentTokens(extractKeywords(query).join(" ")));
  for (const c of codeTermCandidates(query)) out.add(c);
  return [...out];
}

/** True when `toks` hold one of the token runs, contiguous. */
export function hasTokenRun(toks: readonly string[], runs: readonly string[][]): boolean {
  return runs.some((run) => {
    for (let i = 0; i + run.length <= toks.length; i++) {
      if (run.every((t, j) => toks[i + j] === t)) return true;
    }
    return false;
  });
}

/**
 * Document frequency of each candidate rare term of `query` (rareTermCandidates)
 * in `bank`: the number of bank rows whose FTS index holds the term as a phrase,
 * counted up to `cap` when given. The CROSS JOIN keeps the FTS match as the
 * outer loop; with a plain JOIN the planner can walk the bank index and probe
 * FTS once per row (~150 ms per term on a 12k-row bank).
 */
export function keywordDocFrequency(query: string, bank: string, cap?: number): Map<string, number> {
  const db = getDatabase();
  const inner = `SELECT 1 FROM conversations_fts f CROSS JOIN conversations c ON c.id = f.rowid
                 WHERE conversations_fts MATCH ? AND c.bank = ?`;
  const stmt =
    cap === undefined
      ? db.prepare(`SELECT COUNT(*) AS n FROM (${inner})`)
      : db.prepare(`SELECT COUNT(*) AS n FROM (${inner} LIMIT ?)`);
  const out = new Map<string, number>();
  for (const term of rareTermCandidates(query)) {
    const args = cap === undefined ? [`"${term}"`, bank] : [`"${term}"`, bank, cap];
    out.set(term, (stmt.get(...args) as { n: number }).n);
  }
  return out;
}
