import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config so resolveVisionModel can be exercised without MC_API_KEY etc.
// Production config has many more fields; this mock returns only the one
// resolveVisionModel actually reads (`inferencePrimaryModel`). Audit SV1 note.
const mockConfig = vi.fn();
vi.mock("../config.js", () => ({
  getConfig: () => mockConfig(),
}));

import { resolveVisionModel } from "./vision.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Start every test with a clean INFERENCE_VISION_MODEL slot
  delete process.env.INFERENCE_VISION_MODEL;
  mockConfig.mockReturnValue({ inferencePrimaryModel: "" });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("resolveVisionModel", () => {
  it("returns INFERENCE_VISION_MODEL when explicitly set (production path)", () => {
    process.env.INFERENCE_VISION_MODEL =
      "meta-llama/llama-4-scout-17b-16e-instruct";
    expect(resolveVisionModel()).toBe(
      "meta-llama/llama-4-scout-17b-16e-instruct",
    );
  });

  it("derives vision model from primary prefix when env is unset (legacy path)", () => {
    mockConfig.mockReturnValue({ inferencePrimaryModel: "qwen-2.5-72b" });
    expect(resolveVisionModel()).toBe("qwen-vl-max");

    mockConfig.mockReturnValue({ inferencePrimaryModel: "glm-4-plus" });
    expect(resolveVisionModel()).toBe("glm-4v-plus");

    mockConfig.mockReturnValue({ inferencePrimaryModel: "claude-sonnet-4-6" });
    expect(resolveVisionModel()).toBe("claude-sonnet-4-6");
  });

  it("falls back to qwen-vl-max for unknown-prefix primary models (audit R5)", () => {
    // Defensive default branch: `primary` is non-empty but matches none
    // of the known prefixes (glm-/qwen/deepseek/gpt-/claude-). Reachable
    // only under legacy openai routing with an exotic primary; never hit
    // under the SDK path (which empties inferencePrimaryModel entirely
    // and is now guarded by the throw above).
    mockConfig.mockReturnValue({ inferencePrimaryModel: "mistral-large-2407" });
    expect(resolveVisionModel()).toBe("qwen-vl-max");
  });

  it("throws loudly when BOTH overrides are absent (audit foot-gun)", () => {
    // No env override + empty primary model = the misconfiguration class.
    // Pre-guard this silently returned qwen-vl-max, which under the
    // claude-sdk routing would hit Groq with a Qwen model name — wrong
    // vendor, wrong key, silent failure on first vision request.
    mockConfig.mockReturnValue({ inferencePrimaryModel: "" });
    expect(() => resolveVisionModel()).toThrow(/Vision model unresolved/);
    expect(() => resolveVisionModel()).toThrow(/INFERENCE_VISION_MODEL/);
  });
});
