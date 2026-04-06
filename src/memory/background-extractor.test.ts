import { describe, it, expect, vi, afterEach } from "vitest";
import {
  shouldExtract,
  extractFacts,
  storeFacts,
} from "./background-extractor.js";

// Mock pgvector — isPgvectorEnabled controls the gate
vi.mock("../db/pgvector.js", () => ({
  isPgvectorEnabled: vi.fn(() => true),
  pgFindByHash: vi.fn(() => null),
  pgReinforce: vi.fn(() => true),
  pgUpsert: vi.fn(() => true),
  contentHash: vi.fn((text: string) => `hash_${text.slice(0, 8)}`),
}));

// Mock inference adapter — extractFacts uses infer()
const mockInfer = vi.fn();
vi.mock("../inference/adapter.js", () => ({
  infer: (...args: unknown[]) => mockInfer(...args),
}));

afterEach(() => {
  vi.restoreAllMocks();
  mockInfer.mockReset();
});

describe("shouldExtract", () => {
  describe("gate ordering", () => {
    it("returns false when pgvector is disabled", async () => {
      const { isPgvectorEnabled } = await import("../db/pgvector.js");
      vi.mocked(isPgvectorEnabled).mockReturnValue(false);

      expect(
        shouldExtract({
          toolCalls: ["file_read", "file_write", "shell_exec"],
          responseLength: 5000,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(false);
    });

    it("returns false for ritual tasks", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read", "file_write", "shell_exec"],
          responseLength: 5000,
          isRitual: true,
          isProactive: false,
        }),
      ).toBe(false);
    });

    it("returns false for proactive tasks", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read", "file_write", "shell_exec"],
          responseLength: 5000,
          isRitual: false,
          isProactive: true,
        }),
      ).toBe(false);
    });

    it("returns false for background-agent tasks", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read", "file_write", "shell_exec"],
          responseLength: 5000,
          spawnType: "user-background",
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(false);
    });
  });

  describe("noteworthy thresholds", () => {
    it("extracts when ≥3 tool calls", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read", "file_write", "shell_exec"],
          responseLength: 500,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(true);
    });

    it("extracts when response >2K chars", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read"],
          responseLength: 2500,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(true);
    });

    it("does NOT extract for small responses with <3 tools", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read"],
          responseLength: 500,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(false);
    });

    it("does NOT extract for 2 tools + short response", () => {
      expect(
        shouldExtract({
          toolCalls: ["file_read", "web_search"],
          responseLength: 1000,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(false);
    });

    it("extracts for exactly 3 tools", () => {
      expect(
        shouldExtract({
          toolCalls: ["a", "b", "c"],
          responseLength: 100,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(true);
    });

    it("extracts for exactly 2001 chars response", () => {
      expect(
        shouldExtract({
          toolCalls: [],
          responseLength: 2001,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(true);
    });

    it("does NOT extract for exactly 2000 chars response", () => {
      expect(
        shouldExtract({
          toolCalls: [],
          responseLength: 2000,
          isRitual: false,
          isProactive: false,
        }),
      ).toBe(false);
    });
  });
});

describe("extractFacts", () => {
  it("parses multi-line LLM output into fact array", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        "User prefers dark theme dashboards with ECharts.\nThe CRM pipeline has 45 active prospects.\nJarvis should use edge-tts for Spanish narration.",
    });

    const facts = await extractFacts(
      "dame un resumen del pipeline",
      "El pipeline tiene 45 prospectos activos...",
      ["crm_query", "gsheets_read", "web_search"],
    );

    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts.length).toBeLessThanOrEqual(3);
    expect(mockInfer).toHaveBeenCalledOnce();
  });

  it("returns empty array when LLM says NONE", async () => {
    mockInfer.mockResolvedValueOnce({ content: "NONE" });

    const facts = await extractFacts("hola", "Hola!", []);
    expect(facts).toEqual([]);
  });

  it("returns empty array on LLM failure", async () => {
    mockInfer.mockRejectedValueOnce(new Error("timeout"));

    const facts = await extractFacts("test", "test", []);
    expect(facts).toEqual([]);
  });

  it("filters out short lines (<15 chars)", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        "Short.\nThis is a meaningful fact about the project architecture.",
    });

    const facts = await extractFacts("test", "long response...", [
      "a",
      "b",
      "c",
    ]);
    // "Short." should be filtered (< 15 chars)
    for (const f of facts) {
      expect(f.length).toBeGreaterThanOrEqual(15);
    }
  });

  it("caps at 3 facts maximum", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        "Fact one is a meaningful observation.\nFact two is another finding.\nFact three is the third item.\nFact four should be dropped.\nFact five also dropped.",
    });

    const facts = await extractFacts("test", "long response", ["a", "b", "c"]);
    expect(facts.length).toBeLessThanOrEqual(3);
  });

  it("strips bullet prefixes from facts", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        "- User prefers Spanish for all outputs.\n• The VPS runs on Ubuntu 24.04.\n* Edge-tts is the default TTS engine.",
    });

    const facts = await extractFacts("test", "response", ["a", "b", "c"]);
    for (const f of facts) {
      expect(f).not.toMatch(/^[-•*]/);
    }
  });
});

describe("storeFacts", () => {
  it("reinforces existing fact when hash matches", async () => {
    const { pgFindByHash, pgReinforce } = await import("../db/pgvector.js");
    vi.mocked(pgFindByHash).mockResolvedValueOnce({
      path: "extracted/2026-04-06-abc12345.md",
      confidence: 0.5,
    });

    const result = await storeFacts(
      ["User prefers dark theme dashboards with ECharts."],
      "task-123",
    );

    expect(result.reinforced).toBe(1);
    expect(result.stored).toBe(0);
    expect(pgReinforce).toHaveBeenCalledWith(
      "extracted/2026-04-06-abc12345.md",
    );
  });

  it("stores new fact with embedding when hash not found", async () => {
    const { pgFindByHash, pgUpsert } = await import("../db/pgvector.js");
    vi.mocked(pgFindByHash).mockResolvedValueOnce(null);

    // Mock embedding generation
    vi.doMock("../inference/embeddings.js", () => ({
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    }));

    const result = await storeFacts(
      ["The CRM pipeline has 45 active prospects."],
      "task-456",
    );

    expect(result.stored).toBe(1);
    expect(result.reinforced).toBe(0);
    expect(pgUpsert).toHaveBeenCalled();
  });

  it("stores fact even when embedding generation returns null", async () => {
    const { pgFindByHash, pgUpsert } = await import("../db/pgvector.js");
    vi.mocked(pgFindByHash).mockResolvedValueOnce(null);

    vi.doMock("../inference/embeddings.js", () => ({
      generateEmbedding: vi.fn().mockResolvedValue(null),
    }));

    const result = await storeFacts(["Fact without embedding."], "task-789");

    expect(result.stored).toBe(1);
    expect(pgUpsert).toHaveBeenCalled();
  });
});
