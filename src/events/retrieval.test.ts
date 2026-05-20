import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

// Mock only `embed` (the network call). cosineSimilarity / deserializeEmbedding
// / serializeEmbedding stay real so retrieval scoring is exercised end-to-end.
vi.mock("../memory/embeddings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../memory/embeddings.js")>();
  return { ...actual, embed: vi.fn() };
});

import { embed } from "../memory/embeddings.js";
import { createGeneralEvent, linkEpisodic } from "./general-events.js";
import type { GeneralEvent } from "./general-events.js";
import {
  aggregateGeneralEvents,
  resolveEpisodic,
  retrieveForBriefing,
  retrieveGeneralEvents,
} from "./retrieval.js";

const mockEmbed = vi.mocked(embed);

/**
 * Deterministic embedding: a one-hot 1536-dim vector keyed to a theme word
 * in the text. cos(alpha, alpha)=1, cos(alpha, beta)=0 — so retrieval
 * ranking is fully predictable.
 */
function embedFor(text: string): Float32Array {
  const v = new Float32Array(1536).fill(0);
  const t = text.toLowerCase();
  if (t.includes("alpha")) v[0] = 1;
  else if (t.includes("beta")) v[1] = 1;
  else if (t.includes("gamma")) v[2] = 1;
  else v[3] = 1;
  return v;
}

beforeEach(() => {
  initDatabase(":memory:");
  mockEmbed.mockReset();
  mockEmbed.mockImplementation(async (text: string) => embedFor(text));
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

async function seedEvent(
  overrides: Partial<Parameters<typeof createGeneralEvent>[0]> & {
    event_id: string;
  },
): Promise<GeneralEvent> {
  return createGeneralEvent({
    level: "general",
    title: overrides.event_id,
    summary: overrides.event_id,
    start_at: "2026-05-10T00:00:00Z",
    ...overrides,
  });
}

describe("retrieveGeneralEvents — ranking", () => {
  it("ranks by cosine similarity when a query is given", async () => {
    await seedEvent({ event_id: "alpha-event", summary: "the alpha topic" });
    await seedEvent({ event_id: "beta-event", summary: "the beta topic" });
    await seedEvent({ event_id: "gamma-event", summary: "the gamma topic" });

    const results = await retrieveGeneralEvents({ query: "alpha please" });
    expect(results[0].event.event_id).toBe("alpha-event");
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].score).toBeCloseTo(0, 5);
  });

  it("falls back to recency ranking when no query is given", async () => {
    await seedEvent({
      event_id: "older-event",
      start_at: "2026-01-01T00:00:00Z",
    });
    await seedEvent({
      event_id: "newer-event",
      start_at: "2026-05-01T00:00:00Z",
    });
    const results = await retrieveGeneralEvents({});
    expect(results.map((r) => r.event.event_id)).toEqual([
      "newer-event",
      "older-event",
    ]);
    expect(results[0].score).toBeNull();
  });

  it("ranks events with no embedding below embedding-scored events", async () => {
    await seedEvent({ event_id: "alpha-event", summary: "the alpha topic" });
    mockEmbed.mockResolvedValueOnce(null); // next create() stores null embedding
    await seedEvent({ event_id: "no-embed-event", summary: "the alpha topic" });

    const results = await retrieveGeneralEvents({ query: "alpha" });
    expect(results[0].event.event_id).toBe("alpha-event");
    expect(results[1].event.event_id).toBe("no-embed-event");
    expect(results[1].score).toBeNull();
  });

  it("degrades to recency ranking when the query cannot be embedded", async () => {
    await seedEvent({
      event_id: "older-event",
      start_at: "2026-01-01T00:00:00Z",
    });
    await seedEvent({
      event_id: "newer-event",
      start_at: "2026-05-01T00:00:00Z",
    });
    mockEmbed.mockResolvedValueOnce(null); // the query embed fails
    const results = await retrieveGeneralEvents({ query: "alpha" });
    expect(results.map((r) => r.event.event_id)).toEqual([
      "newer-event",
      "older-event",
    ]);
  });

  it("honours k", async () => {
    await seedEvent({ event_id: "event-1" });
    await seedEvent({ event_id: "event-2" });
    await seedEvent({ event_id: "event-3" });
    expect(await retrieveGeneralEvents({}, 2)).toHaveLength(2);
    expect(await retrieveGeneralEvents({}, 0)).toHaveLength(0);
  });

  it("treats a wrong-dimension stored embedding as un-embedded (R1-W2)", async () => {
    await seedEvent({ event_id: "alpha-event", summary: "the alpha topic" });
    // Next create() stores an 8-dim embedding — cosine against the 1536-dim
    // query vector would yield NaN; it must degrade to the recency tail.
    mockEmbed.mockResolvedValueOnce(new Float32Array(8).fill(1));
    await seedEvent({ event_id: "bad-dim-event", summary: "the alpha topic" });

    const results = await retrieveGeneralEvents({ query: "alpha" });
    expect(results[0].event.event_id).toBe("alpha-event");
    expect(results[0].score).toBeCloseTo(1, 5);
    const badDim = results.find((r) => r.event.event_id === "bad-dim-event")!;
    expect(badDim.score).toBeNull();
  });
});

