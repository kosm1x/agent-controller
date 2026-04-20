/**
 * v7.10 — file_convert tool.
 *
 * Dispatches to FLOSS CLI binaries installed via apt (calibre, libreoffice,
 * pandoc, imagemagick, ffmpeg). Closes gaps Jarvis has in reading formats
 * the Node runtime can't parse natively: ebooks, office docs, HEIC/AVIF,
 * video frames.
 *
 * Security: `execFile` with arg array (no shell). Source path must be
 * absolute and resolve under a whitelisted read sandbox. Target format
 * is Zod-enum constrained. Output lands in /tmp or /workspace only.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  statSync,
  lstatSync,
  existsSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { resolve, extname, basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool } from "../types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Allowed source path prefixes. Inputs must resolve under ONE of these.
 * Deliberately excludes `src/` of mission-control to prevent abuse of the
 * tool as a self-source-code reader (file_read already handles that case
 * with its own guards). Outputs never live outside `/tmp` or `/workspace`.
 */
const SOURCE_ALLOW_PREFIXES = [
  "/tmp/",
  "/workspace/",
  "/root/claude/jarvis-kb/",
  "/root/claude/projects/",
  "/root/claude/mission-control/public/docs/",
];

const OUTPUT_ALLOW_PREFIXES = ["/tmp/", "/workspace/"];

const TARGET_FORMATS = [
  "txt",
  "pdf",
  "epub",
  "docx",
  "html",
  "md",
  "jpeg",
  "png",
  "webp",
] as const;
type TargetFormat = (typeof TARGET_FORMATS)[number];

interface DispatchEntry {
  /** Binary name (on PATH). */
  bin: string;
  /** Build argv for execFile. Returns args array. */
  args: (
    input: string,
    output: string,
    target: TargetFormat,
    opts: { timestampSec: number },
  ) => string[];
  /** Some binaries emit next to the input; this function returns the actual
   *  produced path given the LibreOffice `--outdir DIR` convention, etc.
   *  Most binaries write exactly to `output` — default. */
  resolveActualOutput?: (
    input: string,
    output: string,
    target: TargetFormat,
  ) => string;
  /** Supported target formats for this entry. */
  targets: ReadonlySet<TargetFormat>;
}

const EBOOK_SOURCES = new Set([".epub", ".mobi", ".azw", ".azw3", ".fb2"]);
const OFFICE_SOURCES = new Set([
  ".odt",
  ".rtf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".pages",
  ".key",
]);
const PANDOC_SOURCES = new Set([
  ".md",
  ".html",
  ".rst",
  ".tex",
  ".org",
  ".adoc",
]);
const IMAGE_SOURCES = new Set([
  ".heic",
  ".heif",
  ".avif",
  ".jxl",
  ".tiff",
  ".tif",
  ".bmp",
  ".webp",
  ".png",
  ".jpg",
  ".jpeg",
]);
const VIDEO_SOURCES = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

const DISPATCH: Array<{
  match: (ext: string) => boolean;
  entry: DispatchEntry;
}> = [
  {
    match: (ext) => EBOOK_SOURCES.has(ext),
    entry: {
      bin: "ebook-convert",
      args: (input, output) => [input, output],
      targets: new Set(["txt", "pdf", "epub", "docx", "html", "md"]),
    },
  },
  {
    match: (ext) => OFFICE_SOURCES.has(ext),
    entry: {
      bin: "libreoffice",
      args: (input, output, target) => [
        "--headless",
        "--convert-to",
        target,
        "--outdir",
        dirname(output),
        input,
      ],
      // LibreOffice writes `<outdir>/<basename-without-ext>.<target>` — ignores
      // the caller's desired filename. Resolve the actual produced path so
      // we can stat it, then the caller can `mv` if they need an exact name.
      resolveActualOutput: (input, output, target) => {
        const stem = basename(input, extname(input));
        return `${dirname(output)}/${stem}.${target}`;
      },
      targets: new Set(["pdf", "docx", "html", "txt", "md"]),
    },
  },
  {
    match: (ext) => PANDOC_SOURCES.has(ext),
    entry: {
      bin: "pandoc",
      args: (input, output) => [input, "-o", output],
      targets: new Set(["html", "md", "pdf", "docx", "epub", "txt"]),
    },
  },
  {
    match: (ext) => IMAGE_SOURCES.has(ext),
    entry: {
      // ImageMagick 6 on Ubuntu Noble ships `convert`; v7 renamed to `magick`.
      // Stick with `convert` — more portable across the distros we target.
      bin: "convert",
      args: (input, output) => [input, output],
      targets: new Set(["jpeg", "png", "webp"]),
    },
  },
  {
    match: (ext) => VIDEO_SOURCES.has(ext),
    entry: {
      bin: "ffmpeg",
      // `-ss BEFORE -i` seeks via input demuxer — instant on keyframe-aligned
      // videos. `-vframes 1` grabs exactly one frame. `-q:v 2` = high quality.
      // `-y` overwrites existing output silently.
      args: (input, output, _target, { timestampSec }) => [
        "-ss",
        String(timestampSec),
        "-i",
        input,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-y",
        output,
      ],
      targets: new Set(["jpeg", "png"]),
    },
  },
];

