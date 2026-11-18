/**
 * TTS engine tests: splitTextAtSentences, resolveVoice and the duration probe.
 * listVoices is covered in tts-voices.test.ts.
 *
 * No case may depend on a program installed on the host, so the child-process
 * module is replaced fail-closed: every export refuses and records the call,
 * and a probe case passes only when it arranged the call itself. The refusal
 * is also checked after each case because the probe swallows every error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => {
  const unexpected: string[] = [];
  const refuse =
    (name: string) =>
    (...args: unknown[]): never => {
      unexpected.push(`${name} ${JSON.stringify(args)}`);
      throw new Error(`refused: no child process in this test (${name})`);
    };
  return {
    unexpected,
    refuse,
    execFileSync: vi.fn<(...args: unknown[]) => unknown>(),
  };
});

vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  const refused: Record<string, unknown> = Object.fromEntries(
    Object.keys(real)
      .filter((k) => k !== "default")
      .map((k) => [k, mocks.refuse(k)]),
  );
  refused.execFileSync = mocks.execFileSync;
  return { ...refused, default: refused };
});

import {
  splitTextAtSentences,
  resolveVoice,
  probeAudioDuration,
} from "./tts.js";

beforeEach(() => {
  mocks.unexpected.length = 0;
  mocks.execFileSync.mockReset();
  mocks.execFileSync.mockImplementation(mocks.refuse("execFileSync"));
});

afterEach(() => {
  expect(mocks.unexpected).toEqual([]);
  vi.restoreAllMocks();
});

describe("splitTextAtSentences", () => {
  it("returns single chunk for short text", () => {
    const result = splitTextAtSentences("Hello world.", 2000);
    expect(result).toEqual(["Hello world."]);
  });

  it("splits at sentence boundaries", () => {
    const longText =
      "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const result = splitTextAtSentences(longText, 40);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });

  it("preserves all content after splitting", () => {
    const text = "A. B. C. D. E.";
    const chunks = splitTextAtSentences(text, 8);
    const rejoined = chunks.join(" ");
    // All sentences should be present
    expect(rejoined).toContain("A.");
    expect(rejoined).toContain("E.");
  });

  it("hard-splits text with no sentence boundaries at maxChars", () => {
    const text =
      "This is a very long text without any periods that just keeps going and going";
    const result = splitTextAtSentences(text, 30);
    // V1 audit fix: oversized sentences get hard-split at maxChars
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("handles question marks and exclamation marks as boundaries", () => {
    const text = "Is this working? Yes it is! And here we go.";
    const result = splitTextAtSentences(text, 25);
    expect(result.length).toBeGreaterThan(1);
  });

  it("returns a single empty chunk for empty text", () => {
    expect(splitTextAtSentences("", 2000)).toEqual([""]);
  });

  it("uses default maxChars of 2000", () => {
    const shortText = "Short text.";
    expect(splitTextAtSentences(shortText)).toEqual(["Short text."]);
  });
});

describe("resolveVoice", () => {
  it("returns default Spanish voice for 'es'", () => {
    expect(resolveVoice("es")).toBe("es-MX-DaliaNeural");
  });

  it("returns default English voice for 'en'", () => {
    expect(resolveVoice("en")).toBe("en-US-AriaNeural");
  });

  it("returns default English for unknown languages", () => {
    expect(resolveVoice("fr")).toBe("en-US-AriaNeural");
  });

  it("uses explicit voice override when provided", () => {
    expect(resolveVoice("es", "es-ES-AlvaroNeural")).toBe("es-ES-AlvaroNeural");
  });

  it("uses explicit voice even for mismatched language", () => {
    expect(resolveVoice("en", "es-MX-JorgeNeural")).toBe("es-MX-JorgeNeural");
  });
});

describe("probeAudioDuration", () => {
  const MISSING = "/nonexistent/scene-000.mp3";

  // The program and argument list the probe must use, with the path last.
  function expectProbeCall(path: string): void {
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", path],
      expect.objectContaining({ encoding: "utf-8", timeout: 10_000 }),
    );
  }

  // How the call fails when the program exits non-zero (missing or unreadable
  // input) and when the program itself is not installed.
  function exitsNonZero(): never {
    throw Object.assign(new Error("Command failed: ffprobe"), {
      status: 1,
      stdout: "",
      stderr: "",
    });
  }
  function notFound(): never {
    throw Object.assign(new Error("spawnSync ffprobe ENOENT"), {
      code: "ENOENT",
    });
  }

  function probe(path: string): unknown {
    let result: unknown;
    expect(() => {
      result = probeAudioDuration(path);
    }).not.toThrow();
    return result;
  }

  it("returns the duration from the answer as a number", () => {
    mocks.execFileSync.mockImplementationOnce(() =>
      JSON.stringify({
        format: { filename: "a.mp3", duration: "12.345000", size: "4096" },
      }),
    );
    const result = probe("a.mp3");
    expect(result).toBe(12.345);
    expectProbeCall("a.mp3");
  });

  it("returns 0 without throwing when the probe exits non-zero for a missing file", () => {
    mocks.execFileSync.mockImplementationOnce(exitsNonZero);
    expect(probe(MISSING)).toBe(0);
    expectProbeCall(MISSING);
  });

  it("returns 0 without throwing for an empty path", () => {
    mocks.execFileSync.mockImplementationOnce(exitsNonZero);
    expect(probe("")).toBe(0);
    expectProbeCall("");
  });

  it("returns 0 without throwing when the probe program is not installed", () => {
    mocks.execFileSync.mockImplementationOnce(notFound);
    expect(probe(MISSING)).toBe(0);
    expectProbeCall(MISSING);
  });

  it("returns 0 when the answer has no duration", () => {
    mocks.execFileSync
      .mockImplementationOnce(() =>
        JSON.stringify({ format: { filename: "a.mp3", size: "4096" } }),
      )
      .mockImplementationOnce(() => JSON.stringify({}));
    expect(probe("a.mp3")).toBe(0);
    expect(probe("a.mp3")).toBe(0);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it("returns 0 when the answer is not JSON", () => {
    mocks.execFileSync.mockImplementationOnce(() => "not json");
    expect(probe("a.mp3")).toBe(0);
    expectProbeCall("a.mp3");
  });

  it("returns 0 when the duration in the answer is not a finite number", () => {
    for (const duration of ["N/A", "", "Infinity"]) {
      mocks.execFileSync.mockImplementationOnce(() =>
        JSON.stringify({ format: { filename: "a.mp3", duration } }),
      );
      expect(probe("a.mp3")).toBe(0);
    }
    expect(mocks.execFileSync).toHaveBeenCalledTimes(3);
  });

  it("returns a zero or negative duration unchanged as a number", () => {
    for (const [duration, expected] of [
      ["-1.5", -1.5],
      ["0", 0],
    ] as const) {
      mocks.execFileSync.mockImplementationOnce(() =>
        JSON.stringify({ format: { filename: "a.mp3", duration } }),
      );
      expect(probe("a.mp3")).toBe(expected);
    }
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });
});
