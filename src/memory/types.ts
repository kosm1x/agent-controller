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
}

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
