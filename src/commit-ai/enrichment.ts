/**
 * COMMIT context enrichment — loads user's COMMIT state + memories
 * for injection into AI prompts.
 *
 * All calls run in parallel with a 3-second timeout. Failures are
 * silently ignored — enrichment is additive, never blocking.
 */

import { toolRegistry } from "../tools/registry.js";
import { getMemoryService } from "../memory/index.js";

export interface EnrichedContext {
  snapshotSummary?: string;
  goalsSummary?: string;
  memorySummary?: string;
}

const ENRICHMENT_TIMEOUT_MS = 3_000;
const SNAPSHOT_CAP = 500;
const GOALS_CAP = 300;
const MEMORY_CAP = 500;

/** Run a function with a timeout. Returns null on timeout or error. */
async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch {
    return null;
  }
}

/** Derive a search query from function input for memory recall. */
function deriveMemoryQuery(input: Record<string, unknown>): string {
  // Use the longest text field as the search query
  const candidates = [
    input.content,
    input.ideaContent,
    input.ideaTitle,
    input.goalTitle,
    input.objectiveTitle,
    input.problemStatement,
    input.initialInput,
    input.selectedText,
  ].filter(Boolean) as string[];

  const text = candidates.sort((a, b) => b.length - a.length)[0] ?? "";
  return text.slice(0, 200);
}

/** Format a daily snapshot into a brief summary. */
function formatSnapshot(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const lines: string[] = [];

    if (data.vision?.title) {
      lines.push(`Vision: ${data.vision.title}`);
    }
    if (data.summary) {
      const s = data.summary;
      lines.push(
        `Goals: ${s.active_goals} active. Objectives: ${s.active_objectives}. Tasks: ${s.pending_tasks} pending, ${s.completed_today} done today.`,
      );
      if (s.streak_days > 0) lines.push(`Streak: ${s.streak_days} days`);
    }
    if (data.overdue_tasks?.length > 0) {
      const overdue = data.overdue_tasks
        .slice(0, 3)
        .map((t: { title: string }) => t.title)
        .join(", ");
      lines.push(`Overdue: ${overdue}`);
    }

    return lines.join(". ").slice(0, SNAPSHOT_CAP);
  } catch {
    return raw.slice(0, SNAPSHOT_CAP);
  }
}

/** Format goals list into a brief summary. */
function formatGoals(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const goals = Array.isArray(data) ? data : (data.goals ?? []);
    return goals
      .slice(0, 5)
      .map((g: { title: string; status: string }) => `${g.title} (${g.status})`)
      .join(", ")
      .slice(0, GOALS_CAP);
  } catch {
    return raw.slice(0, GOALS_CAP);
  }
}

/**
 * Load enriched COMMIT context based on requested flags.
 * All calls run in parallel with a 3-second timeout per call.
 * Failures return empty strings — never throws.
 */
export async function enrichCommitContext(
  flags: string[],
  input: Record<string, unknown>,
): Promise<EnrichedContext> {
  const result: EnrichedContext = {};
  const tasks: Array<Promise<void>> = [];

  if (flags.includes("snapshot")) {
    tasks.push(
      withTimeout(
        () => toolRegistry.execute("commit__get_daily_snapshot", {}),
        ENRICHMENT_TIMEOUT_MS,
      ).then((raw) => {
        if (raw) result.snapshotSummary = formatSnapshot(raw);
      }),
    );
  }

  if (flags.includes("goals")) {
    tasks.push(
      withTimeout(
        () =>
          toolRegistry.execute("commit__list_goals", {
            status: "in_progress",
            limit: 5,
          }),
        ENRICHMENT_TIMEOUT_MS,
      ).then((raw) => {
        if (raw) result.goalsSummary = formatGoals(raw);
      }),
    );
  }

  if (flags.includes("memory")) {
    const query = deriveMemoryQuery(input);
    if (query.length > 10) {
      tasks.push(
        withTimeout(async () => {
          const memService = getMemoryService();
          const items = await memService.recall(query, {
            bank: "mc-jarvis",
            maxResults: 3,
          });
          return items
            .map((item) => item.content)
            .join(" | ")
            .slice(0, MEMORY_CAP);
        }, ENRICHMENT_TIMEOUT_MS).then((raw) => {
          if (raw && raw.length > 10) {
            result.memorySummary = raw;
          }
        }),
      );
    }
  }

  await Promise.allSettled(tasks);
  return result;
}
