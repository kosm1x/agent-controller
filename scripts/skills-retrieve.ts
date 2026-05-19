/**
 * Phase 3 B2 operator-facing skill retrieval test.
 *
 * Invoked by `mc-ctl skills retrieve "<query>" [--k=N] [--threshold=F]`.
 * Env-driven so the bash wrapper can stay tsx-resolver-agnostic.
 *
 *   QUERY      task description string
 *   K          top-k cap (default 5)
 *   THRESHOLD  minSimilarity cosine floor (optional)
 *
 * Output: tab-separated rows (score, name, description excerpt). Exit
 * code 0 always — empty results print "(no matches)" but aren't an
 * error (vector empty / fallback empty are both valid Phase 3 states).
 */

import { initDatabase } from "../src/db/index.js";
import { retrieveSkills } from "../src/skills/retrieval.js";

async function main(): Promise<void> {
  initDatabase("./data/mc.db");
  const query = process.env.QUERY ?? "";
  if (!query) {
    console.error("QUERY env var required");
    process.exit(2);
  }
  const k = parseInt(process.env.K ?? "5", 10);
  const threshold = process.env.THRESHOLD
    ? parseFloat(process.env.THRESHOLD)
    : undefined;

  const results = await retrieveSkills(query, {
    k,
    minSimilarity: threshold,
  });

  // R1-W4 fold: surface WHICH retrieval path produced the result on
  // stderr so an operator scripting around this can distinguish
  // "vector-source matched" / "keyword-fallback matched" / "empty"
  // (which can still mean any of: API down, no certified skills,
  // below threshold, or no keyword hits).
  const path =
    results.length === 0
      ? "empty"
      : results[0].source === "vector"
        ? "vector"
        : "keyword";
  console.error(`[retrieval] path=${path} matches=${results.length}`);

  if (results.length === 0) {
    console.log("(no matches)");
    return;
  }

  for (const r of results) {
    const score = r.source === "vector" ? r.similarity.toFixed(3) : "kw   ";
    console.log(
      `${score}  ${r.name.padEnd(40)}  ${r.description.slice(0, 80)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