describe("retrieveGeneralEvents — filtering", () => {
  it("filters by active objective ids", async () => {
    await seedEvent({ event_id: "obj-a-event", goal_context_id: "obj-a" });
    await seedEvent({ event_id: "obj-b-event", goal_context_id: "obj-b" });
    const results = await retrieveGeneralEvents({
      active_objective_ids: ["obj-a"],
    });
    expect(results.map((r) => r.event.event_id)).toEqual(["obj-a-event"]);
  });

  it("filters by time-window overlap", async () => {
    await seedEvent({
      event_id: "before-window",
      start_at: "2026-01-01T00:00:00Z",
      end_at: "2026-01-31T00:00:00Z",
    });
    await seedEvent({
      event_id: "inside-window",
      start_at: "2026-05-05T00:00:00Z",
      end_at: "2026-05-15T00:00:00Z",
    });
    await seedEvent({
      event_id: "ongoing-event",
      start_at: "2026-05-01T00:00:00Z",
      end_at: null,
    });
    const results = await retrieveGeneralEvents({
      window: { start: "2026-05-10T00:00:00Z", end: "2026-05-20T00:00:00Z" },
    });
    expect(results.map((r) => r.event.event_id).sort()).toEqual([
      "inside-window",
      "ongoing-event",
    ]);
  });

  it("excludes archived events unless includeArchived is set", async () => {
    await seedEvent({ event_id: "live-event" });
    const archived = await seedEvent({ event_id: "archived-event" });
    const { archiveGeneralEvent } = await import("./general-events.js");
    archiveGeneralEvent(archived.event_id);

    expect(await retrieveGeneralEvents({})).toHaveLength(1);
    expect(await retrieveGeneralEvents({ includeArchived: true })).toHaveLength(
      2,
    );
  });

  it("handles boundary-touching and zero-width windows inclusively (R1-R3)", async () => {
    await seedEvent({
      event_id: "ends-at-window-start",
      start_at: "2026-05-01T00:00:00Z",
      end_at: "2026-05-10T00:00:00Z",
    });
    await seedEvent({
      event_id: "contains-window",
      start_at: "2026-04-01T00:00:00Z",
      end_at: "2026-06-01T00:00:00Z",
    });
    // end_at exactly equals window.start — `end_at >= start` is inclusive,
    // so it is kept.
    const touching = await retrieveGeneralEvents({
      window: { start: "2026-05-10T00:00:00Z", end: "2026-05-20T00:00:00Z" },
    });
    expect(touching.map((r) => r.event.event_id).sort()).toEqual([
      "contains-window",
      "ends-at-window-start",
    ]);
    // Zero-width window (start === end) inside the containing event.
    const zeroWidth = await retrieveGeneralEvents({
      window: { start: "2026-05-05T00:00:00Z", end: "2026-05-05T00:00:00Z" },
    });
    expect(zeroWidth.map((r) => r.event.event_id)).toContain("contains-window");
  });
});

describe("retrieveForBriefing — descent", () => {
  it("retrieves events and resolves up to episodicPerEvent episodic samples", async () => {
    await seedEvent({ event_id: "alpha-event", summary: "the alpha topic" });
    const db = getDatabase();
    db.prepare(
      "INSERT INTO tasks (task_id, title, description, status) VALUES (?, ?, ?, ?)",
    ).run("t-1", "Scrape Vallarta", "extraction plan", "completed");
    db.prepare(
      "INSERT INTO conversations (id, bank, content) VALUES (?, ?, ?)",
    ).run(50, "mc-jarvis", "operator asked about the scraping plan");
    linkEpisodic("alpha-event", "task", "t-1");
    linkEpisodic("alpha-event", "conversation", "50");

    const briefing = await retrieveForBriefing({ query: "alpha" }, 8, 3);
    expect(briefing.generalEvents).toHaveLength(1);
    expect(briefing.episodicSamples).toHaveLength(2);
    const task = briefing.episodicSamples.find(
      (s) => s.episodic.kind === "task",
    )!;
    expect(task.episodic.found).toBe(true);
    expect(task.episodic.title).toContain("Scrape Vallarta");
  });

  it("caps episodic samples per event at episodicPerEvent", async () => {
    await seedEvent({ event_id: "alpha-event", summary: "the alpha topic" });
    const db = getDatabase();
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description) VALUES (?, ?, ?)",
      ).run(`t-${i}`, `task ${i}`, "d");
      linkEpisodic("alpha-event", "task", `t-${i}`);
    }
    const briefing = await retrieveForBriefing({ query: "alpha" }, 8, 3);
    expect(briefing.episodicSamples).toHaveLength(3);
  });
});