function isUnderPrefix(abs: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => abs === p.replace(/\/$/, "") || abs.startsWith(p),
  );
}

function validateInputPath(
  input: string,
): { ok: true; abs: string } | { ok: false; error: string } {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "input_path required" };
  }
  if (!input.startsWith("/")) {
    return { ok: false, error: "input_path must be absolute" };
  }
  const abs = resolve(input);
  if (abs !== input) {
    return {
      ok: false,
      error: "input_path must be canonical (no .. / symlink jumps)",
    };
  }
  if (!isUnderPrefix(abs, SOURCE_ALLOW_PREFIXES)) {
    return {
      ok: false,
      error: `input_path must be under one of: ${SOURCE_ALLOW_PREFIXES.join(", ")}`,
    };
  }
  if (!existsSync(abs)) {
    return { ok: false, error: `input_path does not exist: ${abs}` };
  }
  // Audit C1: `statSync` follows symlinks. Without an lstat check a link
  // under /tmp/ → /etc/shadow would pass every prior guard (absolute,
  // canonical, under whitelist, exists, isFile()) and feed the target into
  // pandoc/libreoffice. Reject symlinks outright.
  const lst = lstatSync(abs);
  if (lst.isSymbolicLink()) {
    return { ok: false, error: "input_path must not be a symlink" };
  }
  if (!lst.isFile()) {
    return { ok: false, error: "input_path must be a regular file" };
  }
  // Re-validate the resolved real path against the allow-list to defend
  // against an intermediate path component being a symlink out of the
  // sandbox (e.g. /tmp/evil → /etc, then /tmp/evil/passwd).
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, error: `input_path realpath failed: ${abs}` };
  }
  if (!isUnderPrefix(real, SOURCE_ALLOW_PREFIXES)) {
    return {
      ok: false,
      error: "input_path realpath escapes the allowed sandbox",
    };
  }
  return { ok: true, abs };
}

function validateOutputPath(
  output: string | undefined,
  target: TargetFormat,
): { ok: true; abs: string } | { ok: false; error: string } {
  if (!output) {
    return { ok: true, abs: `/tmp/file-convert-${randomUUID()}.${target}` };
  }
  if (!output.startsWith("/")) {
    return { ok: false, error: "output_path must be absolute" };
  }
  const abs = resolve(output);
  if (abs !== output) {
    return { ok: false, error: "output_path must be canonical" };
  }
  if (!isUnderPrefix(abs, OUTPUT_ALLOW_PREFIXES)) {
    return {
      ok: false,
      error: `output_path must be under one of: ${OUTPUT_ALLOW_PREFIXES.join(", ")}`,
    };
  }
  return { ok: true, abs };
}

