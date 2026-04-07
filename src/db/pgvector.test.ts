import { describe, it, expect, vi, afterEach } from "vitest";
import { contentHash, isPgvectorEnabled, pgCascadeStale } from "./pgvector.js";

// Mock fetch globally for all pgvector tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Save original env for restoration
const originalCommitDbKey = process.env.COMMIT_DB_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  // Restore env
  if (originalCommitDbKey !== undefined) {
    process.env.COMMIT_DB_KEY = originalCommitDbKey;
  } else {
    delete process.env.COMMIT_DB_KEY;
  }
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
    // Upsert POST response
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Cascade stale search (fire-and-forget, returns no related entries)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const { pgUpsert } = await import("./pgvector.js");
    const result = await pgUpsert({
      path: "test/file.md",
      title: "Test File",
      content: "Hello world",
      embedding: [0.1, 0.2, 0.3],
    });

    expect(result).toBe(true);
    // First call is the upsert POST
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
  it("calls atomic RPC function for reinforcement", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    // Single RPC call (C2 audit fix: atomic server-side update)
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { pgReinforce } = await import("./pgvector.js");
    const result = await pgReinforce("test.md");

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify RPC call to kb_reinforce
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/rpc/kb_reinforce");
    const body = JSON.parse(opts.body);
    expect(body.p_path).toBe("test.md");
  });
});

// ---------------------------------------------------------------------------
// Cascading staleness (v6.4 G1)
// ---------------------------------------------------------------------------

describe("pgCascadeStale", () => {
  it("marks related entries stale when source path changes", async () => {
    process.env.COMMIT_DB_KEY = "test-key";

    // First call: search for entries with related_to containing the path
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { path: "derived/entry1.md" },
        { path: "derived/entry2.md" },
      ],
    });

    // Second call: PATCH to mark them stale
    mockFetch.mockResolvedValueOnce({ ok: true });

    const count = await pgCascadeStale("source/original.md");
    expect(count).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify PATCH call
    const [, patchOpts] = mockFetch.mock.calls[1];
    expect(patchOpts.method).toBe("PATCH");
    const body = JSON.parse(patchOpts.body);
    expect(body.stale).toBe(true);
  });

  it("returns 0 when no related entries found", async () => {
    process.env.COMMIT_DB_KEY = "test-key";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const count = await pgCascadeStale("source/no-deps.md");
    expect(count).toBe(0);
    // Only search call, no PATCH
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns 0 when no API key", async () => {
    delete process.env.COMMIT_DB_KEY;
    const count = await pgCascadeStale("source/test.md");
    expect(count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
