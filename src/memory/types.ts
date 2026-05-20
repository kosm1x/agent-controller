/**
 * Memory service abstraction — pluggable backend for agent memory.
 *
 * Supports retain (store), recall (search), and reflect (synthesize).
 * Backends: SQLite (fallback) and Hindsight (semantic).
 */

/** Memory bank identifiers. */
export type MemoryBank = "mc-operational" | "mc-jarvis" | "mc-system";

/**
 * Trust tiers — confidence level of a memory observation.
 * Higher tiers decay slower; lower tiers fade over weeks.
 *
 * Inspired by Memoria (matrixorigin/Memoria) trust model.
 */
export type TrustTier = 1 | 2 | 3 | 4;

/** Options for storing a memory. */
export interface RetainOptions {
  bank: MemoryBank;
  tags?: string[];
  taskId?: string;
  async?: boolean;
  /** Trust tier (1=verified, 2=inferred, 3=provisional, 4=unverified). Default: 3 */
  trustTier?: TrustTier;
  /** Who stored this memory (agent, user, ritual, system). Default: 'agent' */
  source?: string;
}

/** Options for searching memories. */
export interface RecallOptions {
  bank: MemoryBank;
  tags?: string[];
  maxResults?: number;
  /**
   * Outcome tags to drop entirely from results. Defaults to
   * DEFAULT_EXCLUDE_OUTCOMES which drops only `outcome:failed`.
   * `outcome:concerns` is no longer dropped — it gets a -0.05 score
   * penalty via OUTCOME_BIAS in outcome-bias.ts. Pass `[]` to disable
   * dropping (or use `includeFailed: true` shorthand).
   */
  excludeOutcomes?: string[];
  /**
   * Convenience for analysis tasks: when true, recall returns ALL outcome
   * classes including failures (maps to `excludeOutcomes: []`). Useful
   * for "show me what didn't work" diagnostic queries that should not be
   * silently filtered.
   */
  includeFailed?: boolean;
  /**
   * Two-tier retrieval (queue #10, 2026-05-07).
   *
   * - `undefined` (default): respects the existing
   *   `HINDSIGHT_RECALL_ENABLED` env flag and per-bank disable list. The
   *   operator-side default for new deployments is SQLite hybrid (FTS5 +
   *   embedding) for sub-second latency on every recall — flip
   *   HINDSIGHT_RECALL_ENABLED=false in `.env` to activate it. Until that
   *   flip lands, `undefined` continues to route to Hindsight on banks not
   *   explicitly disabled via HINDSIGHT_RECALL_DISABLED_BANKS.
   * - `true`: explicit opt-in to Hindsight's full pipeline including
   *   the cross-encoder reranker. Reserved for analysis-grade tasks
   *   (offline reflection, deep memory queries) where 2-5s latency is
   *   acceptable in exchange for higher rerank precision.
   * - `false`: explicit opt-out. Forces SQLite hybrid even if the
   *   global default is Hindsight.
   *
   * Bank-level disable (HINDSIGHT_RECALL_DISABLED_BANKS) still wins
   * over withRerank=true — the operator's manual circuit breaker takes
   * priority over caller intent.
   */
  withRerank?: boolean;
  /**
   * Conway Pattern 3 named recall mode (v7.7 Spine 6). Additive high-level
   * intent — `excludeOutcomes`/`includeFailed` above are the low-level
   * knobs and still take precedence when set.
   *
   * - `coherence` (default when unset): drops `outcome:failed` — the
   *   goal-supportive surface for V8.1 briefs / V8.2 proposals.
   * - `correspondence`: includes every outcome class — for retrospective
   *   audits, the S2 critic, post-mortems.
   * - `unfiltered`: debug / `mc-ctl recall` paths.
   *
   * See `src/memory/recall-mode.ts`. The resolved mode is tagged onto
   * `recall_audit.mode` for the weekly correspondence audit.
   */
  recallMode?: "coherence" | "correspondence" | "unfiltered";
}

/**
 * Default outcome tags dropped at recall time (queue #7 part 2 update).
 *
 * - `outcome:failed` — pure-failure narratives are dropped to avoid
 *   recycling them as recipes (Session 114 root cause).
 * - `outcome:concerns` — NOT dropped; gets a -0.05 score penalty via
 *   OUTCOME_BIAS so the partial signal is preserved but down-ranked.
 *   Trade-off: more surface area for the Session 114 class than full
 *   drop, but the score gap (concerns -0.05 vs success +0.10 = 0.15
 *   spread) plus the existing relevance ranking should keep concerns
 *   below higher-confidence matches in top-K.
 * - `outcome:unknown` — KEPT. Historical rows pre-2026-04-29 and
 *   pre-task retains have no outcome tag.
 */
export const DEFAULT_EXCLUDE_OUTCOMES = ["outcome:failed"] as const;

/** Options for synthesizing memories. */
export interface ReflectOptions {
  bank: MemoryBank;
  tags?: string[];
}

/** A retrieved memory item. */
export interface MemoryItem {
  content: string;
  relevance?: number;
  createdAt?: string;
  trustTier?: TrustTier;
  /** Free-form tags carried from the originating retain call. May include
   * channel ("telegram"), outcome ("outcome:success"), kind ("conversation"),
   * etc. Used by recall-side filtering on outcome:* tags. */
  tags?: string[];
}

/** Pluggable memory service interface. */
export interface MemoryService {
  /** Store a memory observation. */
  retain(content: string, options: RetainOptions): Promise<void>;

  /** Search memories by semantic similarity + keyword match. */
  recall(query: string, options: RecallOptions): Promise<MemoryItem[]>;

  /** Synthesize a reflection from stored memories. */
  reflect(query: string, options: ReflectOptions): Promise<string>;

  /** Check if the backend is operational. */
  isHealthy(): Promise<boolean>;

  /** Backend identifier. */
  readonly backend: "sqlite" | "hindsight";
}
