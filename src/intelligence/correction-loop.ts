/**
 * Rephrase correction loop (v6.4 H1).
 *
 * When the user rephrases a message (detected by feedback.ts), this module
 * extracts WHAT changed between the original and the rephrase, and persists
 * it as a "correction" entry in pgvector. On future similar messages, the
 * enrichment pipeline recalls the correction as precedent — building a
 * personal "when Fede says X, he means Y" dictionary over time.
 */

import { contentHash } from "../db/pgvector.js";

/**
 * Extract what changed between two messages and persist as a correction.
 * Uses a cheap LLM call (5s timeout). Fire-and-forget — never blocks.
 */
export async function extractAndPersistCorrection(
  originalMessage: string,
  rephrasedMessage: string,
): Promise<void> {
  // Skip trivially similar messages
  if (originalMessage.length < 10 || rephrasedMessage.length < 10) return;

  try {
    const { infer } = await import("../inference/adapter.js");
    const { pgUpsert, isPgvectorEnabled } = await import("../db/pgvector.js");
    const { generateEmbedding } = await import("../inference/embeddings.js");

    if (!isPgvectorEnabled()) return;

    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("correction timeout")), 5_000),
    );

    const result = await Promise.race([
      infer({
        messages: [
          {
            role: "system",
            content:
              'The user rephrased their message. Extract the correction in one line: "When the user says [original pattern], they mean [corrected intent]". If no meaningful correction (just rewording), reply "SKIP".',
          },
          {
            role: "user",
            content: `Original: ${originalMessage}\nRephrase: ${rephrasedMessage}`,
          },
        ],
        max_tokens: 100,
      }),
      deadline,
    ]);

    const correction = (result.content ?? "").trim();
    if (!correction || correction.toUpperCase() === "SKIP") return;

    // Persist to pgvector as a correction entry
    const hash = contentHash(correction);
    const embedding = await generateEmbedding(correction);

    await pgUpsert({
      path: `corrections/${hash.slice(0, 12)}.md`,
      title: "Intent correction",
      content: correction,
      content_hash: hash,
      embedding: embedding ?? undefined,
      type: "correction",
      qualifier: "always-read",
      salience: 0.8,
      confidence: 0.9,
      tags: ["correction", "rephrase"],
    });

    console.log(`[correction-loop] Persisted: ${correction.slice(0, 100)}`);
  } catch {
    // Non-fatal — correction extraction is best-effort
  }
}
