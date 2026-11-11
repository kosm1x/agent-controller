import { describe, it, expect } from "vitest";
import { parseCriticVerdict, extractBalancedObjects } from "./critic-verdict.js";

describe("parseCriticVerdict", () => {
  it("accepts pure JSON", () => {
    expect(parseCriticVerdict('{"verdict":"pass","critique":""}')).toEqual({
      verdict: "pass",
      critique: "",
    });
  });

  it("accepts JSON inside a markdown fence", () => {
    const raw = 'Here:\n```json\n{"verdict": "fail", "critique": "bad"}\n```';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "fail",
      critique: "bad",
    });
  });

  it("accepts a fence without a language tag", () => {
    const raw = '```\n{"verdict": "pass", "critique": "ok"}\n```';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "pass",
      critique: "ok",
    });
  });

  it("when a fence is present, only its content is searched: the fenced verdict beats an earlier prose one", () => {
    const raw =
      'Draft: {"verdict": "pass", "critique": "prose"}\n```json\n{"verdict": "fail", "critique": "fenced"}\n```';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "fail",
      critique: "fenced",
    });
  });

  it("when the first fence holds no verdict, a verdict outside it is not found", () => {
    const raw =
      '```json\n{"example": true}\n```\n{"verdict": "pass", "critique": "outside"}';
    expect(parseCriticVerdict(raw)).toBeNull();
  });

  it("accepts JSON surrounded by prose", () => {
    const raw =
      'My verdict follows. {"verdict": "fail", "critique": "names a date"} Thanks.';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "fail",
      critique: "names a date",
    });
  });

  it("skips a non-JSON example object and returns the real verdict after it", () => {
    const raw =
      'Format: {"verdict": "pass" | "fail", "critique": "..."}\nAnswer: {"verdict": "fail", "critique": "metric"}';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "fail",
      critique: "metric",
    });
  });

  it("returns the FIRST valid verdict object when two valid ones appear", () => {
    const raw =
      'Example: {"verdict": "pass", "critique": ""} Real: {"verdict": "fail", "critique": "x"}';
    expect(parseCriticVerdict(raw)).toEqual({ verdict: "pass", critique: "" });
  });

  it("skips a wrong-shape object before a valid one", () => {
    const raw = '{"foo": 1} {"verdict": "pass", "critique": "fine"}';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "pass",
      critique: "fine",
    });
  });

  it("finds a verdict object nested inside an array", () => {
    expect(
      parseCriticVerdict('[{"verdict": "pass", "critique": ""}]'),
    ).toEqual({ verdict: "pass", critique: "" });
  });

  it("is not confused by braces inside JSON strings", () => {
    const raw = '{"verdict": "fail", "critique": "has a } and a { inside"}';
    expect(parseCriticVerdict(raw)).toEqual({
      verdict: "fail",
      critique: "has a } and a { inside",
    });
  });

  it.each([
    ["empty string", ""],
    ["plain prose", "looks fine to me"],
    ["malformed JSON", '{"verdict": "pass", "critique": '],
    ["unknown verdict value", '{"verdict": "maybe", "critique": ""}'],
    ["critique not a string", '{"verdict": "pass", "critique": 3}'],
    ["critique missing", '{"verdict": "pass"}'],
    ["null literal", "null"],
  ])("returns null for %s", (_label, raw) => {
    expect(parseCriticVerdict(raw)).toBeNull();
  });
});

describe("extractBalancedObjects", () => {
  it("yields each top-level object in scan order", () => {
    expect([...extractBalancedObjects('a {"x":{"y":1}} b {"z":2}')]).toEqual([
      '{"x":{"y":1}}',
      '{"z":2}',
    ]);
  });

  it("honours backslash escapes inside strings", () => {
    expect([...extractBalancedObjects('{"a":"q\\"}"}')]).toEqual([
      '{"a":"q\\"}"}',
    ]);
  });
});
