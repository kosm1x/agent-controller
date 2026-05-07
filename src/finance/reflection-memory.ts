/**
 * BM25 reflection memory — F7 per-agent learning loop (v7.5 L6 / A6).
 *
 * Adapted from TradingAgents `agents/utils/memory.py` + `graph/reflection.py`
 * (Apache 2.0). Each F7 specialist (macro / technical / sentiment / whale /
 * portfolio) gets an isolated bank of `(situation, lesson, pnl)` tuples.
 * After each settled trade, the post-mortem is written to the relevant
 * bank with the realized P&L. On the next decision, the top-K matching
 * past situations are retrieved and their lessons injected into the
 * specialist's prompt — closing the learning loop without RL.
 *
 * Why hand-rolled BM25 instead of `wink-bm25-text-search`:
 *   - mc invariant disallows new deps without discussion
 *   - ~50 LOC of textbook BM25 covers the use case (per-bank corpus
 *     usually <1000 entries, ~50 tokens each — naive O(N) scoring fine)
 *
 * Scoring formula (Robertson & Walker 1994, classic BM25):
 *   score(D, Q) = Σ IDF(qᵢ) · f(qᵢ,D)·(k1+1) / (f(qᵢ,D) + k1·(1 - b + b·|D|/avgdl))
 *   IDF(qᵢ)    = log((N − n(qᵢ) + 0.5) / (n(qᵢ) + 0.5) + 1)
 *
 * Defaults k1=1.5, b=0.75 (de-facto standard).
 */

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** Optional weight on the BM25 term added to the P&L kicker. */
const PNL_TIE_BREAK_WEIGHT = 0.001;

export interface ReflectionEntry {
  /** Description of the past trade context (used as the BM25 indexed text). */
  situation: string;
  /** Distilled takeaway to inject into the next prompt. */
  lesson: string;
  /** Realized P&L of the trade that produced this lesson; positive = win. */
  pnl: number;
  /** Unix-ms timestamp; only used for tie-breaking and serialization. */
  ts: number;
}

export interface ReflectionBank {
  /** Name of the F7 specialist this bank belongs to. */
  agent: string;
  entries: ReflectionEntry[];
  /**
   * Cached tokenized situations, parallel to `entries`. Rebuilt on add.
   * Held to avoid retokenizing every retrieval.
   */
  tokens: string[][];
  /**
   * Cached IDF map keyed by token. Rebuilt on add. Empty on a fresh bank.
   */
  idf: Map<string, number>;
  /** Cached average document length; recomputed on add. */
  avgDocLen: number;
}

/** Build a fresh, empty bank for an agent. */
export function createBank(agent: string): ReflectionBank {
  return {
    agent,
    entries: [],
    tokens: [],
    idf: new Map(),
    avgDocLen: 0,
  };
}

/**
 * Tokenize: lowercase, split on non-word characters, strip empties.
 *
 * Length filter:
 *   - drop single-letter tokens (mostly noise: "a", "i", stray English
 *     particles)
 *   - KEEP single-digit numerics ("5", "9") since trade postmortems
 *     reference magnitudes ("beat by 5%", "9 standard deviations")
 *     where the digit IS the load-bearing token. Audit W2 fix.
 *
 * No stopword list — short trade postmortems, stopword bias not dominant.
 * Exported for tests + callers that want to pre-validate input.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 || /^\p{N}+$/u.test(t));
}

/** Recompute IDF + avgDocLen across all entries. O(N · avgTokens). */
function rebuildIndex(bank: ReflectionBank): void {
  const N = bank.entries.length;
  if (N === 0) {
    bank.idf = new Map();
    bank.avgDocLen = 0;
    return;
  }

  // Token frequency per document → per-token doc frequency.
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const tokens of bank.tokens) {
    totalLen += tokens.length;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
  }

  // BM25 IDF: log((N - n + 0.5) / (n + 0.5) + 1) — classic, never negative
  // by construction (the "+1" inside log keeps it ≥ 0). The Math.max(0, …)
  // guard is defensive: if a future maintainer swaps in the paper-faithful
  // Robertson IDF (no "+1") that can go negative on common terms, the
  // floor here keeps `bm25Score` (which depends on `w > 0`) coherent.
  // Audit S1.
  const idf = new Map<string, number>();
  for (const [token, n] of docFreq) {
    idf.set(token, Math.max(0, Math.log((N - n + 0.5) / (n + 0.5) + 1)));
  }

  bank.idf = idf;
  bank.avgDocLen = totalLen / N;
}

/**
 * Add a reflection to the bank. Re-indexes (cheap for typical bank sizes).
 */
export function addLesson(bank: ReflectionBank, entry: ReflectionEntry): void {
  bank.entries.push(entry);
  bank.tokens.push(tokenize(entry.situation));
  rebuildIndex(bank);
}

