/**
 * Hindsight memory backend — semantic memory via Hindsight REST API.
 *
 * Features:
 * - Circuit breaker: 3 failures → 60s cooldown → retry
 * - Lazy bank creation with tailored missions/dispositions
 * - Async retain (non-blocking writes)
 * - Budget-aware recall/reflect
 * - 3-second timeout on recall (falls back to [])
 */

import { HindsightClient } from "./hindsight-client.js";
import type {
  MemoryService,
  MemoryItem,
  MemoryBank,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class HindsightMemoryBackend implements MemoryService {
  readonly backend = "hindsight" as const;
  private readonly client: HindsightClient;
  private readonly circuit: CircuitState = {
    failures: 0,
    lastFailure: 0,
    open: false,
  };
  private readonly initializedBanks = new Set<string>();

  constructor(baseUrl: string, apiKey?: string) {
    this.client = new HindsightClient(baseUrl, apiKey);
  }

  async retain(content: string, options: RetainOptions): Promise<void> {
    if (this.isCircuitOpen()) return;

    try {
      await this.ensureBank(options.bank);
      const req = {
        observation: content,
        tags: options.tags,
        async: options.async ?? true,
      };
      await this.client.retain(options.bank, req);
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    if (this.isCircuitOpen()) return [];

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.recall(options.bank, {
        query,
        budget: "low",
        tags: options.tags,
        max_results: options.maxResults ?? 10,
      });
      this.recordSuccess();
      return response.memories.map((m) => ({
        content: m.content,
        relevance: m.relevance,
        createdAt: m.created_at,
      }));
    } catch (err) {
      this.recordFailure(err);
      return [];
    }
  }

  async reflect(query: string, options: ReflectOptions): Promise<string> {
    if (this.isCircuitOpen()) return "";

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.reflect(options.bank, {
        query,
        budget: "mid",
        tags: options.tags,
      });
      this.recordSuccess();
      return response.reflection;
    } catch (err) {
      this.recordFailure(err);
      return "";
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.client.health();
      return result.status === "ok" || result.status === "healthy";
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  private isCircuitOpen(): boolean {
    if (!this.circuit.open) return false;

    const elapsed = Date.now() - this.circuit.lastFailure;
    if (elapsed >= CIRCUIT_COOLDOWN_MS) {
      // Half-open: allow one attempt
      this.circuit.open = false;
      this.circuit.failures = 0;
      console.log("[memory] Circuit breaker: half-open, retrying Hindsight");
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    if (this.circuit.failures > 0) {
      this.circuit.failures = 0;
      this.circuit.open = false;
    }
  }

  private recordFailure(err: unknown): void {
    this.circuit.failures++;
    this.circuit.lastFailure = Date.now();

    if (this.circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuit.open = true;
      console.warn(
        `[memory] Circuit breaker OPEN after ${this.circuit.failures} failures. ` +
          `Cooldown: ${CIRCUIT_COOLDOWN_MS / 1000}s. Last error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Lazy bank creation
  // -------------------------------------------------------------------------

  private async ensureBank(bankId: MemoryBank): Promise<void> {
    if (this.initializedBanks.has(bankId)) return;

    const config = BANK_CONFIGS[bankId];
    if (!config) return;

    try {
      await this.client.upsertBank(bankId, config);
      this.initializedBanks.add(bankId);
      console.log(`[memory] Bank "${bankId}" initialized`);
    } catch (err) {
      // Non-fatal — bank may already exist
      console.warn(
        `[memory] Bank "${bankId}" init warning: ${err instanceof Error ? err.message : err}`,
      );
      this.initializedBanks.add(bankId); // Don't retry
    }
  }
}

// ---------------------------------------------------------------------------
// Bank configurations
// ---------------------------------------------------------------------------

const BANK_CONFIGS: Record<
  MemoryBank,
  { mission: string; disposition: string }
> = {
  "mc-operational": {
    mission:
      "Store and retrieve learnings from task execution — planning patterns, " +
      "tool failures, execution strategies, and reflection insights for an " +
      "autonomous AI agent orchestrator.",
    disposition:
      "Prioritize actionable, specific learnings over generic observations. " +
      "Consolidate similar execution patterns. Discard learnings that become " +
      "outdated as tools/APIs change.",
  },
  "mc-jarvis": {
    mission:
      "Remember conversations with the user across messaging sessions " +
      "(Telegram/WhatsApp). Track user preferences, active projects, " +
      "schedule, and personal context for a strategic assistant named Jarvis.",
    disposition:
      "Prioritize user preferences and active project context. " +
      "Auto-refresh when observations consolidate. Keep conversation " +
      "context relevant and timely — decay old topics.",
  },
  "mc-system": {
    mission:
      "Track infrastructure events, ritual outcomes, agent performance " +
      "metrics, and system-level observations for the Mission Control " +
      "orchestrator.",
    disposition:
      "Focus on patterns and anomalies. Consolidate routine metrics. " +
      "Retain infrastructure incidents and their resolutions long-term.",
  },
};
