/**
 * S6 WS1 — the project record (spec docs/planning/s6-project-contract-spec-2026-10-11.md §2).
 *
 * A project enters Jarvis ONLY through its record: one KB file,
 * `projects/<slug>/project.md`, whose FIRST fenced ```json block is the
 * contract and whose remaining text is free notes. The record is
 * authoritative; the `projects` row is its projection (`./projector.ts`).
 * JSON + zod: no new dependency, and the skills frontmatter parser cannot
 * express nested `repos` / `mcp` (spec §2).
 *
 * WS3 consumes `capabilities.mcp`, `trusted`, `secrets` (names) and
 * `routing.summary` (mcp/config.ts, projects/scope-groups.ts); `egress`,
 * `inbound`, `deny_paths` are projected with no consumer yet (WS4/WS7).
 * `repos` is validated for shape only; the `realpath ⊂ profile.workspaceRoot`
 * rule lands with WS4.
 */

import { z } from "zod";
import { canonicalKbPath } from "../tools/builtin/immutable-core.js";
import { isDeniedEnvName } from "../mcp/env-deny.js";
import { SECRET_REF_RE, literalEnvValueError } from "../mcp/record-env.js";

export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const PROJECT_STATUSES = [
  "active",
  "paused",
  "completed",
  "archived",
] as const;

/** A `kb_readme` chat may inject: one `.md` file directly under a `projects/<folder>/`
 *  (audit R1 C1 / R2 W2; shared by the record, the exporter flag and the injector). */
export const KB_README_RE = /^projects\/[a-z0-9][a-z0-9-]*\/[^/\s]+\.md$/;

/** Canonical KB-relative record path: exactly `projects/<slug>/project.md`. */
const RECORD_PATH_RE = /^projects\/([a-z0-9][a-z0-9-]{1,62})\/project\.md$/;

const slugSchema = z.string().regex(PROJECT_SLUG_RE);
/** KB-relative path: no leading `/`, no `..` segment, no backslash. */
const kbPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."),
    { message: "must be a KB-relative path (no leading /, no .., no backslash)" },
  );
/** An env NAME; loader/runtime names and service-secret families are refused (audit R1 W3). */
const envNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .refine((n) => !isDeniedEnvName(n), { message: "env name is reserved (loader/runtime or service secret)" });
const trustSchema = z.enum(["A", "B", "AB", "NONE"]);
/**
 * WS3a: `"NAME"` (credential `SECRET_<NAME>`), `{name, secret}` (an explicit
 * listed credential reference, delivered as NAME) or `{name, value}` (a
 * literal NON-secret setting; a secret-shaped one is refused).
 */
const envEntrySchema = z.union([
  envNameSchema,
  z.strictObject({ name: envNameSchema, secret: z.string().regex(SECRET_REF_RE) }),
  z.strictObject({ name: envNameSchema, value: z.string() }).superRefine((o, ctx) => {
    const err = literalEnvValueError(o.name, o.value);
    if (err) ctx.addIssue({ code: "custom", message: err });
  }),
]);
const envEntryName = (e: z.infer<typeof envEntrySchema>): string => (typeof e === "string" ? e : e.name);

/** §3 — loaded by `mcp/config.ts` (S6 WS3). */
const mcpEntrySchema = z.strictObject({
  // `__` is the MCP namespace separator: an id containing it could shadow
  // another server's `<id>__` prefix (audit R1 W2).
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .refine((id) => !id.includes("__"), { message: "id must not contain __" })
    .optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  repo: z.string().min(1).optional(),
  cwd: z.string().optional(),
  env: z
    .array(envEntrySchema)
    .refine((es) => new Set(es.map(envEntryName)).size === es.length, { message: "env name declared twice" })
    .optional(),
  trust: trustSchema.optional(),
  tools: z
    .record(
      z.string(),
      z.strictObject({
        trust: trustSchema.optional(),
        destructive: z.boolean().optional(),
        read_only: z.boolean().optional(),
      }),
    )
    .superRefine((tools, ctx) => {
      for (const [name, t] of Object.entries(tools)) {
        if (t.read_only === true && t.destructive === true) {
          ctx.addIssue({ code: "custom", message: `tool ${name}: read_only and destructive are contradictory` });
        }
      }
    })
    .optional(),
  deferred: z.array(z.string()).optional(),
});

