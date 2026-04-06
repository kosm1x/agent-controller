/**
 * Embedding generation — multi-provider, raw fetch.
 *
 * Providers (auto-detected from EMBEDDING_PROVIDER or EMBEDDING_URL):
 * - "gemini" → Google Generative AI (gemini-embedding-001, free tier)
 * - "openai" → OpenAI-compatible endpoint (DashScope, OpenAI, Ollama)
 *
 * Configuration via env vars:
 *   EMBEDDING_PROVIDER — "gemini" or "openai" (auto-detected if omitted)
 *   EMBEDDING_URL — provider base URL (openai mode only)
 *   EMBEDDING_KEY — API key
 *   EMBEDDING_MODEL — model name
 *   EMBEDDING_DIMENSIONS — output dimensions (default: 1536)
 *
 * Default: Gemini if GEMINI_API_KEY is set, otherwise OpenAI-compatible.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface EmbeddingConfig {
  provider: "gemini" | "openai";
  url: string;
  key: string;
  model: string;
  dimensions: number;
}

function getEmbeddingConfig(): EmbeddingConfig {
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  const explicitProvider = process.env.EMBEDDING_PROVIDER as
    | "gemini"
    | "openai"
    | undefined;

  // Auto-detect: prefer Gemini (free, reliable), fall back to OpenAI-compatible
  const provider = explicitProvider ?? (geminiKey ? "gemini" : "openai");

  if (provider === "gemini") {
    return {
      provider: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta",
      key: process.env.EMBEDDING_KEY ?? geminiKey,
      model: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? "1536", 10),
    };
  }

  // OpenAI-compatible fallback
  return {
    provider: "openai",
    url:
      process.env.EMBEDDING_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    key: process.env.EMBEDDING_KEY ?? "",
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-v3",
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? "1536", 10),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an embedding vector for a single text.
 * Returns null on failure (never throws).
 */
export async function generateEmbedding(
  text: string,
): Promise<number[] | null> {
  const result = await generateEmbeddings([text]);
  return result.length > 0 && result[0].length > 0 ? result[0] : null;
}

/**
 * Generate embeddings for multiple texts.
 * Returns array of vectors (same order as input).
 * Failed items return empty arrays. Never throws.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const cfg = getEmbeddingConfig();
  if (!cfg.key) {
    console.warn("[embeddings] No API key configured");
    return texts.map(() => []);
  }

  // Truncate long texts to ~8K tokens (~32K chars) to avoid API errors
  const MAX_CHARS = 32_000;
  const truncated = texts.map((t) =>
    t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t,
  );

  return cfg.provider === "gemini"
    ? geminiEmbed(cfg, truncated)
    : openaiEmbed(cfg, truncated);
}

/**
 * Check if embedding generation is available (API key configured).
 */
export function isEmbeddingEnabled(): boolean {
  const cfg = getEmbeddingConfig();
  return !!cfg.key;
}

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

interface GeminiEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

async function geminiEmbed(
  cfg: EmbeddingConfig,
  texts: string[],
): Promise<number[][]> {
  try {
    // Gemini batchEmbedContents supports up to 100 texts
    const requests = texts.map((text) => ({
      model: `models/${cfg.model}`,
      content: { parts: [{ text }] },
      outputDimensionality: cfg.dimensions,
    }));

    const res = await fetch(
      `${cfg.url}/models/${cfg.model}:batchEmbedContents?key=${cfg.key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.warn(
        `[embeddings] Gemini error ${res.status}: ${err.slice(0, 200)}`,
      );
      return texts.map(() => []);
    }

    const json = (await res.json()) as GeminiEmbedResponse;
    return json.embeddings.map((e) => e.values);
  } catch (err) {
    console.warn(
      "[embeddings] Gemini error:",
      err instanceof Error ? err.message : err,
    );
    return texts.map(() => []);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

async function openaiEmbed(
  cfg: EmbeddingConfig,
  texts: string[],
): Promise<number[][]> {
  try {
    const res = await fetch(`${cfg.url}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        input: texts,
        dimensions: cfg.dimensions,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.warn(
        `[embeddings] OpenAI error ${res.status}: ${err.slice(0, 200)}`,
      );
      return texts.map(() => []);
    }

    const json = (await res.json()) as OpenAIEmbedResponse;
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  } catch (err) {
    console.warn(
      "[embeddings] OpenAI error:",
      err instanceof Error ? err.message : err,
    );
    return texts.map(() => []);
  }
}
