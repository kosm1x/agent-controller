import { describe, it, expect, vi, beforeEach } from "vitest";
import { contentHash, isPgvectorEnabled } from "./pgvector.js";

// Mock fetch globally for all pgvector tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contentHash", () => {
  it("produces consistent SHA-256 hex", () => {
    const hash = contentHash("hello world");
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("different content produces different hash", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("same content produces same hash", () => {
    expect(contentHash("test")).toBe(contentHash("test"));
  });
});

describe("isPgvectorEnabled", () => {
  it("returns false without COMMIT_DB_KEY", () => {
    const original = process.env.COMMIT_DB_KEY;
    delete process.env.COMMIT_DB_KEY;
    expect(isPgvectorEnabled()).toBe(false);
    if (original) process.env.COMMIT_DB_KEY = original;
  });

  it("returns true with COMMIT_DB_KEY", () => {
    const original = process.env.COMMIT_DB_KEY;
    process.env.COMMIT_DB_KEY = "test-key";
    expect(isPgvectorEnabled()).toBe(true);
    if (original) process.env.COMMIT_DB_KEY = original;
    else delete process.env.COMMIT_DB_KEY;
  });
});

describe("pgUpsert", () => {
  it("sends correct POST to kb_entries with merge-duplicates", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { pgUpsert } = await import("./pgvector.js");
    const result = await pgUpsert({
      path: "test/file.md",
      title: "Test File",
      content: "Hello world",
      embedding: [0.1, 0.2, 0.3],
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/kb_entries");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Prefer).toBe("resolution=merge-duplicates");
    const body = JSON.parse(opts.body);
    expect(body.path).toBe("test/file.md");
    expect(body.content_hash).toBeTruthy();
    expect(body.embedding).toBe("[0.1,0.2,0.3]");
  });

  it("returns false when API key missing", async () => {
    delete process.env.COMMIT_DB_KEY;
    const { pgUpsert } = await import("./pgvector.js");
    const result = await pgUpsert({
      path: "test.md",
      title: "Test",
      content: "Hello",
    });
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns false on API error", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    const { pgUpsert } = await import("./pgvector.js");
    const result = await pgUpsert({
      path: "test.md",
      title: "Test",
      content: "Hello",
    });
    expect(result).toBe(false);
  });
});

describe("pgDelete", () => {
  it("sends DELETE with path filter", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { pgDelete } = await import("./pgvector.js");
    const result = await pgDelete("test/file.md");

    expect(result).toBe(true);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("path=eq.test%2Ffile.md");
    expect(opts.method).toBe("DELETE");
  });
});

describe("pgHybridSearch", () => {
  it("calls RPC endpoint with correct parameters", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "uuid-1",
            path: "test.md",
            title: "Test",
            content: "Hello",
            type: "fact",
            qualifier: "reference",
            similarity: 0.85,
            fts_rank: 0.5,
            combined_score: 0.72,
            salience: 0.5,
            confidence: 1.0,
            stale: false,
          },
        ]),
    });

    const { pgHybridSearch } = await import("./pgvector.js");
    const results = await pgHybridSearch([0.1, 0.2], "test query", 5, 0.3);

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("test.md");
    expect(results[0].combined_score).toBe(0.72);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/rpc/kb_hybrid_search");
    const body = JSON.parse(opts.body);
    expect(body.query_text).toBe("test query");
    expect(body.match_count).toBe(5);
  });

  it("returns empty array on error", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    const { pgHybridSearch } = await import("./pgvector.js");
    const results = await pgHybridSearch([0.1], "test", 5);
    expect(results).toEqual([]);
  });
});

describe("pgFindByHash", () => {
  it("returns match when hash exists", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ path: "existing.md", confidence: 0.8 }]),
    });

    const { pgFindByHash } = await import("./pgvector.js");
    const result = await pgFindByHash("abc123");
    expect(result).toEqual({ path: "existing.md", confidence: 0.8 });
  });

  it("returns null when no match", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { pgFindByHash } = await import("./pgvector.js");
    const result = await pgFindByHash("nonexistent");
    expect(result).toBeNull();
  });
});

describe("pgReinforce", () => {
  it("reads current confidence and patches with boosted value", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    // First call: GET current confidence
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([{ confidence: 0.5, reinforcement_count: 2 }]),
    });
    // Second call: PATCH with new values
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { pgReinforce } = await import("./pgvector.js");
    const result = await pgReinforce("test.md");

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify PATCH body has increased confidence
    const patchBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(patchBody.confidence).toBeCloseTo(0.55); // 0.5 + 0.1*(1-0.5) = 0.55
    expect(patchBody.reinforcement_count).toBe(3);
  });
});
