/**
 * HTML-as-Composition parser — v7.4.3.
 *
 * Consumes an HTML file authored under the /root/tmp-video-html/ allowlist and
 * extracts a composition timeline from `data-start`/`data-duration` attributes
 * plus an optional `window.__hf.duration()` override (detected statically via
 * regex; runtime `seek()` is exercised in the renderer, not here).
 *
 * Uses linkedom (already a v7.14 dep) for SSR-safe DOM traversal — no browser
 * spin-up needed for parse-level validation. Parsing is purely for structural
 * checks and duration computation; the renderer is authoritative at run time.
 */

import { parseHTML } from "linkedom";
import { readFileSync, statSync, realpathSync } from "fs";
import path from "path";

/**
 * Absolute-path allowlist — authored HTML must live under this prefix.
 *
 * Uses `/root/tmp-video-html/` instead of `/tmp/` because snap Chromium's
 * AppArmor profile blocks reads from `/tmp/` (confirmed live during v7.4.3
 * smoke test — `page.goto('file:///tmp/...')` returned `ERR_FILE_NOT_FOUND`).
 * Snap's allowed paths include `/root/` so the HTML source must live there.
 */
export const HTML_PATH_ALLOWED_PREFIX = "/root/tmp-video-html/";

/** Path-level forbidden chars mirror composition-protocol.ts for consistency. */
const PATH_FORBIDDEN_CHARS = /[\n\r'"`$\\\0]/;

export interface ParsedHtmlElement {
  tag: string;
  startSec: number;
  durationSec: number;
  trackIndex: number;
  layer: number;
}

export interface ParsedHtmlComposition {
  /** Absolute (realpath'd) path to the HTML file. */
  htmlPath: string;
  /** Total composition duration (seconds, float). */
  totalDurationSec: number;
  /** Explicit duration from `window.__hf.duration()` regex (if detected). */
  declaredDurationSec?: number;
  /** Highest (data-start + data-duration) across annotated elements. */
  dataDrivenDurationSec: number;
  /** Sorted list of timeline-annotated elements. */
  elements: ParsedHtmlElement[];
  /** True if `window.__hf.seek` is statically detected in any <script>. */
  hasSeekFn: boolean;
}

/**
 * Validate that `p` is a safe authored-HTML path. Throws on failure.
 *
 * Defeats: directory traversal, shell metachar injection, symlink-escape
 * outside the allowlist (realpath-check), non-.html file extensions, missing
 * files. Pattern mirrors `isSafeImagePath` from composition-protocol.ts with
 * additional symlink-follow check because realpathSync is cheap here.
 */
export function validateHtmlPath(p: unknown): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("html_path must be a non-empty string");
  }
  if (p.length > 1024) {
    throw new Error("html_path exceeds 1024 chars");
  }
  if (!p.startsWith("/")) {
    throw new Error("html_path must be absolute");
  }
  if (p.includes("..")) {
    throw new Error("html_path must not contain '..'");
  }
  if (PATH_FORBIDDEN_CHARS.test(p)) {
    throw new Error("html_path contains forbidden character");
  }
  if (!p.startsWith(HTML_PATH_ALLOWED_PREFIX)) {
    throw new Error(`html_path must live under ${HTML_PATH_ALLOWED_PREFIX}`);
  }
  if (path.extname(p).toLowerCase() !== ".html") {
    throw new Error("html_path must have .html extension");
  }

  let st;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`html_path does not exist: ${p}`);
  }
  if (!st.isFile()) {
    throw new Error(`html_path is not a regular file: ${p}`);
  }

  // Symlink-escape defense: resolve and re-check allowlist.
  const real = realpathSync(p);
  if (!real.startsWith(HTML_PATH_ALLOWED_PREFIX)) {
    throw new Error(
      `html_path resolves via symlink outside allowlist: ${real}`,
    );
  }
  return real;
}

/**
 * Coerce an HTML attribute string to a non-negative float, clamped to [0, cap].
 * Returns `fallback` for missing/malformed values.
 */
function coerceFloat(
  raw: string | null | undefined,
  fallback: number,
  cap: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, cap);
}

function coerceInt(
  raw: string | null | undefined,
  fallback: number,
  cap: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, cap);
}