/** Spec §2 field table, one entry per field. Unknown top-level keys are an error. */
export const projectContractSchema = z
  .strictObject({
    slug: slugSchema,
    name: z.string().trim().min(1),
    status: z.enum(PROJECT_STATUSES),
    aliases: z.array(z.string().trim().min(1)).optional(),
    match_priority: z.number().int().default(0),
    stall_exempt: z.boolean().optional(),
    kb_readme: kbPathSchema
      .refine((p) => KB_README_RE.test(p), {
        message: "kb_readme must be projects/<folder>/<file>.md",
      })
      .optional(),
    trusted: z.boolean().default(false),
    egress: z
      .array(z.string().regex(/^[a-z0-9.*-]+(:\d{1,5})?$/i))
      .optional(),
    parent: slugSchema.optional(),
    kb_folder: kbPathSchema.optional(),
    repos: z
      .array(
        z.strictObject({
          path: z
            .string()
            .startsWith("/")
            .refine((p) => !p.split("/").includes(".."), { message: "repo path must not contain a .. segment" }),
          role: z.enum(["primary", "other"]),
        }),
      )
      .refine((rs) => rs.filter((r) => r.role === "primary").length <= 1, {
        message: "at most one repo may have role primary",
      })
      .optional(),
    deny_paths: z.array(z.string().startsWith("/")).optional(),
    secrets: z.array(z.string().regex(/^SECRET_[A-Z0-9_]+$/)).optional(),
    capabilities: z
      .strictObject({
        mcp: z.array(mcpEntrySchema).optional(),
        brief: z.string().trim().min(1).optional(),
      })
      .optional(),
    routing: z.strictObject({ summary: z.string().trim().min(1).max(200) }).optional(),
    schedules: z.array(z.string().trim().min(1)).optional(),
    inbound: z
      .strictObject({ route: z.string().startsWith("/"), token_secret: envNameSchema })
      .optional(),
    success: z
      .strictObject({
        daylog: z.literal(true).default(true),
        gates: z.boolean().default(false),
      })
      .optional(),
    links: z.strictObject({ site: z.string().trim().min(1) }).optional(),
  })
  .superRefine((c, ctx) => {
    // WS3a: an explicit `{name, secret}` must name a credential the record lists.
    for (const [i, m] of (c.capabilities?.mcp ?? []).entries()) {
      for (const [j, e] of (m.env ?? []).entries()) {
        if (typeof e === "object" && "secret" in e && !(c.secrets ?? []).includes(e.secret)) {
          ctx.addIssue({
            code: "custom",
            path: ["capabilities", "mcp", i, "env", j, "secret"],
            message: `env ${e.name}: ${e.secret} is not in secrets`,
          });
        }
      }
    }
  })
  .transform((c) => {
    // Defaults that depend on the slug (spec §2: kb_folder, kb_readme).
    const kb_folder = c.kb_folder ?? `projects/${c.slug}/`;
    // Audit R2b: a derived default the injector would refuse is left unset
    // (the injector then uses projects/<slug>/README.md).
    const derived = `${kb_folder.replace(/\/+$/, "")}/README.md`;
    const kb_readme = c.kb_readme ?? (KB_README_RE.test(derived) ? derived : undefined);
    return { ...c, kb_folder, kb_readme };
  });

export type ProjectContract = z.output<typeof projectContractSchema>;

export type ProjectRecordErrorReason =
  | "no_json_block"
  | "invalid_json"
  | "schema"
  | "slug_mismatch";

/** Parse failure. `message` never carries record content (logged as-is). */
export class ProjectRecordError extends Error {
  readonly reason: ProjectRecordErrorReason;
  readonly issues: z.core.$ZodIssue[];
  constructor(
    reason: ProjectRecordErrorReason,
    message: string,
    issues: z.core.$ZodIssue[] = [],
  ) {
    super(message);
    this.name = "ProjectRecordError";
    this.reason = reason;
    this.issues = issues;
  }
}

