/**
 * Code search tools — grep (content search) and glob (file discovery).
 *
 * Adapted from open-swe patterns. These give the LLM the ability to explore
 * and understand codebases without resorting to shell_exec + grep/find, which
 * has worse error handling and inconsistent output formats.
 */

import { execFileSync, spawn } from "child_process";
import { statSync } from "fs";
import { resolve } from "path";
import type { Tool } from "../types.js";
import { readDenylistReason, validatePathSafety } from "./immutable-core.js";
import { kernelWalk } from "./write-guard.js";
import { redactCredentials } from "../../api/mcp-server/redact.js";
import { scrubSecrets, secretSpans } from "../../lib/secret-refs.js";

const MAX_RESULTS = 100;
const MAX_OUTPUT = 15_000; // chars
/**
 * Ruling 3c (audit round 8, B-2): a fixed per-file cap on the UNDERLYING
 * search, far above any user `max_results`, so output stays bounded without a
 * secret-dependent limit-before-filter. The visible cap (`max_results`) is
 * applied in JS AFTER value-span filtering, so a dropped value-line never
 * consumes a visible slot.
 */
const INTERNAL_MAXCOUNT = 2000;

/**
 * Combined-audit B1 (2026-10-03): byte cap on the search's stdout. Line mode
 * (round 8) reads every matching line, so a broad pattern ("const" over src)
 * outgrew the old 2 MB `maxBuffer`: rg threw ENOBUFS, fell back to grep, which
 * overflowed too and the tool returned an error. Output is now streamed and
 * cut at this cap (at the last complete line), and the result says
 * `truncated: true`. A cap hit is an answer, never a reason to re-run grep.
 */
const DEFAULT_SEARCH_BYTE_CAP = 64 * 1024 * 1024;
let searchByteCap = DEFAULT_SEARCH_BYTE_CAP;
/** Test hook: lower the stdout byte cap (no argument restores the default). */
export function __setSearchByteCapForTests(bytes?: number): void {
  searchByteCap = bytes ?? DEFAULT_SEARCH_BYTE_CAP;
}

interface CappedRun {
  stdout: string;
  stderr: string;
  /** Exit code; null when killed (cap or timeout) or not started. */
  status: number | null;
  /** True when stdout reached the byte cap and the child was stopped. */
  capped: boolean;
  timedOut: boolean;
  /** Spawn error code (e.g. ENOENT when the binary is missing). */
  code?: string;
}

/**
 * Run `cmd args` (no shell) and collect stdout up to `cap` bytes. On the cap
 * the child is killed and stdout is cut after its last complete line, so no
 * partial record reaches the parser.
 */
function runCapped(
  cmd: string,
  args: string[],
  cap: number,
  timeoutMs: number,
  cwd?: string,
): Promise<CappedRun> {
  return new Promise((resolveRun) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let capped = false;
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<CappedRun, "stdout" | "stderr" | "capped" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let buf = Buffer.concat(out);
      if (capped) {
        const nl = buf.lastIndexOf(0x0a);
        buf = nl === -1 ? Buffer.alloc(0) : buf.subarray(0, nl + 1);
      }
      resolveRun({
        ...r,
        stdout: buf.toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        capped,
        timedOut,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(cwd !== undefined && { cwd }),
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      resolveRun({ stdout: "", stderr: String(e), status: null, capped: false, timedOut: false, code });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (capped) return;
      const room = cap - outBytes;
      if (chunk.length >= room) {
        out.push(chunk.subarray(0, room));
        outBytes = cap;
        capped = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      // stderr is only reported in an error; keep a small bounded head.
      if (errBytes < 64 * 1024) {
        err.push(chunk);
        errBytes += chunk.length;
      }
    });
    child.on("error", (e) => {
      finish({ status: null, code: (e as { code?: string }).code });
    });
    child.on("close", (status) => {
      finish({ status });
    });
  });
}

