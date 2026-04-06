import { describe, it, expect, vi, afterEach } from "vitest";

// Mock pgvector — include all exports used by lesson-decay
vi.mock("../db/pgvector.js", () => ({
  isPgvectorEnabled: vi.fn(() => true),
  getApiKey: vi.fn(() => process.env.COMMIT_DB_KEY ?? null),
  supabaseHeaders: vi.fn((key: string) => ({
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  })),
}));

// Mock fetch for RPC calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

describe("runDecaySweep", () => {
  it("calls kb_decay_sweep RPC and returns affected count", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(5),
    });

    const { runDecaySweep } = await import("./lesson-decay.js");
    const result = await runDecaySweep();

    expect(result).toBe(5);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/rpc/kb_decay_sweep");
    const body = JSON.parse(opts.body);
    expect(body.min_age_days).toBe(7);
    expect(body.confidence_threshold).toBe(0.1);
  });

  it("returns -1 when API key missing", async () => {
    delete process.env.COMMIT_DB_KEY;
    const { runDecaySweep } = await import("./lesson-decay.js");
    const result = await runDecaySweep();
    expect(result).toBe(-1);
  });

  it("returns -1 on API error", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { runDecaySweep } = await import("./lesson-decay.js");
    const result = await runDecaySweep();
    expect(result).toBe(-1);
  });

  it("accepts custom thresholds", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(0),
    });

    const { runDecaySweep } = await import("./lesson-decay.js");
    await runDecaySweep(14, 0.2);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.min_age_days).toBe(14);
    expect(body.confidence_threshold).toBe(0.2);
  });
});

describe("getKbHealthStats", () => {
  it("returns parsed stats from RPC", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            total_entries: 315,
            active_entries: 300,
            stale_entries: 15,
            avg_confidence: 0.85,
            reinforced_entries: 42,
            avg_reinforcements: 1.5,
          },
        ]),
    });

    const { getKbHealthStats } = await import("./lesson-decay.js");
    const stats = await getKbHealthStats();

    expect(stats).toEqual({
      totalEntries: 315,
      activeEntries: 300,
      staleEntries: 15,
      avgConfidence: 0.85,
      reinforcedEntries: 42,
      avgReinforcements: 1.5,
    });
  });

  it("returns null on API failure", async () => {
    process.env.COMMIT_DB_KEY = "test-key";
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { getKbHealthStats } = await import("./lesson-decay.js");
    const stats = await getKbHealthStats();
    expect(stats).toBeNull();
  });

  it("returns null when pgvector disabled", async () => {
    delete process.env.COMMIT_DB_KEY;
    const { getKbHealthStats } = await import("./lesson-decay.js");
    const stats = await getKbHealthStats();
    expect(stats).toBeNull();
  });
});