export interface ParsedProjectRecord {
  contract: ProjectContract;
  /** The record minus its JSON block, trimmed. */
  notes: string;
  /** First non-empty paragraph of the lead section (before any `##`), whole — never truncated. */
  description: string;
  /** The JSON block as written (no defaults applied) — what a rewrite starts from. */
  json: Record<string, unknown>;
}

/** The FIRST fenced ```json block: [whole match, body]. */
const JSON_BLOCK_RE = /^```json[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/m;

/**
 * Offsets of every fenced block (the contract block included): ``` or ~~~,
 * indented up to 3 spaces, closed by the same marker.
 */
function fenceRanges(text: string): Array<[number, number]> {
  const fences: Array<[number, number]> = [];
  for (const m of text.matchAll(/^[^\S\r\n]{0,3}(```|~~~)[\s\S]*?^[^\S\r\n]{0,3}\1[^\S\r\n]*$/gm)) {
    fences.push([m.index, m.index + m[0].length]);
  }
  return fences;
}

/**
 * Paragraphs that can be a description, with their offsets in `text`: the
 * lead section only (lines before the first `##` heading outside a fence),
 * fenced blocks (the contract block included) and `#` heading lines end a
 * paragraph and never belong to one — so a `## Legacy config` section or a
 * title line is never read as a description.
 */
function leadParagraphs(text: string): Array<{ start: number; end: number; text: string }> {
  const fences = fenceRanges(text);
  const out: Array<{ start: number; end: number; text: string }> = [];
  let cur: { start: number; end: number } | null = null;
  const flush = () => {
    if (cur) {
      const body = text.slice(cur.start, cur.end).trim();
      if (body) out.push({ ...cur, text: body });
    }
    cur = null;
  };
  let pos = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const start = pos;
    pos += line.length;
    const body = line.replace(/\r?\n$/, "");
    if (fences.some(([a, b]) => start >= a && start < b) || body.trim() === "") {
      flush();
      continue;
    }
    if (/^#{2,}\s/.test(body)) break; // the lead section ends at the first section
    if (/^\s*#/.test(body)) {
      flush();
      continue;
    }
    if (cur) cur.end = start + body.length;
    else cur = { start, end: start + body.length };
  }
  flush();
  return out;
}

/** Where a new description goes: after the contract block, or before the first section. */
function descriptionInsertAt(markdown: string): number {
  const m = JSON_BLOCK_RE.exec(markdown);
  const afterBlock = m ? m.index + m[0].length : 0;
  const fences = fenceRanges(markdown);
  let pos = 0;
  for (const line of markdown.split(/(?<=\n)/)) {
    const inFence = fences.some(([a, b]) => pos >= a && pos < b);
    if (pos >= afterBlock && !inFence && /^#{2,}\s/.test(line)) return pos;
    pos += line.length;
  }
  return afterBlock;
}

export function parseProjectRecord(
  markdown: string,
  opts: { folderSlug: string },
): ParsedProjectRecord {
  const m = JSON_BLOCK_RE.exec(markdown);
  if (!m) {
    throw new ProjectRecordError("no_json_block", "no fenced ```json block found");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    throw new ProjectRecordError("invalid_json", "the ```json block is not valid JSON");
  }
  const parsed = projectContractSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw new ProjectRecordError(
      "schema",
      `contract fails the schema at: ${where}`,
      parsed.error.issues,
    );
  }
  if (parsed.data.slug !== opts.folderSlug) {
    throw new ProjectRecordError(
      "slug_mismatch",
      "contract slug does not equal the folder name",
    );
  }
  const notes = (
    markdown.slice(0, m.index) + markdown.slice(m.index + m[0].length)
  ).trim();
  return {
    contract: parsed.data,
    notes,
    // Stored whole: consumers truncate (briefing 300, project list 100), the
    // projector must not (R1 C2).
    description: leadParagraphs(markdown)[0]?.text ?? "",
    json: raw as Record<string, unknown>,
  };
}

/** `projects/<slug>/project.md` — the canonical KB-relative record path. */
export function projectRecordRelPath(slug: string): string {
  return `projects/${slug}/project.md`;
}

/**
 * True when `rel` is a record path. Without `kbRoot` the path must already be
 * canonical (registry spelling, exactly `projects/<slug>/project.md`); with
 * `kbRoot` it is first folded the way `canonicalKbPath` folds it.
 */
export function isProjectRecordPath(rel: string, kbRoot?: string): boolean {
  return RECORD_PATH_RE.test(kbRoot === undefined ? rel : canonicalKbPath(rel, kbRoot));
}

/** The folder slug of a canonical record path, or null. */
export function recordSlugFromPath(rel: string): string | null {
  return RECORD_PATH_RE.exec(rel)?.[1] ?? null;
}

/** One key order for a written contract block, whichever source set a field. */
const RECORD_KEY_ORDER = ["slug", "name", "status", "aliases", "match_priority", "stall_exempt", "parent", "kb_folder", "kb_readme", "schedules", "repos", "trusted", "egress", "deny_paths", "secrets", "capabilities", "routing", "inbound", "success", "links"];

/**
 * The contract block as the operator scripts write it (exporter and create):
 * a value equal to its contract default stays implicit, keys in one order,
 * values as the schema normalises them (trimmed name/aliases/links.site), so
 * a re-export of the projected row reproduces the record (audit R1 W1).
 * Throws ProjectRecordError when the contract would not parse.
 */
export function normaliseRecordJson(json: Record<string, unknown>): Record<string, unknown> {
  const slug = String(json.slug);
  const folder = typeof json.kb_folder === "string" ? json.kb_folder : `projects/${slug}/`;
  const implicit = (k: string, v: unknown) =>
    (k === "match_priority" && v === 0) ||
    (k === "trusted" && v === false) ||
    (k === "kb_folder" && v === `projects/${slug}/`) ||
    (k === "kb_readme" && v === `${folder.replace(/\/+$/, "")}/README.md`);
  const raw = Object.fromEntries(
    Object.entries(json)
      .filter(([k, v]) => !implicit(k, v))
      .sort(([a], [b]) => RECORD_KEY_ORDER.indexOf(a) - RECORD_KEY_ORDER.indexOf(b)),
  );
  const { contract } = parseProjectRecord(renderProjectRecord(raw, ""), { folderSlug: slug }); // throws if invalid
  return Object.fromEntries(Object.keys(raw).map((k) => [k, contract[k as keyof typeof contract]]));
}

/** A new record: the contract block first, then the notes. */
export function renderProjectRecord(json: Record<string, unknown>, notes: string): string {
  const block = "```json\n" + JSON.stringify(json, null, 2) + "\n```\n";
  const body = notes.trim();
  return body ? `${block}\n${body}\n` : block;
}

/** Replace the body of the record's first ```json block; every other byte stays. */
export function replaceRecordJson(markdown: string, json: Record<string, unknown>): string {
  const m = JSON_BLOCK_RE.exec(markdown);
  if (!m) return renderProjectRecord(json, markdown);
  const block = "```json\n" + JSON.stringify(json, null, 2) + "\n```";
  return markdown.slice(0, m.index) + block + markdown.slice(m.index + m[0].length);
}

/** A description as the record stores it: trimmed, blank lines folded so it stays ONE paragraph. */
export function foldDescription(description: string): string {
  return description.trim().replace(/\r?\n[^\S\r\n]*(\r?\n[^\S\r\n]*)+/g, "\n");
}

/**
 * Set the record's description (the first lead paragraph). The current one
 * is replaced in place by offset (never a String.replace: the text is model
 * input and `$'`/`$$` are replacement patterns, and a title line can equal
 * the paragraph); with none, the new one goes after the contract block.
 * Blank lines inside it are folded so it stays ONE paragraph.
 */
export function replaceRecordDescription(markdown: string, description: string): string {
  const text = foldDescription(description);
  const current = leadParagraphs(markdown)[0];
  if (current) {
    if (text) return markdown.slice(0, current.start) + text + markdown.slice(current.end);
    const before = markdown.slice(0, current.start).replace(/\s*$/, "");
    const after = markdown.slice(current.end).replace(/^\s*/, "");
    return before && after ? `${before}\n\n${after}` : before + after;
  }
  if (!text) return markdown;
  const at = descriptionInsertAt(markdown);
  const before = markdown.slice(0, at).replace(/\s*$/, "");
  const after = markdown.slice(at).replace(/^\s*/, "");
  return `${before}\n\n${text}\n${after ? `\n${after}` : ""}`;
}
