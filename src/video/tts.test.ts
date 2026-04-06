/**
 * TTS engine tests (v6.2 V1).
 * Tests pure functions (splitTextAtSentences, resolveVoice, listVoices).
 * ffprobe and edge-tts tests require the binaries installed.
 */

import { describe, it, expect } from "vitest";
import {
  splitTextAtSentences,
  resolveVoice,
  probeAudioDuration,
} from "./tts.js";

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

  it("returns empty array for empty text", () => {
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
  it("returns 0 for non-existent file", () => {
    expect(probeAudioDuration("/tmp/nonexistent-file.mp3")).toBe(0);
  });

  it("returns 0 for invalid path", () => {
    expect(probeAudioDuration("")).toBe(0);
  });
});

describe("listVoices", () => {
  it("returns voices (requires edge-tts installed)", async () => {
    const { listVoices } = await import("./tts.js");
    const voices = listVoices();
    // edge-tts is installed on this VPS
    expect(voices.length).toBeGreaterThan(100);
  });

  it("filters by language prefix", async () => {
    const { listVoices } = await import("./tts.js");
    const esVoices = listVoices("es");
    expect(esVoices.length).toBeGreaterThan(5);
    for (const v of esVoices) {
      expect(v.locale).toMatch(/^es/);
    }
  });

  it("returns empty for non-existent language", async () => {
    const { listVoices } = await import("./tts.js");
    const voices = listVoices("xx");
    expect(voices).toEqual([]);
  });
});
