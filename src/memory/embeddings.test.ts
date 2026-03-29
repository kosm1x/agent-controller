import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

import {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from "./embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles 384-dim vectors", () => {
    const a = new Float32Array(384).fill(0.1);
    const b = new Float32Array(384).fill(0.1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

describe("serialize/deserialize roundtrip", () => {
  it("preserves Float32Array data", () => {
    const original = new Float32Array([1.5, -2.3, 0, 42.1, -0.001]);
    const serialized = serializeEmbedding(original);
    const restored = deserializeEmbedding(serialized);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles 384-dim vectors", () => {
    const original = new Float32Array(384);
    for (let i = 0; i < 384; i++) original[i] = Math.random() * 2 - 1;

    const serialized = serializeEmbedding(original);
    expect(serialized.length).toBe(384 * 4); // 4 bytes per float32

    const restored = deserializeEmbedding(serialized);
    expect(restored.length).toBe(384);
    for (let i = 0; i < 384; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });
});