export const fileConvertTool: Tool = {
  name: "file_convert",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "file_convert",
      description: `Convert a file between formats using FLOSS CLI tools (calibre, libreoffice, pandoc, imagemagick, ffmpeg).

USE WHEN:
- Reading a format Node can't parse natively: .epub/.mobi (calibre), .odt/.rtf/.pages/.doc (libreoffice), HEIC/AVIF/JXL images (imagemagick), video frames (ffmpeg)
- Producing a specific output format from markdown/html/rst (pandoc)
- Extracting a single frame from a video for vision analysis

DO NOT USE for:
- Audio transcription (no coverage here — separate tool)
- Batch multi-file conversion (one file per call)
- Reading plain .txt / .json / .md (use file_read — faster)

DISPATCH (source extension → binary):
- .epub .mobi .azw .azw3 .fb2 → ebook-convert
- .odt .rtf .doc .docx .ppt .pptx .xls .xlsx .pages .key → libreoffice
- .md .html .rst .tex .org .adoc → pandoc
- .heic .heif .avif .jxl .tiff .bmp .webp .png .jpg → imagemagick
- .mp4 .mov .avi .mkv .webm → ffmpeg (frame extraction)

Source must be absolute path under /tmp, /workspace, /root/claude/jarvis-kb, /root/claude/projects, or mission-control/public/docs. Output defaults to /tmp. Output file is OVERWRITTEN if it already exists.

First LibreOffice call takes 5-15s (cold start). Subsequent calls are fast.`,
      parameters: {
        type: "object",
        properties: {
          input_path: {
            type: "string",
            description:
              "Absolute path to source file. Must exist and be a regular file under an allowed read sandbox.",
          },
          target_format: {
            type: "string",
            enum: [...TARGET_FORMATS],
            description:
              "Output format. Must be compatible with the source extension's dispatch (e.g. video sources only support jpeg/png; images only support jpeg/png/webp).",
          },
          output_path: {
            type: "string",
            description:
              "Optional absolute output path under /tmp or /workspace. Defaults to /tmp/file-convert-<uuid>.<target>.",
          },
          timestamp_sec: {
            type: "number",
            description:
              "Video frame extraction only — seconds offset into the video. Default 1.0. Ignored for non-video sources.",
          },
        },
        required: ["input_path", "target_format"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const inputRaw = args.input_path as string;
    const target = args.target_format as TargetFormat;
    const outputRaw = args.output_path as string | undefined;
    // Audit C2: reject Infinity / NaN / negative / day-exceeding values.
    // Infinity passes `typeof === "number" && > 0` and reaches ffmpeg as
    // literal `-ss Infinity`, producing an opaque failure surface.
    const tsRaw = args.timestamp_sec;
    const timestampSec =
      typeof tsRaw === "number" &&
      Number.isFinite(tsRaw) &&
      tsRaw >= 0 &&
      tsRaw < 86_400
        ? tsRaw
        : 1.0;

    if (!TARGET_FORMATS.includes(target)) {
      return JSON.stringify({
        error: `target_format must be one of: ${TARGET_FORMATS.join(", ")}`,
      });
    }

    const inputCheck = validateInputPath(inputRaw);
    if (!inputCheck.ok) return JSON.stringify({ error: inputCheck.error });

    const outputCheck = validateOutputPath(outputRaw, target);
    if (!outputCheck.ok) return JSON.stringify({ error: outputCheck.error });

    const ext = extname(inputCheck.abs).toLowerCase();
    const dispatch = DISPATCH.find((d) => d.match(ext));
    if (!dispatch) {
      return JSON.stringify({
        error: `unsupported source extension: ${ext || "(none)"}. Supported: ebook (.epub, .mobi), office (.odt, .docx, ...), text (.md, .html, ...), image (.heic, .avif, ...), video (.mp4, .mov, ...)`,
      });
    }

    if (!dispatch.entry.targets.has(target)) {
      return JSON.stringify({
        error: `target ${target} not supported for ${ext} source. Supported targets: ${[...dispatch.entry.targets].join(", ")}`,
      });
    }

    const argv = dispatch.entry.args(inputCheck.abs, outputCheck.abs, target, {
      timestampSec,
    });
    const start = Date.now();
    try {
      await execFileAsync(dispatch.entry.bin, argv, {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // binaries are mostly silent; 10MB is plenty
      });
    } catch (err) {
      const e = err as Error & {
        code?: number | string;
        killed?: boolean;
        signal?: string;
      };
      if (e.code === "ENOENT") {
        return JSON.stringify({
          error: `binary not installed: ${dispatch.entry.bin}. Run \`apt install calibre libreoffice pandoc imagemagick libvips-tools ffmpeg\` on the VPS.`,
        });
      }
      if (e.killed && e.signal === "SIGTERM") {
        return JSON.stringify({
          error: `conversion timed out after ${DEFAULT_TIMEOUT_MS}ms. LibreOffice cold-start can hit 15s; retry once before giving up.`,
        });
      }
      return JSON.stringify({
        error: `conversion failed: ${e.message || String(err)}`,
        binary: dispatch.entry.bin,
      });
    }

    const actualOutput = dispatch.entry.resolveActualOutput
      ? dispatch.entry.resolveActualOutput(
          inputCheck.abs,
          outputCheck.abs,
          target,
        )
      : outputCheck.abs;

    if (!existsSync(actualOutput)) {
      return JSON.stringify({
        error: `${dispatch.entry.bin} exited cleanly but produced no output at ${actualOutput}`,
      });
    }
    // Audit W2 + W-R2-2: LibreOffice ignores the caller's requested
    // filename and writes to `<outdir>/<stem>.<target>`. Rename to the
    // advertised output path (whether caller-supplied OR the auto-uuid
    // default) so the tool contract is consistent across dispatch
    // branches. Overwrites silently — documented in the tool description
    // to avoid caller surprise.
    let finalOutput = actualOutput;
    if (actualOutput !== outputCheck.abs) {
      try {
        renameSync(actualOutput, outputCheck.abs);
        finalOutput = outputCheck.abs;
      } catch {
        // Non-fatal — fall back to reporting the actual path. Caller sees
        // the output line and can re-read from there.
        finalOutput = actualOutput;
      }
    }
    const bytes = statSync(finalOutput).size;
    const durationMs = Date.now() - start;

    return `file_convert: ${basename(inputCheck.abs)} → ${target}
  output: ${finalOutput}
  bytes:  ${bytes}
  dur_ms: ${durationMs}
  binary: ${dispatch.entry.bin}`;
  },
};
