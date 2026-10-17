/**
 * Google Drive sync — mirrors jarvis_files to a Drive folder for Obsidian.
 *
 * Maintains a mapping (SQLite table: drive_file_map) of jarvis_files paths
 * to Drive file IDs. On upsert: creates or updates the Drive file.
 * On delete: trashes the Drive file.
 *
 * All operations are fire-and-forget — failures never block the SQLite write.
 * Drive folder structure mirrors jarvis_files paths (subfolders created on demand).
 */

import { googleFetch } from "../google/client.js";
import { getDatabase } from "./index.js";
import { errMsg } from "../lib/err-msg.js";
import { isLiveDatabaseFile, LIVE_DB_PATH, openDbFile } from "./live-db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Root folder ID — "Jarvis Knowledge Base" in peter.blades@gmail.com Drive. */
const ROOT_FOLDER_ID = process.env.DRIVE_KB_FOLDER_ID ?? "";

// ---------------------------------------------------------------------------
// Obsidian-native content transformation
// ---------------------------------------------------------------------------

/** Metadata passed from jarvis-fs to enrich Drive copies for Obsidian. */
export interface DriveMetadata {
  tags?: string[];
  qualifier?: string;
  priority?: number;
  condition?: string | null;
  relatedTo?: string[];
  /**
   * The row's `updated_at` (SQLite `YYYY-MM-DD HH:MM:SS` UTC, or ISO). Drives
   * the `updated:` key so the Drive copy is a pure function of the row; when
   * missing or unparsable the sync day is used.
   */
  updatedAt?: string;
}

/** Options for the bulk Drive passes (backfill + reformat). */
export interface DriveBatchOptions {
  /** Only rows whose path starts with this prefix (case-sensitive). */
  pathPrefix?: string;
  /** Process at most this many rows (after ordering by path). */
  limit?: number;
}

/**
 * Infer the KB section from a file path.
 * Used to populate the `section` frontmatter field for Obsidian filtering.
 */
export function inferSection(path: string): string {
  const top = path.split("/")[0];
  const sectionMap: Record<string, string> = {
    projects: "projects",
    knowledge: "knowledge",
    NorthStar: "NorthStar",
    directives: "directives",
    logs: "logs",
    workspace: "workspace",
    skills: "skills",
    tuning: "tuning",
    inbox: "inbox",
    VPS: "VPS",
  };
  return sectionMap[top] ?? "root";
}

/**
 * Infer the parent path for a file — used to auto-generate a parent wikilink.
 *
 * Rules:
 * - `projects/{slug}/notes/x.md`   → `projects/{slug}/README`
 * - `projects/{slug}/x.md`         → `projects/{slug}/README`  (unless IS the README)
 * - `knowledge/{sub}/x.md`         → `knowledge/{sub}`  (virtual folder node)
 * - `NorthStar/{sub}/x.md`         → `NorthStar/{sub}`
 * - top-level or no parent logic   → null
 */
export function inferParentPath(path: string): string | null {
  const parts = path.replace(/\.md$/, "").split("/");
  if (parts.length < 2) return null;

  const [top, slug, ...rest] = parts;

  // projects/{slug}/README.md — no parent (IS the root of the project)
  if (top === "projects" && rest.length === 0 && slug === "README") return null;

  // projects/{slug}/anything → README of that project
  if (top === "projects" && slug) {
    const readmePath = `projects/${slug}/README`;
    // Don't link to self
    if (path === `projects/${slug}/README.md`) return null;
    return readmePath;
  }

  // knowledge/{sub}/x.md → knowledge/{sub}  (use folder name as virtual node)
  if (top === "knowledge" && rest.length > 0) {
    return `knowledge/${slug}`;
  }

  // NorthStar/{sub}/x.md → NorthStar/{sub}
  if (top === "NorthStar" && rest.length > 0) {
    return `NorthStar/${slug}`;
  }

  return null;
}

/**
 * Scan the file content for bare KB paths (e.g. "projects/foo/README.md") and
 * convert any that are NOT already inside a [[wikilink]] to [[wikilink]] format.
 * This makes implicit cross-references visible in the Obsidian graph.
 *
 * Only activates for paths that look like real KB paths (contain "/" and end
 * with ".md"). Avoids false positives on URLs (http/https) and existing wikilinks.
 * A match glued to a longer token (preceded by a path character) or sitting
 * inside an open `[[ ... ]]` span is left as is. Callers pass the BODY only:
 * frontmatter is never rewritten.
 */
