import { describe, it, expect } from "vitest";
import { safeSlice, sanitizeSurrogates } from "./unicode-safe.js";

describe("safeSlice", () => {
  it("returns the input unchanged when n >= length", () => {
    expect(safeSlice("hello", 10)).toBe("hello");
    expect(safeSlice("hello", 5)).toBe("hello");
  });

  it("slices normally when the cut does not land on a surrogate pair", () => {
    expect(safeSlice("hello world", 5)).toBe("hello");
  });

  it("backs off one code unit when cut would strand a high surrogate", () => {
    // "😀" is U+1F600 = surrogate pair \uD83D\uDE00 (2 code units)
    const s = "a😀b"; // code units: 'a', 0xD83D, 0xDE00, 'b' — length 4
    expect(s.length).toBe(4);
    // Cutting at n=2 would keep only 'a' + lone high surrogate 0xD83D
    const sliced = safeSlice(s, 2);
    expect(sliced).toBe("a");
    // Check there are no lone surrogates
    expect(sanitizeSurrogates(sliced)).toBe(sliced);
  });

  it("preserves a full surrogate pair at the cut boundary", () => {
    const s = "a😀b";
    // Cut at n=3 includes the full pair
    expect(safeSlice(s, 3)).toBe("a😀");
  });

  it("handles n=0", () => {
    expect(safeSlice("abc", 0)).toBe("");
  });

  it("handles empty string", () => {
    expect(safeSlice("", 5)).toBe("");
    expect(safeSlice("", 0)).toBe("");
  });
});

describe("sanitizeSurrogates", () => {
  it("returns the same reference for a clean string", () => {
    const s = "hello world 😀 🎉";
    expect(sanitizeSurrogates(s)).toBe(s);
  });

  it("replaces a lone high surrogate with U+FFFD", () => {
    const dirty = "before" + "\uD83D" + "after";
    const clean = sanitizeSurrogates(dirty);
    expect(clean).toBe("before\uFFFDafter");
  });

  it("replaces a lone low surrogate with U+FFFD", () => {
    const dirty = "before" + "\uDE00" + "after";
    const clean = sanitizeSurrogates(dirty);
    expect(clean).toBe("before\uFFFDafter");
  });

  it("preserves valid surrogate pairs", () => {
    const s = "a\uD83D\uDE00b";
    expect(sanitizeSurrogates(s)).toBe(s);
  });

  it("handles truncated emoji at end-of-string (high without low)", () => {
    const dirty = "hello\uD83D"; // lone high at the end
    expect(sanitizeSurrogates(dirty)).toBe("hello\uFFFD");
  });

  it("handles multiple lone surrogates", () => {
    const dirty = "\uD83D a \uDE00 b \uD83D";
    expect(sanitizeSurrogates(dirty)).toBe("\uFFFD a \uFFFD b \uFFFD");
  });

  it("handles lone low surrogate at position 0", () => {
    const dirty = "\uDE00" + "rest";
    expect(sanitizeSurrogates(dirty)).toBe("\uFFFD" + "rest");
  });

  it("handles consecutive lone surrogates with no separator", () => {
    // Two high surrogates back-to-back: neither pairs with a low, so both fail.
    const dirty = "a\uD83D\uD83Db";
    expect(sanitizeSurrogates(dirty)).toBe("a\uFFFD\uFFFDb");
  });

  it("does not consume a valid pair's high surrogate when a lone one precedes it", () => {
    // Pattern: lone high, then a valid pair. The rebuild loop must treat the
    // first \uD83D as lone (next char is also high, not low) and keep the pair.
    const dirty = "\uD83D\uD83D\uDE00";
    expect(sanitizeSurrogates(dirty)).toBe("\uFFFD\uD83D\uDE00");
  });

  it("handles empty string", () => {
    expect(sanitizeSurrogates("")).toBe("");
  });

  it("handles large clean strings in one pass", () => {
    const big = "x".repeat(200_000) + "😀".repeat(1000);
    const result = sanitizeSurrogates(big);
    expect(result).toBe(big); // same reference returned for clean input
  });

  it("produces JSON-serializable output for previously broken input", () => {
    // The real-world failure mode: a slice-truncated emoji produces a lone high
    // surrogate, which the JSON serializer encodes as \uD83D — and the Claude
    // API then rejects because there's no matching low surrogate.
    const dirty = "some content " + "\uD83D" + " more content";
    const clean = sanitizeSurrogates(dirty);
    // JSON parse/stringify round-trip must succeed on the sanitized version.
    const round = JSON.parse(JSON.stringify(clean));
    expect(round).toBe(clean);
  });
});
