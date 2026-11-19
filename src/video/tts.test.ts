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
  // The children run through promisify(execFile) (MCEventLoopBlock).
  // `execFile` answers with stdout (or a function returning it, run when the
  // child settles) or throws; the call is recorded at spawn and the promise
  // settles on a later tick, carrying `.child` like the real one.
  const execFile = vi.fn<(...args: unknown[]) => unknown>();
  const stdinEnds: Array<ReturnType<typeof vi.fn>> = [];
  const promisified = (...args: unknown[]) => {
    const end = vi.fn();
    stdinEnds.push(end);
    let out: unknown;
    let err: unknown;
    let failed = false;
    try {
      out = execFile(...args);
    } catch (e) {
      failed = true;
      err = e;
    }
    const settled = new Promise((res, rej) =>
      setImmediate(() => {
        if (failed) return rej(err);
        try {
          res({ stdout: typeof out === "function" ? out() : out, stderr: "" });
        } catch (e) {
          rej(e);
        }
      }),
    );
    return Object.assign(settled, { child: { stdin: { end } } });
  };
  return { unexpected, refuse, execFile, stdinEnds, promisified };
});

vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  const refused: Record<string, unknown> = Object.fromEntries(
    Object.keys(real)
      .filter((k) => k !== "default")
      .map((k) => [k, mocks.refuse(k)]),
  );
  refused.execFile = Object.assign(mocks.refuse("execFile"), {
    [Symbol.for("nodejs.util.promisify.custom")]: mocks.promisified,
  });
  return { ...refused, default: refused };
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  splitTextAtSentences,
  resolveVoice,
  probeAudioDuration,
  generateNarration,
  generatePerSceneTTS,
} from "./tts.js";

beforeEach(() => {
  mocks.unexpected.length = 0;
  mocks.execFile.mockReset();
  mocks.execFile.mockImplementation(mocks.refuse("execFile"));
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
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", path],
      expect.objectContaining({ encoding: "utf-8", timeout: 10_000 }),
    );
  }

  // How the call fails when the program exits non-zero (missing or unreadable
  // input) and when the program itself is not installed.
  function exitsNonZero(): never {
    throw Object.assign(new Error("Command failed: ffprobe"), {
      code: 1,
      stdout: "",
      stderr: "",
    });
  }
  function notFound(): never {
    throw Object.assign(new Error("spawn ffprobe ENOENT"), {
      code: "ENOENT",
    });
  }

  // Resolves (never rejects): a rejection fails the case here.
  async function probe(path: string): Promise<unknown> {
    return await probeAudioDuration(path);
  }

  it("returns the duration from the answer as a number", async () => {
    mocks.execFile.mockImplementationOnce(() =>
      JSON.stringify({
        format: { filename: "a.mp3", duration: "12.345000", size: "4096" },
      }),
    );
    const result = await probe("a.mp3");
    expect(result).toBe(12.345);
    expectProbeCall("a.mp3");
  });

  it("returns 0 without throwing when the probe exits non-zero for a missing file", async () => {
    mocks.execFile.mockImplementationOnce(exitsNonZero);
    expect(await probe(MISSING)).toBe(0);
    expectProbeCall(MISSING);
  });

  it("returns 0 without throwing for an empty path", async () => {
    mocks.execFile.mockImplementationOnce(exitsNonZero);
    expect(await probe("")).toBe(0);
    expectProbeCall("");
  });

  it("returns 0 without throwing when the probe program is not installed", async () => {
    mocks.execFile.mockImplementationOnce(notFound);
    expect(await probe(MISSING)).toBe(0);
    expectProbeCall(MISSING);
  });

  it("returns 0 when the answer has no duration", async () => {
    mocks.execFile
      .mockImplementationOnce(() =>
        JSON.stringify({ format: { filename: "a.mp3", size: "4096" } }),
      )
      .mockImplementationOnce(() => JSON.stringify({}));
    expect(await probe("a.mp3")).toBe(0);
    expect(await probe("a.mp3")).toBe(0);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("returns 0 when the answer is not JSON", async () => {
    mocks.execFile.mockImplementationOnce(() => "not json");
    expect(await probe("a.mp3")).toBe(0);
    expectProbeCall("a.mp3");
  });

  it("returns 0 when the duration in the answer is not a finite number", async () => {
    for (const duration of ["N/A", "", "Infinity"]) {
      mocks.execFile.mockImplementationOnce(() =>
        JSON.stringify({ format: { filename: "a.mp3", duration } }),
      );
      expect(await probe("a.mp3")).toBe(0);
    }
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });

  it("returns a zero or negative duration unchanged as a number", async () => {
    for (const [duration, expected] of [
      ["-1.5", -1.5],
      ["0", 0],
    ] as const) {
      mocks.execFile.mockImplementationOnce(() =>
        JSON.stringify({ format: { filename: "a.mp3", duration } }),
      );
      expect(await probe("a.mp3")).toBe(expected);
    }
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });
});

