/**
 * S6 WS1 — projector: record → `projects` row (spec §2). Real in-memory db +
 * a scratch KB mirror (the jarvis-reindex tests' pattern). Synthetic only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import { createProject, getProject, getProjectLog } from "../db/projects.js";
import { upsertFile } from "../db/jarvis-fs.js";
import { reindexJarvisKb, upsertFromDiskWrite } from "../db/jarvis-reindex.js";
import {
  PROJECTOR_CONFIG_KEYS,
  applyProjectRecord,
  contractToRowPatch,
  projectAllRecords,
} from "./projector.js";
import { parseProjectRecord, projectRecordRelPath } from "./record.js";
import { ensureScheduledTasksTable } from "../rituals/dynamic.js";

let kbDir: string;

beforeEach(() => {
  kbDir = mkdtempSync(join(tmpdir(), "mc-projector-test-"));
  process.env.JARVIS_KB_MIRROR_DIR = kbDir;
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  rmSync(kbDir, { recursive: true, force: true });
  delete process.env.JARVIS_KB_MIRROR_DIR;
  vi.restoreAllMocks();
});

const block = (json: unknown) => "```json\n" + JSON.stringify(json, null, 2) + "\n```\n";
const record = (json: Record<string, unknown>, lead = "Synthetic lead paragraph.") =>
  block(json) + `\n${lead}\n\n## Runtime\n\nnotes\n`;

const BASE = {
  slug: "acme-radar",
  name: "Acme Radar",
  status: "active",
  aliases: ["acme"],
  schedules: ["sched-0001"],
  repos: [{ path: "/srv/work/acme-radar", role: "primary" }],
  links: { site: "https://acme.example.test" },
};

describe("contractToRowPatch — ownership", () => {
  it("writes name/description/status/urls.site and only owned config keys present in the contract", () => {
    const { contract } = parseProjectRecord(
      record({ ...BASE, trusted: true, egress: ["x.example.test"], secrets: ["SECRET_A"] }),
      { folderSlug: "acme-radar" },
    );
    const patch = contractToRowPatch(contract, "desc");
    expect(patch.name).toBe("Acme Radar");
    expect(patch.description).toBe("desc");
    expect(patch.status).toBe("active");
    expect(patch.urls).toEqual({ site: "https://acme.example.test" });
    // S6 WS3: trusted/egress/secrets are owned (projected) since WS3.
    expect(Object.keys(patch.config).sort()).toEqual(
      ["aliases", "egress", "kb_folder", "kb_readme", "links", "match_priority", "repos", "schedules", "secrets", "trusted"].sort(),
    );
    for (const k of Object.keys(patch.config)) {
      expect((PROJECTOR_CONFIG_KEYS as readonly string[]).includes(k), k).toBe(true);
    }
    // never the DB-owned columns
    const flat = JSON.stringify(patch);
    for (const k of ["credentials", "commit_goal_id", "\"id\""]) {
      expect(flat, k).not.toContain(k);
    }
  });

  it("S6 WS3: projects the 7 capability keys; trusted=false (the default) stays off the row", () => {
    const full = {
      ...BASE,
      trusted: true,
      egress: ["api.acme.example.test:443"],
      deny_paths: ["/srv/work/acme-radar/private"],
      secrets: ["SECRET_ACME_RADAR_API_TOKEN"],
      capabilities: {
        mcp: [{ command: "node", args: ["dist/mcp.js"], env: ["ACME_RADAR_API_TOKEN"], trust: "AB" }],
        brief: "Acme radar runs",
      },
      routing: { summary: "Acme radar: widget sightings and weekly runs" },
      inbound: { route: "/api/acme-pull", token_secret: "ACME_INBOUND_TOKEN" },
    };
    const { contract } = parseProjectRecord(record(full), { folderSlug: "acme-radar" });
    const patch = contractToRowPatch(contract, "d");
    for (const k of ["capabilities", "secrets", "trusted", "routing", "egress", "deny_paths", "inbound"]) {
      expect(patch.config[k], k).toEqual((full as Record<string, unknown>)[k]);
    }
    const { contract: plain } = parseProjectRecord(record({ ...BASE, trusted: false }), {
      folderSlug: "acme-radar",
    });
    expect("trusted" in contractToRowPatch(plain, "d").config).toBe(false);
  });

  it("no links.site → no urls in the patch", () => {
    const { contract } = parseProjectRecord(block({ slug: "b1", name: "B", status: "active" }), {
      folderSlug: "b1",
    });
    expect(contractToRowPatch(contract, "").urls).toBeUndefined();
  });
});

describe("applyProjectRecord — create / update / skip / error", () => {
  const rel = projectRecordRelPath("acme-radar");

  it("creates the row from a record", () => {
    const r = applyProjectRecord(rel, record(BASE));
    expect(r).toEqual({ slug: "acme-radar", action: "created", schedulesClaimed: 0, schedulesConflict: 0 });
    const p = getProject("acme-radar")!;
    expect(p.name).toBe("Acme Radar");
    expect(p.description).toBe("Synthetic lead paragraph.");
    expect(p.urls).toEqual({ site: "https://acme.example.test" });
    expect(p.config.schedules).toEqual(["sched-0001"]);
    expect(p.credentials).toEqual({});
    expect(p.commit_goal_id).toBeNull();
  });

  it("updates an existing row by merge: keeps credentials, commit_goal_id and foreign config/urls keys", () => {
    const pw = "pw-" + "k".repeat(14);
    createProject("acme-radar", "Old Name", {
      description: "old",
      status: "paused",
      urls: { site: "https://old.example.test", admin: "https://old.example.test/a" },
      credentials: { app_password: pw },
      config: { audience: "synthetic", phase: 2, aliases: ["old"] },
      commit_goal_id: "goal-xyz",
    });
    const id = getProject("acme-radar")!.id;
    const r = applyProjectRecord(rel, record(BASE));
    expect(r).toEqual({ slug: "acme-radar", action: "updated", schedulesClaimed: 0, schedulesConflict: 0 });
    const p = getProject("acme-radar")!;
    expect(p.id).toBe(id);
    expect(p.name).toBe("Acme Radar");
    expect(p.status).toBe("active");
    expect(p.credentials).toEqual({ app_password: pw });
    expect(p.commit_goal_id).toBe("goal-xyz");
    expect(p.urls).toEqual({ site: "https://acme.example.test", admin: "https://old.example.test/a" });
    expect(p.config.audience).toBe("synthetic");
    expect(p.config.phase).toBe(2);
    expect(p.config.aliases).toEqual(["acme"]);
  });

  it("an owned key the record drops is removed from the row; a foreign key is not", () => {
    applyProjectRecord(rel, record(BASE));
    getDatabase()
      .prepare("UPDATE projects SET config = json_set(config, '$.audience', 'kept') WHERE slug = ?")
      .run("acme-radar");
    const { aliases: _a, links: _l, ...rest } = BASE;
    expect(applyProjectRecord(rel, record(rest)).action).toBe("updated");
    const p = getProject("acme-radar")!;
    expect(p.config.aliases).toBeUndefined();
    expect(p.config.links).toBeUndefined();
    expect(p.urls.site).toBeUndefined();
    expect(p.config.audience).toBe("kept");
  });

  it("an unchanged record is skipped: no write, no project_log line", () => {
    applyProjectRecord(rel, record(BASE));
    const p0 = getProject("acme-radar")!;
    const logs0 = getProjectLog(p0.id, 50).length;
    expect(applyProjectRecord(rel, record(BASE))).toEqual({ slug: "acme-radar", action: "skipped", schedulesClaimed: 0, schedulesConflict: 0 });
    expect(getProjectLog(p0.id, 50).length).toBe(logs0);
    expect(getProject("acme-radar")!.updated_at).toBe(p0.updated_at);
  });

  it("a parse error is returned (never thrown), logged once with the reason and no content, row untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createProject("acme-radar", "Kept", { description: "kept" });
    const marker = "unique-" + "m".repeat(10);
    const r = applyProjectRecord(rel, block({ ...BASE, slug: "someone-else", name: marker }));
    expect(r.action).toBe("skipped");
    expect(r.error?.reason).toBe("slug_mismatch");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("slug_mismatch");
    expect(String(warn.mock.calls[0]![0])).not.toContain(marker);
    expect(getProject("acme-radar")!.name).toBe("Kept");
    for (const [content, reason] of [
      ["no block", "no_json_block"],
      ["```json\n{nope\n```\n", "invalid_json"],
      [block({ slug: "acme-radar", name: "N", status: "x" }), "schema"],
    ] as const) {
      expect(applyProjectRecord(rel, content).error?.reason).toBe(reason);
    }
  });

  it("a non-record path is refused without touching the db", () => {
    expect(applyProjectRecord("projects/acme-radar/README.md", record(BASE)).error?.reason).toBe(
      "not_a_record_path",
    );
    expect(getProject("acme-radar")).toBeNull();
  });
});

describe("S6 ruling 5a — a dangling parent warns, never blocks", () => {
  const kid = { slug: "kid-lite", name: "Kid Lite", status: "active", parent: "big-parent" };
  const rel = projectRecordRelPath("kid-lite");

  it("a parent with no row: the record is applied (row created, parent projected) and warned ONCE with ids only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = applyProjectRecord(rel, record(kid));
    expect(r.error).toBeUndefined();
    expect(r.action).toBe("created");
    expect(getProject("kid-lite")!.config.parent).toBe("big-parent");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toBe("[projector] kid-lite: parent big-parent has no projects row (applied anyway)");
    // every apply warns once (an unchanged record is skipped, still warned)
    expect(applyProjectRecord(rel, record(kid)).action).toBe("skipped");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("a parent whose row exists: no warning; no parent: no warning", () => {
    createProject("big-parent", "Big Parent");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(applyProjectRecord(rel, record(kid)).action).toBe("created");
    expect(applyProjectRecord(projectRecordRelPath("acme-radar"), record(BASE)).action).toBe("created");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("S6 WS2 — scheduled_tasks.project_slug follows the record's schedules", () => {
  const rel = projectRecordRelPath("acme-radar");
  const relB = projectRecordRelPath("beta-two");
  const owner = (id: string) =>
    (
      getDatabase()
        .prepare("SELECT project_slug FROM scheduled_tasks WHERE schedule_id = ?")
        .get(id) as { project_slug: string | null }
    ).project_slug;

  beforeEach(() => {
    ensureScheduledTasksTable();
    const ins = getDatabase().prepare(
      "INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr) VALUES (?, 'n', 'd', '0 9 * * 1')",
    );
    for (const id of ["sched-0001", "sched-0002", "sched-0003"]) ins.run(id);
  });

  it("claims every listed schedule that exists; an id with no row is ignored", () => {
    const r = applyProjectRecord(rel, record({ ...BASE, schedules: ["sched-0001", "sched-0002", "sched-gone"] }));
    expect(r).toMatchObject({ action: "created", schedulesClaimed: 2, schedulesConflict: 0 });
    expect([owner("sched-0001"), owner("sched-0002"), owner("sched-0003")]).toEqual([
      "acme-radar",
      "acme-radar",
      null,
    ]);
  });

  it("an unchanged (skipped) record still claims: a schedule created after the record is picked up", () => {
    applyProjectRecord(rel, record({ ...BASE, schedules: ["sched-0001", "sched-late"] }));
    getDatabase()
      .prepare("INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr) VALUES ('sched-late','n','d','0 9 * * 1')")
      .run();
    const r = applyProjectRecord(rel, record({ ...BASE, schedules: ["sched-0001", "sched-late"] }));
    expect(r).toMatchObject({ action: "skipped", schedulesClaimed: 2, schedulesConflict: 0 });
    expect(owner("sched-late")).toBe("acme-radar");
  });

  it("releases (NULL) a schedule the record no longer lists; an emptied list releases all", () => {
    applyProjectRecord(rel, record({ ...BASE, schedules: ["sched-0001", "sched-0002"] }));
    const r = applyProjectRecord(rel, record({ ...BASE, schedules: ["sched-0002"] }));
    expect(r).toMatchObject({ action: "updated", schedulesClaimed: 1, schedulesConflict: 0 });
    expect([owner("sched-0001"), owner("sched-0002")]).toEqual([null, "acme-radar"]);
    // `undefined` drops the key from the JSON block.
    expect(applyProjectRecord(rel, record({ ...BASE, schedules: undefined }))).toMatchObject({ schedulesClaimed: 0, schedulesConflict: 0 });
    expect(owner("sched-0002")).toBeNull();
  });

  it("a schedule claimed by two records: the second apply does not steal it; counted and logged once with ids only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyProjectRecord(rel, record({ ...BASE, schedules: ["sched-0001"] }));
    const r = applyProjectRecord(
      relB,
      block({ slug: "beta-two", name: "B", status: "active", schedules: ["sched-0001", "sched-0003"] }),
    );
    expect(r).toMatchObject({ action: "created", schedulesClaimed: 1, schedulesConflict: 1 });
    expect([owner("sched-0001"), owner("sched-0003")]).toEqual(["acme-radar", "beta-two"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toBe(
      "[projector] beta-two: schedule(s) already claimed by another record, left as is: sched-0001",
    );
    // The loser releasing its list never touches the winner's claim.
    applyProjectRecord(relB, block({ slug: "beta-two", name: "B", status: "active" }));
    expect([owner("sched-0001"), owner("sched-0003")]).toEqual(["acme-radar", null]);
  });

  it("a parse error claims nothing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyProjectRecord(rel, "no json here");
    expect(owner("sched-0001")).toBeNull();
  });
});

describe("hook points — every registry path projects the content it is handed", () => {
  const rel = projectRecordRelPath("acme-radar");

  function writeDisk(relPath: string, content: string, mtimeOffsetS = 0): void {
    const full = join(kbDir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
    if (mtimeOffsetS) {
      const t = Date.now() / 1000 + mtimeOffsetS;
      utimesSync(full, t, t);
    }
  }

  it("upsertFromDiskWrite: registry row + projection, result returned", () => {
    const r = upsertFromDiskWrite(rel, record(BASE));
    expect(r).toEqual({ slug: "acme-radar", action: "created", schedulesClaimed: 0, schedulesConflict: 0 });
    expect(getProject("acme-radar")!.name).toBe("Acme Radar");
    expect(upsertFromDiskWrite("knowledge/x.md", "# x")).toBeUndefined();
  });

  it("hourly walk IMPORT of a disk-only record projects it", () => {
    writeDisk(rel, record(BASE));
    const r = reindexJarvisKb({ kbRoot: kbDir });
    expect(r.upserted).toBeGreaterThanOrEqual(1);
    expect(getProject("acme-radar")!.config.schedules).toEqual(["sched-0001"]);
  });

  it("hourly walk REFRESH of a hand-edited record projects the new content", () => {
    upsertFromDiskWrite(rel, record(BASE));
    // the registry row is older than the disk edit
    getDatabase()
      .prepare("UPDATE jarvis_files SET updated_at = datetime('now', '-1 hour') WHERE path = ?")
      .run(rel);
    writeDisk(rel, record({ ...BASE, status: "paused" }), 5);
    const r = reindexJarvisKb({ kbRoot: kbDir });
    expect(r.refreshed).toBe(1);
    expect(getProject("acme-radar")!.status).toBe("paused");
  });

  it("projects/ is not a managed namespace (records are imported and refreshed)", async () => {
    const { MANAGED_NAMESPACES } = await import("../db/jarvis-reindex.js");
    expect(MANAGED_NAMESPACES.some((ns) => "projects/".startsWith(ns))).toBe(false);
  });

  it("boot pass projectAllRecords: projects every registered record, counts disk-only ones", () => {
    upsertFile(rel, "Acme", record(BASE));
    upsertFile(projectRecordRelPath("beta-two"), "B", block({ slug: "beta-two", name: "B", status: "active" }));
    upsertFile(projectRecordRelPath("bad-one"), "Bad", "no json here");
    upsertFile("projects/acme-radar/README.md", "readme", "# not a record");
    writeDisk(projectRecordRelPath("disk-only"), block({ slug: "disk-only", name: "D", status: "active" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = projectAllRecords(kbDir);
    expect(r).toEqual({ created: 2, updated: 0, skipped: 0, errors: 1, unregistered: 1 });
    expect(getProject("acme-radar")).not.toBeNull();
    expect(getProject("beta-two")).not.toBeNull();
    expect(getProject("disk-only")).toBeNull(); // the hourly walk imports it first
    expect(projectAllRecords(kbDir)).toEqual({ created: 0, updated: 0, skipped: 2, errors: 1, unregistered: 1 });
  });

  it("src/index.ts runs projectAllRecords at boot, after the user_facts → projects migration", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
    const migrate = src.indexOf("migrateUserFactsToProjects();");
    const project = src.indexOf("projectAllRecords(getJarvisKbRoot())");
    expect(migrate).toBeGreaterThan(0);
    expect(project).toBeGreaterThan(migrate);
  });
});
