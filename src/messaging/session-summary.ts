/**
 * Session-end summary — appended to the day-log after a conversation
 * goes idle for SESSION_IDLE_THRESHOLD_MS.
 *
 * Purpose: give the morning brief a definitive record that interactions
 * from a session completed successfully, so it never reports "incierto"
 * for exchanges that did produce a result.
 *
 * Format appended to the day-log:
 *   - [HH:MM:SS] **JARVIS**: [SESSION_END] N interacciones · temas: X, Y · completado
 */

/** 20 minutes of inactivity = session ended. */
export const SESSION_IDLE_THRESHOLD_MS = 20 * 60 * 1000;

/** How often we poll for idle sessions (5 min). */
export const SESSION_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionEntry {
  role: "USER" | "JARVIS";
  text: string;
  time: string; // HH:MM:SS from the log
}

/**
 * Parse raw day-log content into entries.
 * Handles lines like: `- [HH:MM:SS] **USER**: text`
 */
export function parseDayLogEntries(content: string): SessionEntry[] {
  const LINE_RE = /^- \[(\d{2}:\d{2}:\d{2})\] \*\*(USER|JARVIS)\*\*: (.+)$/;
  const entries: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (m) {
      entries.push({ time: m[1], role: m[2] as "USER" | "JARVIS", text: m[3] });
    }
  }
  return entries;
}

/**
 * Check whether the log already has a SESSION_END marker after the last
 * USER entry — avoids writing duplicates if the idle timer fires twice.
 */
export function hasRecentSessionEnd(entries: SessionEntry[]): boolean {
  // Find the index of the last USER message
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "USER") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return true; // no USER entries → nothing to summarise

  // Any JARVIS SESSION_END after the last USER message means we're done
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    if (
      entries[i].role === "JARVIS" &&
      entries[i].text.includes("[SESSION_END]")
    ) {
      return true;
    }
  }
  return false;
}

/** Stop words filtered when extracting topics (ES + EN). */
const STOP = new Set([
  "el","la","los","las","un","una","de","del","en","con","por","para","que",
  "qué","como","cómo","es","son","me","mi","te","se","yo","tu","su","the","a",
  "an","of","in","to","for","and","is","are","do","did","will","can","hay",
  "no","si","sí","ya","más","muy","pero","haz","dame","dime","muestra",
]);

/**
 * Derive up to 4 topic snippets from USER messages in the current session block.
 * Session block = entries after the last SESSION_END (or all entries).
 */
function extractTopics(entries: SessionEntry[]): string[] {
  // Start of current block
  let blockStart = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (
      entries[i].role === "JARVIS" &&
      entries[i].text.includes("[SESSION_END]")
    ) {
      blockStart = i + 1;
      break;
    }
  }

  const userMessages = entries
    .slice(blockStart)
    .filter((e) => e.role === "USER");
  if (userMessages.length === 0) return [];

  const seen = new Set<string>();
  const topics: string[] = [];

  for (const entry of userMessages.slice(0, 8)) {
    const words = entry.text
      .toLowerCase()
      .replace(/[^a-záéíóúüñ0-9\s]/gi, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w));
    const topic = words.slice(0, 3).join(" ");
    if (topic && !seen.has(topic)) {
      seen.add(topic);
      topics.push(topic);
    }
  }

  return topics.slice(0, 4);
}

/**
 * Build the SESSION_END summary text to append to the day-log.
 * Returns null if there is nothing new to summarise (no USER messages
 * since the last SESSION_END, or a SESSION_END already written).
 *
 * Pure function — no IO side effects, fully testable.
 */
export function buildSessionSummary(
  entries: SessionEntry[],
  _isoDate: string,
): string | null {
  if (hasRecentSessionEnd(entries)) return null;

  // Count interactions in the current block
  let blockStart = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (
      entries[i].role === "JARVIS" &&
      entries[i].text.includes("[SESSION_END]")
    ) {
      blockStart = i + 1;
      break;
    }
  }

  const block = entries.slice(blockStart);
  const userCount = block.filter((e) => e.role === "USER").length;
  if (userCount === 0) return null;

  const topics = extractTopics(entries);
  const topicStr =
    topics.length > 0
      ? `temas: ${topics.join(", ")}`
      : "sin temas identificados";

  const noun = userCount === 1 ? "interacción" : "interacciones";
  return `[SESSION_END] ${userCount} ${noun} · ${topicStr} · completado`;
}
