/**
 * General-events retrieval — Conway Pattern 1 substrate (v7.7 Spine 4 Bundle 2).
 *
 * Hierarchical, two-layer retrieval:
 *   Layer 1 — `retrieveGeneralEvents`: match general events by semantic
 *             similarity (when a query is given) or recency, filtered by
 *             NorthStar objective and time window.
 *   Layer 2 — descend: for each matched event, sample concrete episodic
 *             source rows through the explicit links table.
 *
 * `retrieveForBriefing` composes both layers — it is the entry point V8.1's
 * morning-brief proactive scan calls. Per Conway Pattern 1: briefings
 * retrieve at the general-event level (~8 events) and descend to episodic
 * (~3 per event) only as needed, instead of drowning in a 50-item episodic
 * recall.
 *
 * Read path only — no writes. The write path is `./general-events.ts`.
 * Spec: docs/planning/v8-capability-1-spec.md §5.
 */

import { getDatabase } from "../db/index.js";
import {
  cosineSimilarity,
  deserializeEmbedding,
  embed,
} from "../memory/embeddings.js";
import {
  type EpisodicKind,
  type GeneralEvent,
  getEpisodicLinks,
  getGeneralEvent,
} from "./general-events.js";

export interface RetrievalContext {
  /**
   * Optional free-text query. When present it is embedded and general events
   * are ranked by cosine similarity against their `summary_embedding`. When
   * absent (or when the embedding service is unavailable), events are ranked
   * by recency (`start_at` descending).
   */
  query?: string;
  /**
   * NorthStar objective ids. When non-empty, only events whose
   * `goal_context_id` is in this set are retrieved. Empty/omitted = no goal
   * filter.
   */
  active_objective_ids?: string[];
  /**
   * Time window. An event is kept when its `[start_at, end_at]` span
   * overlaps the window — i.e. it started on/before `window.end` and either
   * is ongoing (`end_at IS NULL`) or ended on/after `window.start`.
   * Omitted = no window filter.
   */
  window?: { start: string; end: string };
  /** Include archived events. Default false. */
  includeArchived?: boolean;
}

export interface RetrievedGeneralEvent {
  event: GeneralEvent;
  /**
   * Cosine similarity in [-1, 1] when the context carried a query AND the
   * event has a stored embedding; `null` when ranking fell back to recency
   * (no query, embedding service down, or this event has no embedding).
   */
  score: number | null;
}

export interface ResolvedEpisodic {
  kind: EpisodicKind;
  ref: string;
  /** False when the referenced source row no longer exists. */
  found: boolean;
  /** A short human label for the row, or null when unresolved. */
  title: string | null;
  /** A content excerpt (≤200 chars), or null when unresolved/empty. */
  snippet: string | null;
  /** The source row's timestamp (ISO), or null when unresolved. */
  timestamp: string | null;
}

export interface BriefingEpisodicSample {
  event_id: string;
  episodic: ResolvedEpisodic;
}

export interface BriefingRetrieval {
  generalEvents: GeneralEvent[];
  episodicSamples: BriefingEpisodicSample[];
}

interface CandidateRow {
  event_id: string;
  summary_embedding: Buffer | null;
  start_at: string;
}

/**
 * Layer 1 — retrieve up to `k` general events.
 *
 * Filtering (SQL): archived, `goal_context_id`, time-window overlap.
 * Ranking: cosine similarity when `context.query` is set and embeddable;
 * otherwise recency. Events with no stored embedding always rank below
 * embedding-scored events (they cannot be semantically matched), ordered
 * among themselves by recency.
 */
