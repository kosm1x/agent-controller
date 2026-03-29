import { describe, it, expect, vi, afterEach } from "vitest";
import { jsonSchemaToZod, validateArgs } from "./schema-validator.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsonSchemaToZod", () => {
  it("converts simple string + number properties", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(schema).not.toBeNull();

    const valid = validateArgs(schema!, { name: "Alice", age: 30 });
    expect(valid.success).toBe(true);

    const missingRequired = validateArgs(schema!, { age: 30 });
    expect(missingRequired.success).toBe(false);

    const optionalOmitted = validateArgs(schema!, { name: "Alice" });
    expect(optionalOmitted.success).toBe(true);
  });

  it("handles enum values", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "publish", "private"] },
      },
      required: ["status"],
    });
    expect(schema).not.toBeNull();

    expect(validateArgs(schema!, { status: "draft" }).success).toBe(true);
    expect(validateArgs(schema!, { status: "invalid" }).success).toBe(false);
  });

  it("coerces string numbers to numbers", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        width: { type: "number" },
        count: { type: "integer" },
      },
      required: ["width"],
    });
    expect(schema).not.toBeNull();

    // LLM commonly sends numbers as strings
    const result = validateArgs(schema!, { width: "1024" });
    expect(result.success).toBe(true);

    const intResult = validateArgs(schema!, { width: 100, count: "5" });
    expect(intResult.success).toBe(true);
  });

  it("coerces string booleans", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        append: { type: "boolean" },
      },
    });
    expect(schema).not.toBeNull();

    expect(validateArgs(schema!, { append: "true" }).success).toBe(true);
    expect(validateArgs(schema!, { append: false }).success).toBe(true);
    expect(validateArgs(schema!, { append: true }).success).toBe(true);
    expect(validateArgs(schema!, { append: "0" }).success).toBe(true);
    expect(validateArgs(schema!, { append: "1" }).success).toBe(true);
  });

  it("coerces string 'false' correctly (not truthy)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        append: { type: "boolean" },
      },
      required: ["append"],
    });
    expect(schema).not.toBeNull();

    // The critical test: "false" as string must NOT become true
    const result = schema!.safeParse({ append: "false" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).append).toBe(false);
    }

    const trueResult = schema!.safeParse({ append: "true" });
    expect(trueResult.success).toBe(true);
    if (trueResult.success) {
      expect((trueResult.data as Record<string, unknown>).append).toBe(true);
    }
  });

  it("validates arrays with typed items", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["values"],
    });
    expect(schema).not.toBeNull();

    expect(validateArgs(schema!, { values: [["a", "b"], ["c"]] }).success).toBe(
      true,
    );
    expect(validateArgs(schema!, { values: "not an array" }).success).toBe(
      false,
    );
  });

  it("allows extra fields (LLM sends unexpected keys)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    expect(schema).not.toBeNull();

    const result = validateArgs(schema!, {
      query: "hello",
      extra_field: true,
    });
    expect(result.success).toBe(true);
  });

  it("returns null for non-object schemas", () => {
    expect(jsonSchemaToZod({ type: "string" })).toBeNull();
    expect(jsonSchemaToZod({})).toBeNull();
  });

  it("provides clear error messages with field paths", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
      },
      required: ["to", "subject"],
    });
    expect(schema).not.toBeNull();

    const result = validateArgs(schema!, { to: "test@test.com" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("subject");
    }
  });

  it("handles nested objects", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "number" },
          },
          required: ["key"],
        },
      },
    });
    expect(schema).not.toBeNull();

    expect(
      validateArgs(schema!, { config: { key: "test", value: 42 } }).success,
    ).toBe(true);
    expect(validateArgs(schema!, { config: { value: 42 } }).success).toBe(
      false,
    );
  });

  it("validates a real tool schema (gsheets_write pattern)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
        append: { type: "boolean" },
      },
      required: ["spreadsheet_id", "range", "values"],
    });
    expect(schema).not.toBeNull();

    // Valid call
    expect(
      validateArgs(schema!, {
        spreadsheet_id: "abc123",
        range: "Sheet1!A:J",
        values: [["Name", "Score"]],
        append: true,
      }).success,
    ).toBe(true);

    // Missing required
    expect(
      validateArgs(schema!, {
        spreadsheet_id: "abc123",
        range: "Sheet1!A:J",
      }).success,
    ).toBe(false);
  });
});