describe("resolveEpisodic", () => {
  it("returns found:false for a missing source row", () => {
    const r = resolveEpisodic("task", "does-not-exist");
    expect(r.found).toBe(false);
    expect(r.ref).toBe("does-not-exist");
    expect(r.title).toBeNull();
  });

  it("descent survives a deleted source row without throwing (R1-R2)", async () => {
    await seedEvent({ event_id: "alpha-event", summary: "the alpha topic" });
    const db = getDatabase();
    db.prepare(
      "INSERT INTO tasks (task_id, title, description) VALUES (?, ?, ?)",
    ).run("t-gone", "soon-deleted", "d");
    linkEpisodic("alpha-event", "task", "t-gone");
    db.prepare("DELETE FROM tasks WHERE task_id = ?").run("t-gone");

    const briefing = await retrieveForBriefing({ query: "alpha" });
    expect(briefing.episodicSamples).toHaveLength(1);
    expect(briefing.episodicSamples[0].episodic.found).toBe(false);
  });

  it("resolves every episodic kind", () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO tasks (task_id, title, description, status) VALUES (?, ?, ?, ?)",
    ).run("t-9", "a task", "task body", "running");
    db.prepare(
      "INSERT INTO conversations (id, bank, content) VALUES (?, ?, ?)",
    ).run(7, "mc-jarvis", "conversation body");
    db.prepare(
      "INSERT INTO jarvis_files (id, path, title, content) VALUES (?, ?, ?, ?)",
    ).run("f-1", "notes/x.md", "X Notes", "file body");
    db.prepare(
      "INSERT INTO recall_audit (id, bank, query, source) VALUES (?, ?, ?, ?)",
    ).run(3, "world", "what is X", "sqlite-only");
    db.prepare(
      "INSERT INTO cost_ledger (id, run_id, task_id, agent_type, model, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(4, "run-x", "t-9", "fast", "sonnet", 0.0123);
    db.prepare(
      `INSERT INTO reports (report_id, surface, started_at, produced_at, report_json, critic_verdict)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "r-1",
      "morning_brief",
      "2026-05-19T06:00:00Z",
      "2026-05-19T06:01:00Z",
      '{"k":"v"}',
      "pass",
    );

    expect(resolveEpisodic("task", "t-9").title).toBe("[running] a task");
    expect(resolveEpisodic("conversation", "7").found).toBe(true);
    expect(resolveEpisodic("memory_item", "notes/x.md").title).toBe("X Notes");
    expect(resolveEpisodic("recall_audit", "3").title).toBe("recall on world");
    expect(resolveEpisodic("cost_ledger", "4").title).toContain("fast run");
    expect(resolveEpisodic("report", "r-1").title).toBe(
      "morning_brief report (pass)",
    );
  });
});

describe("aggregateGeneralEvents", () => {
  it("buckets by day", async () => {
    const a = await seedEvent({
      event_id: "e-a",
      start_at: "2026-05-10T08:00:00Z",
    });
    const b = await seedEvent({
      event_id: "e-b",
      start_at: "2026-05-10T20:00:00Z",
    });
    const c = await seedEvent({
      event_id: "e-c",
      start_at: "2026-05-11T08:00:00Z",
    });
    const agg = aggregateGeneralEvents([a, b, c], "day");
    expect(agg).toEqual([
      { bucket: "2026-05-11", event_count: 1, episodic_total: 0 },
      { bucket: "2026-05-10", event_count: 2, episodic_total: 0 },
    ]);
  });

  it("buckets by week (Monday of the UTC week)", async () => {
    // 2026-05-13 is a Wednesday; its week-Monday is 2026-05-11.
    const a = await seedEvent({
      event_id: "e-a",
      start_at: "2026-05-13T00:00:00Z",
    });
    const b = await seedEvent({
      event_id: "e-b",
      start_at: "2026-05-15T00:00:00Z",
    });
    const agg = aggregateGeneralEvents([a, b], "week");
    expect(agg).toEqual([
      { bucket: "2026-05-11", event_count: 2, episodic_total: 0 },
    ]);
  });

  it("buckets by project, grouping un-attributed events", async () => {
    const a = await seedEvent({ event_id: "e-a", goal_context_id: "obj-1" });
    const b = await seedEvent({ event_id: "e-b", goal_context_id: "obj-1" });
    const c = await seedEvent({ event_id: "e-c" });
    const agg = aggregateGeneralEvents([a, b, c], "project");
    const byBucket = Object.fromEntries(
      agg.map((x) => [x.bucket, x.event_count]),
    );
    expect(byBucket["obj-1"]).toBe(2);
    expect(byBucket["(no-objective)"]).toBe(1);
  });

  it("sums episodic_total across a bucket", async () => {
    await seedEvent({ event_id: "e-a", start_at: "2026-05-10T00:00:00Z" });
    const db = getDatabase();
    db.prepare(
      "INSERT INTO tasks (task_id, title, description) VALUES (?, ?, ?)",
    ).run("t-1", "t", "d");
    linkEpisodic("e-a", "task", "t-1");
    const { listGeneralEvents } = await import("./general-events.js");
    const agg = aggregateGeneralEvents(listGeneralEvents(), "day");
    expect(agg[0].episodic_total).toBe(1);
  });
});
