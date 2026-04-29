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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Toggle on fenced code blocks (``` or ~~~, with optional language tag)
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    outline.push(`L${i + 1}: ${m[1]} ${m[2]}`);
    if (outline.length >= MAX_OUTLINE_HEADINGS) break;
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
