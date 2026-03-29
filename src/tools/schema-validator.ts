/**
 * JSON Schema → Zod converter for tool argument validation.
 *
 * Converts the JSON Schema defined in tool definitions into Zod schemas
 * at registration time. Validates tool call arguments before execution,
 * catching type errors, missing fields, and enum violations early —
 * with clear error messages the LLM can use to retry.
 *
 * Only handles the JSON Schema subset our tools actually use.
 * Unknown/complex types pass through as z.unknown().
 */

import { z, type ZodType } from "zod";

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Convert a single JSON Schema property to a Zod schema.
 */
function propertyToZod(prop: JsonSchemaProperty): ZodType {
  // Enum — always string enum
  if (prop.enum && Array.isArray(prop.enum)) {
    if (prop.enum.length === 0) return z.string();
    return z.enum(prop.enum as [string, ...string[]]);
  }

  switch (prop.type) {
    case "string":
      return z.string();

    case "number":
      return z.coerce.number();

    case "integer":
      return z.coerce.number().int();

    case "boolean":
      return z.coerce.boolean();

    case "array": {
      const itemSchema = prop.items ? propertyToZod(prop.items) : z.unknown();
      return z.array(itemSchema);
    }

    case "object": {
      if (prop.properties) {
        return objectToZod(prop as JsonSchemaObject);
      }
      return z.record(z.string(), z.unknown());
    }

    default:
      return z.unknown();
  }
}

/**
 * Convert a JSON Schema object (with properties + required) to z.object().
 */
function objectToZod(schema: JsonSchemaObject): ZodType {
  if (!schema.properties) return z.record(z.string(), z.unknown());

  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodType> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    let fieldSchema = propertyToZod(prop);
    if (!required.has(key)) {
      fieldSchema = fieldSchema.optional();
    }
    shape[key] = fieldSchema;
  }

  // catchall allows extra fields — LLMs sometimes send unexpected keys
  return z.object(shape).catchall(z.unknown());
}

/**
 * Convert a tool's JSON Schema parameters to a Zod schema.
 * Returns null if the schema can't be converted (no properties, not an object).
 */
export function jsonSchemaToZod(
  parameters: Record<string, unknown>,
): ZodType | null {
  const schema = parameters as JsonSchemaObject;
  if (schema.type !== "object" || !schema.properties) {
    return null;
  }
  return objectToZod(schema);
}

/**
 * Validate args against a Zod schema. Returns success or a human-readable error.
 */
export function validateArgs(
  schema: ZodType,
  args: Record<string, unknown>,
): { success: true } | { success: false; error: string } {
  const result = schema.safeParse(args);
  if (result.success) {
    return { success: true };
  }

  // Build a concise error message the LLM can act on
  const issues = result.error.issues
    .slice(0, 5) // cap at 5 issues to avoid prompt bloat
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

  return { success: false, error: issues };
}
