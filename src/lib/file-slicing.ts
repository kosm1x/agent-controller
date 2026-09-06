/**
 * File-slicing helpers for file_read / jarvis_file_read.
 *
 * Tier B fix for the large-file truncation issue (Session 114): rather than
 * returning full content and leaving the LLM to navigate a buried truncation
 * trailer, these helpers let the model self-chunk via a `lines` parameter
 * and produce a top-level structured envelope when the file is large.
 */

/** Maximum number of markdown headings to surface in the outline. */
const MAX_OUTLINE_HEADINGS = 30;

/**
 * Maximum timestamped log entries (`- [HH:MM:SS] **WHO**: …`) surfaced in the
 * outline. Day-logs are flat lists under ONE heading, so a headings-only
 * outline gave the model nothing to navigate by: on 2026-09-06 it read the
 * 2026-09-05 log twice, guessed a slice, and reported «no hay entrada a las
 * 11:45» while L31 was exactly that entry. Each entry costs ~70 chars, so
 * 150 entries ≈ 10 KB — still well under a 20–50 KB log.
 */
const MAX_OUTLINE_ENTRIES = 150;

/** Chars of entry text kept after the timestamp/speaker in an outline entry. */
const ENTRY_SNIPPET_CHARS = 60;

/**
 * Snippet shapes that are probably a credential (a pasted session token, a
 * «Pswd: …» line) — the outline shows a placeholder instead (qa-audit W2:
 * 106 such snippets across the live day-logs would otherwise surface on
 * every large-file read, not only when that range is requested).
 */
