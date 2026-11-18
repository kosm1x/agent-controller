/**
 * listVoices parsing and filtering, against a synthetic voice table.
 *
 * The real tool fetches its voice list over the network, so the child-process
 * module is replaced fail-closed: every export refuses and records the call,
 * and a case passes only when it arranged each call itself. The refusal is
 * also checked after each case because listVoices swallows every error.
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

import { listVoices } from "./tts.js";

// Shape of the tool's listing: a header line, a dashes line, then one row per
// voice with columns separated by runs of two or more spaces. Names are
// invented. Six data rows, a blank line and a single-column line.
const TABLE = [
  "Name                   Gender    ContentCategories   VoicePersonalities",
  "---------------------  --------  ------------------  ------------------",
  "en-GB-AlderNeural      Male      General             Calm, Clear",
  "en-US-BirchNeural      Female    News, Novel         Warm",
  "es-ES-CedroNeural      Male      General             Friendly",
  "",
  "es-MX-DuraznoNeural    Female    General             Bright, Positive",
  "StrayColumn",
  "es-MX-EncinoNeural     Male      Conversation        Steady",
  "fr-FR-FresnoNeural     Female    General             Lively",
  "",
].join("\n");

const ALL = [
  { name: "en-GB-AlderNeural", gender: "Male", locale: "en-GB" },
  { name: "en-US-BirchNeural", gender: "Female", locale: "en-US" },
  { name: "es-ES-CedroNeural", gender: "Male", locale: "es-ES" },
  { name: "es-MX-DuraznoNeural", gender: "Female", locale: "es-MX" },
  { name: "es-MX-EncinoNeural", gender: "Male", locale: "es-MX" },
  { name: "fr-FR-FresnoNeural", gender: "Female", locale: "fr-FR" },
];

beforeEach(() => {
  mocks.unexpected.length = 0;
  mocks.execFileSync.mockReset();
  mocks.execFileSync.mockImplementation(mocks.refuse("execFileSync"));
});

afterEach(() => {
  expect(mocks.unexpected).toEqual([]);
  vi.restoreAllMocks();
});

function arrangeTable(): void {
  mocks.execFileSync.mockImplementationOnce(() => TABLE);
}

describe("listVoices", () => {
  it("runs edge-tts once with the single argument --list-voices, as text", () => {
    arrangeTable();
    listVoices();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "edge-tts",
      ["--list-voices"],
      expect.objectContaining({ encoding: "utf-8", timeout: 15_000 }),
    );
  });

  it("skips the two header lines and keeps the first data row", () => {
    arrangeTable();
    const voices = listVoices();
    expect(voices).toHaveLength(6);
    expect(voices[0].name).toBe("en-GB-AlderNeural");
    expect(voices[5].name).toBe("fr-FR-FresnoNeural");
  });

  it("reads name and gender from the columns and the locale from the name's first two parts", () => {
    arrangeTable();
    expect(listVoices()).toEqual(ALL);
  });

  it("skips blank lines and lines with a single column", () => {
    arrangeTable();
    const names = listVoices().map((v) => v.name);
    expect(names).not.toContain("");
    expect(names).not.toContain("StrayColumn");
    expect(names).toEqual(ALL.map((v) => v.name));
  });

  it("keeps the voices whose locale starts with a language filter", () => {
    arrangeTable();
    expect(listVoices("es")).toEqual(ALL.slice(2, 5));
  });

  it("keeps only the matching region for a language-region filter", () => {
    arrangeTable();
    expect(listVoices("es-MX")).toEqual(ALL.slice(3, 5));
  });

  it("matches the filter against the locale, not the full voice name", () => {
    arrangeTable();
    expect(listVoices("es-MX-D")).toEqual([]);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it("does not match a filter that appears only later in the locale", () => {
    arrangeTable();
    expect(listVoices("MX")).toEqual([]);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list for a language with no voices", () => {
    arrangeTable();
    expect(listVoices("xx")).toEqual([]);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list without throwing when the tool fails", () => {
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error("synthetic tool failure");
    });
    let voices: unknown;
    expect(() => {
      voices = listVoices();
    }).not.toThrow();
    expect(voices).toEqual([]);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });
});
