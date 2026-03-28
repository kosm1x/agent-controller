/**
 * Deep journal analysis — triggered by COMMIT webhook when a journal entry
 * is created. Enriches analysis with COMMIT goals, memory, and produces
 * actionable suggestions.
 *
 * Runs asynchronously (fire-and-forget from the webhook handler).
 */

import { z } from "zod";
import { infer } from "../inference/adapter.js";
import type { ChatMessage } from "../inference/adapter.js";
import { toolRegistry } from "../tools/registry.js";
import { getMemoryService } from "../memory/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("journal-analysis");

const JournalAnalysisSchema = z.object({
  emotions: z
    .array(
      z.object({
        name: z.string(),
        intensity: z.number().min(0).max(100),
        color: z.string(),
      }),
    )
    .min(1),
  patterns: z.array(z.string()),
  coping_strategies: z.array(z.string()),
  primary_emotion: z.string(),
  goal_connections: z.array(z.string()).optional().default([]),
  suggested_action: z.string().nullable().optional().default(null),
});

/**
 * Perform deep analysis on a journal entry.
 * Called asynchronously from the commit-events webhook handler.
 */
export async function analyzeJournalDeep(
  journalId: string,
  _userId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const content = (changes.content as string) ?? (changes.text as string) ?? "";
  if (!content || content.length < 20) {
    log.info({ journalId, chars: content.length }, "skipping short entry");
    return;
  }

  log.info({ journalId, chars: content.length }, "starting deep analysis");

  // Load context in parallel (all fire-and-forget, failures return defaults)
  const [snapshotRaw, goalsRaw, memoryItems] = await Promise.allSettled([
    toolRegistry.execute("commit__get_daily_snapshot", {}),
    toolRegistry.execute("commit__list_goals", {
      status: "in_progress",
      limit: 5,
    }),
    getMemoryService()
      .recall(content.slice(0, 200), {
        bank: "mc-jarvis",
        maxResults: 3,
      })
      .catch(() => []),
  ]);

  // Format context
  const snapshot = snapshotRaw.status === "fulfilled" ? snapshotRaw.value : "";
  const goals = goalsRaw.status === "fulfilled" ? goalsRaw.value : "";
  const memories =
    memoryItems.status === "fulfilled"
      ? memoryItems.value
          .map((item) => item.content)
          .join(" | ")
          .slice(0, 500)
      : "";

  // Build deep analysis prompt
  const prompt = `You are analyzing a journal entry in the context of the user's personal growth journey.

[JOURNAL ENTRY]
${content}

${snapshot ? `[CURRENT STATE]\n${snapshot.slice(0, 600)}` : ""}

${goals ? `[ACTIVE GOALS]\n${goals.slice(0, 400)}` : ""}

${memories ? `[RELEVANT CONTEXT FROM PAST INTERACTIONS]\n${memories}` : ""}

Produce a deep analysis with:
1. Emotional analysis: emotions array with {name, intensity (0-100), color (Tailwind bg class)}, plus primary_emotion
2. Behavioral patterns: recurring themes or behaviors observed
3. Coping strategies: actionable suggestions for the user
4. Goal connections: which active goals relate to this entry's content

Return ONLY a JSON object:
{
  "emotions": [{"name": "...", "intensity": 50, "color": "bg-blue-500"}],
  "patterns": ["..."],
  "coping_strategies": ["..."],
  "primary_emotion": "...",
  "goal_connections": ["goal title 1", "goal title 2"],
  "suggested_action": "brief suggestion for a task or objective if applicable, or null"
}

Respond in the same language as the journal entry.`;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are the deep analysis engine for COMMIT, a personal growth app. " +
        "Provide insightful, empathetic, and actionable analysis. " +
        "Return ONLY valid JSON.",
    },
    { role: "user", content: prompt },
  ];

  try {
    const response = await infer({
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const text = response.content ?? "";
    const jsonStr = extractJSON(text);
    if (!jsonStr) {
      log.warn({ journalId }, "failed to extract JSON");
      return;
    }

    const raw = JSON.parse(jsonStr);
    const parsed = JournalAnalysisSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ journalId, zodError: parsed.error.message }, "invalid schema");
      return;
    }

    const analysis = parsed.data;

    // Write analysis to COMMIT's ai_analysis table
    {
      try {
        await toolRegistry.execute("commit__upsert_ai_analysis", {
          journal_entry_id: journalId,
          emotions: analysis.emotions,
          patterns: analysis.patterns,
          coping_strategies: analysis.coping_strategies,
          primary_emotion: analysis.primary_emotion,
        });
        log.info(
          { journalId, primaryEmotion: analysis.primary_emotion },
          "analysis written",
        );
      } catch (err) {
        log.warn({ err, journalId }, "failed to write analysis");
      }
    }

    // Create suggestion if actionable insight found
    if (analysis.suggested_action && analysis.suggested_action !== "null") {
      try {
        await toolRegistry.execute("commit__create_suggestion", {
          type: "create_task",
          title: analysis.suggested_action.slice(0, 100),
          suggestion: {
            title: analysis.suggested_action,
            source_journal_id: journalId,
          },
          reasoning: `Based on journal analysis: ${analysis.primary_emotion}. ${(analysis.patterns ?? []).slice(0, 2).join(". ")}`,
          source: "journal_analysis",
        });
        log.info(
          { journalId, action: analysis.suggested_action.slice(0, 60) },
          "suggestion created from journal",
        );
      } catch (err) {
        log.warn({ err, journalId }, "failed to create suggestion");
      }
    }

    // Store analysis summary in Hindsight memory for future enrichment
    try {
      const memService = getMemoryService();
      await memService.retain(
        `Journal analysis (${new Date().toISOString().split("T")[0]}): ` +
          `primary emotion: ${analysis.primary_emotion}. ` +
          `Patterns: ${(analysis.patterns ?? []).slice(0, 3).join(", ")}. ` +
          `Goal connections: ${(analysis.goal_connections ?? []).join(", ") || "none"}.`,
        { bank: "mc-jarvis", tags: ["journal", "analysis"], async: true },
      );
    } catch {
      // Memory storage is best-effort
    }

    log.info(
      {
        journalId,
        latencyMs: response.latency_ms,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      },
      "analysis complete",
    );
  } catch (err) {
    log.error({ err, journalId }, "analysis failed");
  }
}

/** Extract JSON from LLM response using brace-depth counting. */
function extractJSON(text: string): string | null {
  const cleaned = text.replace(/```(?:json|javascript)?\s*\n?/g, "").trim();

  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // continue
  }

  for (let i = 0; i < cleaned.length; i++) {
    const open = cleaned[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < cleaned.length; j++) {
      const c = cleaned[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === open) depth++;
      if (c === close) depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(i, j + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