export async function retrieveGeneralEvents(
  context: RetrievalContext,
  k = 8,
): Promise<RetrievedGeneralEvent[]> {
  if (k <= 0) return [];

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!context.includeArchived) clauses.push("archived_at IS NULL");

  const objectiveIds = (context.active_objective_ids ?? []).filter(Boolean);
  if (objectiveIds.length > 0) {
    clauses.push(
      `goal_context_id IN (${objectiveIds.map(() => "?").join(",")})`,
    );
    params.push(...objectiveIds);
  }
  if (context.window) {
    // Overlap: started on/before window end, AND ongoing or ended on/after
    // window start.
    clauses.push("start_at <= ?");
    clauses.push("(end_at IS NULL OR end_at >= ?)");
    params.push(context.window.end, context.window.start);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const candidates = getDatabase()
    .prepare(
      `SELECT event_id, summary_embedding, start_at
         FROM general_events ${where}
        ORDER BY start_at DESC`,
    )
    .all(...params) as CandidateRow[];

  if (candidates.length === 0) return [];

  // Embed the query once, outside any loop. A null result (service down)
  // degrades to recency ranking.
  const queryVec = context.query?.trim()
    ? await embed(context.query.trim())
    : null;

  let ranked: Array<{ event_id: string; score: number | null }>;
  if (queryVec) {
    const scored = candidates.map((row) => {
      const raw = row.summary_embedding
        ? cosineSimilarity(
            queryVec,
            deserializeEmbedding(row.summary_embedding),
          )
        : null;
      // A stored embedding of a different dimension than the query vector
      // makes cosineSimilarity return NaN. Treat any non-finite score as
      // "un-embedded" so it degrades to the recency tail instead of sorting
      // unpredictably (NaN comparisons leave Array.sort order undefined).
      // (R1-W2 fold.)
      const score = raw !== null && Number.isFinite(raw) ? raw : null;
      return { event_id: row.event_id, score, start_at: row.start_at };
    });
    // Embedding-scored events first (cosine desc); un-embedded events after,
    // ordered by recency (candidates are already start_at DESC).
    const withScore = scored
      .filter((c) => c.score !== null)
      .sort((a, b) => (b.score as number) - (a.score as number));
    const withoutScore = scored.filter((c) => c.score === null);
    ranked = [...withScore, ...withoutScore].map(({ event_id, score }) => ({
      event_id,
      score,
    }));
  } else {
    // Recency ranking — candidates already ordered start_at DESC.
    ranked = candidates.map((row) => ({ event_id: row.event_id, score: null }));
  }

  const top = ranked.slice(0, k);
  const out: RetrievedGeneralEvent[] = [];
  for (const { event_id, score } of top) {
    const event = getGeneralEvent(event_id);
    if (event) out.push({ event, score });
  }
  return out;
}

/**
 * Layer 2 entry point — retrieve general events and descend to episodic
 * samples. This is what V8.1's morning-brief proactive scan calls.
 *
 * For each retrieved general event, the `episodicPerEvent` most recently
 * linked episodic rows are resolved to their source data. Recency stands in
 * for "most relevant" — descent has no per-episodic embedding (a deliberate
 * Bundle-1 scope cut; see the migration comment in `src/db/index.ts`).
 */
export async function retrieveForBriefing(
  context: RetrievalContext,
  k = 8,
  episodicPerEvent = 3,
): Promise<BriefingRetrieval> {
  const retrieved = await retrieveGeneralEvents(context, k);
  const generalEvents = retrieved.map((r) => r.event);

  const episodicSamples: BriefingEpisodicSample[] = [];
  for (const event of generalEvents) {
    const links = getEpisodicLinks(event.event_id);
    // getEpisodicLinks returns oldest-first (linked_at ASC, id ASC); take the
    // last-linked N as a recency proxy. linked_at has 1-second resolution, so
    // links created in the same second tie-break on insertion order (id ASC)
    // — deterministic, but "last-inserted N" within a same-second batch
    // rather than strict wall-clock recency (R1-W3).
    const recent = episodicPerEvent > 0 ? links.slice(-episodicPerEvent) : [];
    for (const link of recent) {
      episodicSamples.push({
        event_id: event.event_id,
        episodic: resolveEpisodic(link.episodic_kind, link.episodic_ref),
      });
    }
  }
  return { generalEvents, episodicSamples };
}

const SNIPPET_MAX = 200;

function snippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > SNIPPET_MAX
    ? `${trimmed.slice(0, SNIPPET_MAX)}…`
    : trimmed;
}

/**
 * Resolve one episodic link to its source row. Read-only. Returns
 * `found: false` (with the kind/ref echoed) when the source row no longer
 * exists — descent never throws, so a deleted task cannot break a briefing.
 */
