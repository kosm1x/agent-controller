/**
 * v7.7 Spine 3 — S5 substrate Phase 1.
 *
 * Strict YAML-subset frontmatter parser. We deliberately do not pull in a
 * full YAML library (no dep in package.json; new deps need operator
 * approval per CLAUDE.md invariant). The spec's frontmatter shape uses
 * only a narrow subset (scalar k/v, string arrays, comments) — anything
 * structurally complex (inputs[], tests[]) is JSON-encoded into an
 * `*_json` string. Zod validates the output; the parser only has to
 * shape the input map.
 *
 * Failure modes return a FrontmatterError with a stable `kind` so the
 * loader can categorize without string-matching messages.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema — validates the parsed map
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * `*_json` fields hold inline JSON strings. The refine validates they
 * parse to an array; downstream callers re-parse to get the array shape.
 * We don't shape-check the array elements here — that's Phase 2's critic
 * gate. Phase 1 just guarantees structural well-formedness.
 */
const jsonArrayString = z.string().refine(
  (s) => {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed);
    } catch {
      return false;
    }
  },
  { message: "must be a JSON-encoded array" },
);

export const ParsedSkillSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(NAME_RE, "must be lowercase-with-hyphens, 2-64 chars"),
  description: z.string().min(1).max(1024),
  version: z.string().regex(SEMVER_RE, "must be semver MAJOR.MINOR.PATCH"),
  output_type: z.enum(["text", "json", "structured"]),
  trigger_examples: z
    .array(z.string().min(1))
    .min(3, "frontmatter requires ≥3 trigger_examples for retrieval grounding"),
  tools_used: z.array(z.string().min(1)),
  inputs_json: jsonArrayString,
  tests_json: jsonArrayString,
});

export type ParsedSkill = z.infer<typeof ParsedSkillSchema>;

export interface ParsedSkillFile {
  frontmatter: ParsedSkill;
  body: string;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type FrontmatterErrorKind = "no_fence" | "parse" | "validation";

export class FrontmatterError extends Error {
  readonly kind: FrontmatterErrorKind;
  readonly issues?: z.ZodError["issues"];
  constructor(
    kind: FrontmatterErrorKind,
    message: string,
    issues?: z.ZodError["issues"],
  ) {
    super(message);
    this.name = "FrontmatterError";
    this.kind = kind;
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const FENCE = "---";

/**
 * Split `---\n<frontmatter>\n---\n<body>`. Both fences must appear at
 * line start. If the opening fence is missing or the closing fence is
 * absent, throws FrontmatterError{kind: 'no_fence'}.
 */
function splitFence(input: string): { fm: string; body: string } {
  const lines = input.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    throw new FrontmatterError("no_fence", "missing opening `---` fence");
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      const fm = lines.slice(1, i).join("\n");
      const body = lines.slice(i + 1).join("\n");
      return { fm, body };
    }
  }
  throw new FrontmatterError("no_fence", "missing closing `---` fence");
}

type RawValue = string | string[];

/**
 * Parse the YAML subset:
 *   - `# comment` → strip everything from `#` to EOL (only on lines that
 *     don't start with a fully-quoted value; we strip greedily — quoted
 *     values containing `#` are not supported by Phase 1)
 *   - `key: value` → scalar string (value may be `"quoted"` or bare; both
 *     stored as the same string content, no type coercion in this layer)
 *   - `key:` followed by `  - item` lines → string array
 *
 * Returns a flat `Record<string, string | string[]>`. Type coercion to
 * non-string fields happens via Zod (preprocess hooks if needed; current
 * schema only uses string/enum/array-of-string).
 */
function parseYamlSubset(fm: string): Record<string, RawValue> {
  const out: Record<string, RawValue> = {};
  const rawLines = fm.split("\n");
  // Strip comments and trailing whitespace; keep blank lines so the
  // subsequent index-walk can detect array boundaries. Comment-strip
  // respects quote state — `#` inside a quoted string is data, not a
  // comment marker. R1-W1/W4 fold: prior `indexOf("#")` silently truncated
  // `description: "Priority #1 ticket"` and `- "Reach out about #marketing"`.
  const lines = rawLines.map((l) => stripComment(l).replace(/\s+$/, ""));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Top-level key must start in column 0
    if (/^\s/.test(line)) {
      throw new FrontmatterError(
        "parse",
        `unexpected indentation at frontmatter line ${i + 1}: "${line}"`,
      );
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      throw new FrontmatterError(
        "parse",
        `missing ':' at frontmatter line ${i + 1}: "${line}"`,
      );
    }
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!key) {
      throw new FrontmatterError(
        "parse",
        `empty key at frontmatter line ${i + 1}`,
      );
    }

    if (rawValue !== "") {
      out[key] = unquote(rawValue);
      i++;
      continue;
    }

    // Empty rhs → next lines should be `  - item` array entries
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (next.trim() === "") {
        j++;
        continue;
      }
      const m = /^(\s+)-\s+(.*)$/.exec(next);
      if (!m) break;
      if (m[1].length < 2) {
        throw new FrontmatterError(
          "parse",
          `array item must be indented ≥2 spaces at line ${j + 1}`,
        );
      }
      items.push(unquote(m[2] ?? ""));
      j++;
    }
    out[key] = items;
    i = j;
  }

  return out;
}

/**
 * Strip an unquoted `# comment` tail. Single-pass scanner that tracks
 * which quote (if any) currently surrounds the cursor. A `#` is treated
 * as a comment marker only when both quote flags are false. Backslash
 * escapes are not interpreted — the spec subset doesn't need them, and
 * a literal backslash before a quote keeps the quote state as-is.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/**
 * Strip surrounding single OR double quotes from a scalar value. Inner
 * escapes are not interpreted (Phase 1 doesn't need that — `*_json`
 * fields use single quotes around the whole JSON blob; inner double
 * quotes survive untouched).
 */
function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s.charAt(0);
    const last = s.charAt(s.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Parse a full SKILL.md file (frontmatter + body) into a validated
 * `ParsedSkillFile`. Throws `FrontmatterError` on any failure.
 */
export function parseSkillFile(input: string): ParsedSkillFile {
  const { fm, body } = splitFence(input);
  const raw = parseYamlSubset(fm);

  const validation = ParsedSkillSchema.safeParse(raw);
  if (!validation.success) {
    const summary = validation.error.issues
      .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
      .join("; ");
    throw new FrontmatterError(
      "validation",
      `frontmatter validation failed: ${summary}`,
      validation.error.issues,
    );
  }

  return { frontmatter: validation.data, body };
}
