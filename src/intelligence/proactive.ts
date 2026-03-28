/**
 * Proactive intelligence scheduler — scans for risks and nudges the user.
 *
 * Runs every 4 hours during waking hours (8AM, noon, 4PM, 8PM user tz).
 * Scans: overdue tasks, approaching deadlines (2 days), stale objectives (7 days).
 * Throttle: max 2 nudges per day, suppressed if user chatted in last hour.
 *
 * Delivers nudges via router.broadcastToAll(). Non-blocking, non-fatal.
 */

import cron, { type ScheduledTask } from "node-cron";
import type { MessageRouter } from "../messaging/router.js";
import { submitTask } from "../dispatch/dispatcher.js";

const NUDGE_CRON = "0 8,12,16,20 * * *"; // 8AM, noon, 4PM, 8PM
const MAX_NUDGES_PER_DAY = 2;
const SUPPRESS_IF_ACTIVE_MS = 3_600_000; // 1 hour
const TIMEZONE = process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";

let job: ScheduledTask | null = null;
let nudgeCountToday = 0;
let lastNudgeDate = "";
let routerRef: MessageRouter | null = null;

/**
 * Start the proactive scheduler.
 */
export function startProactiveScheduler(router: MessageRouter): void {
  routerRef = router;

  job = cron.schedule(
    NUDGE_CRON,
    () => {
      runProactiveScan().catch((err) => {
        console.warn(
          `[proactive] Scan failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    },
    { timezone: TIMEZONE },
  );

  console.log(`[proactive] Scheduled (${NUDGE_CRON}, tz=${TIMEZONE})`);
}

/**
 * Stop the proactive scheduler.
 */
export function stopProactiveScheduler(): void {
  if (job) {
    job.stop();
    job = null;
  }
  routerRef = null;
  console.log("[proactive] Stopped");
}

/**
 * Run a proactive scan. Called by the cron job.
 */
async function runProactiveScan(): Promise<void> {
  if (!routerRef) return;

  // Reset daily counter
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: TIMEZONE,
  });
  if (lastNudgeDate !== today) {
    nudgeCountToday = 0;
    lastNudgeDate = today;
  }

  // Throttle: max nudges per day
  if (nudgeCountToday >= MAX_NUDGES_PER_DAY) {
    console.log("[proactive] Daily nudge limit reached, skipping");
    return;
  }

  // Suppress if user was active recently
  const lastMsg = routerRef.getLastMessageTime();
  if (lastMsg && Date.now() - lastMsg < SUPPRESS_IF_ACTIVE_MS) {
    console.log("[proactive] User active recently, skipping");
    return;
  }

  // Determine current hour in MX timezone for context-aware scanning
  const mxHour = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    hour12: false,
  });
  const currentHour = parseInt(mxHour, 10);
  const isEvening = currentHour >= 18; // 6PM+

  // Submit a proactive scan task — the LLM will use commit tools
  // to check deadlines, overdue tasks, stale goals, and project-goal sync
  try {
    const result = await submitTask({
      title: `Proactive scan — ${today}`,
      description: `Eres Jarvis. Realiza un escaneo proactivo de la situación del usuario:

1. Usa commit__get_daily_snapshot para ver tareas pendientes, vencidas, y próximos deadlines.
2. Usa commit__list_objectives con status "in_progress" para detectar objetivos estancados.
3. Usa commit__list_goals con status "in_progress" para detectar metas sin actividad en 14+ días.
4. Usa project_list para ver proyectos activos y verificar que los que tienen commit_goal_id vinculado tengan progreso reciente.

## Qué buscar

- **Tareas vencidas** (overdue) → alerta inmediata
- **Deadlines en los próximos 2 días** → recordatorio
- **Metas estancadas** (14+ días sin movimiento en objetivos/tareas) → "Tu meta X lleva 2+ semanas sin movimiento. ¿La replanteamos?"
- **Objetivos completables** → si todas las tareas de un objetivo están completadas, sugiere marcar el objetivo como completado
- **Proyecto-meta desincronizado** → si un proyecto tiene actividad reciente pero su meta COMMIT vinculada no se mueve (o viceversa)
${isEvening ? `- **Protección de racha**: Son las ${currentHour}h. Si no hay completaciones hoy, sugiere la tarea pendiente más fácil para mantener la racha.` : ""}

Genera un mensaje BREVE (máximo 4-5 líneas) SOLO si encuentras algo importante.
Si todo está en orden, responde exactamente: "NOTHING_TO_REPORT"

No saludes. No agregues contexto innecesario. Ve directo al punto.`,
      agentType: "fast",
      tools: [
        "commit__get_daily_snapshot",
        "commit__list_objectives",
        "commit__list_tasks",
        "commit__list_goals",
        "project_list",
      ],
      tags: ["proactive"],
    });

    // Watch for the result — the task will complete asynchronously
    // and the event handler below will broadcast if warranted
    watchProactiveTask(result.taskId);
  } catch (err) {
    console.warn(
      `[proactive] Failed to submit scan: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Track proactive task IDs so we can handle their results. */
const pendingProactive = new Set<string>();

function watchProactiveTask(taskId: string): void {
  pendingProactive.add(taskId);
}

/**
 * Handle a completed proactive scan task.
 * Called from the router or event bus when a proactive task completes.
 */
export function handleProactiveResult(taskId: string, result: string): void {
  if (!pendingProactive.has(taskId)) return;
  pendingProactive.delete(taskId);

  if (!routerRef) return;
  if (!result || result.includes("NOTHING_TO_REPORT")) {
    console.log("[proactive] Scan found nothing to report");
    return;
  }

  // Broadcast the nudge
  nudgeCountToday++;
  routerRef.broadcastToAll(result).catch((err) => {
    console.error(`[proactive] Broadcast failed: ${err}`);
  });
  console.log(
    `[proactive] Nudge sent (${nudgeCountToday}/${MAX_NUDGES_PER_DAY} today)`,
  );
}

/**
 * Clean up a failed proactive task from the pending set.
 * Called from the router's task.failed handler.
 */
export function handleProactiveFailure(taskId: string): void {
  pendingProactive.delete(taskId);
}

/**
 * Check if a task ID is a proactive scan (for router integration).
 */
export function isProactiveTask(taskId: string): boolean {
  return pendingProactive.has(taskId);
}