/**
 * Detect `window.__hf = { duration: () => N }` statically via regex.
 * Returns the numeric literal if a simple arrow-fn pattern is found;
 * undefined otherwise (the renderer will fall through to data-driven max).
 *
 * Regex is intentionally conservative — only matches `duration: () => <num>`
 * or `duration() { return <num> }`. Dynamic durations (arithmetic, var refs)
 * are ignored at parse time — renderer reads the live value via page.evaluate.
 */
function extractDeclaredDuration(html: string): number | undefined {
  // Pattern 1: `duration: () => 12.5` or `duration:()=>12.5`
  const arrowMatch = html.match(
    /duration\s*:\s*\(\s*\)\s*=>\s*(-?\d+(?:\.\d+)?)/,
  );
  if (arrowMatch) {
    const n = Number(arrowMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Pattern 2: `duration() { return 12.5 }` or `duration(){return 12.5}`
  const fnMatch = html.match(
    /duration\s*\(\s*\)\s*\{\s*return\s+(-?\d+(?:\.\d+)?)\s*;?\s*\}/,
  );
  if (fnMatch) {
    const n = Number(fnMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Static detection of `window.__hf.seek` — informational only. */
function detectSeekFn(html: string): boolean {
  return /__hf\s*[=.]/.test(html) && /seek\s*[:(]/.test(html);
}

/**
 * Parse the HTML composition file and compute a validated timeline.
 *
 * `maxDurationSec` is the caller's ceiling (tool default 120s). Per-element
 * durationSec is clamped to this cap, and the resulting `totalDurationSec` is
 * the max of (data-driven max, declared override) but never exceeds the cap.
 */
export function parseHtmlComposition(
  inputPath: string,
  opts: { maxDurationSec: number },
): ParsedHtmlComposition {
  const maxCap = opts.maxDurationSec;
  if (!Number.isFinite(maxCap) || maxCap <= 0 || maxCap > 600) {
    throw new Error("maxDurationSec must be in (0, 600]");
  }

  const htmlPath = validateHtmlPath(inputPath);
  const raw = readFileSync(htmlPath, "utf8");
  if (raw.length > 2 * 1024 * 1024) {
    throw new Error("HTML file exceeds 2MB cap");
  }

  const { document } = parseHTML(raw);

  const elements: ParsedHtmlElement[] = [];
  // W1 fix: only elements that actually declare a timeline position
  // (data-start OR data-duration) count. Elements carrying only
  // data-track-index or data-layer are decorative markers — including them
  // made coerceFloat default their duration to maxCap, inflating the total
  // composition duration up to the hard cap.
  const annotated = document.querySelectorAll("[data-start], [data-duration]");
  for (const el of Array.from(annotated) as Array<{
    getAttribute: (name: string) => string | null;
    tagName: string;
  }>) {
    const start = coerceFloat(el.getAttribute("data-start"), 0, maxCap);
    const duration = coerceFloat(
      el.getAttribute("data-duration"),
      maxCap - start,
      maxCap,
    );
    const trackIndex = coerceInt(el.getAttribute("data-track-index"), 0, 99);
    const layer = coerceInt(el.getAttribute("data-layer"), 0, 99);
    elements.push({
      tag: String(el.tagName).toLowerCase(),
      startSec: start,
      durationSec: duration,
      trackIndex,
      layer,
    });
  }
  // Sort by start then by layer (for deterministic output)
  elements.sort((a, b) => a.startSec - b.startSec || a.layer - b.layer);

  const dataDrivenDurationSec = elements.reduce(
    (acc, e) => Math.max(acc, e.startSec + e.durationSec),
    0,
  );

  const declaredDurationSec = extractDeclaredDuration(raw);

  const pickDuration = declaredDurationSec ?? dataDrivenDurationSec;
  if (pickDuration <= 0) {
    throw new Error(
      "no timeline found — add data-start/data-duration to at least one element or define window.__hf.duration()",
    );
  }
  const totalDurationSec = Math.min(pickDuration, maxCap);

  return {
    htmlPath,
    totalDurationSec,
    declaredDurationSec,
    dataDrivenDurationSec,
    elements,
    hasSeekFn: detectSeekFn(raw),
  };
}