/**
 * A listed name is refused on its spelling AND where the kernel lands: the
 * listing runs from the base path the kernel walked, so `link/..` in the base
 * (or `/proc/self/cwd/..`) lists a different tree than resolve() names
 * (audit 2026-10-01 C1). A walk through a /proc magic link (another
 * process's filesystem view) is refused outright (C1-R2).
 */
function listedBlocked(p: string): boolean {
  const walk = kernelWalk(p);
  return (
    walk.procLink !== null ||
    readDenylistReason(resolve(p)) !== null ||
    readDenylistReason(walk.path) !== null
  );
}

// ---------------------------------------------------------------------------
// grep — content search
// ---------------------------------------------------------------------------

/**
 * Map a record of an rg run made FROM `searchPath` with path "." ("./rel")
 * back to the form rg prints for `searchPath` itself (Path::join: one "/"
 * unless the root already ends with "/"), so the read denylist judges the
 * real location. Any other record shape cannot be placed under the root and
 * is dropped (""): fail closed, never judged as a path relative to the
 * process cwd.
 */
export function rgRecordMapper(searchPath: string): (f: string) => string {
  const base = searchPath.endsWith("/") ? searchPath : `${searchPath}/`;
  return (f) => (f.startsWith("./") ? base + f.slice(2) : "");
}


/**
 * Ruling 3c (audit round 8, B-2): parse NUL-delimited line-mode output
 * (`path\0lineno:line\n`) into per-line records, dropping every record whose
 * file the read denylist refuses (the same fail-closed check as
 * `dropBlockedFiles`). Always run in line mode so each line's text can be
 * inspected for stored-value spans; files / count are derived from the kept
 * lines, never from the raw tool's own `-l` / `-c` output.
 */
function parseLineRecords(
  output: string,
  mapFile: (file: string) => string = (f) => f,
): Array<{ file: string; lineno: string; content: string }> {
  const verdicts = new Map<string, boolean>();
  const allowed = (file: string): boolean => {
    let ok = verdicts.get(file);
    if (ok === undefined) {
      ok = [file, ...file.split("\n")].every(
        (f) => !!f && validatePathSafety(f, "read").safe,
      );
      verdicts.set(file, ok);
    }
    return ok;
  };
  const out: Array<{ file: string; lineno: string; content: string }> = [];
  const chunks = output.split("\0");
  let file = chunks[0] ?? "";
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const nl = chunk.indexOf("\n");
    const text = nl === -1 ? chunk : chunk.slice(0, nl);
    if (file) file = mapFile(file);
    if (file && allowed(file)) {
      const m = /^(\d+):([\s\S]*)$/.exec(text);
      out.push(
        m
          ? { file, lineno: m[1]!, content: m[2]! }
          : { file, lineno: "", content: text },
      );
    }
    file = nl === -1 ? "" : chunk.slice(nl + 1);
  }
  return out;
}

/**
 * Ruling 3c (audit round 8, B-2): the number of occurrences of `pattern`
 * (literal / fixed-string) in `line` that do NOT cut into a stored-value span
 * — the same rule `file_edit` uses (`safeMatches`). An occurrence that starts
 * inside, ends inside, or lies inside a value span is dropped (it would turn
 * grep's match / no-match / count into a per-character oracle on the value); an
 * occurrence that covers a whole value, or sits entirely outside every span,
 * is a real match. Spans are computed on the RAW line (before scrubbing), so
 * the offsets line up with the pattern's own offsets.
 */
function safeMatchCount(
  line: string,
  pattern: string,
  caseInsensitive: boolean,
): number {
  if (pattern === "") return 0;
  const spans = secretSpans(line);
  const hay = caseInsensitive ? line.toLowerCase() : line;
  const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
  const cuts = (a: number, b: number): boolean =>
    spans.some(([s, e]) => a < e && s < b && !(a <= s && e <= b));
  let count = 0;
  let next = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (i < next) continue;
    if (cuts(i, i + needle.length)) continue;
    count++;
    next = i + needle.length;
  }
  return count;
}

