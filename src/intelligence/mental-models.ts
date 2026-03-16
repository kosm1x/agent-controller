/**
 * Mental model seeds — creates and maintains 4 Hindsight mental models
 * that form the agent's evolving understanding of the user, projects,
 * task effectiveness, and conversation patterns.
 *
 * Called at startup when Hindsight is active. Models auto-refresh
 * after Hindsight consolidation cycles.
 */

import { HindsightClient } from "../memory/hindsight-client.js";
import type { MentalModelCreateRequest } from "../memory/hindsight-client.js";

/** The 4 mental models that power adaptive intelligence. */
const MODELS: Array<MentalModelCreateRequest & { bank: string }> = [
  {
    bank: "mc-jarvis",
    id: "user-behavior",
    name: "User Behavior Profile",
    source_query:
      "What patterns exist in how the user communicates? Include: " +
      "preferred times of day, communication style (formal/informal), " +
      "language preferences, typical request types, topics they care most about, " +
      "how they give feedback (positive and negative signals), " +
      "and how they prefer responses (concise vs detailed).",
    tags: ["conversation", "telegram"],
    max_tokens: 2048,
    trigger: { refresh_after_consolidation: true },
  },
  {
    bank: "mc-jarvis",
    id: "active-projects",
    name: "Active Projects & Priorities",
    source_query:
      "What are the user's current active projects, goals, and priorities? " +
      "Include: which goals and objectives are in progress, what tasks are pending, " +
      "which areas have recent activity vs are stale, upcoming deadlines, " +
      "and any stated priorities or urgency signals.",
    tags: ["conversation"],
    max_tokens: 2048,
    trigger: { refresh_after_consolidation: true },
  },
  {
    bank: "mc-operational",
    id: "task-effectiveness",
    name: "Task Effectiveness Patterns",
    source_query:
      "Which types of requests succeed on which runner types? " +
      "What tool combinations work best for common request patterns? " +
      "What are the most common failure modes? " +
      "What classification decisions led to good vs poor outcomes?",
    tags: ["execution", "reflection"],
    max_tokens: 1024,
    trigger: { refresh_after_consolidation: true },
  },
  {
    bank: "mc-jarvis",
    id: "conversation-themes",
    name: "Conversation Themes & Patterns",
    source_query:
      "What recurring topics and themes appear in conversations? " +
      "What questions come up repeatedly? What follow-up patterns exist " +
      "(e.g., user always asks about X after asking about Y)? " +
      "What unresolved topics or promises were made?",
    tags: ["conversation"],
    max_tokens: 1024,
    trigger: { refresh_after_consolidation: true },
  },
];

/**
 * Seed all mental models in Hindsight. Idempotent — safe to call on every startup.
 * Errors are non-fatal (models may already exist from prior runs).
 */
export async function seedMentalModels(
  baseUrl: string,
  apiKey?: string,
): Promise<void> {
  const client = new HindsightClient(baseUrl, apiKey);

  for (const { bank, ...model } of MODELS) {
    try {
      await client.createMentalModel(bank, model);
      console.log(
        `[intelligence] Mental model "${model.id}" seeded in ${bank}`,
      );
    } catch (err) {
      // 409/422 = already exists, which is fine
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("409") ||
        msg.includes("422") ||
        msg.includes("already")
      ) {
        console.log(`[intelligence] Mental model "${model.id}" already exists`);
      } else {
        console.warn(
          `[intelligence] Mental model "${model.id}" seed failed: ${msg}`,
        );
      }
    }
  }
}

/** Model IDs for use by enrichment service. */
export const MODEL_IDS = {
  userBehavior: "user-behavior",
  activeProjects: "active-projects",
  taskEffectiveness: "task-effectiveness",
  conversationThemes: "conversation-themes",
} as const;
