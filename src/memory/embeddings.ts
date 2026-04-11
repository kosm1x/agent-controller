/**
 * Embedding service for semantic memory search.
 *
 * Uses Gemini gemini-embedding-001 (1536 dims, free tier).
 * Falls back gracefully — recall degrades to FTS5-only if embeddings unavailable.
 */

import { generateEmbedding } from "../inference/embeddings.js";

export const EMBED_DIMS = 1536;

/**
 * Embed text into a 1536-dim float32 vector via Gemini Embedding API.
 * Returns null on any error (graceful degradation).
 */
export async function embed(text: string): Promise<Float32Array | null> {
  try {
    const vec = await generateEmbedding(text);
    if (!vec || vec.length === 0) {
      console.warn("[embed] No embedding returned — check GEMINI_API_KEY");
      return null;
    }
    return new Float32Array(vec);
  } catch (err) {
    console.warn(
      "[embed] Embedding failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Cosine similarity between two vectors. Returns [-1, 1].
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Deserialize a Buffer (from SQLite BLOB) back to Float32Array.
 */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