// `_` is left out so `_projects/x.md_` (underscore italics) is still wrapped.
const PATH_CHAR_RE = /[A-Za-z0-9/.:-]/;

export function injectContentWikilinks(content: string): string {
  // Match bare KB paths not already inside [[ ]] and not a markdown-link
  // target `](path.md)` — the `(?<!\()` lookbehind. (Review fold 2026-07-12.)
  const KB_PATH_RE =
    /(?<!\[\[)(?<!\()((?:projects|knowledge|NorthStar|directives|logs|workspace|skills|tuning|inbox)\/[a-zA-Z0-9_\-./]+\.md)(?!\]\])/g;

  // Never rewrite inside fenced code blocks or inline code spans — KB
  // technical notes quote paths in code constantly, and a wikilink inside
  // a code block corrupts the example. Split with capture groups: odd
  // indices are the code segments, passed through verbatim.
  const segments = content.split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return segments
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // code — untouched
      // Last `[[` / `]]` start on the current line, advanced once through the
      // segment as matches arrive in order (linear, not per-match rescans).
      let cursor = 0;
      let lastOpen = -1;
      let lastClose = -1;
      return segment.replace(KB_PATH_RE, (match: string, _p: string, offset: number) => {
        for (; cursor < offset; cursor++) {
          const ch = segment[cursor];
          if (ch === "\n") {
            lastOpen = -1;
            lastClose = -1;
          } else if (ch === "[" && segment[cursor + 1] === "[") lastOpen = cursor;
          else if (ch === "]" && segment[cursor + 1] === "]") lastClose = cursor;
        }
        // Glued to a longer token (URL path, `myprojects/x.md`): leave it.
        if (offset > 0 && PATH_CHAR_RE.test(segment[offset - 1])) return match;
        // Inside an open `[[ ... ]]` span on the same line (alias target,
        // `[[projects/a/knowledge/x.md|X]]`): leave it.
        if (lastOpen > lastClose) return match;
        const withoutExt = match.replace(/\.md$/, "");
        const display = withoutExt.split("/").pop() ?? withoutExt;
        return `[[${withoutExt}|${display}]]`;
      });
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Frontmatter split + merge (textual; no YAML dependency, ruling R2)
// ---------------------------------------------------------------------------

/** Result of {@link splitFrontmatter}. */
export interface FrontmatterSplit {
  /** Lines strictly between the fences (trailing `\r` stripped), or null. */
  block: string[] | null;
  /** Text after the closing fence line, or the whole content when no block. */
  body: string;
  /** Set when line 1 is a fence but the block was rejected. */
  malformedReason?: string;
}

/** The closing fence must appear within this many lines after the opener. */
const FM_SCAN_LIMIT = 200;
const FM_KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s|$)/;
const FM_BLANK_RE = /^\s*$/;
const FM_COMMENT_RE = /^\s*#/;
const FM_LIST_ITEM_RE = /^\s*-(?:\s|$)/;
const FM_INDENTED_RE = /^\s+\S/;
/** A plain scalar (comment cut off) may not contain `: ` nor end in `:`. */
const PLAIN_BAD_RE = /:\s|:$/;
/** Block scalar header: `|` or `>`, optional modifiers, optional comment. */
const BLOCK_HEADER_RE = /^[|>][-+0-9]*(?:\s+#.*)?$/;

/**
 * Index just after a flow value (`[...]` / `{...}`) that closes on this line,
 * or -1. Brackets inside quoted items are ignored; a quote opens an item only
 * at an item start, so `[it's]` stays a plain item.
 */
function flowValueEnd(value: string): number {
  let depth = 0;
  let quote: string | null = null;
  let prev = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) {
        if (quote === "'" && value[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && "[{,:".includes(prev)) quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  return -1;
}

/**
 * Classify a top-level key's own value (text after the colon, trimmed):
 * `empty` (nothing or only a comment), `block` (block scalar header) or
 * `scalar`, with `problem` set when the value is not valid YAML on one line.
 */
function classifyValue(value: string): {
  kind: "empty" | "block" | "scalar";
  problem?: string;
} {
  if (value === "" || value.startsWith("#")) return { kind: "empty" };
  const c = value[0];
  if (c === "|" || c === ">") {
    return BLOCK_HEADER_RE.test(value)
      ? { kind: "block" }
      : { kind: "scalar", problem: "bad block scalar header" };
  }
  let end = -1;
  if (c === '"') {
    for (let i = 1; i < value.length; i++) {
      if (value[i] === "\\") i++;
      else if (value[i] === '"') {
        end = i + 1;
        break;
      }
    }
    if (end < 0) return { kind: "scalar", problem: "unterminated double-quoted value" };
  } else if (c === "'") {
    for (let i = 1; i < value.length; i++) {
      if (value[i] !== "'") continue;
      if (value[i + 1] === "'") {
        i++;
        continue;
      }
      end = i + 1;
      break;
    }
    if (end < 0) return { kind: "scalar", problem: "unterminated single-quoted value" };
  } else if (c === "[" || c === "{") {
    end = flowValueEnd(value);
    if (end < 0) return { kind: "scalar", problem: "unclosed flow value" };
  } else {
    // Plain scalar: ` #` starts a comment, which is valid and cut off here.
    const plain = value.split(/\s#/)[0].trimEnd();
    return PLAIN_BAD_RE.test(plain)
      ? { kind: "scalar", problem: "plain value with ': '" }
      : { kind: "scalar" };
  }
  const rest = value.slice(end);
  return rest === "" || /^\s+#/.test(rest)
    ? { kind: "scalar" }
    : { kind: "scalar", problem: "text after a quoted or flow value" };
}

/** Keys the sync writes (ruling R1); a file entry with one of these yields. */
const SYNC_KEYS = new Set([
  "title",
  "qualifier",
  "priority",
  "section",
  "parent",
  "tags",
  "condition",
  "path",
  "updated",
]);

/**
 * Split a leading YAML frontmatter block from `content`. Only a fence on
 * line 1 counts (a leading UTF-8 BOM is tolerated): body `---` lines are
 * horizontal rules. The block must close (`---` or `...`) within
 * FM_SCAN_LIMIT lines and every line must fit the small grammar below, or the
 * whole content is treated as body.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  let pos = content.startsWith("\uFEFF") ? 1 : 0;
  const readLine = (): string | null => {
    if (pos >= content.length) return null;
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(pos, end);
    pos = end + 1;
    return line.replace(/\r$/, "");
  };

  if (readLine() !== "---") return { block: null, body: content };

  const block: string[] = [];
  for (let n = 0; n < FM_SCAN_LIMIT; n++) {
    const line = readLine();
    if (line === null) break;
    if (line === "---" || line === "...") {
      const body = content.slice(Math.min(pos, content.length));
      let seenKey = false;
      // Kind of the last top-level key's own value: a column-0 `- item` may
      // follow only `empty`; an indented line only `empty` or `block`.
      let keyKind: "empty" | "block" | "scalar" = "scalar";
      for (let i = 0; i < block.length; i++) {
        const l = block[i];
        if (FM_BLANK_RE.test(l) || FM_COMMENT_RE.test(l)) continue;
        let what: string | null = null;
        if (FM_KEY_RE.test(l)) {
          seenKey = true;
          const v = classifyValue(entryValue(l));
          keyKind = v.kind;
          what = v.problem ?? null;
        } else if (!seenKey) {
          what = "content before the first key";
        } else if (FM_INDENTED_RE.test(l)) {
          // nested map / block list under an empty key, or block scalar text
          if (keyKind === "scalar") what = "indented line after a scalar value";
        } else if (FM_LIST_ITEM_RE.test(l)) {
          if (keyKind !== "empty") what = "list item after a scalar value";
        } else {
          what = "unrecognized line";
        }
        if (what) {
          return {
            block: null,
            body: content,
            malformedReason: `line ${i + 2}: ${what} "${l.slice(0, 40)}"`,
          };
        }
      }
      return { block, body };
    }
    block.push(line);
  }
  return { block: null, body: content, malformedReason: "no closing fence" };
}

/** Double-quoted YAML scalar. */
function yamlQuote(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

const FLOW_UNSAFE_RE = /[\s,:#[\]{}"']/;
const FLOW_UNSAFE_START_RE = /^[-?&*!|>'"%@`]/;

/** One item of a flow list, quoted only when a plain scalar would misparse. */
function yamlFlowItem(t: string): string {
  return t === "" || FLOW_UNSAFE_RE.test(t) || FLOW_UNSAFE_START_RE.test(t)
    ? yamlQuote(t)
    : t;
}

/** Strip one layer of matching quotes (undoing their escapes); null = unsupported. */
function parseTagScalar(raw: string): string | null {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\(["\\nr])/g, (_m, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c,
      );
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[[{]/.test(raw) || /:\s/.test(raw) || /\s#/.test(raw)) return null;
  return raw;
}

/** Split the inside of `[ ... ]` on commas outside quotes; null = nested. */
function splitFlowList(inner: string): string[] | null {
  const items: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote === '"' && ch === "\\") {
      cur += ch + (inner[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("[]{}".includes(ch)) return null;
    else if (ch === ",") {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  items.push(cur);
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.trim();
    if (t === "") continue;
    const v = parseTagScalar(t);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 1 && FM_BLANK_RE.test(lines[end - 1])) end--;
  return lines.slice(0, end);
}

/** Text after the key's colon, trimmed. */
function entryValue(line: string): string {
  return line.slice(line.indexOf(":") + 1).trim();
}

/**
 * Parse a file's `tags` entry: a one-line flow list (`tags: [a, "b c"]`), a
 * block list (`tags:` + `- item` lines) or an empty `tags:`. Any other shape
 * returns null (the entry is then kept as `source_tags`).
 */
function parseFileTags(lines: string[]): string[] | null {
  const [head, ...rest] = trimTrailingBlank(lines);
  const value = entryValue(head);
  if (rest.length === 0) {
    if (value === "") return [];
    if (!value.startsWith("[") || !value.endsWith("]")) return null;
    return splitFlowList(value.slice(1, -1));
  }
  if (value !== "") return null;
  const out: string[] = [];
  for (const l of rest) {
    if (FM_BLANK_RE.test(l)) continue;
    const m = /^\s*-(?:\s+(.*))?$/.exec(l);
    if (!m) return null;
    const t = (m[1] ?? "").trim();
    if (t === "") continue;
    const v = parseTagScalar(t);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

function unionTags(base: string[], extra: string[]): string[] {
  const out: string[] = [];
  for (const raw of [...base, ...extra]) {
    const t = String(raw); // a non-string tag from a JSON column must not throw
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Merge the file's own block into the sync block (ruling R1). Returns the
 * file's leading comment/blank lines (emitted right after the opening fence,
 * before the sync keys, so a later pass sees them as leading again), the file
 * lines to emit after the sync keys and the final tag list. Pushes one warning
 * per edge-case kind into `warnings`. Returns `{ collision }` instead when a
 * sync-owned key would be renamed onto the file's own `source_<key>`: the
 * caller then treats the block as malformed, so nothing is dropped.
 */
function mergeFileBlock(
  block: string[],
  syncValues: Map<string, string>,
  syncTags: string[],
  warnings: string[],
): { lead: string[]; lines: string[]; tags: string[] } | { collision: string } {
  // Leading comment/blank lines (validation admits nothing else before the
  // first key) are kept, even when the block has no key at all.
  const lead: string[] = [];
  const entries: Array<{ key: string; lines: string[] }> = [];
  for (const line of block) {
    const m = FM_KEY_RE.exec(line);
    if (m) entries.push({ key: m[1], lines: [line] });
    else if (entries.length > 0) entries[entries.length - 1].lines.push(line);
    else lead.push(line);
  }

  const fileKeys = new Set(entries.map((e) => e.key));
  const seen = new Set<string>();
  const dupes: string[] = [];
  let tags = syncTags;
  const lines: string[] = [];

  for (const e of entries) {
    if (seen.has(e.key)) {
      dupes.push(e.key);
      continue;
    }
    seen.add(e.key);

    if (SYNC_KEYS.has(e.key)) {
      if (e.key === "tags") {
        const fileTags = parseFileTags(e.lines);
        if (fileTags) {
          tags = unionTags(tags, fileTags);
          continue;
        }
      } else {
        // A line the sync itself would write (a Drive copy fed back in):
        // drop it so repeated passes do not grow source_ keys.
        const own = trimTrailingBlank(e.lines);
        const emitted = syncValues.get(e.key);
        if (own.length === 1 && emitted !== undefined && entryValue(own[0]) === emitted)
          continue;
      }
      if (fileKeys.has(`source_${e.key}`)) return { collision: `source_${e.key}` };
      if (e.key === "tags") warnings.push("tags kept as source_tags (unsupported shape)");
      lines.push(`source_${e.lines[0]}`, ...e.lines.slice(1));
      continue;
    }
    lines.push(...e.lines);
  }

  if (dupes.length > 0)
    warnings.push(`duplicate keys dropped: ${[...new Set(dupes)].join(", ")}`);
  return { lead, lines, tags };
}

/** `updated:` value: the row's timestamp as a Mexico City date, else today. */
function syncDate(updatedAt?: string): string {
  let when = new Date();
  if (updatedAt) {
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(updatedAt)
      ? `${updatedAt.replace(" ", "T")}Z`
      : updatedAt;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) when = new Date(t);
  }
  return when.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function renderFrontmatter(
  fields: Array<[string, string]>,
  tags: string[],
  fileLines: string[],
  leadLines: string[] = [],
): string {
  let yaml = "---\n";
  for (const line of leadLines) yaml += `${line}\n`;
  for (const [key, value] of fields) {
    if (key === "tags") {
      if (tags.length > 0) yaml += `tags: [${tags.map(yamlFlowItem).join(", ")}]\n`;
      continue;
    }
    yaml += `${key}: ${value}\n`;
  }
  for (const line of fileLines) yaml += `${line}\n`;
  return yaml + "---\n";
}

/**
 * Transform content into Obsidian-native markdown:
 * - ONE YAML frontmatter block: the sync keys (title, qualifier, priority,
 *   section, parent, tags, condition, path, updated) followed by the file's own
 *   block, merged per ruling R1 (sync-owned keys in the file become
 *   `source_<key>`, tags are unioned)
 * - Inject [[wikilinks]] for bare KB paths found in the content body
 * - Append ## Related section: inferred parent + explicit relatedTo entries
 *
 * Pure and idempotent: feeding the output back in with the same metadata
 * returns it unchanged. Exported for testing. Only applied to Drive copies —
 * SQLite content is untouched.
 */
export function toObsidianContent(
  path: string,
  title: string,
  content: string,
  metadata?: DriveMetadata,
): string {
  // --- Sync-owned frontmatter keys, in emission order ---
  const qualifier = metadata?.qualifier ?? "reference";
  const priority = metadata?.priority ?? 50;
  const section = inferSection(path);
  const parentPath = inferParentPath(path);

  const fields: Array<[string, string]> = [
    ["title", yamlQuote(title)],
    ["qualifier", String(qualifier)],
    ["priority", String(priority)],
    ["section", section],
  ];
  if (parentPath) fields.push(["parent", yamlQuote(`[[${parentPath}]]`)]);
  fields.push(["tags", ""]); // placeholder: rendered from the merged list
  if (metadata?.condition) fields.push(["condition", yamlQuote(metadata.condition)]);
  fields.push(["path", yamlQuote(path)]);
  fields.push(["updated", syncDate(metadata?.updatedAt)]);
  const syncTags = unionTags(metadata?.tags ?? [], []);

  // --- Merge with the file's own frontmatter (Drive copy only) ---
  let head: string;
  let body: string;
  try {
    const split = splitFrontmatter(content);
    if (split.malformedReason) {
      console.warn(
        `[drive-sync] frontmatter ignored for ${path}: ${split.malformedReason}`,
      );
    }
    const warnings: string[] = [];
    const merged = split.block
      ? mergeFileBlock(split.block, new Map(fields), syncTags, warnings)
      : null;
    if (merged && "collision" in merged) {
      console.warn(
        `[drive-sync] frontmatter ignored for ${path}: ${merged.collision} collision`,
      );
    }
    if (merged && !("collision" in merged)) {
      for (const w of warnings) console.warn(`[drive-sync] frontmatter ${w} for ${path}`);
      body = split.body;
      // One blank line after the fence, without adding a second one when the
      // body already opens with it (keeps repeated passes byte-identical).
      head =
        renderFrontmatter(fields, merged.tags, merged.lines, merged.lead) +
        (/^\r?\n/.test(body) ? "" : "\n");
    } else {
      body = content;
      head = renderFrontmatter(fields, syncTags, []) + "\n";
    }
  } catch (err) {
    console.warn(
      `[drive-sync] frontmatter merge failed for ${path}: ${errMsg(err)}`,
    );
    body = content;
    head = renderFrontmatter(fields, syncTags, []) + "\n";
  }

  // --- Inject wikilinks for bare KB paths in the body only ---
  const enrichedContent = injectContentWikilinks(body);

  let result = head + enrichedContent;

  // --- Related section: inferred parent + explicit relatedTo ---
  const relatedLinks: string[] = [];

  // Inferred parent first (if not already in relatedTo)
  if (parentPath) {
    const parentMd = `${parentPath}.md`;
    const alreadyIncluded = metadata?.relatedTo?.some(
      (r) => r === parentMd || r === parentPath,
    );
    if (!alreadyIncluded) {
      const display = parentPath.split("/").pop() ?? parentPath;
      relatedLinks.push(`- [[${parentPath}|${display}]]`);
    }
  }

  // Explicit relatedTo entries
  if (metadata?.relatedTo?.length) {
    for (const p of metadata.relatedTo) {
      const withoutExt = p.replace(/\.md$/, "");
      const display = withoutExt.split("/").pop() ?? withoutExt;
      relatedLinks.push(`- [[${withoutExt}|${display}]]`);
    }
  }

  if (relatedLinks.length > 0) {
    const related = `\n\n## Related\n${relatedLinks.join("\n")}\n`;
    // Already present (a Drive copy fed back in): do not append it twice.
    if (!enrichedContent.endsWith(related)) result += related;
  }

  return result;
}

/** Cache of path-prefix → Drive folder ID (avoids repeated lookups). */
const folderCache = new Map<string, string>();

export function isDriveSyncEnabled(): boolean {
  return !!ROOT_FOLDER_ID;
}

// The Drive copy belongs to exactly one database (queue 4a, 2026-10-16): a
// process with DRIVE_KB_FOLDER_ID that opened any other db (scratch, snapshot,
// :memory:, vitest) has an empty or foreign drive_file_map, so its writes
// CREATE duplicate Drive files or PATCH live copies. Every Drive write path
// asks driveWritesAllowed() first: same realpath rule as the disk mirror
// (live-db.ts), no override. Reads stay ungated.
let driveDisabledLogged = false;
function driveWritesAllowed(): boolean {
  const dbFile = openDbFile();
  if (isLiveDatabaseFile(dbFile, LIVE_DB_PATH)) return true;
  if (!driveDisabledLogged) {
    driveDisabledLogged = true;
    console.warn(
      `[drive-sync] Drive sync DISABLED for this process: open db "${dbFile || "(none/memory)"}" is not the live ${LIVE_DB_PATH} — nothing will be created in, updated in or trashed from Drive`,
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drive file map (SQLite)
// ---------------------------------------------------------------------------

function ensureMapTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS drive_file_map (
      path TEXT PRIMARY KEY,
      drive_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function getDriveId(path: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT drive_id FROM drive_file_map WHERE path = ?")
    .get(path) as { drive_id: string } | undefined;
  return row?.drive_id ?? null;
}

function setDriveId(path: string, driveId: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO drive_file_map (path, drive_id, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET drive_id = excluded.drive_id, updated_at = datetime('now')`,
  ).run(path, driveId);
}

function removeDriveId(path: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM drive_file_map WHERE path = ?").run(path);
}

// ---------------------------------------------------------------------------
// Folder management — create Drive folders matching path hierarchy
// ---------------------------------------------------------------------------

/**
 * Ensure a folder exists in Drive for the given directory path.
 * Creates intermediate folders as needed. Returns the folder's Drive ID.
 */
async function ensureFolder(dirPath: string): Promise<string> {
  if (!dirPath || dirPath === ".") return ROOT_FOLDER_ID;

  // Check cache first
  const cached = folderCache.get(dirPath);
  if (cached) return cached;

  // Split into segments and create each level
  const segments = dirPath.split("/").filter(Boolean);
  let parentId = ROOT_FOLDER_ID;

  for (let i = 0; i < segments.length; i++) {
    const partialPath = segments.slice(0, i + 1).join("/");
    const cachedPartial = folderCache.get(partialPath);
    if (cachedPartial) {
      parentId = cachedPartial;
      continue;
    }

    // Search for existing folder
    const query = `name='${segments[i]}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`;

    const search = await googleFetch<{ files: Array<{ id: string }> }>(
      searchUrl,
    );

    if (search.files.length > 0) {
      parentId = search.files[0].id;
    } else {
      // Create folder
      const created = await googleFetch<{ id: string }>(
        "https://www.googleapis.com/drive/v3/files?fields=id",
        {
          method: "POST",
          body: {
            name: segments[i],
            mimeType: "application/vnd.google-apps.folder",
            parents: [parentId],
          },
        },
      );
      parentId = created.id;
    }

    folderCache.set(partialPath, parentId);
  }

  return parentId;
}

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

/**
 * Sync a jarvis_files upsert to Google Drive (fire-and-forget).
 * Creates the file if new, updates content if existing.
 * Applies Obsidian-native transformation (frontmatter + wikilinks).
 */
export function syncToDrive(
  path: string,
  title: string,
  content: string,
  driveMetadata?: DriveMetadata,
): void {
  if (!isDriveSyncEnabled() || !driveWritesAllowed()) return;

  (async () => {
    try {
      ensureMapTable();
      const obsidianContent = toObsidianContent(
        path,
        title,
        content,
        driveMetadata,
      );
      const existingDriveId = getDriveId(path);

      if (existingDriveId) {
        // UPDATE existing file
        await googleFetch(
          `https://www.googleapis.com/upload/drive/v3/files/${existingDriveId}?uploadType=media`,
          {
            method: "PATCH",
            rawBody: obsidianContent,
            contentType: "text/markdown",
          },
        );
      } else {
        // CREATE new file — ensure parent folder exists
        const dirPath = path.includes("/")
          ? path.slice(0, path.lastIndexOf("/"))
          : "";
        const parentId = await ensureFolder(dirPath);
        const fileName = path.includes("/")
          ? path.slice(path.lastIndexOf("/") + 1)
          : path;

        const boundary = "jarvis_drive_sync";
        const fileMeta = JSON.stringify({
          name: fileName,
          mimeType: "text/markdown",
          parents: [parentId],
        });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${fileMeta}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: text/markdown\r\n\r\n` +
          `${obsidianContent}\r\n` +
          `--${boundary}--`;

        const result = await googleFetch<{ id: string }>(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
          {
            method: "POST",
            rawBody: body,
            contentType: `multipart/related; boundary=${boundary}`,
          },
        );
        setDriveId(path, result.id);
      }
    } catch (err) {
      console.warn(`[drive-sync] Failed for ${path}:`, errMsg(err));
    }
  })();
}

/**
 * Sync a jarvis_files delete to Google Drive (fire-and-forget).
 * Moves the Drive file to trash.
 */
export function syncDeleteToDrive(path: string): void {
  if (!isDriveSyncEnabled() || !driveWritesAllowed()) return;

  (async () => {
    try {
      ensureMapTable();
      const driveId = getDriveId(path);
      if (!driveId) return;

      await googleFetch(
        `https://www.googleapis.com/drive/v3/files/${driveId}`,
        { method: "PATCH", body: { trashed: true } },
      );
      removeDriveId(path);
    } catch (err) {
      console.warn(`[drive-sync] Delete failed for ${path}:`, errMsg(err));
    }
  })();
}

// ---------------------------------------------------------------------------
// Backfill — one-time upload of all existing files
// ---------------------------------------------------------------------------

interface DriveRow {
  id: string;
  path: string;
  title: string;
  content: string;
  tags: string;
  qualifier: string;
  priority: number;
  condition: string | null;
  related_to: string;
  updated_at: string | null;
}

/** Rows for a bulk pass, ordered by path, narrowed by `opts`. */
function selectDriveRows(opts: DriveBatchOptions): DriveRow[] {
  const db = getDatabase();
  const cols =
    "SELECT id, path, title, content, tags, qualifier, priority, condition, related_to, updated_at FROM jarvis_files";
  const prefix = opts.pathPrefix;
  let rows = prefix
    ? (db
        .prepare(`${cols} WHERE path LIKE ? ESCAPE '\\' ORDER BY path`)
        .all(`${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) as DriveRow[])
    : (db.prepare(`${cols} ORDER BY path`).all() as DriveRow[]);
  // LIKE is ASCII case-insensitive in SQLite; the prefix is not.
  if (prefix) rows = rows.filter((r) => r.path.startsWith(prefix));
  const limit = opts.limit;
  if (limit !== undefined && Number.isInteger(limit) && limit > 0)
    rows = rows.slice(0, limit);
  return rows;
}

function rowMetadata(file: DriveRow): DriveMetadata {
  return {
    tags: JSON.parse(file.tags || "[]"),
    qualifier: file.qualifier,
    priority: file.priority,
    condition: file.condition,
    relatedTo: JSON.parse(file.related_to || "[]"),
    updatedAt: file.updated_at ?? undefined,
  };
}

/**
 * Upload all jarvis_files to Drive. Skips files that already have a drive_id.
 * Call once to initialize, then syncToDrive handles ongoing changes.
 * `opts.pathPrefix` / `opts.limit` narrow the rows this run looks at. `limit`
 * is a canary, not paging: the first N rows by path after the prefix filter,
 * rows skipped for already having a drive_id count toward it, and a re-run
 * with the same limit looks at the same rows again.
 */
export async function backfillToDrive(
  opts: DriveBatchOptions = {},
): Promise<{
  uploaded: number;
  skipped: number;
  failed: number;
  /** Set when the live-db guard refused the whole pass (nothing was read or written). */
  refused?: true;
}> {
  if (!isDriveSyncEnabled()) {
    console.warn("[drive-sync] DRIVE_KB_FOLDER_ID not set, skipping backfill");
    return { uploaded: 0, skipped: 0, failed: 0 };
  }
  if (!driveWritesAllowed()) {
    console.warn(
      "[drive-sync] backfillToDrive REFUSED: the open db is not the live mc.db — nothing uploaded",
    );
    return { uploaded: 0, skipped: 0, failed: 0, refused: true };
  }

  ensureMapTable();
  const files = selectDriveRows(opts);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const existingDriveId = getDriveId(file.path);
    if (existingDriveId) {
      skipped++;
      continue;
    }

    try {
      const dirPath = file.path.includes("/")
        ? file.path.slice(0, file.path.lastIndexOf("/"))
        : "";
      const parentId = await ensureFolder(dirPath);
      const fileName = file.path.includes("/")
        ? file.path.slice(file.path.lastIndexOf("/") + 1)
        : file.path;

      const obsidianContent = toObsidianContent(
        file.path,
        file.title,
        file.content,
        rowMetadata(file),
      );

      const boundary = "jarvis_backfill";
      const fileMeta = JSON.stringify({
        name: fileName,
        mimeType: "text/markdown",
        parents: [parentId],
      });
      const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${fileMeta}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/markdown\r\n\r\n` +
        `${obsidianContent}\r\n` +
        `--${boundary}--`;

      const result = await googleFetch<{ id: string }>(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
        {
          method: "POST",
          rawBody: body,
          contentType: `multipart/related; boundary=${boundary}`,
          timeout: 30_000,
        },
      );
      setDriveId(file.path, result.id);
      uploaded++;

      // Rate limiting — avoid Drive API quota (300 req/min)
      if (uploaded % 50 === 0) {
        console.log(
          `[drive-sync] Backfill progress: ${uploaded}/${files.length}`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.warn(
        `[drive-sync] Backfill failed for ${file.path}:`,
        errMsg(err),
      );
      failed++;
    }
  }

  console.log(
    `[drive-sync] Backfill complete: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`,
  );
  return { uploaded, skipped, failed };
}

/**
 * Reformat all existing Drive files with Obsidian-native content.
 * Updates files that already have a drive_id with current frontmatter + wikilinks.
 * Use after changing the toObsidianContent format. `opts.pathPrefix` /
 * `opts.limit` narrow the rows this run looks at. `limit` is a canary, not
 * paging: the first N rows by path after the prefix filter, rows skipped for
 * having no drive_id count toward it, and a re-run with the same limit looks
 * at the same rows again.
 */
export async function reformatDriveFiles(
  opts: DriveBatchOptions = {},
): Promise<{
  updated: number;
  skipped: number;
  failed: number;
  /** Set when the live-db guard refused the whole pass (nothing was read or written). */
  refused?: true;
}> {
  if (!isDriveSyncEnabled()) {
    console.warn("[drive-sync] DRIVE_KB_FOLDER_ID not set, skipping reformat");
    return { updated: 0, skipped: 0, failed: 0 };
  }
  if (!driveWritesAllowed()) {
    console.warn(
      "[drive-sync] reformatDriveFiles REFUSED: the open db is not the live mc.db — nothing updated",
    );
    return { updated: 0, skipped: 0, failed: 0, refused: true };
  }

  ensureMapTable();
  const files = selectDriveRows(opts);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const driveId = getDriveId(file.path);
    if (!driveId) {
      skipped++;
      continue;
    }

    try {
      const obsidianContent = toObsidianContent(
        file.path,
        file.title,
        file.content,
        rowMetadata(file),
      );

      await googleFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${driveId}?uploadType=media`,
        {
          method: "PATCH",
          rawBody: obsidianContent,
          contentType: "text/markdown",
          timeout: 30_000,
        },
      );
      updated++;

      // Rate limiting — avoid Drive API quota (300 req/min)
      if (updated % 50 === 0) {
        console.log(
          `[drive-sync] Reformat progress: ${updated}/${files.length}`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.warn(
        `[drive-sync] Reformat failed for ${file.path}:`,
        errMsg(err),
      );
      failed++;
    }
  }

  console.log(
    `[drive-sync] Reformat complete: ${updated} updated, ${skipped} no drive_id, ${failed} failed`,
  );
  return { updated, skipped, failed };
}
