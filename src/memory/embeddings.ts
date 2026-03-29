/**
 * Embedding service for semantic memory search.
 *
 * Uses BAAI/bge-small-en-v1.5 via HuggingFace Inference API (384 dims).
 * Free with HF Pro subscription. Falls back gracefully — recall degrades
 * to FTS5-only if embeddings unavailable.
 */

const HF_EMBED_URL =
  "https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5";
const EMBED_DIMS = 384;
const EMBED_TIMEOUT_MS = 10_000;
const MAX_INPUT_CHARS = 512;

/**
 * Embed text into a 384-dim float32 vector via HF Inference API.
 * Returns null on any error (graceful degradation).
 */
export async function embed(text: string): Promise<Float32Array | null> {
  const token = process.env.HUGGINGFACE_TOKEN;
  if (!token) return null;

  try {
    const input = text.slice(0, MAX_INPUT_CHARS);
    const response = await fetch(HF_EMBED_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: input }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as number[];
    if (!Array.isArray(data) || data.length !== EMBED_DIMS) return null;

    return new Float32Array(data);
  } catch {
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
