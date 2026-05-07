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
