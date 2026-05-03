/**
 * Hindsight memory backend — semantic memory via Hindsight REST API.
 *
 * Features:
 * - Circuit breaker: 3 failures → 60s cooldown → half-open probe → re-open on
 *   probe failure (failure count is sticky; only success resets it). Prevents
 *   the low-traffic dysfunction where >cooldown gaps reset the counter and
 *   every recall pays the timeout tax.
 * - Lazy bank creation with tailored missions/dispositions
 * - Async retain (non-blocking writes)
 * - Budget-aware recall/reflect
 * - 1.5s recall timeout + SQLite fallback (Hindsight agentic recall ~9s
 *   under load burned 5s/call before this audit; see
 *   docs/audit/2026-04-22-speed.md S7)
 */

import { HindsightClient } from "./hindsight-client.js";
import { SqliteMemoryBackend } from "./sqlite-backend.js";
import { logRecall } from "./recall-utility.js";
import { DEFAULT_EXCLUDE_OUTCOMES } from "./types.js";
import type {
  MemoryService,
  MemoryItem,
  MemoryBank,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";

/**
 * Filter MemoryItems whose tags include any of the excluded outcome tags.
 * Returns {kept, excluded} so callers can log + log_recall the drop count.
 */
function applyOutcomeFilter(
  items: MemoryItem[],
  options: RecallOptions,
): { kept: MemoryItem[]; excluded: number } {
  const exclude = options.excludeOutcomes ?? DEFAULT_EXCLUDE_OUTCOMES;
  if (exclude.length === 0) return { kept: items, excluded: 0 };
  const excludeSet = new Set(exclude);
  const kept = items.filter((item) => {
    const tags = item.tags ?? [];
    for (const t of tags) if (excludeSet.has(t)) return false;
    return true;
  });
  return { kept, excluded: items.length - kept.length };
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Recall path toggle (2026-04-25)
// ---------------------------------------------------------------------------
// Hindsight's agentic recall does cross-encoder reranking over the full
// candidate pool — measured 22.2s of the 22.4s end-to-end on a 244-candidate
// query. With the 1.5s client timeout, 100% of recall calls fail-fast to
// SQLite. The Hindsight call is pure 1.5s tax per turn with no upside since
// SQLite hybrid (FTS5 + embed in sqlite-backend.ts) is the path actually
// answering prompts.
//
// HINDSIGHT_RECALL_ENABLED defaults to "false". Set to "true" once Hindsight's
// reranker latency is fixed upstream. Retain/reflect/bank ops are unaffected
// — only the user-facing recall path bypasses Hindsight.
function isRecallPathEnabled(): boolean {
  return process.env.HINDSIGHT_RECALL_ENABLED === "true";
}

// HINDSIGHT_RECALL_DISABLED_BANKS — CSV of bank IDs whose recall path skips
// Hindsight regardless of the global flag (V8 substrate follow-up,
// 2026-05-03). Surgical demote primitive for the per-bank H/D/R verdict
// approach: HARDEN one bank while DEMOTING another. Born from the trilogy
// validation showing mc-jarvis at 1,637 mems suffered reranker collapse
// (4/15 success vs SQLite 30/30) while mc-operational at 69 mems was
// fully recovered (15/15). The global enable flag couldn't capture the
// per-bank verdict — this can.
//
// Evaluated on every recall (sub-microsecond), so operator changes take
// effect on next request after `systemctl restart mission-control`.
// Retain/reflect remain on Hindsight on disabled banks — the bank is not
// abandoned, just exempted from the recall-time tax.
function getDisabledBanks(): Set<string> {
  const csv = process.env.HINDSIGHT_RECALL_DISABLED_BANKS;
  if (!csv) return new Set();
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function isBankDisabled(bank: string): boolean {
  return getDisabledBanks().has(bank);
}

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
  // True while a half-open probe is in-flight. Concurrent recalls in the
  // same tick must NOT all be treated as probes — only the first one races
  // through; siblings see this flag and short-circuit. Cleared by
  // recordSuccess/recordFailure when the probe completes.
  probeInFlight: boolean;
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
    probeInFlight: false,
  };
  private readonly initializedBanks = new Set<string>();
  private readonly sqliteFallback = new SqliteMemoryBackend();

  constructor(baseUrl: string, apiKey?: string) {
    this.client = new HindsightClient(baseUrl, apiKey);
  }

  async retain(content: string, options: RetainOptions): Promise<void> {
    // ALWAYS dual-write to SQLite — it's the source of truth for conversation
    // thread continuity. Hindsight async writes are fire-and-forget and can
    // silently fail without triggering the circuit breaker.
    await this.sqliteFallback.retain(content, options);

    if (this.isCircuitOpen()) return;

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
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    // Per-bank Hindsight disable (V8 substrate follow-up, 2026-05-03).
    // Checked BEFORE the global flag so a HARDEN-mc-operational +
    // DEMOTE-mc-jarvis verdict can run with HINDSIGHT_RECALL_ENABLED=true
    // globally and HINDSIGHT_RECALL_DISABLED_BANKS=mc-jarvis surgically.
    // Logs source='bank-disabled' so the recall_audit + mc-ctl recall-utility
    // surface attributes the routing decision (vs 'sqlite-only' which means
    // the global flag is off).
    if (isBankDisabled(options.bank)) {
      const start = Date.now();
      const raw = await this.sqliteFallback.recall(query, options);
      const { kept, excluded } = applyOutcomeFilter(raw, options);
      logRecall({
        bank: options.bank,
        query,
        source: "bank-disabled",
        results: kept,
        latencyMs: Date.now() - start,
        excludedCount: excluded,
      });
      if (excluded > 0) {
        console.log(
          `[memory] recall(bank-disabled) bank=${options.bank} filtered ${excluded} outcome-tagged result(s)`,
        );
      }
      return kept;
    }
    if (!isRecallPathEnabled()) {
      // HINDSIGHT_RECALL_ENABLED=false: skip the Hindsight probe entirely.
      // SQLite hybrid (FTS5 + embed) is the actual answering path and runs
      // separately upstream of this call too. This branch removes the 1.5s/
      // call dead-wait that was firing on every turn.
      const start = Date.now();
      const raw = await this.sqliteFallback.recall(query, options);
      const { kept, excluded } = applyOutcomeFilter(raw, options);
      logRecall({
        bank: options.bank,
        query,
        source: "sqlite-only",
        results: kept,
        latencyMs: Date.now() - start,
        excludedCount: excluded,
      });
      if (excluded > 0) {
        console.log(
          `[memory] recall(sqlite-only) filtered ${excluded} outcome-tagged result(s)`,
        );
      }
      return kept;
    }
    if (this.isCircuitOpen()) {
      // Hindsight down — fall back to SQLite keyword recall
      console.log(
        "[memory] Hindsight circuit open — recall falling back to SQLite",
      );
      const start = Date.now();
      const raw = await this.sqliteFallback.recall(query, options);
      const { kept, excluded } = applyOutcomeFilter(raw, options);
      logRecall({
        bank: options.bank,
        query,
        source: "circuit-open",
        results: kept,
        latencyMs: Date.now() - start,
        excludedCount: excluded,
      });
      if (excluded > 0) {
        console.log(
          `[memory] recall(circuit-open) filtered ${excluded} outcome-tagged result(s)`,
        );
      }
      return kept;
    }

    // Per-call timing for E5 audit. Baseline recorded `memory_search` at
    // 5388ms avg with no idea whether it was Hindsight API latency, SQLite
    // fallback, or the 5000ms client-level timeout being hit. Log the path
    // + duration so the distribution becomes visible.
    const start = Date.now();
    try {
      await this.ensureBank(options.bank);
      const response = await this.client.recall(options.bank, {
        query,
        budget: "low",
        tags: options.tags,
      });
      this.recordSuccess();
      const ms = Date.now() - start;
      console.log(
        `[memory] recall(hindsight) bank=${options.bank} results=${response.results.length} ${ms}ms`,
      );
      const raw: MemoryItem[] = response.results.map((r) => ({
        content: r.text,
        tags: r.tags ?? [],
      }));
      const { kept, excluded } = applyOutcomeFilter(raw, options);
      if (excluded > 0) {
        console.log(
          `[memory] recall(hindsight) filtered ${excluded} outcome-tagged result(s)`,
        );
      }
      logRecall({
        bank: options.bank,
        query,
        source: "hindsight",
        results: kept,
        latencyMs: ms,
        excludedCount: excluded,
      });
      return kept;
    } catch (err) {
      this.recordFailure(err);
      const ms = Date.now() - start;
      console.log(
        `[memory] recall(hindsight) FAILED after ${ms}ms — falling back to SQLite`,
      );
      // Fall back to SQLite on failure
      const fbStart = Date.now();
      const raw = await this.sqliteFallback.recall(query, options);
      const fbMs = Date.now() - fbStart;
      console.log(
        `[memory] recall(sqlite-fallback) results=${raw.length} ${fbMs}ms`,
      );
      const { kept, excluded } = applyOutcomeFilter(raw, options);
      if (excluded > 0) {
        console.log(
          `[memory] recall(sqlite-fallback) filtered ${excluded} outcome-tagged result(s)`,
        );
      }
      logRecall({
        bank: options.bank,
        query,
        source: "sqlite-fallback",
        results: kept,
        latencyMs: ms + fbMs,
        excludedCount: excluded,
      });
      return kept;
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
    // While a half-open probe is in-flight, treat the circuit as open for
    // siblings. Otherwise N concurrent recalls would all flip open=false
    // and all pay the full Hindsight timeout — the very pathology this
    // change was meant to kill.
    if (this.circuit.probeInFlight) return true;

    if (!this.circuit.open) return false;

    const elapsed = Date.now() - this.circuit.lastFailure;
    if (elapsed >= CIRCUIT_COOLDOWN_MS) {
      // Half-open: allow one probe through. Do NOT reset failures here —
      // only success (recordSuccess) clears the counter. This way, if the
      // probe fails, recordFailure increments past the threshold and
      // re-opens the breaker immediately instead of letting the next 2
      // requests also pay the timeout tax.
      this.circuit.open = false;
      this.circuit.probeInFlight = true;
      console.log("[memory] Circuit breaker: half-open, retrying Hindsight");
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    // Always clear probeInFlight first so siblings unblock even if the
    // success path runs before the failures-reset branch (failures may
    // already be 0 in the steady-state success case).
    this.circuit.probeInFlight = false;
    if (this.circuit.failures > 0) {
      this.circuit.failures = 0;
      this.circuit.open = false;
    }
  }

  private recordFailure(err: unknown): void {
    this.circuit.probeInFlight = false;
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
