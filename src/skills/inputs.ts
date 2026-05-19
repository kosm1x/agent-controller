/**
 * v7.7 Spine 3 Phase 4 — runtime Zod schema generator for skill inputs.
 *
 * Frontmatter `inputs` (JSON-encoded into `inputs_json`) declares the
 * skill's argument contract. Spec §4 example:
 *
 *   inputs:
 *     - { name: lead_id, type: string, required: true, description: "..." }
 *     - { name: count,   type: number, required: false, default: 10 }
 *     - { name: kind,    type: enum,   values: [a,b,c], required: true }
 *
 * The dispatcher uses the generated schema to validate `args` BEFORE the
 * skill body sees them. Phase 1's frontmatter parser already validates
 * that `inputs_json` is a JSON array; this module shapes each entry into
 * a Zod field.
 *
 * Schema is .strict() — unknown keys reject. Skill bodies declaring
 * `inputs: []` accept only `{}`. A skill that wants free-form input
 * declares one `name: payload, type: object` field instead.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Declaration schema — validates ONE entry in `inputs[]`
// ---------------------------------------------------------------------------

const SUPPORTED_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "enum",
  "object",
  "array",
] as const;

type SupportedType = (typeof SUPPORTED_TYPES)[number];

const InputDeclSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-zA-Z_][a-zA-Z0-9_]*$/,
        "input name must be a valid identifier (letters, digits, underscore)",
      ),
    type: z.enum(SUPPORTED_TYPES),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    /** For type=enum only: the allowed string values. */
    values: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (decl) => {
      if (decl.type === "enum") {
        return Array.isArray(decl.values) && decl.values.length > 0;
      }
      return decl.values === undefined;
    },
    {
      message:
        "type=enum requires a non-empty `values` array; other types must omit `values`",
    },
  );

export type InputDecl = z.infer<typeof InputDeclSchema>;

const InputDeclArraySchema = z.array(InputDeclSchema);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type InputsBuildErrorKind =
  | "malformed_json"
  | "schema_violation"
  | "duplicate_name";

export class InputsBuildError extends Error {
  readonly kind: InputsBuildErrorKind;
  readonly issues?: z.ZodError["issues"];
  constructor(
    kind: InputsBuildErrorKind,
    message: string,
    issues?: z.ZodError["issues"],
  ) {
    super(message);
    this.name = "InputsBuildError";
    this.kind = kind;
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a Zod schema describing the `args` object a skill accepts.
 *
 * Returns z.object({}).strict() when `inputsJson` is `[]` — skills with no
 * declared inputs accept only `{}`.
 *
 * Throws `InputsBuildError` on malformed JSON, schema-violating declarations,
 * or duplicate input names. Callers should treat any throw as a
 * "skill is corrupt" condition (Phase 1's parser should have caught it,
 * but defensive validation here prevents a malformed row from bricking
 * `skill_run`).
 */
export function buildArgsSchema(
  inputsJson: string,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputsJson);
  } catch (e) {
    throw new InputsBuildError(
      "malformed_json",
      `inputs_json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const decls = InputDeclArraySchema.safeParse(parsed);
  if (!decls.success) {
    throw new InputsBuildError(
      "schema_violation",
      "inputs_json does not match the InputDecl shape",
      decls.error.issues,
    );
  }

  const seen = new Set<string>();
  for (const decl of decls.data) {
    if (seen.has(decl.name)) {
      throw new InputsBuildError(
        "duplicate_name",
        `duplicate input name: "${decl.name}"`,
      );
    }
    seen.add(decl.name);
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const decl of decls.data) {
    let field: z.ZodTypeAny = baseTypeFor(decl);
    if (!decl.required) {
      // Optional fields: accept undefined; apply default if declared.
      // We do NOT round-trip `default` into a `.default()` because the
      // dispatcher logs `args` verbatim — auto-filling defaults would
      // make `cost_ledger` entries lie about what the LLM passed.
      // Callers wanting defaults read them from `inputs_json` directly.
      field = field.optional();
    }
    shape[decl.name] = field;
  }

  return z.object(shape).strict();
}

function baseTypeFor(decl: InputDecl): z.ZodTypeAny {
  switch (decl.type as SupportedType) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "enum": {
      const values = decl.values ?? [];
      if (values.length === 0) {
        // Defensive — refine on InputDeclSchema should prevent this,
        // but TypeScript narrowing requires the runtime check.
        throw new InputsBuildError(
          "schema_violation",
          `enum input "${decl.name}" missing values`,
        );
      }
      return z.enum(values as [string, ...string[]]);
    }
    case "object":
      // Open-shape object — skill body is responsible for inner validation.
      return z.record(z.string(), z.unknown());
    case "array":
      return z.array(z.unknown());
  }
}

/**
 * Validate `args` against the schema generated from `inputsJson`. Returns
 * the validated object on success or a structured error envelope on
 * failure. Never throws — the dispatcher converts a failed validation
 * into a `skill_failures` row with `error_class='other'` + a detail
 * pulled from the first Zod issue.
 */
export function validateSkillArgs(
  inputsJson: string,
  args: unknown,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string } {
  let schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  try {
    schema = buildArgsSchema(inputsJson);
  } catch (e) {
    return {
      ok: false,
      reason:
        e instanceof InputsBuildError
          ? `skill inputs_json corrupt: ${e.message}`
          : `schema build failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.length ? first.path.join(".") : "<root>";
    return { ok: false, reason: `${path}: ${first?.message ?? "invalid"}` };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}
