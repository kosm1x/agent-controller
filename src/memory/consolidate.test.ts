/**
 * Learning consolidation tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { serializeEmbedding } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Mock database
// ---------------------------------------------------------------------------

const mockRun = vi.fn();
const mockAll = vi.fn();
const mockTransaction = vi.fn((fn: (ids: number[]) => void) => fn);
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: mockRun,
    all: mockAll,
  }),
  transaction: mockTransaction,
};

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
}));

import { consolidateLearnings } from "./consolidate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a normalized embedding vector (384-dim) from a seed. */
function makeEmbedding(seed: number): Buffer {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.01);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return serializeEmbedding(v);
}

/** Create a nearly-identical embedding (high cosine similarity). */
function makeNearDuplicate(seed: number): Buffer {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.01) + 0.001 * Math.sin(i * 0.5);
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return serializeEmbedding(v);
}

/** Create a completely different embedding. */
function makeDifferentEmbedding(seed: number): Buffer {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    v[i] = Math.cos(seed * (i + 1) * 7.3 + i * 2.1);
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return serializeEmbedding(v);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset prepare to return default mock
  mockDb.prepare.mockReturnValue({
    run: mockRun,
    all: mockAll,
  });
  mockDb.transaction.mockImplementation((fn: (ids: number[]) => void) => fn);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consolidateLearnings", () => {
  it("should return no-op for empty bank", () => {
    mockAll.mockReturnValueOnce([]);

    const result = consolidateLearnings({ bank: "mc-operational" });
    expect(result.entriesScanned).toBe(0);
    expect(result.groupCount).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(result.deletedIds).toEqual([]);
  });

  it("should return no-op for single entry", () => {
    mockAll.mockReturnValueOnce([
      {
        id: 1,
        content: "learning 1",
        trust_tier: 2,
        created_at: "2026-03-30",
        embedding: makeEmbedding(1),
      },
    ]);

    const result = consolidateLearnings();
    expect(result.entriesScanned).toBe(1);
    expect(result.groupCount).toBe(0);
    expect(result.mergedCount).toBe(0);
  });

  it("should merge near-duplicate entries", () => {
    mockAll.mockReturnValueOnce([
      {
        id: 1,
        content: "Always check return values",
        trust_tier: 2,
        created_at: "2026-03-30",
        embedding: makeEmbedding(42),
      },
      {
        id: 2,
        content: "Always verify return values",
        trust_tier: 3,
        created_at: "2026-03-29",
        embedding: makeNearDuplicate(42),
      },
    ]);

    const result = consolidateLearnings({ similarityThreshold: 0.85 });
    expect(result.groupCount).toBe(1);
    expect(result.mergedCount).toBe(1);
    // Should delete id=2 (higher trust_tier = lower quality)
    expect(result.deletedIds).toEqual([2]);
  });

  it("should keep both entries below similarity threshold", () => {
    mockAll.mockReturnValueOnce([
      {
        id: 1,
        content: "Check return values",
        trust_tier: 2,
        created_at: "2026-03-30",
        embedding: makeEmbedding(1),
      },
      {
        id: 2,
        content: "Use proper error handling",
        trust_tier: 2,
        created_at: "2026-03-29",
        embedding: makeDifferentEmbedding(99),
      },
    ]);

    const result = consolidateLearnings({ similarityThreshold: 0.85 });
    expect(result.groupCount).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(result.deletedIds).toEqual([]);
  });

  it("should not delete in dry-run mode", () => {
    mockAll.mockReturnValueOnce([
      {
        id: 1,
        content: "learning A",
        trust_tier: 2,
        created_at: "2026-03-30",
        embedding: makeEmbedding(42),
      },
      {
        id: 2,
        content: "learning A duplicate",
        trust_tier: 3,
        created_at: "2026-03-29",
        embedding: makeNearDuplicate(42),
      },
    ]);

    const result = consolidateLearnings({ dryRun: true });
    expect(result.groupCount).toBe(1);
    expect(result.mergedCount).toBe(0); // Dry run: no actual deletes
    expect(result.deletedIds).toEqual([]); // Dry run: empty
    expect(mockRun).not.toHaveBeenCalled(); // No DELETE executed
  });

  it("should respect maxMerges safety cap", () => {
    // Create 4 near-duplicate entries (3 should be deleted, but cap at 2)
    const emb = makeEmbedding(42);
    const dup1 = makeNearDuplicate(42);
    mockAll.mockReturnValueOnce([
      {
        id: 1,
        content: "a",
        trust_tier: 1,
        created_at: "2026-03-30",
        embedding: emb,
      },
      {
        id: 2,
        content: "b",
        trust_tier: 2,
        created_at: "2026-03-29",
        embedding: dup1,
      },
      {
        id: 3,
        content: "c",
        trust_tier: 3,
        created_at: "2026-03-28",
        embedding: dup1,
      },
      {
        id: 4,
        content: "d",
        trust_tier: 4,
        created_at: "2026-03-27",
        embedding: dup1,
      },
    ]);

    const result = consolidateLearnings({ maxMerges: 2 });
    expect(result.mergedCount).toBe(2);
    expect(result.deletedIds).toHaveLength(2);
    // Should keep id=1 (best trust_tier), delete the next 2
  });

  it("should prefer keeping lower trust_tier entries", () => {
    mockAll.mockReturnValueOnce([
      {
        id: 10,
        content: "learning",
        trust_tier: 3,
        created_at: "2026-03-30",
        embedding: makeEmbedding(42),
      },
      {
        id: 20,
        content: "same learning",
        trust_tier: 1,
        created_at: "2026-03-28",
        embedding: makeNearDuplicate(42),
      },
    ]);

    const result = consolidateLearnings();
    // id=20 has trust_tier=1 (better) — should be kept
    expect(result.deletedIds).toEqual([10]);
  });
});
