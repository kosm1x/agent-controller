import { describe, it, expect, vi, afterEach } from "vitest";
import { geminiImageTool } from "./gemini-image.js";

const { mockGetUserFacts } = vi.hoisted(() => ({
  mockGetUserFacts: vi.fn((): Array<{ key: string; value: string }> => []),
}));
vi.mock("../../db/user-facts.js", () => ({
  getUserFacts: mockGetUserFacts,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("gemini_image missing key (Ruling 3c)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockGetUserFacts.mockReset();
  });

  it("points to GEMINI_API_KEY and the gemini_api_key fact", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    mockGetUserFacts.mockReturnValue([]);
    const out = await geminiImageTool.execute({ prompt: "a cat" });
    const { error } = JSON.parse(out) as { error: string };
    expect(error).toBe(
      "No Gemini API key. Set GEMINI_API_KEY env var or store via user_fact_set (category: projects, key: gemini_api_key).",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("still reads an existing gemini_api_key fact (reader unchanged)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    mockGetUserFacts.mockReturnValue([
      { key: "gemini_api_key", value: "test-key-fact" },
    ]);
    mockFetch.mockRejectedValue(new Error("network down"));
    await geminiImageTool.execute({ prompt: "a cat" });
    expect(mockFetch).toHaveBeenCalled();
    expect(String(mockFetch.mock.calls[0]![0])).toContain("test-key-fact");
  });
});
