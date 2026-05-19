/**
 * v7.7 Spine 3 Phase 4 — tests for runtime inputs schema generator.
 */

import { describe, it, expect } from "vitest";
import {
  buildArgsSchema,
  validateSkillArgs,
  InputsBuildError,
} from "./inputs.js";

describe("buildArgsSchema", () => {
  it("returns a strict object schema for empty inputs[]", () => {
    const schema = buildArgsSchema("[]");
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ foo: 1 }).success).toBe(false);
  });

  it("accepts string + number + boolean required fields", () => {
    const decls = JSON.stringify([
      { name: "title", type: "string", required: true },
      { name: "count", type: "number", required: true },
      { name: "active", type: "boolean", required: true },
    ]);
    const schema = buildArgsSchema(decls);
    expect(
      schema.safeParse({ title: "x", count: 3, active: true }).success,
    ).toBe(true);
    expect(schema.safeParse({ title: "x", count: 3 }).success).toBe(false);
  });

  it("integer type rejects floats", () => {
    const decls = JSON.stringify([
      { name: "n", type: "integer", required: true },
    ]);
    const schema = buildArgsSchema(decls);
    expect(schema.safeParse({ n: 4 }).success).toBe(true);
    expect(schema.safeParse({ n: 4.5 }).success).toBe(false);
  });

  it("enum constrains to declared values", () => {
    const decls = JSON.stringify([
      {
        name: "kind",
        type: "enum",
        values: ["follow_up_24h", "follow_up_72h"],
        required: true,
      },
    ]);
    const schema = buildArgsSchema(decls);
    expect(schema.safeParse({ kind: "follow_up_24h" }).success).toBe(true);
    expect(schema.safeParse({ kind: "anything_else" }).success).toBe(false);
  });

  it("enum without values rejects at decl time", () => {
    const decls = JSON.stringify([
      { name: "kind", type: "enum", required: true },
    ]);
    expect(() => buildArgsSchema(decls)).toThrow(InputsBuildError);
  });

  it("non-enum with values[] rejects at decl time", () => {
    const decls = JSON.stringify([
      { name: "n", type: "number", values: ["1"], required: true },
    ]);
    expect(() => buildArgsSchema(decls)).toThrow(InputsBuildError);
  });

  it("optional fields accept undefined and don't auto-fill defaults", () => {
    const decls = JSON.stringify([
      { name: "limit", type: "number", required: false, default: 10 },
    ]);
    const schema = buildArgsSchema(decls);
    const r = schema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({});
    }
  });

  it("rejects unknown keys (strict)", () => {
    const decls = JSON.stringify([
      { name: "a", type: "string", required: true },
    ]);
    const schema = buildArgsSchema(decls);
    expect(schema.safeParse({ a: "x", b: "extra" }).success).toBe(false);
  });

  it("object type accepts arbitrary inner shape", () => {
    const decls = JSON.stringify([
      { name: "payload", type: "object", required: true },
    ]);
    const schema = buildArgsSchema(decls);
    expect(
      schema.safeParse({ payload: { anything: 1, nested: { x: true } } })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ payload: "not-object" }).success).toBe(false);
  });

  it("array type accepts arbitrary element types", () => {
    const decls = JSON.stringify([
      { name: "items", type: "array", required: true },
    ]);
    const schema = buildArgsSchema(decls);
    expect(schema.safeParse({ items: [1, "two", { three: 3 }] }).success).toBe(
      true,
    );
    expect(schema.safeParse({ items: "not-array" }).success).toBe(false);
  });

  it("rejects duplicate input names", () => {
    const decls = JSON.stringify([
      { name: "x", type: "string", required: true },
      { name: "x", type: "number", required: true },
    ]);
    expect(() => buildArgsSchema(decls)).toThrow(InputsBuildError);
  });

  it("rejects malformed JSON with kind=malformed_json", () => {
    try {
      buildArgsSchema("not-json");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InputsBuildError);
      expect((e as InputsBuildError).kind).toBe("malformed_json");
    }
  });

  it("rejects non-array JSON with kind=schema_violation", () => {
    try {
      buildArgsSchema('{"not": "an array"}');
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InputsBuildError);
      expect((e as InputsBuildError).kind).toBe("schema_violation");
    }
  });

  it("rejects invalid input names (non-identifier)", () => {
    const decls = JSON.stringify([
      { name: "has-hyphen", type: "string", required: true },
    ]);
    expect(() => buildArgsSchema(decls)).toThrow(InputsBuildError);
  });
});

describe("validateSkillArgs", () => {
  it("returns ok:true with parsed value on success", () => {
    const decls = JSON.stringify([
      { name: "lead", type: "string", required: true },
    ]);
    const r = validateSkillArgs(decls, { lead: "L-123" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ lead: "L-123" });
    }
  });

  it("returns ok:false with a structured reason on failure", () => {
    const decls = JSON.stringify([
      { name: "lead", type: "string", required: true },
    ]);
    const r = validateSkillArgs(decls, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/lead/);
    }
  });

  it("returns ok:false when schema build itself throws (corrupt inputs_json)", () => {
    const r = validateSkillArgs("not-json", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/inputs_json corrupt/);
    }
  });
});
