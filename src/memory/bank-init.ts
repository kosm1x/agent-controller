/**
 * Bank initialization — creates memory banks with tailored configurations.
 *
 * Called at startup when Hindsight is active. Idempotent (PUT = upsert).
 * Bank configs are also defined in hindsight-backend.ts (lazy init handles this
 * automatically, but explicit init ensures banks exist early).
 */

import { HindsightClient } from "./hindsight-client.js";

/**
 * Initialize all memory banks.
 * Called from index.ts after Hindsight is confirmed healthy.
 */
export async function initBanks(
  baseUrl: string,
  apiKey?: string,
): Promise<void> {
  const client = new HindsightClient(baseUrl, apiKey);

  try {
    await client.upsertBank("mc-jarvis", {
      reflect_mission:
        "Recall and synthesize conversations with the user (Fede) across messaging sessions. " +
        "Track preferences, active projects, schedule, and personal context.",
      retain_mission:
        "Extract user preferences, project updates, task changes, and conversation context. " +
        "Always include who said what and any decisions made.",
      observations_mission:
        "Prioritize user preferences and active project context. " +
        "Keep conversation context relevant and timely — decay old topics.",
    });

    await client.upsertBank("mc-operational", {
      reflect_mission:
        "Synthesize learnings from AI agent task execution — planning patterns, " +
        "tool failures, execution strategies, and reflection insights.",
      retain_mission:
        "Extract actionable learnings from task execution. Focus on tool usage patterns, " +
        "error recovery strategies, and planning decisions.",
      observations_mission:
        "Consolidate similar execution patterns. Discard learnings that become " +
        "outdated as tools/APIs change.",
    });

    await client.upsertBank("mc-system", {
      reflect_mission:
        "Analyze infrastructure events, ritual outcomes, and agent performance " +
        "for the Mission Control orchestrator.",
      retain_mission:
        "Extract infrastructure events, ritual results, and system anomalies. " +
        "Include timestamps and error details.",
      observations_mission:
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
