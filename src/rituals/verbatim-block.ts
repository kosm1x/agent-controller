/**
 * Harness-loaded KB files for ritual templates (2026-10-03).
 *
 * `jarvis_file_read` returns an OUTLINE for any file over LARGE_FILE_THRESHOLD
 * (8,000 chars): one line per log entry cut at 60 chars. The nightly close
 * read the day-log once and reported from those stubs (18 of 25 recent closes
 * with a large log), so work finished past char 60 of an entry came out as
 * "open". The scheduler now loads the file itself and the template embeds it
 * verbatim; the model never has to page through it.
 */

import { getFile } from "../db/jarvis-fs.js";
import { redactCredentialsForPersist } from "../api/mcp-server/redact.js";

/**
 * Embed cap. Day-logs in the 30 days to 2026-10-03 peaked at 99,187 chars
 * (narratives at 16,448); 120,000 keeps every one of them whole, ~35k tokens.
 * Over the cap the END of the day is kept (where an item's final state is)
 * and the block header states what was dropped.
 */
export const VERBATIM_MAX_CHARS = 120_000;

/**
 * The file's content, or null when it does not exist or is blank. Credential
 * shapes are redacted (the stored-text redactor, incl. Telegram bot tokens):
 * the embedded text is persisted in `tasks.description` and `task.created`
 * events every run.
 */
export function loadKbText(path: string): string | null {
  const content = getFile(path)?.content;
  if (!content || !content.trim()) return null;
  return redactCredentialsForPersist(content) ?? content;
}

// The fence characters. Stripped from the content (→ [ ]) so nothing inside
// the block can close it or open a fake one.
const OPEN = "⟦";
const CLOSE = "⟧";

export function fenceBegin(label: string): string {
  return `${OPEN}BEGIN ${label}`;
}

export function fenceEnd(label: string): string {
  return `${OPEN}END ${label}${CLOSE}`;
}

/**
 * Render `content` as a fenced, data-only block. `label` names the block in
 * both fences (e.g. "DAY-LOG"); the header line carries the source path and
 * the size, plus the drop notice when the cap cut the start.
 */
export function renderVerbatimBlock(
  label: string,
  path: string,
  content: string,
  maxChars: number = VERBATIM_MAX_CHARS,
): string {
  let body = content.replaceAll(OPEN, "[").replaceAll(CLOSE, "]").trimEnd();
  const total = body.length;
  let note = `${total.toLocaleString("en-US")} chars, complete`;
  if (total > maxChars) {
    // Cut at a line start so no entry is half-kept; with no line break in the
    // kept window, a plain cut that never splits a surrogate pair.
    const nl = body.indexOf("\n", total - maxChars - 1);
    let from = nl === -1 ? total - maxChars : nl + 1;
    if (nl === -1) {
      const c = body.charCodeAt(from);
      if (c >= 0xdc00 && c <= 0xdfff) from++;
    }
    const droppedEntries = (body.slice(0, from).match(/^- \[/gm) ?? []).length;
    body = body.slice(from);
    note = `TRUNCATED — the first ${from.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} chars (${droppedEntries} entries) were dropped; what follows is the END of the day`;
  }
  return `${fenceBegin(label)} — ${path} — ${note}${CLOSE}\n${body}\n${fenceEnd(label)}`;
}