export const grepTool: Tool = {
  name: "grep",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "grep",
      description: `Search file contents for a text pattern. Uses fixed-string matching (not regex) for reliability.

DO NOT USE WHEN:
- You are looking for a note in the knowledge base → use jarvis_file_search.
- You want a symbol (function, class, type) in mission-control by name → use code_search.

WHEN TO USE:
- Find where a function, class, variable, or string is used
- Locate error messages, config keys, or API endpoints
- Search for TODO/FIXME/HACK comments

OUTPUT MODES:
- "files" (default): Just file paths that contain the pattern — fast overview
- "content": Matching lines with line numbers — for reading the matches
- "count": Number of matches per file — for gauging scope

TIPS:
- Start with "files" mode to find relevant files, then use file_read to examine them
- Use include_glob to narrow search (e.g. "*.ts" for TypeScript only)
- Search is case-sensitive by default; set case_insensitive=true if needed`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text to search for (literal string, not regex)",
          },
          path: {
            type: "string",
            description:
              'Directory or file to search in. Defaults to current working directory "."',
          },
          include_glob: {
            type: "string",
            description:
              'File pattern filter, e.g. "*.ts", "*.py", "src/**/*.js" (a directory part narrows to that directory).',
          },
          output_mode: {
            type: "string",
            enum: ["files", "content", "count"],
            description:
              'What to return: "files" (paths only), "content" (matching lines), "count" (match counts). Default: "files"',
          },
          case_insensitive: {
            type: "boolean",
            description: "Case-insensitive search. Default: false",
          },
          max_results: {
            type: "number",
            description: `Maximum results to return. Default: ${MAX_RESULTS}`,
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    if (!pattern) return JSON.stringify({ error: "pattern is required" });

    const searchPath = (args.path as string) || ".";
    // Same read denylist as file_read: grep over /root/.claude.json or a
    // .env returned its lines verbatim (audit 2026-09-22).
    const safety = validatePathSafety(searchPath, "read");
    if (!safety.safe) {
      return JSON.stringify({ error: `path blocked: ${safety.reason}` });
    }
    const includeGlob = args.include_glob as string | undefined;
    const mode = (args.output_mode as string) || "files";
    const caseInsensitive = args.case_insensitive === true;
    const maxResults = Math.min(
      typeof args.max_results === "number" ? args.max_results : MAX_RESULTS,
      500,
    );

    // Build ripgrep command (available on most Linux systems, falls back to grep)
    // --with-filename + --null: every output record starts with "<file>\0",
    // so each line can be checked against the read denylist below.
    const flags: string[] = [
      "--fixed-strings",
      "--no-heading",
      "--with-filename",
      "--null",
    ];
    if (caseInsensitive) flags.push("--ignore-case");

    // Ruling 3c (audit round 8, B-2): ALWAYS run in line mode (never the
    // tool's own --files-with-matches / --count), so every matching line's
    // text is available for value-span filtering below; files and counts are
    // derived from the kept lines.
    flags.push("--line-number");

    // rg's --glob is path-aware — pass the glob verbatim. Only grep's
    // --include is basename-only; the fallback below narrows its search root
    // to the glob's leading directory instead (logic audit F25 / qa W1).
    if (includeGlob) {
      flags.push("--glob", includeGlob);
    }
    let grepSearchPath = searchPath;
    let grepNameGlob = includeGlob;
    if (includeGlob && includeGlob.includes("/")) {
      const firstSlash = includeGlob.indexOf("/");
      const dir = includeGlob.slice(0, firstSlash);
      grepNameGlob = includeGlob.slice(includeGlob.lastIndexOf("/") + 1);
      if (dir && dir !== "**" && !dir.includes("*")) {
        grepSearchPath =
          searchPath === "."
            ? dir
            : `${searchPath.endsWith("/") ? searchPath : `${searchPath}/`}${dir}`;
      }
    }

    // Bound the underlying search per file at a fixed cap well above any
    // user max_results — the visible cap is applied in JS after value-span
    // filtering, so a dropped value-line never consumes a visible slot (B-2).
    flags.push("--max-count", String(INTERNAL_MAXCOUNT));

    // A glob with a directory part ("src/**/*.ts") matches nothing on some
    // rg versions (14.1.0) when the search path is not "." — rg matches it
    // against the path as given ("/abs/root/src/..."), not relative to the
    // search root. Run rg FROM the root with path "." instead, then map each
    // "./rel" record back to the exact form rg prints for `searchPath`
    // (Path::join: one "/" unless the root already ends with "/"), BEFORE the
    // read-denylist check in parseLineRecords sees it.
    let rgCwd: string | undefined;
    let rgPath = searchPath;
    let mapRgFile: ((f: string) => string) | undefined;
    if (includeGlob && includeGlob.includes("/") && searchPath !== ".") {
      let isDir = false;
      try {
        isDir = statSync(searchPath).isDirectory();
      } catch {
        // Missing / unreadable root: leave rg to report it as before.
      }
      if (isDir) {
        // The spelling, not resolve(): spawn's chdir walks `link/..` on disk
        // as rg would (resolve() collapses it as text — another tree).
        rgCwd = searchPath;
        rgPath = ".";
        mapRgFile = rgRecordMapper(searchPath);
      }
    }

    // spawn: args as array — no shell interpolation, immune to injection
    const rgArgs = [...flags, "--", pattern, rgPath];

    try {
      let output: string;
      let byteCapped = false;
      let mapFile: ((f: string) => string) | undefined;
      const rg = await runCapped("rg", rgArgs, searchByteCap, 20_000, rgCwd);
      if (rg.capped || (rg.status === 0 && !rg.timedOut)) {
        // A cap hit is an answer (truncated), never a fallback trigger: grep
        // over the same tree would overflow the same way (combined-audit B1).
        output = rg.stdout;
        byteCapped = rg.capped;
        mapFile = mapRgFile;
      } else if (
        rg.status === 1 &&
        !rg.stderr.trim() &&
        rg.code !== "ENOENT"
      ) {
        // rg exit 1 = "no matches" (rg present, nothing found) — that is an
        // answer, not a failure; falling through to grep re-ran the search
        // under different glob semantics (qa R2 W2).
        return JSON.stringify({ matches: [], total: 0, message: "No matches found" });
      } else {
        // rg not found or failed — fall back to grep
        // Bounded like the rg path: without these the default path "."
        // walks node_modules (707 MB) and dies on the 20 s timeout or
        // the output cap before returning anything (logic audit F3).
        const grepArgs = [
          "-r",
          "-H",
          "-Z",
          // --include must come FIRST: GNU grep includes a file matching no
          // pattern unless the first --include/--exclude was an --include.
          ...(grepNameGlob ? [`--include=${grepNameGlob}`] : []),
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          // Recursive searches skip credential stores (rg skips dotfiles by
          // default; grep does not).
          "--exclude-dir=.ssh",
          "--exclude-dir=.docker",
          "--exclude-dir=.gnupg",
          "--exclude=.env*",
          "--exclude=.claude.json",
          "--exclude=.git-credentials",
          "--max-count",
          String(INTERNAL_MAXCOUNT),
          ...(caseInsensitive ? ["-i"] : []),
          // Always line mode (-n -Z) — files / counts derived from kept lines.
          "-n",
          "--fixed-strings",
          "--",
          pattern,
          grepSearchPath,
        ];
        const gr = await runCapped("grep", grepArgs, searchByteCap, 20_000);
        if (gr.capped) {
          output = gr.stdout;
          byteCapped = true;
        } else if (gr.status === 0 && !gr.timedOut) {
          output = gr.stdout;
        } else if (gr.status === 1 && !gr.stderr) {
          // grep returns exit code 1 for "no matches" — not an error
          return JSON.stringify({
            matches: [],
            total: 0,
            message: "No matches found",
          });
        } else {
          return JSON.stringify({
            error:
              gr.stderr.trim() ||
              (gr.timedOut
                ? "search timed out after 20s"
                : `grep failed (${gr.code ?? `exit ${gr.status}`})`),
          });
        }
      }

      if (!output.trim()) {
        return JSON.stringify({
          matches: [],
          total: 0,
          message: "No matches found",
          ...(byteCapped && { truncated: true }),
        });
      }

      // Ruling 3c (audit round 8, B-2): keep only lines with at least one
      // match that does NOT cut into a stored-value span; a line whose only
      // hit is inside a value is dropped (match / no-match / count would
      // otherwise be a per-character oracle). Files and counts are derived
      // from the kept lines, and each kept line is scrubbed before the cap.
      const records = parseLineRecords(output, mapFile);
      // Audit round 9 (should-fix 5): a file that reached the internal
      // per-file cap was cut by the search itself — say so. (Residual: the
      // cap counts raw matching lines, including a line whose only hit is
      // inside a value, so for a file with ~2000 matching lines the cut point
      // — and `total` — can move by such a line.)
      const perFile = new Map<string, number>();
      for (const r of records) perFile.set(r.file, (perFile.get(r.file) ?? 0) + 1);
      const capped = [...perFile.values()].some((n) => n >= INTERNAL_MAXCOUNT);
      const kept: Array<{ file: string; lineno: string; content: string; hits: number }> =
        [];
      for (const r of records) {
        const hits = safeMatchCount(r.content, pattern, caseInsensitive);
        if (hits > 0) kept.push({ ...r, hits });
      }
      if (kept.length === 0) {
        return JSON.stringify({
          matches: [],
          total: 0,
          message: "No matches found",
          ...((capped || byteCapped) && { truncated: true }),
        });
      }

      let lines: string[];
      if (mode === "files") {
        const seen = new Set<string>();
        lines = [];
        for (const r of kept) {
          if (!seen.has(r.file)) {
            seen.add(r.file);
            lines.push(r.file);
          }
        }
      } else if (mode === "count") {
        const counts = new Map<string, number>();
        const order: string[] = [];
        for (const r of kept) {
          if (!counts.has(r.file)) order.push(r.file);
          counts.set(r.file, (counts.get(r.file) ?? 0) + r.hits);
        }
        lines = order.map((f) => `${f}:${counts.get(f)}`);
      } else {
        lines = kept.map(
          (r) => `${r.file}:${r.lineno}:${scrubSecrets(r.content)}`,
        );
      }

      const total = lines.length;
      if (lines.length > maxResults) {
        lines = lines.slice(0, maxResults);
      }

      const result = redactCredentials(lines.join("\n"));
      const trimmed =
        result.length > MAX_OUTPUT
          ? result.slice(0, MAX_OUTPUT) +
            `\n... (truncated, ${total} total matches)`
          : result;

      return JSON.stringify({
        matches: trimmed,
        total,
        truncated: total > maxResults || capped || byteCapped,
      });
    } catch (err) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // grep returns exit code 1 for "no matches" — not an error
      if (error.status === 1 && !error.stderr) {
        return JSON.stringify({
          matches: [],
          total: 0,
          message: "No matches found",
        });
      }
      return JSON.stringify({
        error: error.stderr || error.message || String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// glob — file discovery
// ---------------------------------------------------------------------------

export const globTool: Tool = {
  name: "glob",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "glob",
      description: `Find files matching a glob pattern. Use this to discover project structure, locate files by extension, or find specific filenames.

DO NOT USE WHEN:
- You want to search file CONTENTS → use grep.
- You are looking for knowledge-base notes → use jarvis_file_search.

WHEN TO USE:
- "What TypeScript files are in src/?" → glob pattern="src/**/*.ts"
- "Find all test files" → glob pattern="**/*.test.*"
- "Is there a package.json?" → glob pattern="**/package.json"
- "Find all Python files" → glob pattern="**/*.py"

PATTERNS:
- "*" matches any filename: "*.ts" finds all .ts files in current dir
- "**" matches any depth: "src/**/*.ts" finds .ts files anywhere under src/
- "{a,b}" alternation: "*.{ts,js}" finds both .ts and .js files

TIPS:
- Always use "**/" prefix to search recursively
- Results are sorted alphabetically
- Use path to narrow the search directory`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'Glob pattern, e.g. "**/*.ts", "src/**/*.{ts,tsx}", "**/package.json"',
          },
          path: {
            type: "string",
            description: 'Base directory to search from. Defaults to "."',
          },
          max_results: {
            type: "number",
            description: `Maximum files to return. Default: ${MAX_RESULTS}`,
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    if (!pattern) return JSON.stringify({ error: "pattern is required" });

    const searchPath = (args.path as string) || ".";
    // Names are output too: the same read denylist as grep, on the base
    // directory and on every listed path (audit 2026-09-22).
    const safety = validatePathSafety(searchPath, "read");
    if (!safety.safe) {
      return JSON.stringify({ error: `path blocked: ${safety.reason}` });
    }
    const maxResults = Math.min(
      typeof args.max_results === "number" ? args.max_results : MAX_RESULTS,
      1000,
    );

    // execFileSync: args as array — no shell interpolation, immune to injection
    try {
      let output: string;
      try {
        // fd first (fast, respects .gitignore)
        output = execFileSync(
          "fd",
          [
            "--glob",
            pattern,
            "--type",
            "f",
            "--max-results",
            String(maxResults + 1), // +1 so `truncated` can be detected (qa W3)
          ],
          {
            timeout: 20_000,
            maxBuffer: 2 * 1024 * 1024,
            encoding: "utf-8",
            cwd: searchPath,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch {
        // fd not found — fall back to find. Keep the glob's directory part
        // (`-path` lets `*` span slashes, so `src/**/*.ts` → `./src/*.ts`),
        // and prune node_modules/.git (logic audit F4: 5,126 of 6,793 hits
        // were under node_modules).
        const findArgs = pattern.includes("/")
          ? ["-path", `./${pattern.replace(/\*\*\//g, "*").replace(/\*\*/g, "*")}`]
          : ["-name", pattern];
        output = execFileSync(
          "find",
          [
            ".",
            "-maxdepth", "10",
            "(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune",
            "-o", "-type", "f", ...findArgs, "-print",
          ],
          {
            timeout: 20_000,
            maxBuffer: 2 * 1024 * 1024,
            encoding: "utf-8",
            cwd: searchPath,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      }

      if (!output.trim()) {
        return JSON.stringify({
          files: [],
          total: 0,
          message: "No files found",
        });
      }

      const listed = output.trim().split("\n").filter(Boolean);
      const all = listed.filter((f) => !listedBlocked(`${searchPath}/${f}`));
      // The find fallback has no limit of its own — apply max_results here
      // (the handler never sliced; `truncated` claimed a cut that never happened).
      const files = all.slice(0, maxResults);
      return JSON.stringify({
        files,
        total: all.length,
        // Decided on the listing: fd stops at maxResults + 1 BEFORE the filter.
        truncated: listed.length > maxResults,
      });
    } catch (err) {
      const error = err as { stderr?: string; message?: string };
      return JSON.stringify({
        error: error.stderr || error.message || String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// ls — directory listing
// ---------------------------------------------------------------------------

export const listDirTool: Tool = {
  name: "list_dir",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description: `List the contents of a directory. Shows files and subdirectories with type indicators.

DO NOT USE WHEN:
- You already know the filename pattern → use glob (recursive, one call).
- You want to read a file → use file_read.

WHEN TO USE:
- Explore project structure before making changes
- Check what files exist in a directory
- Verify a file was created or deleted

Returns entries sorted alphabetically with "/" suffix for directories.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Directory path to list. Defaults to "."',
          },
          recursive: {
            type: "boolean",
            description:
              "If true, list all files recursively (tree view). Default: false",
          },
          max_depth: {
            type: "number",
            description: "Maximum depth for recursive listing. Default: 3",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = (args.path as string) || ".";
    // Same read denylist as grep/glob, on the directory and on every entry
    // (audit 2026-09-22: `list_dir /root/.ssh` named the key files).
    const safety = validatePathSafety(dirPath, "read");
    if (!safety.safe) {
      return JSON.stringify({ error: `path blocked: ${safety.reason}` });
    }
    const recursive = args.recursive === true;
    const maxDepth = Math.min(
      typeof args.max_depth === "number" ? args.max_depth : 3,
      6,
    );

    try {
      let output: string;
      if (recursive) {
        output = execFileSync(
          "find",
          [
            dirPath,
            "-maxdepth",
            String(maxDepth),
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
            "-not",
            "-path",
            "*/dist/*",
          ],
          {
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        // Sort and limit
        const lines = output.trim().split("\n").sort();
        output = lines.slice(0, 500).join("\n");
      } else {
        output = execFileSync("ls", ["-1Ap", dirPath], {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const lines = output.trim().split("\n");
        output = lines.slice(0, 200).join("\n");
      }

      if (!output.trim()) {
        return JSON.stringify({
          entries: [],
          message: "Directory is empty or does not exist",
        });
      }

      // Recursive entries are paths (find prints them from dirPath); `ls`
      // entries are names, directories suffixed "/".
      const entries = output
        .trim()
        .split("\n")
        .filter(
          (e) =>
            !!e &&
            !listedBlocked(
              recursive ? e : `${dirPath}/${e.replace(/\/$/, "")}`,
            ),
        );
      return JSON.stringify({ path: dirPath, entries, total: entries.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};

// ---------------------------------------------------------------------------
// code_search — semantic search of mission-control's own codebase
// ---------------------------------------------------------------------------

import { searchCode, symbolsInFile, type SymbolKind } from "./code-index.js";

export const codeSearchTool: Tool = {
  name: "code_search",
  deferred: true,
  readOnlyHint: true,
  destructiveHint: false,
  // Reads from a stale-able SQLite index that mutates as files change —
  // closer to web_search semantics than to grep on a live FS.
  idempotentHint: false,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "code_search",
      description: `Search your own codebase (mission-control) for functions, classes, types, constants by name or keyword.

DO NOT USE WHEN:
- The repo is not mission-control → use grep with a path.
- You need arbitrary text (a log line, a string literal) → use grep.

USE WHEN:
- You need to find where a function is defined before fixing it
- You need to understand what a module exports
- User asks "where is X?" about your own code
- Before using file_read on mission-control — find the right file first

Returns: file path, line number, and signature for each match.

WORKFLOW:
1. code_search query="detectsHallucinatedExecution" → finds fast-runner.ts:250
2. file_read the file around that line
3. file_edit to make the fix

AFTER SEARCHING: Report the matches found with file:line references.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Symbol name or keyword to search for (case-insensitive).",
          },
          kind: {
            type: "string",
            enum: ["function", "class", "interface", "type", "const", "enum"],
            description: "Optional: filter by symbol kind.",
          },
          file: {
            type: "string",
            description:
              'Optional: list all symbols in a specific file (relative path, e.g. "src/runners/fast-runner.ts").',
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const kind = args.kind as SymbolKind | undefined;
    const file = args.file as string | undefined;

    if (file) {
      const symbols = symbolsInFile(file);
      if (symbols.length === 0) return `No symbols indexed for "${file}".`;
      const lines = [`📄 **${file}** — ${symbols.length} symbols`];
      for (const s of symbols) {
        const icon = s.exported ? "📤" : "  ";
        lines.push(`${icon} ${s.kind} **${s.name}** (line ${s.line})`);
      }
      return lines.join("\n");
    }

    if (!query || query.length < 2)
      return "Query must be at least 2 characters.";

    const results = searchCode(query, { kind, limit: 15 });
    if (results.length === 0)
      return `🔍 No matches for "${query}"${kind ? ` (kind: ${kind})` : ""}.`;

    const lines = [
      `🔍 **"${query}"** — ${results.length} match${results.length > 1 ? "es" : ""}`,
    ];
    for (const s of results) {
      lines.push(
        `\n${s.exported ? "📤" : "🔒"} **${s.name}** (${s.kind}) — ${s.file}:${s.line}\n\`${s.signature}\``,
      );
    }
    return lines.join("\n");
  },
};
