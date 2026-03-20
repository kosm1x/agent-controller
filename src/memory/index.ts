/**
 * Memory service singleton factory.
 *
 * Returns Hindsight backend if configured + healthy, otherwise SQLite.
 */

import type { MemoryService } from "./types.js";
import { SqliteMemoryBackend } from "./sqlite-backend.js";

let _service: MemoryService | null = null;

/** Small delay helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialize the memory service. Called at startup.
 * Attempts Hindsight if HINDSIGHT_ENABLED=true with retry (handles startup race
 * where Hindsight's embedded PG isn't ready yet). Falls back to SQLite.
 */
export async function initMemoryService(): Promise<MemoryService> {
  if (_service) return _service;

  if (process.env.HINDSIGHT_ENABLED === "true") {
    const RETRY_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 3_000;

    try {
      const { HindsightMemoryBackend } = await import("./hindsight-backend.js");
      const hindsight = new HindsightMemoryBackend(
        process.env.HINDSIGHT_URL ?? "http://localhost:8888",
        process.env.HINDSIGHT_API_KEY,
      );

      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        if (await hindsight.isHealthy()) {
          _service = hindsight;
          console.log("[memory] Backend: hindsight");
          return _service;
        }
        if (attempt < RETRY_ATTEMPTS) {
          console.log(
            `[memory] Hindsight not ready (attempt ${attempt}/${RETRY_ATTEMPTS}), retrying in ${RETRY_DELAY_MS / 1000}s...`,
          );
          await delay(RETRY_DELAY_MS);
        }
      }
      console.warn(
        `[memory] Hindsight not healthy after ${RETRY_ATTEMPTS} attempts, falling back to SQLite`,
      );
    } catch (err) {
      console.warn(
        `[memory] Failed to init Hindsight: ${err instanceof Error ? err.message : err}; using SQLite`,
      );
    }
  }

  _service = new SqliteMemoryBackend();
  console.log("[memory] Backend: sqlite");
  return _service;
}

/**
 * Get the current memory service instance.
 * Falls back to SQLite if not yet initialized.
 */
export function getMemoryService(): MemoryService {
  if (!_service) {
    _service = new SqliteMemoryBackend();
  }
  return _service;
}

/** Reset singleton (for testing). */
export function resetMemoryService(): void {
  _service = null;
}
