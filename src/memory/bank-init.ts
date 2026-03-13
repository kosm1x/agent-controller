/**
 * Bank initialization — creates memory banks with tailored configurations.
 *
 * Called at startup when Hindsight is active. Idempotent (PUT = upsert).
 * Bank configs are defined in hindsight-backend.ts (lazy init handles this
 * automatically, but explicit init ensures banks + mental models exist early).
 */

import { HindsightClient } from "./hindsight-client.js";

/**
 * Initialize all memory banks and their mental models.
 * Called from index.ts after Hindsight is confirmed healthy.
 */
export async function initBanks(
  baseUrl: string,
  apiKey?: string,
): Promise<void> {
  const client = new HindsightClient(baseUrl, apiKey);

  // Banks are created lazily by hindsight-backend.ts on first use.
  // This function exists for explicit early init + mental model setup.

  try {
    // Create mc-jarvis mental models for conversation memory
    // These are handled by Hindsight's auto-consolidation, but we
    // seed the bank config to ensure the mission/disposition are set.
    await client.upsertBank("mc-jarvis", {
      mission:
        "Remember conversations with the user across messaging sessions. " +
        "Track user preferences, active projects, schedule, and personal " +
        "context for a strategic assistant named Jarvis.",
      disposition:
        "Prioritize user preferences and active project context. " +
        "Auto-refresh when observations consolidate. Keep conversation " +
        "context relevant and timely — decay old topics.",
    });

    await client.upsertBank("mc-operational", {
      mission:
        "Store and retrieve learnings from task execution — planning patterns, " +
        "tool failures, execution strategies, and reflection insights.",
      disposition:
        "Prioritize actionable, specific learnings over generic observations. " +
        "Consolidate similar execution patterns.",
    });

    await client.upsertBank("mc-system", {
      mission:
        "Track infrastructure events, ritual outcomes, agent performance " +
        "metrics, and system-level observations.",
      disposition:
        "Focus on patterns and anomalies. Consolidate routine metrics. " +
        "Retain infrastructure incidents and their resolutions long-term.",
    });

    console.log("[memory] All banks initialized");
  } catch (err) {
    // Non-fatal — banks get created lazily on first use anyway
    console.warn(
      `[memory] Bank init warning: ${err instanceof Error ? err.message : err}`,
    );
  }
}