const SECRET_SHAPED_SNIPPET =
  /(?:^|[\s"'`(=:;,])[A-Za-z0-9%+/=_-]{32,}(?=$|[\s"'`);,.])|\{[0-9A-Fa-f-]{32,}\}|\b(?:pswd|passwd|password|contrase[ñn]a|api[_ -]?key|secret|token)\b\s*[:=]/i;
const MASKED_SNIPPET = "[contenido omitido — posible credencial]";

/** Timestamped log entry: `- [11:45:00] **USER**: text` (speaker optional). */
const LOG_ENTRY_RE =
  /^-\s+\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(?:\*\*([^*]+)\*\*:?\s*)?(.*)$/;

/** Maximum total lines that can be requested via the lines parameter. */
const MAX_LINES_PER_REQUEST = 2_000;

/** Char count used in the structured "preview" field for large files. */
const PREVIEW_CHARS = 1_500;

export interface LineRange {
  start: number; // 1-indexed, inclusive
  end: number; // 1-indexed, inclusive
}

/**
 * Parse a `lines` argument like `"1-200"`, `"50-150"`, or `"1-50,200-250"`
 * (multiple ranges, comma-separated) into validated LineRange objects.
 *
 * Throws on malformed input — caller should wrap in try/catch and surface as
 * an error envelope.
 */
export function parseLineRanges(spec: string): LineRange[] {
  if (typeof spec !== "string" || spec.trim().length === 0) {
    throw new Error("lines must be a non-empty string");
  }

  const ranges: LineRange[] = [];
  const parts = spec.split(",").map((p) => p.trim());

  for (const part of parts) {
    if (!/^\d+-\d+$/.test(part) && !/^\d+$/.test(part)) {
      throw new Error(
        `lines must be 'N-M' or 'N' (one-indexed), got: '${part}'`,
      );
    }

    let start: number;
    let end: number;
    if (part.includes("-")) {
      const [s, e] = part.split("-").map(Number);
      start = s;
      end = e;
    } else {
      const n = Number(part);
      start = n;
      end = n;
    }

    if (start < 1 || end < 1) {
      throw new Error(
        `line numbers must be >= 1 (one-indexed), got: '${part}'`,
      );
    }
    if (end < start) {
      throw new Error(`range '${part}' has end < start`);
    }
    ranges.push({ start, end });
  }

  return ranges;
}

/**
 * Extract the requested line ranges from `content`. Out-of-bounds ranges
 * clamp to the available line count rather than erroring — a request for
 * lines 1-1000 on a 50-line file returns the 50 lines, not an error.
 *
 * Returns the joined slice, the total line count of the source, the number
 * of lines the slice contains, `clamped: true` when any range exceeded the
 * file size, and `lineCapped: true` when MAX_LINES_PER_REQUEST was hit
 * (separate signal so the model knows whether to paginate).
 *
 * CRLF inputs (`\r\n`) are normalized — both the `\n` split and the trailing
 * `\r` are stripped so the slice and outline don't carry stray carriage
 * returns into the JSON envelope.
 */
export function extractLineRanges(
  content: string,
  ranges: LineRange[],
): {
  slice: string;
  totalLines: number;
  sliceLines: number;
  clamped: boolean;
  lineCapped: boolean;
} {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  const collected: string[] = [];
  const seen = new Set<number>(); // dedupe overlapping ranges
  let clamped = false;

  for (const { start, end } of ranges) {
    const clampedStart = Math.max(1, start);
    const clampedEnd = Math.min(totalLines, end);
    if (end > totalLines) clamped = true;

    for (let i = clampedStart; i <= clampedEnd; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      collected.push(lines[i - 1]);
      if (collected.length >= MAX_LINES_PER_REQUEST) {
        return {
          slice: collected.join("\n"),
          totalLines,
          sliceLines: collected.length,
          clamped,
          lineCapped: true,
        };
      }
    }
  }

  return {
    slice: collected.join("\n"),
    totalLines,
    sliceLines: collected.length,
    clamped,
    lineCapped: false,
  };
}

/**
 * Build a markdown outline from a string — first MAX_OUTLINE_HEADINGS h1-h6
 * headings, ordered as they appear, with their 1-indexed line numbers so the
 * model can map directly to a `lines` request.
 *
 * Returns an array of `"L42: # Section title"`-shaped strings — the line
 * number prefix is the load-bearing signal because it tells the model exactly
 * which `lines` arg to use to read each section.
 *
 * Skips heading-shaped lines INSIDE fenced code blocks (` ``` ` or ` ~~~ `)
 * because those are content, not structure — common in markdown notes that
 * paste shell prompts, comments, or other documents.
 *
 * Tolerates CRLF inputs by splitting on `\r?\n` and stripping any stray `\r`.
 */
export function buildOutline(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const outline: string[] = [];
  let inFence = false;
  let headings = 0;
  let entries = 0;
  let lastEntryLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Toggle on fenced code blocks (``` or ~~~, with optional language tag)
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (headings < MAX_OUTLINE_HEADINGS) {
        outline.push(`L${i + 1}: ${m[1]} ${m[2]}`);
        headings++;
      }
      continue;
    }

    // Timestamped log entries (day-log shape) — see MAX_OUTLINE_ENTRIES.
    const e = LOG_ENTRY_RE.exec(line);
    if (!e) continue;
    entries++;
    if (entries > MAX_OUTLINE_ENTRIES) continue;
    lastEntryLine = i + 1;
    const speaker = e[2] ? ` ${e[2].trim()}:` : "";
    const text = e[3].replace(/\s+/g, " ").trim();
    const snippet = SECRET_SHAPED_SNIPPET.test(text)
      ? MASKED_SNIPPET
      : text.slice(0, ENTRY_SNIPPET_CHARS);
    outline.push(`L${i + 1}: [${e[1]}]${speaker} ${snippet}`.trimEnd());
  }

  if (entries > MAX_OUTLINE_ENTRIES) {
    outline.push(
      `… +${entries - MAX_OUTLINE_ENTRIES} more timestamped entries after L${lastEntryLine} (read them with lines='${lastEntryLine + 1}-${lines.length}')`,
    );
  }

  return outline;
}

/**
 * Total line count of a string. Empty string is 1 line (matches `wc -l + 1`
 * semantics — the absence of a trailing newline still represents one line of
 * content). Tolerates CRLF inputs.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 1;
  return content.split(/\r?\n/).length;
}

/** Char count used in the structured "preview" field for large files. */
export { PREVIEW_CHARS };