export function resolveEpisodic(
  kind: EpisodicKind,
  ref: string,
): ResolvedEpisodic {
  const db = getDatabase();
  const miss = (): ResolvedEpisodic => ({
    kind,
    ref,
    found: false,
    title: null,
    snippet: null,
    timestamp: null,
  });

  switch (kind) {
    case "task": {
      const row = db
        .prepare(
          "SELECT title, description, status, created_at FROM tasks WHERE task_id = ?",
        )
        .get(ref) as
        | {
            title: string;
            description: string;
            status: string;
            created_at: string;
          }
        | undefined;
      if (!row) return miss();
      return {
        kind,
        ref,
        found: true,
        title: `[${row.status}] ${row.title}`,
        snippet: snippet(row.description),
        timestamp: row.created_at,
      };
    }
    case "conversation": {
      const row = db
        .prepare("SELECT content, created_at FROM conversations WHERE id = ?")
        .get(ref) as { content: string; created_at: string } | undefined;
      if (!row) return miss();
      return {
        kind,
        ref,
        found: true,
        title: snippet(row.content)?.slice(0, 60) ?? null,
        snippet: snippet(row.content),
        timestamp: row.created_at,
      };
    }
    case "memory_item": {
      const row = db
        .prepare(
          "SELECT title, content, updated_at FROM jarvis_files WHERE path = ?",
        )
        .get(ref) as
        | { title: string; content: string; updated_at: string }
        | undefined;
      if (!row) return miss();
      return {
        kind,
        ref,
        found: true,
        title: row.title,
        snippet: snippet(row.content),
        timestamp: row.updated_at,
      };
    }
    case "recall_audit": {
      const row = db
        .prepare(
          "SELECT query, bank, created_at FROM recall_audit WHERE id = ?",
        )
        .get(ref) as
        | { query: string; bank: string; created_at: string }
        | undefined;
      if (!row) return miss();
      return {
        kind,
        ref,
        found: true,
        title: `recall on ${row.bank}`,
        snippet: snippet(row.query),
        timestamp: row.created_at,
      };
    }
    case "cost_ledger": {
      const row = db
        .prepare(
          "SELECT run_id, task_id, agent_type, cost_usd, created_at FROM cost_ledger WHERE id = ?",
        )
        .get(ref) as
        | {
            run_id: string;
            task_id: string;
            agent_type: string;
            cost_usd: number;
            created_at: string;
          }
        | undefined;
      if (!row) return miss();
      return {
        kind,
        ref,
        found: true,
        title: `${row.agent_type} run $${row.cost_usd.toFixed(4)}`,
        snippet: `run ${row.run_id} · task ${row.task_id}`,
        timestamp: row.created_at,
      };
    }
    case "report": {
      const row = db
        .prepare(
          "SELECT surface, critic_verdict, report_json, produced_at FROM reports WHERE report_id = ?",
        )
        .get(ref) as
        | {
            surface: string;
            critic_verdict: string;
            report_json: string;
            produced_at: string;
          }
        | undefined;
      if (!row) return miss();
      return {
        kind,
        ref,
        found: true,
        title: `${row.surface} report (${row.critic_verdict})`,
        snippet: snippet(row.report_json),
        timestamp: row.produced_at,
      };
    }
    default: {
      // Exhaustiveness guard — `kind` is `never` here; a new EpisodicKind
      // that adds an enum value will fail typecheck until a case is added.
      kind satisfies never;
      return miss();
    }
  }
}

export type AggregateDimension = "day" | "week" | "project";

export interface EventAggregateBucket {
  /** Bucket key — `YYYY-MM-DD` (day / week-start Monday) or objective id. */
  bucket: string;
  event_count: number;
  /** Sum of `episodic_count` across the events in this bucket. */
  episodic_total: number;
}

/**
 * Time-windowed aggregation over a set of general events (the GUIDE's
 * per-day / per-week / per-project roll-up). Pure — operates on the array
 * passed in, no DB access.
 *
 * `day` and `week` bucket on the date component of each event's `start_at`
 * computed in UTC (week = the Monday of that UTC week) so the result is
 * deterministic regardless of process timezone. `project` buckets on
 * `goal_context_id`, with un-attributed events grouped under
 * `(no-objective)`. Buckets are returned sorted descending by key.
 */
export function aggregateGeneralEvents(
  events: GeneralEvent[],
  dimension: AggregateDimension,
): EventAggregateBucket[] {
  const buckets = new Map<string, EventAggregateBucket>();

  for (const event of events) {
    const key = bucketKey(event, dimension);
    const existing = buckets.get(key);
    if (existing) {
      existing.event_count += 1;
      existing.episodic_total += event.episodic_count;
    } else {
      buckets.set(key, {
        bucket: key,
        event_count: 1,
        episodic_total: event.episodic_count,
      });
    }
  }

  return [...buckets.values()].sort((a, b) =>
    a.bucket < b.bucket ? 1 : a.bucket > b.bucket ? -1 : 0,
  );
}

function bucketKey(event: GeneralEvent, dimension: AggregateDimension): string {
  if (dimension === "project") {
    return event.goal_context_id ?? "(no-objective)";
  }
  const d = new Date(event.start_at);
  if (Number.isNaN(d.getTime())) return "(invalid-date)";
  if (dimension === "day") {
    return d.toISOString().slice(0, 10);
  }
  // week — Monday of the UTC week containing start_at.
  const monday = new Date(d);
  const dow = monday.getUTCDay(); // 0=Sun..6=Sat
  const delta = dow === 0 ? -6 : 1 - dow;
  monday.setUTCDate(monday.getUTCDate() + delta);
  return monday.toISOString().slice(0, 10);
}