// edge-tts, the silence/concat ffmpeg steps and the silent fallback run as
// async children (MCEventLoopBlock). Each child "writes" its output only when
// it settles, so a call that is not awaited finds no file.
describe("generateNarration / generatePerSceneTTS — async children", () => {
  let dir: string;
  const events: string[] = [];
  const argvs = () =>
    mocks.execFile.mock.calls.map(
      (c) => `${c[0]} ${(c[1] as string[]).join(" ")}`,
    );
  /** The output path of an edge-tts (--write-media) or ffmpeg (last) call. */
  const outputOf = (cmd: string, args: string[]) => {
    const out =
      cmd === "edge-tts"
        ? args[args.indexOf("--write-media") + 1]
        : cmd === "ffmpeg"
          ? args.at(-1)
          : undefined;
    // Only into this test's temp dir: an argv without the expected output
    // flag (indexOf -1 → args[0]) must not become a path in the cwd.
    if (!out?.startsWith(`${dir}/`))
      throw new Error(`${cmd} output outside the test dir: ${out}`);
    return out;
  };
  const writes =
    (label = "") =>
    (cmd: unknown, args: unknown) => {
      const out = outputOf(cmd as string, args as string[]);
      events.push(`call ${label || cmd}`);
      return () => {
        writeFileSync(out, "audio");
        events.push(`done ${label || cmd}`);
        return "";
      };
    };
  const fails = (cmd: unknown) => {
    events.push(`call ${cmd} (fails)`);
    throw Object.assign(new Error(`Command failed: ${cmd}`), { code: 1 });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-test-tts-"));
    events.length = 0;
    mocks.stdinEnds.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("one chunk: edge-tts --file writes the media and its path is returned", async () => {
    const out = join(dir, "n.mp3");
    mocks.execFile.mockImplementationOnce(writes());
    expect(await generateNarration("Hola mundo.", out, "es")).toBe(out);
    expect(mocks.execFile.mock.calls).toEqual([
      [
        "edge-tts",
        [
          "--voice",
          "es-MX-DaliaNeural",
          "--file",
          join(dir, "n.txt"),
          "--write-media",
          out,
        ],
        { timeout: 30_000 },
      ],
    ]);
    expect(readFileSync(join(dir, "n.txt"), "utf-8")).toBe("Hola mundo.");
    expect(mocks.stdinEnds[0]).toHaveBeenCalledTimes(1);
  });

  it("--file fails → the --text fallback runs after it and its media is used", async () => {
    const out = join(dir, "n.mp3");
    mocks.execFile.mockImplementationOnce(fails).mockImplementationOnce(writes());
    expect(await generateNarration("Hi.", out, "en")).toBe(out);
    expect(mocks.execFile.mock.calls[1]).toEqual([
      "edge-tts",
      ["--voice", "en-US-AriaNeural", "--text", "Hi.", "--write-media", out],
      { timeout: 30_000 },
    ]);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("long text: parts, then the silence gap, then the concat — each awaited in turn", async () => {
    const out = join(dir, "long.mp3");
    const sentence = `${"palabra ".repeat(120).trim()}.`; // ~960 chars
    const text = [sentence, sentence, sentence].join(" "); // 3 chunks of < 2000
    const parts = splitTextAtSentences(text);
    expect(parts.length).toBeGreaterThan(1);
    mocks.execFile.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "edge-tts") return writes()(cmd, args);
      return writes(a.includes("concat") ? "concat" : "silence")(cmd, args);
    });
    expect(await generateNarration(text, out, "es")).toBe(out);
    const partsDir = join(dir, "long_parts");
    const silence = join(partsDir, "silence.mp3");
    const calls = mocks.execFile.mock.calls;
    expect(calls.filter((c) => c[0] === "edge-tts")).toHaveLength(parts.length);
    expect(calls.at(-2)).toEqual([
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.3", "-c:a", "libmp3lame", silence],
      { timeout: 10_000 },
    ]);
    expect(calls.at(-1)).toEqual([
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", join(partsDir, "concat.txt"), "-c", "copy", out],
      { timeout: 30_000 },
    ]);
    // Each child settles before the next one starts.
    expect(events.slice(-4)).toEqual([
      "call silence",
      "done silence",
      "call concat",
      "done concat",
    ]);
    expect(events.filter((e) => e.startsWith("done"))).toHaveLength(
      parts.length + 2,
    );
    expect(readFileSync(join(partsDir, "concat.txt"), "utf-8")).toBe(
      parts
        .map((_, i) => join(partsDir, `part-${String(i).padStart(3, "0")}.mp3`))
        .flatMap((f, i) =>
          i < parts.length - 1
            ? [`file '${f}'`, `file '${silence}'`]
            : [`file '${f}'`],
        )
        .join("\n"),
    );
    expect(existsSync(out)).toBe(true);
  });

  it("edge-tts fails both ways → the silent placeholder ffmpeg writes the file", async () => {
    const out = join(dir, "n.mp3");
    mocks.execFile
      .mockImplementationOnce(fails)
      .mockImplementationOnce(fails)
      .mockImplementationOnce(writes("placeholder"));
    const words = "uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince";
    expect(await generateNarration(words, out, "es")).toBe(out);
    expect(mocks.execFile.mock.calls[2]).toEqual([
      "ffmpeg",
      // 15 words / 2.5 = 6 s (floor 5).
      ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "6", "-c:a", "libmp3lame", out],
      { timeout: 30_000 },
    ]);
    expect(events.at(-1)).toBe("done placeholder");
  });

  it("a failing placeholder ffmpeg rejects (the sync code threw)", async () => {
    const out = join(dir, "n.mp3");
    mocks.execFile.mockImplementation(fails);
    await expect(generateNarration("x", out, "es")).rejects.toThrow(
      "Command failed: ffmpeg",
    );
    expect(argvs()).toHaveLength(3);
  });

  it("per scene: the probed duration for a voiced scene, the scene duration for a silent one", async () => {
    mocks.execFile.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "ffprobe") return JSON.stringify({ format: { duration: "3.25" } });
      if (cmd === "edge-tts" && a.includes(join(dir, "scene-001.mp3")))
        return fails(cmd);
      return writes()(cmd, args);
    });
    const result = await generatePerSceneTTS(
      [
        { text: "Uno.", duration: 4, imageQuery: "a" },
        { text: "Dos.", duration: 7, imageQuery: "b" },
      ],
      dir,
      { language: "es" },
    );
    expect(result).toEqual({
      files: [join(dir, "scene-000.mp3"), join(dir, "scene-001.mp3")],
      durations: [3.25, 7],
      totalDuration: 10.25,
    });
    expect(argvs()).toEqual([
      `edge-tts --voice es-MX-DaliaNeural --file ${join(dir, "scene-000.txt")} --write-media ${join(dir, "scene-000.mp3")}`,
      `ffprobe -v quiet -print_format json -show_format ${join(dir, "scene-000.mp3")}`,
      `edge-tts --voice es-MX-DaliaNeural --file ${join(dir, "scene-001.txt")} --write-media ${join(dir, "scene-001.mp3")}`,
      `edge-tts --voice es-MX-DaliaNeural --text Dos. --write-media ${join(dir, "scene-001.mp3")}`,
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 7 -c:a libmp3lame ${join(dir, "scene-001.mp3")}`,
    ]);
    expect(existsSync(join(dir, "scene-001.mp3"))).toBe(true);
  });
});
