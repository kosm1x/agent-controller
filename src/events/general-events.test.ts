import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

// Mock at the actual import boundary of the unit under test (R1-W3 fold):
// general-events.ts imports `embed` + `serializeEmbedding` from
// ../memory/embeddings.js. `serializeEmbedding` stays real so the stored
// BLOB is a genuine Buffer; only `embed` (the network call) is stubbed.
vi.mock("../memory/embeddings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../memory/embeddings.js")>();
  return { ...actual, embed: vi.fn() };
});

import { embed } from "../memory/embeddings.js";
import {
  GeneralEventError,
  archiveGeneralEvent,
  createGeneralEvent,
  getEpisodicLinks,
  getGeneralEvent,
  linkEpisodic,
  listGeneralEvents,
  supersedeGeneralEvent,
  unlinkEpisodic,
  updateGeneralEvent,
} from "./general-events.js";

const mockEmbed = vi.mocked(embed);

/** A deterministic 1536-dim embedding so embed() returns a non-null vector. */
function embedding(value: number): Float32Array {
  return new Float32Array(1536).fill(value);
}

beforeEach(() => {
  initDatabase(":memory:");
  mockEmbed.mockReset();
  mockEmbed.mockResolvedValue(embedding(0.1));
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

const baseInput = {
  event_id: "v77-spine-3-s5-skills",
  level: "general" as const,
  title: "v7.7 Spine 3 — S5 skills substrate",
  summary: "Shipped the skills-as-stored-procedures substrate across 5 phases.",
  start_at: "2026-05-19T00:00:00Z",
};

describe("createGeneralEvent", () => {
  it("creates an event and embeds title+summary", async () => {
    const ev = await createGeneralEvent(baseInput);
    expect(ev.event_id).toBe("v77-spine-3-s5-skills");
    expect(ev.level).toBe("general");
    expect(ev.episodic_count).toBe(0);
    expect(ev.created_by).toBe("manual");
    expect(ev.archived_at).toBeNull();
    expect(mockEmbed).toHaveBeenCalledOnce();

    const row = getDatabase()
      .prepare(
        "SELECT summary_embedding FROM general_events WHERE event_id = ?",
      )
      .get(ev.event_id) as { summary_embedding: Buffer | null };
    expect(row.summary_embedding).toBeInstanceOf(Buffer);
  });

  it("stores the event even when embedding is unavailable", async () => {
    mockEmbed.mockResolvedValue(null);
    const ev = await createGeneralEvent(baseInput);
    expect(ev.event_id).toBe("v77-spine-3-s5-skills");
    const row = getDatabase()
      .prepare(
        "SELECT summary_embedding FROM general_events WHERE event_id = ?",
      )
      .get(ev.event_id) as { summary_embedding: Buffer | null };
    expect(row.summary_embedding).toBeNull();
  });

  it("rejects a malformed event_id", async () => {
    await expect(
      createGeneralEvent({ ...baseInput, event_id: "Bad ID!" }),
    ).rejects.toThrow(GeneralEventError);
  });

  it("rejects a duplicate event_id", async () => {
    await createGeneralEvent(baseInput);
    await expect(createGeneralEvent(baseInput)).rejects.toThrow(
      /already exists/,
    );
  });

  it("rejects an empty title or summary", async () => {
    await expect(
      createGeneralEvent({ ...baseInput, title: "   " }),
    ).rejects.toThrow(/title is required/);
    await expect(
      createGeneralEvent({ ...baseInput, summary: "" }),
    ).rejects.toThrow(/summary is required/);
  });

  it("rejects end_at earlier than start_at", async () => {
    await expect(
      createGeneralEvent({ ...baseInput, end_at: "2026-05-01T00:00:00Z" }),
    ).rejects.toThrow(/earlier than start_at/);
  });

  it("round-trips themes as a JSON array", async () => {
    const ev = await createGeneralEvent({
      ...baseInput,
      themes: ["v8-substrate", "skills"],
    });
    expect(ev.themes).toEqual(["v8-substrate", "skills"]);
    expect(getGeneralEvent(ev.event_id)!.themes).toEqual([
      "v8-substrate",
      "skills",
    ]);
  });
});

describe("listGeneralEvents", () => {
  it("filters by level and excludes archived rows by default", async () => {
    await createGeneralEvent(baseInput);
    await createGeneralEvent({
      ...baseInput,
      event_id: "v8-substrate-arc",
      level: "lifetime",
      start_at: "2026-04-01T00:00:00Z",
    });
    archiveGeneralEvent("v8-substrate-arc");

    expect(listGeneralEvents()).toHaveLength(1);
    expect(listGeneralEvents({ includeArchived: true })).toHaveLength(2);
    expect(listGeneralEvents({ level: "general" })).toHaveLength(1);
    expect(listGeneralEvents({ level: "lifetime" })).toHaveLength(0);
  });

  it("orders newest start_at first", async () => {
    await createGeneralEvent({
      ...baseInput,
      event_id: "older-event",
      start_at: "2026-01-01T00:00:00Z",
    });
    await createGeneralEvent(baseInput);
    expect(listGeneralEvents().map((e) => e.event_id)).toEqual([
      "v77-spine-3-s5-skills",
      "older-event",
    ]);
  });
});

describe("updateGeneralEvent", () => {
  it("re-embeds when summary changes, bumps updated_at", async () => {
    await createGeneralEvent(baseInput);
    mockEmbed.mockClear();
    const updated = await updateGeneralEvent("v77-spine-3-s5-skills", {
      summary: "Revised: all 5 phases closed in one calendar day.",
    });
    expect(updated.summary).toMatch(/Revised/);
    expect(mockEmbed).toHaveBeenCalledOnce();
  });

  it("does NOT re-embed when only end_at changes", async () => {
    await createGeneralEvent(baseInput);
    mockEmbed.mockClear();
    await updateGeneralEvent("v77-spine-3-s5-skills", {
      end_at: "2026-05-19T23:00:00Z",
    });
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("tolerates a null embedding on the re-embed path", async () => {
    await createGeneralEvent(baseInput);
    mockEmbed.mockResolvedValue(null);
    await updateGeneralEvent("v77-spine-3-s5-skills", {
      summary: "Revised summary with no embedding available.",
    });
    const row = getDatabase()
      .prepare(
        "SELECT summary_embedding FROM general_events WHERE event_id = ?",
      )
      .get("v77-spine-3-s5-skills") as { summary_embedding: Buffer | null };
    expect(row.summary_embedding).toBeNull();
  });

  it("rejects an unknown event_id", async () => {
    await expect(
      updateGeneralEvent("does-not-exist", { title: "x" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("archiveGeneralEvent", () => {
  it("sets archived_at and tags the reason into themes", async () => {
    await createGeneralEvent(baseInput);
    archiveGeneralEvent("v77-spine-3-s5-skills", "superseded by closure doc");
    const ev = getGeneralEvent("v77-spine-3-s5-skills")!;
    expect(ev.archived_at).not.toBeNull();
    expect(ev.themes).toContain("archived:superseded by closure doc");
  });

  it("is idempotent — re-archiving preserves the original timestamp", async () => {
    await createGeneralEvent(baseInput);
    archiveGeneralEvent("v77-spine-3-s5-skills");
    const first = getGeneralEvent("v77-spine-3-s5-skills")!.archived_at;
    archiveGeneralEvent("v77-spine-3-s5-skills", "second try");
    expect(getGeneralEvent("v77-spine-3-s5-skills")!.archived_at).toBe(first);
  });

  it("throws for an unknown event_id", async () => {
    expect(() => archiveGeneralEvent("nope")).toThrow(GeneralEventError);
  });
});

describe("supersedeGeneralEvent", () => {
  it("points superseded_by at the new event and archives the old one", async () => {
    await createGeneralEvent(baseInput);
    const next = await createGeneralEvent({
      ...baseInput,
      event_id: "v77-spine-3-closure",
      title: "v7.7 Spine 3 closure",
    });
    supersedeGeneralEvent("v77-spine-3-s5-skills", "v77-spine-3-closure");
    const old = getGeneralEvent("v77-spine-3-s5-skills")!;
    expect(old.superseded_by).toBe(next.id);
    expect(old.archived_at).not.toBeNull();
  });

  it("rejects self-supersession and unknown ids", async () => {
    await createGeneralEvent(baseInput);
    expect(() =>
      supersedeGeneralEvent("v77-spine-3-s5-skills", "v77-spine-3-s5-skills"),
    ).toThrow(/cannot supersede itself/);
    expect(() =>
      supersedeGeneralEvent("v77-spine-3-s5-skills", "ghost"),
    ).toThrow(/not found/);
  });
});

describe("episodic links", () => {
  it("links episodic refs and recomputes episodic_count", async () => {
    await createGeneralEvent(baseInput);
    linkEpisodic("v77-spine-3-s5-skills", "task", "f3c2046f");
    linkEpisodic("v77-spine-3-s5-skills", "report", "audit-p5-b1");
    expect(getGeneralEvent("v77-spine-3-s5-skills")!.episodic_count).toBe(2);
    expect(getEpisodicLinks("v77-spine-3-s5-skills")).toHaveLength(2);
  });

  it("is idempotent — re-linking the same triple does not double-count", async () => {
    await createGeneralEvent(baseInput);
    linkEpisodic("v77-spine-3-s5-skills", "task", "f3c2046f");
    linkEpisodic("v77-spine-3-s5-skills", "task", "f3c2046f", "co-occurrence");
    expect(getGeneralEvent("v77-spine-3-s5-skills")!.episodic_count).toBe(1);
  });

  it("unlink removes the edge and decrements the count", async () => {
    await createGeneralEvent(baseInput);
    linkEpisodic("v77-spine-3-s5-skills", "task", "f3c2046f");
    linkEpisodic("v77-spine-3-s5-skills", "conversation", "c-99");
    unlinkEpisodic("v77-spine-3-s5-skills", "task", "f3c2046f");
    expect(getGeneralEvent("v77-spine-3-s5-skills")!.episodic_count).toBe(1);
    expect(getEpisodicLinks("v77-spine-3-s5-skills")).toHaveLength(1);
  });

  it("rejects linking to an unknown event", async () => {
    expect(() => linkEpisodic("ghost", "task", "f3c2046f")).toThrow(
      /not found/,
    );
  });

  it("rejects unlinking from an unknown event (R1-W1)", async () => {
    expect(() => unlinkEpisodic("ghost", "task", "f3c2046f")).toThrow(
      /not found/,
    );
  });

  it("rejects an empty episodic_ref on link and unlink (R1-W2)", async () => {
    await createGeneralEvent(baseInput);
    expect(() => linkEpisodic("v77-spine-3-s5-skills", "task", "  ")).toThrow(
      /episodic_ref is required/,
    );
    expect(() => unlinkEpisodic("v77-spine-3-s5-skills", "task", "")).toThrow(
      /episodic_ref is required/,
    );
  });
});
