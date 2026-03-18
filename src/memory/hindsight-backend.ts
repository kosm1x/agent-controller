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
import { SqliteMemoryBackend } from "./sqlite-backend.js";
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
  private readonly sqliteFallback = new SqliteMemoryBackend();

  constructor(baseUrl: string, apiKey?: string) {
    this.client = new HindsightClient(baseUrl, apiKey);
  }

  async retain(content: string, options: RetainOptions): Promise<void> {
    if (this.isCircuitOpen()) {
      // Hindsight down — write to SQLite so conversations aren't lost
      console.log(
        "[memory] Hindsight circuit open — retain falling back to SQLite",
      );
      await this.sqliteFallback.retain(content, options);
      return;
    }

    try {
      await this.ensureBank(options.bank);
      await this.client.retain(options.bank, {
        content,
        tags: options.tags,
        async: options.async ?? true,
      });
      this.recordSuccess();
    } catch (err) {
      this.recordFailure(err);
      // Write to SQLite on failure so the exchange is not lost
      await this.sqliteFallback.retain(content, options);
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    if (this.isCircuitOpen()) {
      // Hindsight down — fall back to SQLite keyword recall
      console.log(
        "[memory] Hindsight circuit open — recall falling back to SQLite",
      );
      return this.sqliteFallback.recall(query, options);
    }

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.recall(options.bank, {
        query,
        budget: "low",
        tags: options.tags,
      });
      this.recordSuccess();
      return response.results.map((r) => ({
        content: r.text,
      }));
    } catch (err) {
      this.recordFailure(err);
      // Fall back to SQLite on failure
      return this.sqliteFallback.recall(query, options);
    }
  }

  async reflect(query: string, options: ReflectOptions): Promise<string> {
    if (this.isCircuitOpen()) return "";

    try {
      await this.ensureBank(options.bank);
      const response = await this.client.reflect(options.bank, {
        query,
        budget: "mid",
      });
      this.recordSuccess();
      return response.text;
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
  {
    reflect_mission: string;
    retain_mission: string;
    observations_mission: string;
  }
> = {
  "mc-operational": {
    reflect_mission:
      "Synthesize learnings from AI agent task execution — planning patterns, " +
      "tool failures, execution strategies, and reflection insights.",
    retain_mission:
      "Extract actionable learnings from task execution. Focus on tool usage patterns, " +
      "error recovery strategies, and planning decisions. Ignore generic status updates.",
    observations_mission:
      "Consolidate similar execution patterns. Discard learnings that become " +
      "outdated as tools/APIs change. Prioritize specifics over generalities.",
  },
  "mc-jarvis": {
    reflect_mission:
      "Recall and synthesize conversations with the user (Fede) across messaging sessions. " +
      "Track preferences, active projects, schedule, and personal context.",
    retain_mission:
      "Extract user preferences, project updates, task changes, and conversation context. " +
      "Always include who said what and any decisions made.",
    observations_mission:
      "Prioritize user preferences and active project context. " +
      "Keep conversation context relevant and timely — decay old topics.",
  },
  "mc-system": {
    reflect_mission:
      "Analyze infrastructure events, ritual outcomes, and agent performance " +
      "for the Mission Control orchestrator.",
    retain_mission:
      "Extract infrastructure events, ritual results, and system anomalies. " +
      "Include timestamps and error details.",
    observations_mission:
      "Focus on patterns and anomalies. Consolidate routine metrics. " +
      "Retain infrastructure incidents and their resolutions long-term.",
  },
};
