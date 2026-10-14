/**
 * S6 WS2 — project attribution (spec docs/planning/s6-project-contract-spec-2026-10-11.md §4).
 * The resolver is pure (every branch of the priority order, ties, fall-through,
 * the chat thread window); the adapter reads a real `:memory:` db.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { ensureScheduledTasksTable } from "../rituals/dynamic.js";
import { RITUAL_PROJECT } from "../rituals/config.js";
import {
  CHAT_THREAD_WINDOW_MS,
  PROJECT_SOURCES,
  attributeNewTask,
  canonicalProjectSlug,
  readAttributionInput,
  resolveProjectAttribution,
  type AttributionInput,
} from "./attribution.js";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const none: AttributionInput = {
  scheduleSlug: null,
  parent: null,
  ritualProjects: {},
  thread: null,
  nowMs: NOW,
};

describe("resolveProjectAttribution — priority order, first match wins", () => {
  it("nothing matches → null (operator-level work)", () => {
    expect(resolveProjectAttribution(none)).toBeNull();
  });

  it("1. schedule", () => {
    expect(resolveProjectAttribution({ ...none, scheduleSlug: "acme-radar" })).toEqual({
      slug: "acme-radar",
      source: "schedule",
    });
  });

  it("schedule AND parent both present → schedule wins", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        scheduleSlug: "acme-radar",
        parent: { slug: "other-proj", source: "chat" },
      }),
    ).toEqual({ slug: "acme-radar", source: "schedule" });
  });

  it("2. parent: inherits the parent's slug AND source", () => {
    expect(
      resolveProjectAttribution({ ...none, parent: { slug: "acme-radar", source: "schedule" } }),
    ).toEqual({ slug: "acme-radar", source: "schedule" });
    expect(
      resolveProjectAttribution({ ...none, parent: { slug: "acme-radar", source: "chat" } }),
    ).toEqual({ slug: "acme-radar", source: "chat" });
    // A source outside the enum (never written by the INSERT) reads as `parent`.
    expect(
      resolveProjectAttribution({ ...none, parent: { slug: "acme-radar", source: null } }),
    ).toEqual({ slug: "acme-radar", source: "parent" });
  });

  it("parent with a null slug falls through to the next source", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        parent: { slug: null, source: null },
        ritualId: "r-1",
        ritualProjects: { "r-1": "acme-radar" },
      }),
    ).toEqual({ slug: "acme-radar", source: "ritual" });
    expect(resolveProjectAttribution({ ...none, parent: { slug: null, source: null } })).toBeNull();
  });

  it("3. ritual: only through the ritual→project map; an unmapped ritual falls through", () => {
    expect(
      resolveProjectAttribution({ ...none, ritualId: "r-1", ritualProjects: { "r-1": "acme-radar" } }),
    ).toEqual({ slug: "acme-radar", source: "ritual" });
    expect(resolveProjectAttribution({ ...none, ritualId: "r-2", ritualProjects: { "r-1": "x" } })).toBeNull();
  });

  it("ritual beats inbound and chat", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        ritualId: "r-1",
        ritualProjects: { "r-1": "acme-radar" },
        submitted: { slug: "other-proj", source: "chat" },
      }),
    ).toEqual({ slug: "acme-radar", source: "ritual" });
  });

  it("4. inbound (the jarvis-pull seam)", () => {
    expect(
      resolveProjectAttribution({ ...none, submitted: { slug: "acme-radar", source: "inbound" } }),
    ).toEqual({ slug: "acme-radar", source: "inbound" });
  });

  it("5. chat: the detector's slug, which beats the thread fallback", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        submitted: { slug: "acme-radar", source: "chat" },
        thread: { slug: "other-proj", createdAtMs: NOW - 1000 },
      }),
    ).toEqual({ slug: "acme-radar", source: "chat" });
  });

  it("6. classifier (ruling 3t): the turn's single project scope group beats the thread fallback", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        submitted: { slug: "acme-radar", source: "classifier" },
        thread: { slug: "other-proj", createdAtMs: NOW - 1000 },
      }),
    ).toEqual({ slug: "acme-radar", source: "classifier" });
  });

  it("chat beats classifier (one submission carries one source; the router sends chat when a project is named)", () => {
    // The pure order: chat is checked first, so a chat submission never reaches the classifier branch.
    expect(
      resolveProjectAttribution({ ...none, submitted: { slug: "acme-radar", source: "chat" } }),
    ).toEqual({ slug: "acme-radar", source: "chat" });
    expect(
      resolveProjectAttribution({
        ...none,
        ritualId: "r-1",
        ritualProjects: { "r-1": "other-proj" },
        submitted: { slug: "acme-radar", source: "classifier" },
      }),
    ).toEqual({ slug: "other-proj", source: "ritual" });
  });

  it("7. thread: no name → the thread's last explicit mention within 24 h, source thread", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        thread: { slug: "acme-radar", createdAtMs: NOW - CHAT_THREAD_WINDOW_MS },
      }),
    ).toEqual({ slug: "acme-radar", source: "thread" });
  });

  it("chat with a stale thread (> 24 h) → null", () => {
    expect(
      resolveProjectAttribution({
        ...none,
        thread: { slug: "acme-radar", createdAtMs: NOW - CHAT_THREAD_WINDOW_MS - 1 },
      }),
    ).toBeNull();
  });

  it("a named slug with no source is ignored", () => {
    expect(resolveProjectAttribution({ ...none, submitted: { slug: "acme-radar" } })).toBeNull();
  });

  it("the enum: classifier has a producer since ruling 3t (router chatProject); the ritual map ships empty", () => {
    expect(PROJECT_SOURCES).toEqual(["schedule", "parent", "ritual", "inbound", "chat", "thread", "classifier"]);
    expect(RITUAL_PROJECT).toEqual({});
  });
});

describe("readAttributionInput / attributeNewTask — the db adapter", () => {
  const sqliteAt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

  const project = (slug: string, status: string, aliases: string[] = []) =>
    getDatabase()
      .prepare("INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, ?, ?)")
      .run(`id-${slug}`, slug, slug, status, JSON.stringify({ aliases }));

  beforeEach(() => {
    logWarn.mockClear();
    initDatabase(":memory:");
    ensureScheduledTasksTable();
    project("acme-radar", "active", ["acme"]);
    project("other-proj", "active");
    const db = getDatabase();
    db.prepare(
      `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr, project_slug) VALUES ('s-claimed','n','d','0 9 * * 1','acme-radar'), ('s-free','n','d','0 9 * * 1',NULL)`,
    ).run();
    const task = (id: string, slug: string | null, source: string | null, meta: unknown, at: number) =>
      db
        .prepare(
          `INSERT INTO tasks (task_id, title, description, metadata, project_slug, project_source, created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, "t", "d", meta ? JSON.stringify(meta) : null, slug, source, sqliteAt(at));
    task("p-attr", "acme-radar", "schedule", null, NOW - 60_000);
    task("p-none", null, null, null, NOW - 60_000);
    task("th-old", "other-proj", "chat", { threadId: "th-1" }, NOW - 2 * 3600_000);
    task("th-new", "acme-radar", "chat", { threadId: "th-1" }, NOW - 3600_000);
    task("th-unattr", null, null, { threadId: "th-1" }, NOW - 60_000);
    task("th-inherited", "other-proj", "thread", { threadId: "th-1" }, NOW - 120_000); // never a fallback source
    task("th-stale", "acme-radar", "chat", { threadId: "th-2" }, NOW - CHAT_THREAD_WINDOW_MS - 3600_000);
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  it("schedule: the origin schedule's claim; an unclaimed or unknown schedule reads null", () => {
    const db = getDatabase();
    expect(readAttributionInput(db, { originScheduleId: "s-claimed" }, NOW).scheduleSlug).toBe("acme-radar");
    expect(readAttributionInput(db, { originScheduleId: "s-free" }, NOW).scheduleSlug).toBeNull();
    expect(readAttributionInput(db, { originScheduleId: "evolution-log" }, NOW).scheduleSlug).toBeNull();
  });

  it("parent: the row's slug and source; a missing parent row reads as no parent", () => {
    const db = getDatabase();
    expect(readAttributionInput(db, { parentTaskId: "p-attr" }, NOW).parent).toEqual({
      slug: "acme-radar",
      source: "schedule",
    });
    expect(readAttributionInput(db, { parentTaskId: "p-none" }, NOW).parent).toEqual({ slug: null, source: null });
    expect(readAttributionInput(db, { parentTaskId: "gone" }, NOW).parent).toBeNull();
  });

  it("thread: the newest EXPLICIT mention (source chat) of the same thread inside the window; inherited rows and stale → none", () => {
    const db = getDatabase();
    expect(readAttributionInput(db, { threadId: "th-1" }, NOW).thread).toEqual({
      slug: "acme-radar",
      createdAtMs: NOW - 3600_000,
    });
    expect(readAttributionInput(db, { threadId: "th-2" }, NOW).thread).toBeNull();
    expect(readAttributionInput(db, { threadId: "th-none" }, NOW).thread).toBeNull();
    // A named project skips the thread read.
    expect(
      readAttributionInput(db, { threadId: "th-1", projectSlug: "x", projectSource: "chat" }, NOW).thread,
    ).toBeNull();
  });

  it("end to end: schedule beats the parent; a chat turn with no name inherits its thread", () => {
    const db = getDatabase();
    expect(attributeNewTask(db, { originScheduleId: "s-claimed", parentTaskId: "th-old" })).toEqual({
      slug: "acme-radar",
      source: "schedule",
    });
    expect(attributeNewTask(db, { threadId: "th-1" }, NOW)).toEqual({ slug: "acme-radar", source: "thread" });
    expect(attributeNewTask(db, {})).toBeNull();
  });

  it("a broken lookup skips only its own source: the next source still resolves, and the warn is emitted", () => {
    const db = getDatabase();
    db.exec("DROP TABLE scheduled_tasks");
    expect(attributeNewTask(db, { originScheduleId: "s-claimed", parentTaskId: "p-attr" })).toEqual({
      slug: "acme-radar",
      source: "schedule", // the parent's source, inherited
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]![0]).toMatchObject({ source: "schedule", err: expect.stringMatching(/no such table/) });
  });

  it("ruling 3t: a classifier task never renews or changes the thread — the next unnamed turn resolves from the LAST chat row", () => {
    const db = getDatabase();
    const insert = (id: string, at: number, a: { slug: string; source: string } | null) =>
      db
        .prepare(
          `INSERT INTO tasks (task_id, title, description, metadata, project_slug, project_source, created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, "t", "d", JSON.stringify({ threadId: "th-3t" }), a?.slug ?? null, a?.source ?? null, sqliteAt(at));
    insert("3t-chat", NOW - 3 * 3600_000, { slug: "acme-radar", source: "chat" });
    const scoped = attributeNewTask(
      db,
      { threadId: "th-3t", projectSlug: "other-proj", projectSource: "classifier" },
      NOW - 3600_000,
    );
    expect(scoped).toEqual({ slug: "other-proj", source: "classifier" });
    insert("3t-cls", NOW - 3600_000, scoped);
    expect(readAttributionInput(db, { threadId: "th-3t" }, NOW).thread).toEqual({
      slug: "acme-radar",
      createdAtMs: NOW - 3 * 3600_000,
    });
    expect(attributeNewTask(db, { threadId: "th-3t" }, NOW)).toEqual({ slug: "acme-radar", source: "thread" });
    // A classifier row alone never feeds the fallback.
    insert("3t-only", NOW - 60_000, { slug: "other-proj", source: "classifier" });
    db.prepare("UPDATE tasks SET metadata = ? WHERE task_id = '3t-only'").run(JSON.stringify({ threadId: "th-3t-b" }));
    expect(attributeNewTask(db, { threadId: "th-3t-b" }, NOW)).toBeNull();
  });

  it("C2: the window never renews itself — named at t0, unnamed at +20 h → thread, unnamed at +40 h → null", () => {
    const db = getDatabase();
    const t0 = NOW - 48 * 3600_000;
    const insert = (id: string, at: number, a: { slug: string; source: string } | null) =>
      db
        .prepare(
          `INSERT INTO tasks (task_id, title, description, metadata, project_slug, project_source, created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, "t", "d", JSON.stringify({ threadId: "th-c2" }), a?.slug ?? null, a?.source ?? null, sqliteAt(at));
    const named = attributeNewTask(db, { threadId: "th-c2", projectSlug: "acme-radar", projectSource: "chat" }, t0);
    expect(named).toEqual({ slug: "acme-radar", source: "chat" });
    insert("c2-0", t0, named);
    const second = attributeNewTask(db, { threadId: "th-c2" }, t0 + 20 * 3600_000);
    expect(second).toEqual({ slug: "acme-radar", source: "thread" });
    insert("c2-1", t0 + 20 * 3600_000, second);
    expect(attributeNewTask(db, { threadId: "th-c2" }, t0 + 40 * 3600_000)).toBeNull();
  });
});

describe("canonicalProjectSlug — C1: every resolved slug must name a projects row", () => {
  beforeEach(() => {
    logWarn.mockClear();
    initDatabase(":memory:");
    const ins = getDatabase().prepare(
      "INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run("p1", "acme-entry-radar", "A", "active", JSON.stringify({ aliases: ["Acme"] }));
    ins.run("p2", "acme-radar-journal", "J", "archived", JSON.stringify({ aliases: ["acme"] }));
    ins.run("p3", "twin-one", "T1", "active", JSON.stringify({ aliases: ["twin"] }));
    ins.run("p4", "twin-two", "T2", "paused", JSON.stringify({ aliases: ["twin"] }));
  });
  afterEach(() => closeDatabase());

  it("an exact projects.slug wins at any status for a record claim (schedule/parent); an archived exact slug named in words (chat/thread/inbound) → null", () => {
    const db = getDatabase();
    expect(canonicalProjectSlug(db, "acme-radar-journal", "schedule")).toBe("acme-radar-journal");
    expect(canonicalProjectSlug(db, "acme-radar-journal", "parent")).toBe("acme-radar-journal");
    expect(canonicalProjectSlug(db, "acme-radar-journal", "ritual")).toBe("acme-radar-journal");
    expect(canonicalProjectSlug(db, "acme-radar-journal", "chat")).toBeNull();
    expect(canonicalProjectSlug(db, "acme-radar-journal", "thread")).toBeNull();
    expect(canonicalProjectSlug(db, "acme-radar-journal", "inbound")).toBeNull();
    expect(canonicalProjectSlug(db, "twin-two", "chat")).toBe("twin-two"); // paused is live
    expect(
      attributeNewTask(db, { projectSlug: "acme-radar-journal", projectSource: "chat" }),
    ).toBeNull();
  });

  it("ruling 3t: a classifier slug binds only to a live row (an archived exact slug → null)", () => {
    const db = getDatabase();
    expect(canonicalProjectSlug(db, "acme-radar-journal", "classifier")).toBeNull();
    expect(canonicalProjectSlug(db, "acme-entry-radar", "classifier")).toBe("acme-entry-radar");
    expect(canonicalProjectSlug(db, "twin-two", "classifier")).toBe("twin-two"); // paused is live
  });

  it("ruling 3t (audit W2): a classifier slug naming an archived row falls through to the live thread default; with no thread → null", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, metadata, project_slug, project_source, created_at) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      "w2-chat",
      "t",
      "d",
      JSON.stringify({ threadId: "th-w2" }),
      "acme-entry-radar",
      "chat",
      new Date(NOW - 3600_000).toISOString().replace("T", " ").slice(0, 19),
    );
    expect(
      attributeNewTask(db, { threadId: "th-w2", projectSlug: "acme-radar-journal", projectSource: "classifier" }, NOW),
    ).toEqual({ slug: "acme-entry-radar", source: "thread" });
    expect(
      attributeNewTask(db, { threadId: "th-none", projectSlug: "acme-radar-journal", projectSource: "classifier" }, NOW),
    ).toBeNull();
    expect(attributeNewTask(db, { projectSlug: "acme-radar-journal", projectSource: "classifier" }, NOW)).toBeNull();
    // chat keeps its behaviour: a rejected chat slug is null, never the thread.
    expect(
      attributeNewTask(db, { threadId: "th-w2", projectSlug: "acme-radar-journal", projectSource: "chat" }, NOW),
    ).toBeNull();
  });

  it("ruling 3t (audit R2-W2): a rejected chat or inbound slug stays null even with a live chat thread row in the window", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (task_id, title, description, metadata, project_slug, project_source, created_at) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      "r2w2-chat",
      "t",
      "d",
      JSON.stringify({ threadId: "th-r2w2" }),
      "acme-entry-radar",
      "chat",
      new Date(NOW - 3600_000).toISOString().replace("T", " ").slice(0, 19),
    );
    expect(attributeNewTask(db, { threadId: "th-r2w2" }, NOW)).toEqual({ slug: "acme-entry-radar", source: "thread" });
    for (const projectSource of ["chat", "inbound"] as const) {
      expect(
        attributeNewTask(db, { threadId: "th-r2w2", projectSlug: "acme-radar-journal", projectSource }, NOW),
      ).toBeNull();
    }
  });

  it("ruling 3t: only a classifier slug re-resolves — a rejected record claim is validated once", () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO tasks (task_id, title, description, project_slug, project_source) VALUES ('p-twin','t','d','twin','parent')",
    ).run();
    expect(attributeNewTask(db, { parentTaskId: "p-twin" }, NOW)).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1); // the alias tie, once
  });

  it("R2: a whole-phrase alias outranks a single hyphen-word alias; the tie rule applies within the winning rank", () => {
    const db = getDatabase();
    db.prepare("UPDATE projects SET config = ? WHERE slug = 'acme-entry-radar'").run(
      JSON.stringify({ aliases: ["Acme Radar"] }),
    );
    db.prepare(
      "INSERT INTO projects (id, slug, name, status, config) VALUES ('p5', 'radar-hub', 'R', 'active', ?)",
    ).run(JSON.stringify({ aliases: ["radar"] }));
    expect(canonicalProjectSlug(db, "acme-radar", "chat")).toBe("acme-entry-radar");
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("a detector folder name resolves through an ACTIVE/PAUSED row's alias, case-insensitive; the archived row with the same alias is skipped", () => {
    // the shape of `williams-radar` → `williams-entry-radar` via alias `williams`
    expect(canonicalProjectSlug(getDatabase(), "acme-radar", "chat")).toBe("acme-entry-radar");
  });

  it("no row and no alias → null (the shape of cmll-gira-estrellas)", () => {
    expect(canonicalProjectSlug(getDatabase(), "gira-estrellas", "chat")).toBeNull();
    expect(attributeNewTask(getDatabase(), { projectSlug: "gira-estrellas", projectSource: "chat" })).toBeNull();
  });

  it("an alias shared by two live rows is a tie → null, logged with the row slugs only", () => {
    expect(canonicalProjectSlug(getDatabase(), "twin", "chat")).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(
      { slug: "twin", matches: ["twin-one", "twin-two"] },
      expect.any(String),
    );
  });

  it("the validator applies to every source: a chat slug is stored canonical, an unknown inbound slug is dropped", () => {
    const db = getDatabase();
    expect(attributeNewTask(db, { projectSlug: "acme-radar", projectSource: "chat" })).toEqual({
      slug: "acme-entry-radar",
      source: "chat",
    });
    expect(attributeNewTask(db, { projectSlug: "nope-nope", projectSource: "inbound" })).toBeNull();
  });
});

describe("set once: nothing but the dispatcher INSERT writes the task columns", () => {
  it("no src file (tests excluded) UPDATEs tasks.project_slug / project_source", () => {
    const root = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          const text = readFileSync(p, "utf8");
          for (const m of text.matchAll(/UPDATE\s+tasks\b[\s\S]{0,400}?(?:`|;|"\))/gi)) {
            if (/project_(slug|source)/.test(m[0])) offenders.push(p);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
