/**
 * The day log: the per-entry cut and the append of one user or Jarvis turn
 * to the day's log file in the knowledge base.
 *
 * This module must not import the message router: the router imports these
 * names and re-exports `dayLogEntryText` for its existing callers, so an
 * import back would make the two a cycle.
 */
import { getDatabase } from "../db/index.js";
import { safeSlice } from "../lib/unicode-safe.js";
import { getFile, mirrorToDisk } from "../db/jarvis-fs.js";
import { scrubSecrets } from "../lib/secret-refs.js";
import { withholdForStore } from "../lib/v8-4/store-withhold.js";

// ---------------------------------------------------------------------------
// Day log — mechanical append of every user + Jarvis exchange to jarvis_files DB.
// No LLM involvement, no scheduled task — direct DB write on every message.
// Writes to jarvis_files table (where jarvis_file_read reads from) + disk mirror.
// ---------------------------------------------------------------------------

/** Per-entry cap for the day-log. */
const DAY_LOG_ENTRY_MAX = 500;

/**
 * The day-log entry text: cut at DAY_LOG_ENTRY_MAX and, only when the text
 * was actually cut, marked with one trailing "…" (2026-10-03) so the rituals
 * reading the log can tell a cut entry from a complete one. Not doubled when
 * the cut already ends in "…".
 */
export function dayLogEntryText(text: string): string {
  const cut = safeSlice(text, DAY_LOG_ENTRY_MAX);
  return cut.length < text.length && !cut.endsWith("…") ? `${cut}…` : cut;
}

export function appendDayLog(role: "USER" | "JARVIS", text: string): void {
  try {
    const now = new Date();
    const date = now.toLocaleDateString("en-CA", {
      timeZone: "America/Mexico_City",
    }); // YYYY-MM-DD
    const time = now.toLocaleTimeString("es-MX", {
      timeZone: "America/Mexico_City",
      hour12: false,
    });

    const path = `logs/day-logs/${date}.md`;
    // Ruling 3c (audit R3 S3): stored credential values scrubbed before the cut;
    // the mailbox-password store rule (store-withhold.ts) too, so a cut never
    // leaves part of a value; dayLogEntryText then cuts and marks a truncated
    // entry with "…".
    const entry = `- [${time}] **${role}**: ${dayLogEntryText(withholdForStore(scrubSecrets(text))).replace(/\n/g, " ")}\n`;

    // Synchronous read-append-write via jarvis_files DB (atomic per SQLite)
    const existing = getFile(path);
    const content = existing
      ? existing.content + entry
      : `# Day Log: ${date}\n\n${entry}`;

    // Direct DB write — skip pgvector embedding + Drive sync + index regen.
    // Day logs are ephemeral workspace entries; embedding/syncing them is waste.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO jarvis_files (id, path, title, content, tags, qualifier, priority, related_to, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         content = excluded.content, updated_at = datetime('now')`,
    ).run(
      path,
      path,
      `Day Log: ${date}`,
      content,
      '["day-log"]',
      "workspace",
      90,
      "[]",
    );
    mirrorToDisk(path, content);
  } catch {
    // Non-fatal — never block message processing for logging
  }
}
