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

  // A catch block that calls the helper must not fail inside its catch: a
  // value whose message or text form throws when read gets a second sentence.
  const UNREADABLE = "(unreadable error)";
  const trapThrows = {
    get(): never {
      throw new Error("trap");
    },
  };

  it.each([
    ["an object with no prototype", () => Object.create(null) as unknown],
    ["an object whose toString throws", () => ({ toString(): string { throw new Error("t"); } })],
    ["an object whose toString and valueOf return objects", () => ({ toString: () => ({}), valueOf: () => ({}) })],
    ["an object whose toString returns a symbol", () => ({ toString: () => Symbol("s") })],
    ["an object whose Symbol.toPrimitive throws", () => ({ [Symbol.toPrimitive](): never { throw new Error("p"); } })],
    [
      "an Error whose message getter throws",
      () => Object.defineProperty(new Error("x"), "message", { get(): never { throw new Error("g"); } }),
    ],
    ["a proxy whose get trap throws", () => new Proxy({}, trapThrows)],
    ["a proxy over an Error whose get trap throws", () => new Proxy(new Error("x"), trapThrows)],
    [
      "a revoked proxy",
      () => {
        const r = Proxy.revocable({}, {});
        r.revoke();
        return r.proxy;
      },
    ],
  ])("%s gives the unreadable sentence", (_label, make) => {
    const value: unknown = make();
    let got: unknown;
    try {
      got = errMsg(value);
    } catch (e) {
      got = e;
    }
    expect(got).toBe(UNREADABLE);
  });

  it.each([
    ["a thrown symbol", () => Symbol("s") as unknown, "Symbol(s)"],
    ["an object whose toString returns a number", () => ({ toString: () => 5 }), "5"],
    ["a proxy over an Error", () => new Proxy(new Error("x"), {}), "x"],
    ["a proxy over a plain object", () => new Proxy({}, {}), "[object Object]"],
  ])("%s keeps its own text", (_label, make, expected) => {
    const value: unknown = make();
    let got: unknown;
    try {
      got = errMsg(value);
    } catch (e) {
      got = e;
    }
    expect(got).toBe(expected);
  });
});
