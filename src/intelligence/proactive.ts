/**
 * Proactive intelligence scheduler — scans for risks and nudges the user.
 *
 * Runs every 4 hours during waking hours (8AM, noon, 4PM, 8PM user tz).
 * Scans: overdue tasks, approaching deadlines (2 days), stale objectives (7 days).
 * Throttle: max 2 nudges per day, suppressed if user chatted in last hour.
 *
 * Delivers nudges via router.broadcastToAll(). Non-blocking, non-fatal.
 */

import { type ScheduledTask } from "node-cron";
import { scheduleCron } from "../lib/cron.js";
import type { MessageRouter } from "../messaging/router.js";
import { submitTask } from "../dispatch/dispatcher.js";
import { createLogger } from "../lib/logger.js";
import { noteJobFailure } from "../observability/failure-counters.js";
import {
  startSessionEndWriter,
  stopSessionEndWriter,
} from "./session-end-writer.js";

const log = createLogger("proactive");

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

  // ALWAYS keep the session-end writer running — it stamps the [SESSION_END]
  // markers in the day-log, which is the work-truth source the rest of the
  // system now depends on. (It is independent of the nudge scan below.)
  startSessionEndWriter(router);

  // The proactive nudge scan used to read NorthStar to flag "overdue/stale/
  // estancado" work — the source the operator ruled is NOT work-truth
  // (2026-06-23). Its prompt now reads the projects list + the day-log
  // (2026-11-03; the jarvis file tools refuse NorthStar/ anyway). Still OFF
  // by default:
  //   PROACTIVE_NUDGE_ENABLED=true
  if (process.env.PROACTIVE_NUDGE_ENABLED !== "true") {
    log.info(
      "proactive NorthStar nudge DISABLED (PROACTIVE_NUDGE_ENABLED!=true); session-end day-log writer still active",
    );
    return;
  }

  job = scheduleCron("proactive-nudge", 
    NUDGE_CRON,
    () => {
      return runProactiveScan().catch((err) => {
        noteJobFailure("proactive-nudge", err);
        log.warn({ err }, "scan failed");
      });
    },
    { timezone: TIMEZONE },
  );

  log.info({ cron: NUDGE_CRON, timezone: TIMEZONE }, "scheduled");
}

/**
 * Stop the proactive scheduler.
 */
export function stopProactiveScheduler(): void {
  if (job) {
    job.stop();
    job = null;
  }
  stopSessionEndWriter();
  routerRef = null;
  log.info("stopped");
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
    log.info("daily nudge limit reached, skipping");
    return;
  }

  // Suppress if user was active recently
  const lastMsg = routerRef.getLastMessageTime();
  if (lastMsg && Date.now() - lastMsg < SUPPRESS_IF_ACTIVE_MS) {
    log.info("user active recently, skipping");
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

  // Submit a proactive scan task — the LLM reads the projects list + the
  // day-log (NorthStar retired 2026-11-03; the jarvis file tools refuse it)
  // to check deadlines, overdue tasks and stalled projects
  try {
    const result = await submitTask({
      title: `Proactive scan — ${today}`,
      interactive: false, // background (W-E): no operator to confirm
      description: `Eres Jarvis. Realiza un escaneo proactivo de la situación del usuario:

1. Usa project_list para ver proyectos activos (las tareas, metas y objetivos del usuario viven ahí) y verificar que tengan progreso reciente.
2. Usa jarvis_file_read para leer el day-log de hoy y de los últimos días (logs/day-logs/YYYY-MM-DD.md) y ver tareas pendientes, vencidas, y próximos deadlines.
3. Cruza ambos: un proyecto activo sin menciones en el day-log en 14+ días está estancado.

## Qué buscar

- **Tareas vencidas** (overdue) → alerta inmediata
- **Deadlines en los próximos 2 días** → recordatorio
- **Metas estancadas** (14+ días sin movimiento en objetivos/tareas) → "Tu meta X lleva 2+ semanas sin movimiento. ¿La replanteamos?"
- **Tareas completables** → si el day-log muestra una tarea terminada que sigue abierta, sugiere registrarla con una línea de tarea fechada al final de projects/{slug}/README.md (jarvis_file_update con append)
${isEvening ? `- **Protección de racha**: Son las ${currentHour}h. Si no hay completaciones hoy, sugiere la tarea pendiente más fácil para mantener la racha.` : ""}

Genera un mensaje BREVE (máximo 4-5 líneas) SOLO si encuentras algo importante.
Si todo está en orden, responde exactamente: "NOTHING_TO_REPORT"

No saludes. No agregues contexto innecesario. Ve directo al punto.`,
      agentType: "fast",
      tools: ["jarvis_file_read", "project_list"],
      tags: ["proactive"],
    });

    // Watch for the result — the task will complete asynchronously
    // and the event handler below will broadcast if warranted
    watchProactiveTask(result.taskId);
  } catch (err) {
    noteJobFailure("proactive-nudge", err);
    log.warn({ err }, "failed to submit scan");
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
    log.info("scan found nothing to report");
    return;
  }

  // Broadcast the nudge
  nudgeCountToday++;
  routerRef.broadcastToAll(result).catch((err) => {
    log.error({ err }, "broadcast failed");
  });
  log.info(
    { nudgeCount: nudgeCountToday, maxNudges: MAX_NUDGES_PER_DAY },
    "nudge sent",
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
