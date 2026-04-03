/**
 * COMMIT event reaction handlers.
 *
 * Wired from the commit-events webhook endpoint. Each reaction is async
 * and fire-and-forget — errors are logged but never block the webhook response.
 */

import { createSuggestion } from "../db/commit.js";
import { getProjectByGoalId } from "../db/projects.js";
import { getRouter } from "../messaging/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("event-reactions");

// ---------------------------------------------------------------------------
// task.created — verify alignment with active goals (flag orphan tasks)
// ---------------------------------------------------------------------------

export async function onTaskCreated(
  rowId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const objectiveId = changes.objective_id as string | undefined;
  // Only flag tasks that have no parent objective
  if (objectiveId) return;

  const title = (changes.title as string) ?? "Sin título";

  log.info({ rowId, title }, "orphan task created — no objective linked");

  try {
    createSuggestion({
      type: "link_task",
      target_table: "tasks",
      target_id: rowId,
      title: `Tarea huérfana: "${title}"`,
      suggestion: { task_id: rowId, task_title: title },
      reasoning: `La tarea "${title}" fue creada sin vincularla a ningún objetivo. Considera asignarla a un objetivo activo para mantener alineación con tus metas.`,
      source: "event_reactor",
    });
  } catch (err) {
    log.error({ err }, "failed to create orphan task suggestion");
  }
}

// ---------------------------------------------------------------------------
// task.completed — check if all sibling tasks are done → suggest objective completion
// ---------------------------------------------------------------------------

export async function onTaskCompleted(
  _rowId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const objectiveId = changes.objective_id as string | undefined;
  if (!objectiveId) return;

  // Fetch all tasks under this objective (direct SQLite)
  let tasks: Array<{ id: string; status: string; title: string }>;
  try {
    const { getDatabase } = await import("../db/index.js");
    tasks = getDatabase()
      .prepare(
        "SELECT id, status, title FROM commit_tasks WHERE objective_id = ?",
      )
      .all(objectiveId) as Array<{ id: string; status: string; title: string }>;
  } catch (err) {
    log.error({ err, objectiveId }, "failed to list tasks for objective");
    return;
  }

  const allDone =
    tasks.length > 0 &&
    tasks.every((t) => t.status === "completed" || t.status === "archived");

  if (allDone) {
    // Fetch the objective name for a meaningful title
    let objectiveName = "objetivo";
    try {
      const { getDatabase } = await import("../db/index.js");
      const row = getDatabase()
        .prepare("SELECT title FROM commit_objectives WHERE id = ?")
        .get(objectiveId) as { title: string } | undefined;
      if (row?.title) objectiveName = row.title;
    } catch {
      /* use fallback */
    }

    log.info(
      { objectiveId, objectiveName },
      "all tasks under objective are done — suggesting completion",
    );
    try {
      createSuggestion({
        type: "complete_objective",
        target_table: "objectives",
        target_id: objectiveId,
        title: `Completar: ${objectiveName}`,
        suggestion: { objective_id: objectiveId, new_status: "completed" },
        reasoning: `Las ${tasks.length} tarea(s) bajo "${objectiveName}" están completadas. ¿Marcar el objetivo como completado?`,
        source: "event_reactor",
      });
    } catch (err) {
      log.error({ err }, "failed to create objective completion suggestion");
    }
  }
}

// ---------------------------------------------------------------------------
// task.completed (recurring) — celebrate streak milestones
// ---------------------------------------------------------------------------

export async function onRecurringTaskCompleted(
  changes: Record<string, unknown>,
): Promise<void> {
  const isRecurring = changes.is_recurring === true;
  if (!isRecurring) return;

  // Calculate streak directly from SQLite
  let streak = 0;
  try {
    const { getDatabase } = await import("../db/index.js");
    const db = getDatabase();
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Mexico_City",
    });
    const dates = db
      .prepare(
        "SELECT DISTINCT completion_date FROM commit_completions ORDER BY completion_date DESC LIMIT 30",
      )
      .all() as Array<{ completion_date: string }>;
    const cursor = new Date(today + "T12:00:00");
    for (const { completion_date } of dates) {
      const expected = cursor.toLocaleDateString("en-CA", {
        timeZone: "America/Mexico_City",
      });
      if (completion_date === expected) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else if (completion_date < expected) break;
    }
  } catch {
    return;
  }

  const milestones = [7, 30, 50, 100, 200, 365];
  if (!milestones.includes(streak)) return;

  const messages: Record<number, string> = {
    7: `🔥 ¡1 semana de racha! ${streak} días consecutivos completando hábitos.`,
    30: `🏆 ¡1 MES de racha! ${streak} días consecutivos. La consistencia gana.`,
    50: `💎 ¡50 días de racha! Eres una máquina.`,
    100: `🎯 ¡100 DÍAS! Triple dígitos. Esto ya es identidad, no disciplina.`,
    200: `🌟 ¡200 días de racha! Menos del 1% de las personas llegan aquí.`,
    365: `👑 ¡UN AÑO COMPLETO! 365 días. Leyenda.`,
  };

  const message = messages[streak] ?? `🔥 ¡${streak} días de racha!`;
  log.info({ streak }, "streak milestone reached");

  const router = getRouter();
  if (router) {
    router.broadcastToAll(message).catch((err) => {
      log.error({ err }, "streak broadcast failed");
    });
  }
}

