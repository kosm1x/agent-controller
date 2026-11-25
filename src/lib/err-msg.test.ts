import { describe, it, expect } from "vitest";
import { errMsg } from "./err-msg.js";

// A reader that tests an error text by truth takes an empty one for "no
// error", so a caught value whose own text is empty gets a fixed sentence.
const NO_MESSAGE = "unknown error (no message given)";

describe("errMsg", () => {
  it.each([
    ["an Error without a message", new Error()],
    ["an Error with an empty message", new Error("")],
    ["a TypeError with an empty message", new TypeError("")],
    ["a thrown empty string", ""],
    ["an empty array", []],
    ["an object whose text form is empty", { toString: (): string => "" }],
    ["an Error whose message is undefined", Object.assign(new Error("x"), { message: undefined })],
    ["an Error whose message is a number", Object.assign(new Error("x"), { message: 5 })],
    ["an Error whose message is a symbol", Object.assign(new Error("x"), { message: Symbol("s") })],
  ])("%s gives the fixed sentence", (_label, value) => {
    expect(errMsg(value)).toBe(NO_MESSAGE);
  });

  it.each([
    ["an Error with a message", new Error("x"), "x"],
    ["an Error whose message is spaces", new Error("   "), "   "],
    ["a thrown string of spaces", "   ", "   "],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["an Error saying boom", new Error("boom"), "boom"],
    ["a thrown string saying boom", "boom", "boom"],
    ["a plain object", {}, "[object Object]"],
    ["a number", 0, "0"],
  ])("%s keeps its own text", (_label, value, expected) => {
    expect(errMsg(value)).toBe(expected);
  });

  it("a value whose text form throws still throws", () => {
    expect(() => errMsg(Object.create(null))).toThrow(TypeError);
  });
});
