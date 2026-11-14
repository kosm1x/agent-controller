/**
 * `db/projects` statements on the real schema (`initDatabase(":memory:")`),
 * asserting the exact rows and columns each statement reads or writes. A keyed
 * read or write acts on a row with a neighbour on both sides of its key (by
 * slug and by id) that must stay out of the result or unchanged, and a lookup
 * of an absent key below the lowest and above the highest returns nothing.
 * Sorted reads are seeded so that no other column (slug, id, insertion order,
 * timestamps) gives the same order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import {
  createProject,
  getProject,
  getProjectLog,
  listProjects,
  logProjectAction,
  migrateUserFactsToProjects,
  updateProject,
} from "./projects.js";

type RawRow = Record<string, unknown>;

const OLD = "2001-02-03 04:05:06";
const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const rawProject = (id: string): RawRow =>
  getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(id) as RawRow;

function seedProject(
  id: string,
  slug: string,
  name: string,
  status: string,
  createdAt: string,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO projects (id, slug, name, description, status, urls, credentials, config, commit_goal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      slug,
      name,
      `about ${name}`,
      status,
      JSON.stringify({ site: `https://${slug}.example.invalid` }),
      JSON.stringify({ login: `syn-login-${slug}` }),
      JSON.stringify({ mode: `mode-${slug}` }),
      `goal-${slug}`,
      createdAt,
      createdAt,
    );
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("listProjects / getProject on the real schema", () => {
  // Inserted out of name order; slug order, id order and created_at order
  // each differ from name order (and from its reverse).
  beforeEach(() => {
    seedProject("p-3", "delta", "Bravo", "active", "2026-01-01 10:00:01");
    seedProject("p-1", "alpha", "Echo", "paused", "2026-01-01 10:00:03");
    seedProject("p-5", "echo", "Alpha", "active", "2026-01-01 10:00:05");
    seedProject("p-2", "charlie", "Delta", "completed", "2026-01-01 10:00:02");
    seedProject("p-4", "bravo", "Charlie", "archived", "2026-01-01 10:00:04");
  });

  const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

  it("lists every project ordered by name, with each stored column mapped", () => {
    const rows = listProjects();
    expect(names(rows)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    expect(rows[3]).toEqual({
      id: "p-2",
      slug: "charlie",
      name: "Delta",
      description: "about Delta",
      status: "completed",
      urls: { site: "https://charlie.example.invalid" },
      credentials: { login: "syn-login-charlie" },
      config: { mode: "mode-charlie" },
      commit_goal_id: "goal-charlie",
      created_at: "2026-01-01 10:00:02",
      updated_at: "2026-01-01 10:00:02",
    });
  });

  it("filters by the exact status (statuses sorting below and above it stay out), ordered by name", () => {
    expect(names(listProjects("active"))).toEqual(["Alpha", "Bravo"]);
    expect(names(listProjects("completed"))).toEqual(["Delta"]);
    expect(names(listProjects("archived"))).toEqual(["Charlie"]);
    expect(names(listProjects("paused"))).toEqual(["Echo"]);
  });

  it("finds one project by slug or by id; an absent key below or above every row finds nothing", () => {
    expect(getProject("charlie")?.id).toBe("p-2");
    expect(getProject("charlie")?.name).toBe("Delta");
    expect(getProject("p-3")?.slug).toBe("delta");
    expect(getProject("p-3")?.name).toBe("Bravo");
    expect(getProject("aaa")).toBeNull();
    expect(getProject("zzz")).toBeNull();
    expect(getProject("p-0")).toBeNull();
    expect(getProject("p-9")).toBeNull();
  });
});

describe("createProject on the real schema", () => {
  it("stores every given field in its own column and logs the creation", () => {
    const p = createProject("given-slug", "Given Name", {
      description: "given description",
      status: "paused",
      urls: { site: "https://given.example.invalid", nested: { depth: 1 } },
      credentials: { login: "syn-login-given" },
      config: { mode: "syn-mode-given" },
      commit_goal_id: "goal-given",
    });
    const row = rawProject(p.id);
    expect(row).toEqual({
      id: p.id,
      slug: "given-slug",
      name: "Given Name",
      description: "given description",
      status: "paused",
      urls: JSON.stringify({ site: "https://given.example.invalid", nested: { depth: 1 } }),
      credentials: JSON.stringify({ login: "syn-login-given" }),
      config: JSON.stringify({ mode: "syn-mode-given" }),
      commit_goal_id: "goal-given",
      created_at: expect.stringMatching(STAMP_RE),
      updated_at: expect.stringMatching(STAMP_RE),
    });
    expect(p.id).toMatch(/^proj-\d+-[a-z0-9]{1,4}$/);
    expect(
      getDatabase()
        .prepare("SELECT project_id, action, details FROM project_log ORDER BY id")
        .all(),
    ).toEqual([
      { project_id: p.id, action: "created", details: 'Project "Given Name" created' },
    ]);
  });

  it("omitted fields take their defaults", () => {
    const p = createProject("bare-slug", "Bare Name");
    expect(rawProject(p.id)).toMatchObject({
      slug: "bare-slug",
      name: "Bare Name",
      description: "",
      status: "active",
      urls: "{}",
      credentials: "{}",
      config: "{}",
      commit_goal_id: null,
    });
  });
});

describe("updateProject on the real schema", () => {
  /** Three projects; returns them sorted by their generated id. */
  function three(): Array<{ id: string; slug: string }> {
    const made = ["one", "two", "three"].map((n) =>
      createProject(`slug-${n}`, `Name ${n}`, {
        description: `desc ${n}`,
        urls: { site: `https://${n}.example.invalid`, keep: `keep-${n}` },
        credentials: { login: `syn-login-${n}`, other: `syn-other-${n}` },
        config: { mode: `mode-${n}`, depth: 1 },
        commit_goal_id: `goal-${n}`,
      }),
    );
    getDatabase()
      .prepare("UPDATE projects SET updated_at = ?, created_at = ?")
      .run(OLD, OLD);
    // Code-unit order, as the database compares TEXT keys (BINARY collation).
    return made
      .map((p) => ({ id: p.id, slug: p.slug }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  it("writes every given column of the middle row only, stamping updated_at", () => {
    const [low, mid, high] = three();
    const before = { low: rawProject(low.id), high: rawProject(high.id) };

    const out = updateProject(mid.slug, {
      name: "Renamed",
      description: "new description",
      status: "archived",
      urls: { site: null, extra: "https://extra.example.invalid" },
      credentials: { login: "syn-login-new" },
      config: { mode: null, depth: 2 },
      commit_goal_id: "goal-new",
    });

    const midName = out!.slug.replace("slug-", "");
    expect(rawProject(mid.id)).toEqual({
      id: mid.id,
      slug: mid.slug,
      name: "Renamed",
      description: "new description",
      status: "archived",
      urls: JSON.stringify({ keep: `keep-${midName}`, extra: "https://extra.example.invalid" }),
      credentials: JSON.stringify({ login: "syn-login-new", other: `syn-other-${midName}` }),
      config: JSON.stringify({ depth: 2 }),
      commit_goal_id: "goal-new",
      created_at: OLD,
      updated_at: expect.stringMatching(STAMP_RE),
    });
    expect(rawProject(mid.id).updated_at).not.toBe(OLD);
    expect(rawProject(low.id)).toEqual(before.low);
    expect(rawProject(high.id)).toEqual(before.high);
    expect(
      getDatabase()
        .prepare("SELECT project_id, action, details FROM project_log WHERE action = 'updated'")
        .all(),
    ).toEqual([
      {
        project_id: mid.id,
        action: "updated",
        details: "Fields: name, description, status, urls, credentials, config, commit_goal_id",
      },
    ]);
  });

  it("an update naming one field leaves every other column as it was; an empty goal id clears it", () => {
    const [low, mid, high] = three();
    const before = { low: rawProject(low.id), mid: rawProject(mid.id), high: rawProject(high.id) };

    updateProject(mid.id, { description: "only this" });
    expect(rawProject(mid.id)).toEqual({
      ...before.mid,
      description: "only this",
      updated_at: expect.stringMatching(STAMP_RE),
    });
    expect(rawProject(mid.id).updated_at).not.toBe(OLD);

    updateProject(mid.id, { commit_goal_id: "" });
    expect(rawProject(mid.id).commit_goal_id).toBeNull();
    expect(rawProject(mid.id).description).toBe("only this");
    expect(rawProject(low.id)).toEqual(before.low);
    expect(rawProject(high.id)).toEqual(before.high);
  });
});

describe("project log on the real schema", () => {
  it("logProjectAction stores project, action and details in their own columns; omitted details are NULL", () => {
    seedProject("p-log", "logslug", "Log Name", "active", "2026-01-01 10:00:00");
    logProjectAction("p-log", "act-given", "details-given");
    logProjectAction("p-log", "act-bare");
    expect(
      getDatabase()
        .prepare("SELECT project_id, action, details FROM project_log ORDER BY id")
        .all(),
    ).toEqual([
      { project_id: "p-log", action: "act-given", details: "details-given" },
      { project_id: "p-log", action: "act-bare", details: null },
    ]);
  });

  it("getProjectLog reads one project's entries newest first, up to the limit (10 when omitted)", () => {
    seedProject("p-a", "slug-a", "Name A", "active", "2026-01-01 10:00:00");
    seedProject("p-b", "slug-b", "Name B", "active", "2026-01-01 10:00:00");
    seedProject("p-c", "slug-c", "Name C", "active", "2026-01-01 10:00:00");
    const log = getDatabase().prepare(
      "INSERT INTO project_log (project_id, action, details, created_at) VALUES (?, ?, ?, ?)",
    );
    // Inserted out of time order, so id order is not created_at order.
    for (const m of [5, 0, 9, 2, 7, 10, 1, 8, 3, 6, 4]) {
      const mm = String(m).padStart(2, "0");
      log.run("p-b", `b-${mm}`, `d-${mm}`, `2026-01-01 10:${mm}:00`);
    }
    // Neighbours on both sides of the key, newer than every p-b entry.
    log.run("p-a", "a-new", null, "2026-01-01 10:30:00");
    log.run("p-c", "c-new", null, "2026-01-01 10:31:00");

    const actions = (rows: Array<{ action: string }>) => rows.map((r) => r.action);
    expect(actions(getProjectLog("p-b"))).toEqual([
      "b-10", "b-09", "b-08", "b-07", "b-06", "b-05", "b-04", "b-03", "b-02", "b-01",
    ]);
    expect(getProjectLog("p-b", 3)).toEqual([
      { id: expect.any(Number), project_id: "p-b", action: "b-10", details: "d-10", created_at: "2026-01-01 10:10:00" },
      { id: expect.any(Number), project_id: "p-b", action: "b-09", details: "d-09", created_at: "2026-01-01 10:09:00" },
      { id: expect.any(Number), project_id: "p-b", action: "b-08", details: "d-08", created_at: "2026-01-01 10:08:00" },
    ]);
    expect(actions(getProjectLog("p-a"))).toEqual(["a-new"]);
    expect(getProjectLog("p-0")).toEqual([]);
  });
});

describe("migrateUserFactsToProjects on the real schema", () => {
  it("builds projects from the `projects` category only; neighbouring categories are not read", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fact = getDatabase().prepare(
      "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
    );
    fact.run("project", "zeta_login", "syn-zeta-login");
    fact.run("projects", "acme_ftp_host", "ftp.acme.example.invalid");
    fact.run("personal", "beta_site_url", "https://beta.example.invalid");
    fact.run("projects", "acme_login", "syn-acme-login");
    fact.run("projectsx", "omega_login", "syn-omega-login");
    fact.run("projects", "gemini_model", "syn-model-name");
    fact.run("projects", "loose", "syn-loose-value");

    migrateUserFactsToProjects();

    const got = listProjects().map((p) => ({
      slug: p.slug,
      name: p.name,
      description: p.description,
      urls: p.urls,
      credentials: p.credentials,
    }));
    expect(got).toEqual([
      {
        slug: "acme",
        name: "Acme",
        description: "Auto-migrated from user_facts",
        urls: { ftp_host: "ftp.acme.example.invalid" },
        credentials: { login: "syn-acme-login" },
      },
      {
        slug: "general-credentials",
        name: "General Credentials",
        description: "Auto-migrated from user_facts",
        urls: {},
        credentials: { gemini_model: "syn-model-name", loose: "syn-loose-value" },
      },
    ]);
  });
});
