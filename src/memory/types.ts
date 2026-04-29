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
   * Outcome tags to exclude from results. Defaults to DEFAULT_EXCLUDE_OUTCOMES
   * which drops `outcome:concerns` and `outcome:failed` — closes the Session
   * 114 poison-source class. Pass `[]` to disable filtering.
   */
  excludeOutcomes?: string[];
}

/**
 * Default outcome tags filtered out at recall time.
 * - `outcome:concerns` was the literal Session 114 incident class
 *   (a `completed_with_concerns` task whose body narrated a failure)
 * - `outcome:failed` is unreachable via the current retain wiring (router's
 *   handleTaskFailed doesn't retain) but documented for future-proofing
 * - `outcome:unknown` is intentionally KEPT in default — most historical rows
 *   pre-2026-04-29 lack the tag, and pre-task retains (positive feedback,
 *   fast-path) have no taskId so will tag as unknown
 */
export const DEFAULT_EXCLUDE_OUTCOMES = [
  "outcome:concerns",
  "outcome:failed",
] as const;

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
