/**
 * COMMIT event reaction handlers.
 *
 * Wired from the commit-events webhook endpoint. Each reaction is async
 * and fire-and-forget — errors are logged but never block the webhook response.
 */

import { toolRegistry } from "../tools/registry.js";
import { getProjectByGoalId } from "../db/projects.js";
import { getRouter } from "../messaging/index.js";

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

  console.log(
    `[event-reactions] Orphan task created: "${title}" (${rowId}) — no objective linked`,
  );

  try {
    await toolRegistry.execute("commit__create_suggestion", {
      type: "link_task",
      title: `Tarea huérfana: "${title}"`,
      suggestion: { task_id: rowId, task_title: title },
      reasoning: `La tarea "${title}" fue creada sin vincularla a ningún objetivo. Considera asignarla a un objetivo activo para mantener alineación con tus metas.`,
      source: "event_reactor",
    });
  } catch (err) {
    console.error(
      `[event-reactions] Failed to create orphan task suggestion:`,
      err,
    );
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

  // Fetch all tasks under this objective
  let tasksResult: string;
  try {
    tasksResult = await toolRegistry.execute("commit__list_tasks", {
      objective_id: objectiveId,
    });
  } catch (err) {
    console.error(
      `[event-reactions] Failed to list tasks for objective ${objectiveId}:`,
      err,
    );
    return;
  }

  // Parse the result to check completion status
  let tasks: Array<{ id: string; status: string }>;
  try {
    const parsed = JSON.parse(tasksResult);
    tasks = Array.isArray(parsed)
      ? parsed
      : (parsed.tasks ?? parsed.data ?? []);
  } catch {
    return;
  }

  const allDone =
    tasks.length > 0 &&
    tasks.every((t) => t.status === "completed" || t.status === "archived");

  if (allDone) {
    console.log(
      `[event-reactions] All tasks under objective ${objectiveId} are done — suggesting completion`,
    );
    try {
      await toolRegistry.execute("commit__create_suggestion", {
        type: "complete_objective",
        title: `Todas las tareas del objetivo completadas`,
        suggestion: { objective_id: objectiveId, new_status: "completed" },
        reasoning: `Las ${tasks.length} tarea(s) bajo este objetivo están completadas. ¿Marcar el objetivo como completado?`,
        source: "event_reactor",
      });
    } catch (err) {
      console.error(
        `[event-reactions] Failed to create objective completion suggestion:`,
        err,
      );
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

  // Check current streak via daily snapshot
  let snapshotRaw: string;
  try {
    snapshotRaw = await toolRegistry.execute("commit__get_daily_snapshot", {});
  } catch {
    return;
  }

  let streak = 0;
  try {
    const snapshot = JSON.parse(snapshotRaw);
    streak = snapshot.streak ?? snapshot.current_streak ?? 0;
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
  console.log(`[event-reactions] Streak milestone: ${streak} days`);

  const router = getRouter();
  if (router) {
    router.broadcastToAll(message).catch((err) => {
      console.error(`[event-reactions] Streak broadcast failed:`, err);
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
      console.error(
        `[event-reactions] Goal celebration broadcast failed:`,
        err,
      );
    });
  }

  // Check if there's a linked project
  const project = getProjectByGoalId(rowId);
  if (project) {
    console.log(
      `[event-reactions] Goal ${rowId} linked to project ${project.slug} — suggesting archive`,
    );
    try {
      await toolRegistry.execute("commit__create_suggestion", {
        type: "archive_project",
        title: `Archivar proyecto "${project.name}" (meta completada)`,
        suggestion: {
          project_slug: project.slug,
          new_status: "completed",
        },
        reasoning: `La meta "${goalName}" está completada. El proyecto "${project.name}" está vinculado a esta meta. ¿Marcarlo como completado?`,
        source: "event_reactor",
      });
    } catch (err) {
      console.error(
        `[event-reactions] Failed to create archive project suggestion:`,
        err,
      );
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

  // Fetch remaining objectives under the goal
  let objectivesResult: string;
  try {
    objectivesResult = await toolRegistry.execute("commit__list_objectives", {
      goal_id: goalId,
    });
  } catch (err) {
    console.error(
      `[event-reactions] Failed to list objectives for goal ${goalId}:`,
      err,
    );
    return;
  }

  let objectives: Array<{ id: string; status: string }>;
  try {
    const parsed = JSON.parse(objectivesResult);
    objectives = Array.isArray(parsed)
      ? parsed
      : (parsed.objectives ?? parsed.data ?? []);
  } catch {
    return;
  }

  const pendingObjectives = objectives.filter(
    (o) => o.status !== "completed" && o.status !== "archived",
  );
  const allDone = objectives.length > 0 && pendingObjectives.length === 0;

  if (allDone) {
    // All objectives done — suggest completing the goal
    console.log(
      `[event-reactions] All objectives under goal ${goalId} are done — suggesting goal completion`,
    );
    try {
      await toolRegistry.execute("commit__create_suggestion", {
        type: "complete_goal",
        title: `Todos los objetivos completados — ¿completar la meta?`,
        suggestion: { goal_id: goalId, new_status: "completed" },
        reasoning: `Los ${objectives.length} objetivo(s) bajo esta meta están completados.`,
        source: "event_reactor",
      });
    } catch (err) {
      console.error(
        `[event-reactions] Failed to create goal completion suggestion:`,
        err,
      );
    }
  } else if (pendingObjectives.length > 0) {
    // There are more objectives — suggest focusing on the next one
    console.log(
      `[event-reactions] Objective completed, ${pendingObjectives.length} remaining under goal ${goalId}`,
    );
    try {
      await toolRegistry.execute("commit__create_suggestion", {
        type: "focus_next_objective",
        title: `Siguiente objetivo: enfoca en los ${pendingObjectives.length} restantes`,
        suggestion: {
          goal_id: goalId,
          remaining_count: pendingObjectives.length,
        },
        reasoning: `Completaste un objetivo. Quedan ${pendingObjectives.length} por avanzar bajo esta meta.`,
        source: "event_reactor",
      });
    } catch (err) {
      console.error(
        `[event-reactions] Failed to create next objective suggestion:`,
        err,
      );
    }
  }
}