// ---------------------------------------------------------------------------
// goal.completed — celebrate via Telegram + suggest archiving linked project
// ---------------------------------------------------------------------------

export async function onGoalCompleted(
  rowId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const goalName =
    (changes.title as string) ?? (changes.name as string) ?? "Meta";

  // Celebrate via Telegram
  const message = `🎉 ¡Meta completada: "${goalName}"! Excelente trabajo.`;
  const router = getRouter();
  if (router) {
    router.broadcastToAll(message).catch((err) => {
      log.error({ err }, "goal celebration broadcast failed");
    });
  }

  // Check if there's a linked project
  const project = getProjectByGoalId(rowId);
  if (project) {
    log.info(
      { rowId, projectSlug: project.slug },
      "goal linked to project — suggesting archive",
    );
    try {
      createSuggestion({
        type: "archive_project",
        target_table: "goals",
        target_id: rowId,
        title: `Archivar proyecto "${project.name}" (meta completada)`,
        suggestion: {
          project_slug: project.slug,
          new_status: "completed",
        },
        reasoning: `La meta "${goalName}" está completada. El proyecto "${project.name}" está vinculado a esta meta. ¿Marcarlo como completado?`,
        source: "event_reactor",
      });
    } catch (err) {
      log.error({ err }, "failed to create archive project suggestion");
    }
  }
}

// ---------------------------------------------------------------------------
// objective.completed — suggest next objective or goal promotion
// ---------------------------------------------------------------------------

export async function onObjectiveCompleted(
  _rowId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const goalId = changes.goal_id as string | undefined;
  if (!goalId) return;

  // Fetch remaining objectives under the goal (direct SQLite)
  let objectives: Array<{ id: string; status: string }>;
  try {
    const { getDatabase } = await import("../db/index.js");
    objectives = getDatabase()
      .prepare("SELECT id, status FROM commit_objectives WHERE goal_id = ?")
      .all(goalId) as Array<{ id: string; status: string }>;
  } catch (err) {
    log.error({ err, goalId }, "failed to list objectives for goal");
    return;
  }

  const pendingObjectives = objectives.filter(
    (o) => o.status !== "completed" && o.status !== "archived",
  );
  const allDone = objectives.length > 0 && pendingObjectives.length === 0;

  // Fetch goal name for meaningful titles
  const goalName =
    (changes.title as string) ?? (changes.name as string) ?? null;
  let resolvedGoalName = goalName ?? "meta";
  if (!goalName) {
    try {
      const { getDatabase } = await import("../db/index.js");
      const row = getDatabase()
        .prepare("SELECT title FROM commit_goals WHERE id = ?")
        .get(goalId) as { title: string } | undefined;
      if (row?.title) resolvedGoalName = row.title;
    } catch {
      /* use fallback */
    }
  }

  if (allDone) {
    log.info(
      { goalId, goalName: resolvedGoalName },
      "all objectives under goal are done — suggesting goal completion",
    );
    try {
      createSuggestion({
        type: "complete_goal",
        target_table: "goals",
        target_id: goalId,
        title: `Completar meta: ${resolvedGoalName}`,
        suggestion: { goal_id: goalId, new_status: "completed" },
        reasoning: `Los ${objectives.length} objetivo(s) bajo "${resolvedGoalName}" están completados.`,
        source: "event_reactor",
      });
    } catch (err) {
      log.error({ err }, "failed to create goal completion suggestion");
    }
  } else if (pendingObjectives.length > 0) {
    log.info(
      { goalId, remaining: pendingObjectives.length },
      "objective completed, remaining under goal",
    );
    try {
      createSuggestion({
        type: "focus_next_objective",
        target_table: "goals",
        target_id: goalId,
        title: `${resolvedGoalName}: ${pendingObjectives.length} objetivo(s) pendiente(s)`,
        suggestion: {
          goal_id: goalId,
          remaining_count: pendingObjectives.length,
        },
        reasoning: `Completaste un objetivo bajo "${resolvedGoalName}". Quedan ${pendingObjectives.length} por avanzar.`,
        source: "event_reactor",
      });
    } catch (err) {
      log.error({ err }, "failed to create next objective suggestion");
    }
  }
}
