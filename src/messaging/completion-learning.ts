/**
 * Learning steps the router starts after it has begun sending the reply to an
 * owner's chat request: execution pattern extraction, conversation auto-persist,
 * the recall-utility mark, fact extraction and lesson crystallization. Nothing
 * waits for them; their journal lines keep the router's tag.
 */
import { getDatabase } from "../db/index.js";
import { extractPattern } from "../intelligence/execution-patterns.js";
import { autoPersistConversation } from "../memory/auto-persist.js";
import { errMsg } from "../lib/err-msg.js";

export interface CompletionLearningInput {
  taskId: string;
  pending: { channel: string; originalText: string; scopeGroups?: string[] };
  resultText: string;
  taskToolCalls: string[];
  isBackground: boolean;
  data: { duration_ms: number };
}

export function startCompletionLearning({
  taskId,
  pending,
  resultText,
  taskToolCalls,
  isBackground,
  data,
}: CompletionLearningInput): void {
  // Execution pattern extraction (async, fire-and-forget)
  try {
    const db = getDatabase();
    const task = db
      .prepare(
        "SELECT title, spawn_type, status FROM tasks WHERE task_id = ?",
      )
      .get(taskId) as
      | { title: string; spawn_type: string; status: string }
      | undefined;
    // A run that ended with concerns must not become a lesson (2026-10-26:
    // a web-search-only Rumi answer became a pattern and would have been
    // injected into the next Rumi request by title overlap).
    if (
      task &&
      task.status === "completed" &&
      !isBackground &&
      taskToolCalls.length >= 2
    ) {
      extractPattern({
        taskId,
        title: task.title,
        status: task.status,
        toolsCalled: taskToolCalls,
        scopeGroups: pending.scopeGroups ?? [],
        userMessage: pending.originalText,
        result: resultText.slice(0, 500),
      }).catch(() => {});
    }
  } catch {
    // Non-fatal
  }

  // Mechanical auto-persist: store noteworthy exchanges based on heuristics
  try {
    autoPersistConversation({
      userText: pending.originalText,
      responseText: resultText,
      toolCalls: taskToolCalls,
      channel: pending.channel,
      taskId,
    }).catch((err) => {
      console.warn("[router] Auto-persist failed:", errMsg(err));
    });
  } catch {
    // Non-fatal
  }

  // Recall utility instrumentation: claim unmatched recall_audit rows from
  // the last 60s and substring-match snippets against the assistant
  // response. Answers "is recall actually used?" without coupling to the
  // recall caller's context. Fire-and-forget; never blocks delivery.
  try {
    import("../memory/recall-utility.js")
      .then(({ markRecallUtility }) => {
        markRecallUtility({
          taskId,
          responseText: resultText,
        });
      })
      .catch((err) => {
        console.warn("[router] recall-utility match failed:", errMsg(err));
      });
  } catch {
    // Non-fatal — instrumentation must never break delivery
  }

  // v6.2 M0.5: Background memory extraction (fire-and-forget)
  // Extracts 1-3 atomic facts from noteworthy exchanges via LLM,
  // stores in pgvector with embeddings for semantic enrichment.
  // Dynamic import + .then() because this function is not async.
  try {
    import("../memory/background-extractor.js")
      .then(({ shouldExtract, runBackgroundExtraction }) => {
        if (
          shouldExtract({
            toolCalls: taskToolCalls,
            responseLength: resultText.length,
            spawnType: isBackground ? "user-background" : undefined,
            isRitual: false, // rituals return early in the caller
            isProactive: false, // proactive tasks return early in the caller
          })
        ) {
          runBackgroundExtraction(
            pending.originalText,
            resultText,
            taskToolCalls,
            taskId,
          ).catch((err) => {
            console.warn(
              "[router] Background extraction failed:",
              errMsg(err),
            );
          });
        }
      })
      .catch(() => {});
  } catch {
    // Non-fatal — extraction is best-effort
  }

  // v6.2 M3: Crystal → Lesson pipeline (fire-and-forget)
  // Higher bar than M0.5 fact extraction: ≥5 tools AND >30s duration.
  // Extracts lessons (what worked/failed) vs facts (what happened).
  try {
    import("../memory/background-extractor.js")
      .then(({ shouldCrystallize, runCrystallization }) => {
        if (
          shouldCrystallize({
            toolCalls: taskToolCalls,
            durationMs: data.duration_ms,
            spawnType: isBackground ? "user-background" : undefined,
            isRitual: false,
            isProactive: false,
          })
        ) {
          runCrystallization(
            pending.originalText,
            resultText,
            taskToolCalls,
            data.duration_ms,
            taskId,
          ).catch((err) => {
            console.warn("[router] Crystallization failed:", errMsg(err));
          });
        }
      })
      .catch(() => {});
  } catch {
    // Non-fatal
  }
}
