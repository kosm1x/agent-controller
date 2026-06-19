/**
 * Session-end writer — appends a [SESSION_END] summary to the day-log
 * after a conversation goes idle for SESSION_IDLE_THRESHOLD_MS.
 *
 * Motivation: the morning brief reads the day-log to reconstruct what
 * happened the prior day. Without SESSION_END markers, it cannot tell
 * whether a completed exchange produced a result — it just sees a query
 * and marks the outcome "incierto" (uncertain). This module writes a
 * concise SESSION_END line so the brief has certainty.
 *
 * Integration: called from startProactiveScheduler() in proactive.ts,
 * which already holds the router reference and starts the cron jobs.
 *
 * Design:
 * - No LLM calls — pure mechanical logic.
 * - Reads day-log directly from SQLite (via getFile), same as appendDayLog.
 * - Non-blocking / fire-and-forget — never delays message handling.
 * - Idempotent: hasRecentSessionEnd() guards against duplicate markers.
 */

import type { MessageRouter } from "../messaging/router.js";
import { getDatabase } from "../db/index.js";
import { mirrorToDisk } from "../db/jarvis-fs.js";
import { createLogger } from "../lib/logger.js";
import {
  parseDayLogEntries,
  buildSessionSummary,
  SESSION_IDLE_THRESHOLD_MS,
  SESSION_IDLE_CHECK_INTERVAL_MS,
} from "../messaging/session-summary.js";

const log = createLogger("session-end-writer");
const TIMEZONE = process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";

let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
let routerRef: MessageRouter | null = null;

/**
 * Start the idle-session watcher.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startSessionEndWriter(router: MessageRouter): void {
  if (idleCheckInterval) return; // already running
  routerRef = router;

  idleCheckInterval = setInterval(() => {
    checkAndWriteSessionEnd().catch((err) => {
      log.warn({ err }, "session-end check failed");
    });
  }, SESSION_IDLE_CHECK_INTERVAL_MS);

  log.info(
    {
      idleThresholdMs: SESSION_IDLE_THRESHOLD_MS,
      checkIntervalMs: SESSION_IDLE_CHECK_INTERVAL_MS,
    },
    "session-end writer started",
  );
}

/**
 * Stop the idle-session watcher.
 */
export function stopSessionEndWriter(): void {
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
  routerRef = null;
  log.info("session-end writer stopped");
}

/**
 * Check if the conversation is idle and write a SESSION_END if needed.
 * Called by the interval timer.
 */
async function checkAndWriteSessionEnd(): Promise<void> {
  if (!routerRef) return;

  const lastMsgTime = routerRef.getLastMessageTime();
  if (lastMsgTime === 0) return; // no messages yet this session

  const idleMs = Date.now() - lastMsgTime;
  if (idleMs < SESSION_IDLE_THRESHOLD_MS) return; // still active

  const date = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const path = `logs/day-logs/${date}.md`;

  // Read current day-log from DB
  const db = getDatabase();
  const row = db
    .prepare("SELECT content FROM jarvis_files WHERE path = ?")
    .get(path) as { content: string } | undefined;

  if (!row?.content) return; // no log yet today

  const entries = parseDayLogEntries(row.content);
  const summary = buildSessionSummary(entries, date);
  if (!summary) return; // nothing to write (already written or empty)

  // Append SESSION_END entry to the log
  const time = new Date().toLocaleTimeString("es-MX", {
    timeZone: TIMEZONE,
    hour12: false,
  });
  const entry = `- [${time}] **JARVIS**: ${summary}\n`;
  const newContent = row.content + entry;

  // Write via direct DB (same pattern as appendDayLog in router.ts)
  db.prepare(
    `UPDATE jarvis_files SET content = ?, updated_at = datetime('now') WHERE path = ?`,
  ).run(newContent, path);
  mirrorToDisk(path, newContent);

  log.info({ date, summary }, "SESSION_END appended to day-log");
}
