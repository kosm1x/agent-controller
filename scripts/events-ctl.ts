/**
 * v7.7 Spine 4 Bundle 3 — general-events operator helper.
 *
 * Backs the embedding-dependent and aggregation `mc-ctl events` subcommands
 * (the thin bash front-end handles list/show/seed directly via SQLite).
 *
 * Env: MODE=retrieve|aggregate (required).
 *   retrieve  — QUERY (optional free text), K (default 8). Semantic /
 *               recency retrieval over the general-events layer.
 *   aggregate — BY=day|week|project (default day). Time-windowed roll-up.
 *
 * Exit codes: 0 ok | 2 fatal (bad MODE / bad arg).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import { listGeneralEvents } from "../src/events/general-events.js";
import {
  aggregateGeneralEvents,
  retrieveGeneralEvents,
  type AggregateDimension,
} from "../src/events/retrieval.js";

async function runRetrieve(): Promise<number> {
  const query = process.env.QUERY?.trim() || undefined;
  const kRaw = process.env.K?.trim();
  const k = kRaw ? Number(kRaw) : 8;
  if (!Number.isInteger(k) || k <= 0) {
    console.error(`[events-ctl] K must be a positive integer (got "${kRaw}")`);
    return 2;
  }

  const results = await retrieveGeneralEvents({ query }, k);
  if (results.length === 0) {
    console.log("(no general events matched)");
    return 0;
  }
  console.log(
    query
      ? `Top ${results.length} general events for query (cosine-ranked):`
      : `Top ${results.length} general events (recency-ranked, no query):`,
  );
  console.log("");
  for (const { event, score } of results) {
    const scoreStr = score === null ? "  —  " : score.toFixed(3);
    console.log(
      `  [${scoreStr}] ${event.event_id}  (${event.level}, ${event.episodic_count} episodic)`,
    );
    console.log(`          ${event.title}`);
  }
  return 0;
}

function runAggregate(): number {
  const by = (process.env.BY?.trim() || "day").toLowerCase();
  if (by !== "day" && by !== "week" && by !== "project") {
    console.error(`[events-ctl] BY must be day|week|project (got "${by}")`);
    return 2;
  }
  const events = listGeneralEvents();
  const buckets = aggregateGeneralEvents(events, by as AggregateDimension);
  if (buckets.length === 0) {
    console.log("(no general events to aggregate)");
    return 0;
  }
  console.log(`General events aggregated by ${by}:`);
  console.log("");
  for (const b of buckets) {
    console.log(
      `  ${b.bucket.padEnd(20)} ${String(b.event_count).padStart(3)} event(s)` +
        `   ${String(b.episodic_total).padStart(4)} episodic link(s)`,
    );
  }
  return 0;
}

// Resolve the DB path relative to THIS script, not the process cwd, so the
// helper works regardless of where it is invoked from (R1-W1 fold).
const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "mc.db",
);

async function main(): Promise<number> {
  initDatabase(DB_PATH);
  const mode = (process.env.MODE ?? "").toLowerCase();
  switch (mode) {
    case "retrieve":
      return runRetrieve();
    case "aggregate":
      return runAggregate();
    default:
      console.error(
        `[events-ctl] MODE must be retrieve|aggregate (got "${mode}")`,
      );
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