/** Pure BM25 score for a single doc against a query token list. */
function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  idf: Map<string, number>,
  avgDocLen: number,
  k1: number,
  b: number,
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  // avgDocLen=0 means the entire bank holds zero-token docs (every
  // situation tokenized to empty). The early-return on docTokens.length
  // already covers each doc-side path that touches `lenNorm`, but the
  // explicit guard removes the divide-by-zero shape entirely so future
  // refactors that tighten the docTokens guard don't reintroduce NaN.
  // Audit W1.
  if (avgDocLen === 0) return 0;
  // Term-frequency map for the doc.
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  const docLen = docTokens.length;
  // Length-normalization denominator constant (per-token).
  const lenNorm = 1 - b + (b * docLen) / avgDocLen;

  // Each query token contributes once even if repeated — standard BM25.
  const seen = new Set<string>();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const f = tf.get(q) ?? 0;
    if (f === 0) continue;
    const w = idf.get(q) ?? 0;
    if (w <= 0) continue;
    score += (w * f * (k1 + 1)) / (f + k1 * lenNorm);
  }
  return score;
}

export interface RetrieveOptions {
  k1?: number;
  b?: number;
  /** Set to true to break BM25 ties by realized P&L (winners surface first). */
  preferWinners?: boolean;
}

/**
 * Retrieve the top-K most relevant lessons for the query. Always returns
 * an array of length ≤ K; never returns documents with zero BM25 score.
 *
 * @param bank   the per-agent bank
 * @param query  free-text description of the current trade context
 * @param k      max lessons to return (typically 2 for prompt injection)
 */
export function retrieveTop(
  bank: ReflectionBank,
  query: string,
  k: number,
  options: RetrieveOptions = {},
): ReflectionEntry[] {
  if (k <= 0 || bank.entries.length === 0) return [];

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;

  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < bank.entries.length; i++) {
    const score = bm25Score(
      qTokens,
      bank.tokens[i]!,
      bank.idf,
      bank.avgDocLen,
      k1,
      b,
    );
    if (score <= 0) continue;
    const tweak = options.preferWinners
      ? PNL_TIE_BREAK_WEIGHT * bank.entries[i]!.pnl
      : 0;
    scored.push({ idx: i, score: score + tweak });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => bank.entries[s.idx]!);
}

/** Number of entries currently held. */
export function bankSize(bank: ReflectionBank): number {
  return bank.entries.length;
}

/**
 * Format the top-K lessons into a prompt-injectable block. Convention:
 * a blank line between the header and entries lets it slot cleanly into
 * a system prompt after the agent's persona.
 *
 *   "Past lessons for <agent>:
 *     - <lesson 1>
 *     - <lesson 2>"
 *
 * Returns empty string when no lessons retrieved (caller can omit the
 * section without trailing whitespace).
 */
export function formatLessonsBlock(
  agent: string,
  lessons: readonly ReflectionEntry[],
): string {
  if (lessons.length === 0) return "";
  const bullets = lessons.map((l) => `- ${l.lesson}`).join("\n");
  return `Past lessons for ${agent}:\n${bullets}`;
}

/**
 * Serialize a bank to JSON. Used for SQLite-backed persistence; the
 * bank's BM25 caches are NOT serialized (they're rebuilt on import).
 */
export function serializeBank(bank: ReflectionBank): string {
  return JSON.stringify({ agent: bank.agent, entries: bank.entries });
}

/**
 * Deserialize a bank from JSON. Rebuilds the BM25 index from scratch.
 * Throws on malformed input.
 */
export function deserializeBank(json: string): ReflectionBank {
  const parsed = JSON.parse(json) as {
    agent?: string;
    entries?: ReflectionEntry[];
  };
  if (!parsed.agent || !Array.isArray(parsed.entries)) {
    throw new Error("deserializeBank: missing agent or entries field");
  }
  const bank = createBank(parsed.agent);
  for (const e of parsed.entries) {
    if (
      typeof e.situation !== "string" ||
      typeof e.lesson !== "string" ||
      typeof e.pnl !== "number" ||
      typeof e.ts !== "number"
    ) {
      throw new Error(
        "deserializeBank: malformed entry (need situation/lesson/pnl/ts)",
      );
    }
    addLesson(bank, e);
  }
  return bank;
}

/**
 * Per-agent registry — convenience over a bare Map. Lazy-creates banks
 * on first access so callers don't have to pre-register specialists.
 */
export class ReflectionRegistry {
  private banks = new Map<string, ReflectionBank>();

  bank(agent: string): ReflectionBank {
    let b = this.banks.get(agent);
    if (!b) {
      b = createBank(agent);
      this.banks.set(agent, b);
    }
    return b;
  }

  agents(): string[] {
    return Array.from(this.banks.keys()).sort();
  }

  /** Total entries across all banks. */
  totalEntries(): number {
    let n = 0;
    for (const b of this.banks.values()) n += b.entries.length;
    return n;
  }
}
