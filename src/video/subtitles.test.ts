/**
 * Subtitle generator tests — pure TS, no mocks needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const mockWriteFileSync = vi.fn();
vi.mock("fs", () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

import { generateSubtitles } from "./subtitles.js";
import type { VideoScript } from "./types.js";

describe("subtitles", () => {
  afterEach(() => {
    mockWriteFileSync.mockClear();
  });
  it("generates valid SRT format", () => {
    const script: VideoScript = {
      title: "Test",
      language: "es",
      totalDuration: 16,
      scenes: [
        { text: "Primera escena", duration: 8, imageQuery: "test" },
        { text: "Segunda escena", duration: 8, imageQuery: "test" },
      ],
    };

    generateSubtitles(script, "/tmp/test.srt");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test.srt",
      expect.stringContaining("00:00:00,000 --> 00:00:08,000"),
      "utf-8",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test.srt",
      expect.stringContaining("00:00:08,000 --> 00:00:16,000"),
      "utf-8",
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test.srt",
      expect.stringContaining("Primera escena"),
      "utf-8",
    );
  });

  it("handles single scene", () => {
    const script: VideoScript = {
      title: "Single",
      language: "en",
      totalDuration: 10,
      scenes: [{ text: "Only scene", duration: 10, imageQuery: "test" }],
    };

    generateSubtitles(script, "/tmp/single.srt");

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    expect(content).toContain("1\n00:00:00,000 --> 00:00:10,000\nOnly scene");
  });
});
