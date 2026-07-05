import { describe, expect, it } from "vitest";
import { parseJsonFromLlm } from "./llm-json.js";

describe("parseJsonFromLlm", () => {
  it("parses plain JSON", () => {
    expect(parseJsonFromLlm<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a ```json fenced block", () => {
    expect(parseJsonFromLlm('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses a bare ``` fenced block", () => {
    expect(parseJsonFromLlm('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses a fenced block surrounded by prose", () => {
    expect(
      parseJsonFromLlm('Here you go:\n```json\n{"a":1}\n```\nHope it helps!'),
    ).toEqual({ a: 1 });
  });

  it("extracts a prose-wrapped object without fences", () => {
    expect(parseJsonFromLlm('The result is {"a":1} as requested.')).toEqual({
      a: 1,
    });
  });

  it("parses arrays, fenced and prose-wrapped", () => {
    expect(parseJsonFromLlm("```json\n[1,2]\n```")).toEqual([1, 2]);
    expect(parseJsonFromLlm("Sure: [1,2]")).toEqual([1, 2]);
  });

  it("trims surrounding whitespace", () => {
    expect(parseJsonFromLlm('  \n {"a":1} \n ')).toEqual({ a: 1 });
  });

  it("throws a descriptive error with an excerpt on unparseable input", () => {
    expect(() => parseJsonFromLlm("I cannot answer that.")).toThrow(
      /LLM output is not valid JSON.*I cannot answer that\./,
    );
  });

  it("throws when the extracted span is still invalid", () => {
    expect(() => parseJsonFromLlm("broken {a: not json} here")).toThrow(
      /LLM output is not valid JSON/,
    );
  });
});
