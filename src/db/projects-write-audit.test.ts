/**
 * Schema migration v15 — project_write_audit + trg_projects_after_update_audit
 * (docs/planning/next-sessions-queue.md item 4by).
 *
 * A projects.credentials value was rewritten by a writer that never went
 * through updateProject. The trigger records, for EVERY UPDATE on projects,
 * which columns changed (flags only, never values). These tests run the REAL
 * initDatabase: a raw UPDATE that bypasses updateProject is attributable
 * (credentials_changed = 1, updated_at_changed = 0), updateProject's own write
 * stamps updated_at_changed = 1, no audit row carries column content, and the
 * migration re-runs cleanly.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { createProject, updateProject } from "./projects.js";

let tmpDbPath: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tmpDbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(tmpDbPath + suffix)) unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
    tmpDbPath = null;
  }
});

type AuditRow = Record<string, string | number>;

const auditRows = (db: Database.Database, projectId: string): AuditRow[] =>
  db
    .prepare("SELECT * FROM project_write_audit WHERE project_id = ? ORDER BY id")
    .all(projectId) as AuditRow[];

const FAKE_SECRET = "fake-key-1-zzqv";

describe("migration v15 — project_write_audit trigger", () => {
  it("fresh DB: head is v16 with the audit table and the trigger", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    const trg = db
      .prepare(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_projects_after_update_audit'",
      )
      .get() as { tbl_name: string } | undefined;
    expect(trg?.tbl_name).toBe("projects");
    const cols = (
      db.prepare("PRAGMA table_info(project_write_audit)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "project_id",
        "written_at",
        "credentials_changed",
        "updated_at_changed",
        "name_changed",
        "status_changed",
      ]),
    );
    // Flags only: no column that could carry a value.
    expect(cols.filter((c) => c !== "id" && c !== "project_id" && c !== "written_at")).toEqual(
      cols.filter((c) => c.endsWith("_changed")),
    );
  });

  it("a raw UPDATE of credentials (bypassing updateProject) writes exactly one row: credentials_changed=1, updated_at_changed=0", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    const p = createProject("audit-raw", "Audit Raw");
    expect(auditRows(db, p.id)).toHaveLength(0); // INSERT does not fire it

    db.prepare("UPDATE projects SET credentials = ? WHERE id = ?").run(
      JSON.stringify({ api_key: FAKE_SECRET }),
      p.id,
    );

    const rows = auditRows(db, p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: p.id,
      credentials_changed: 1,
      updated_at_changed: 0,
      name_changed: 0,
      status_changed: 0,
      urls_changed: 0,
      config_changed: 0,
    });
    expect(String(rows[0].written_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The trigger never touches the projects row itself.
    const after = db.prepare("SELECT updated_at FROM projects WHERE id = ?").get(p.id) as {
      updated_at: string;
    };
    expect(after.updated_at).toBe(p.updated_at);
  });

  it("updateProject writes a row with updated_at_changed=1", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    const p = createProject("audit-api", "Audit Api");
    // Age updated_at so updateProject's datetime('now') stamp is a change even
    // inside the same second as createProject.
    db.prepare("UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(p.id);
    expect(auditRows(db, p.id)).toHaveLength(1);

    updateProject(p.id, { credentials: { api_key: FAKE_SECRET }, status: "paused" });

    const rows = auditRows(db, p.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      credentials_changed: 1,
      updated_at_changed: 1,
      status_changed: 1,
      name_changed: 0,
    });
  });

  const FLAG_CASES: Array<[column: string, value: string]> = [
    ["id", "fake-id-2"],
    ["slug", "fake-slug-2"],
    ["name", "fake name 2"],
    ["description", "fake description 2"],
    ["status", "archived"],
    ["urls", '{"site":"https://example.invalid"}'],
    ["credentials", '{"placeholder":"fake-value-2"}'],
    ["config", '{"fake_setting":2}'],
    ["commit_goal_id", "fake-goal-2"],
    ["created_at", "2020-01-01 00:00:00"],
    ["updated_at", "2020-01-01 00:00:00"],
  ];

  it.each(FLAG_CASES)(
    "a raw UPDATE of only %s sets exactly that flag",
    (column, value) => {
      initDatabase(":memory:");
      const db = getDatabase();
      const p = createProject(`flag-${column.replace(/_/g, "-")}`, "Flag Case");
      // project_log's FK on projects(id) would block the id case.
      db.prepare("DELETE FROM project_log WHERE project_id = ?").run(p.id);
      db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(value, p.id);

      const rows = auditRows(db, p.id);
      expect(rows).toHaveLength(1);
      const flags = Object.fromEntries(
        Object.entries(rows[0]).filter(([k]) => k.endsWith("_changed")),
      );
      expect(Object.keys(flags).sort()).toEqual(
        FLAG_CASES.map(([c]) => `${c}_changed`).sort(),
      );
      expect(flags).toEqual(
        Object.fromEntries(
          FLAG_CASES.map(([c]) => [`${c}_changed`, c === column ? 1 : 0]),
        ),
      );
    },
  );

  it("no audit row carries any part of the credential value", () => {
    initDatabase(":memory:");
    const db = getDatabase();
    const p = createProject("audit-leak", "Audit Leak", {
      credentials: { api_key: "fake-key-0-old" },
    });
    db.prepare("UPDATE projects SET credentials = ? WHERE id = ?").run(
      JSON.stringify({ api_key: FAKE_SECRET }),
      p.id,
    );
    updateProject(p.id, { credentials: { other: "fake-key-2-new" } });

    const dump = JSON.stringify(
      db.prepare("SELECT * FROM project_write_audit").all(),
    );
    for (const needle of [FAKE_SECRET, "fake-key", "zzqv", "api_key", "other"]) {
      expect(dump).not.toContain(needle);
    }
  });

  it("is idempotent: a DB pinned back below v15 (twice) re-runs it without error, keeps rows, one trigger", () => {
    tmpDbPath = join(tmpdir(), `mc-proj-audit-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    const p = createProject("audit-idem", "Audit Idem");
    getDatabase().prepare("UPDATE projects SET name = 'x' WHERE id = ?").run(p.id);
    closeDatabase();

    for (let i = 0; i < 2; i++) {
      const pin = new Database(tmpDbPath);
      pin.exec("PRAGMA user_version = 14;");
      pin.close();
      expect(() => initDatabase(tmpDbPath!)).not.toThrow();
      const db = getDatabase();
      expect(db.pragma("user_version", { simple: true })).toBe(16);
      expect(auditRows(db, p.id)).toHaveLength(1);
      const n = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_projects_after_update_audit'",
        )
        .get() as { n: number };
      expect(n.n).toBe(1);
      closeDatabase();
    }
  });

  it("existing v14 DB without the table: v15 creates table + trigger and the next write is audited", () => {
    tmpDbPath = join(tmpdir(), `mc-proj-audit-v14-${process.pid}-${Date.now()}.db`);
    initDatabase(tmpDbPath);
    const p = createProject("audit-v14", "Audit V14");
    closeDatabase();
    const raw = new Database(tmpDbPath);
    raw.exec(`
      DROP TRIGGER trg_projects_after_update_audit;
      DROP TABLE project_write_audit;
      PRAGMA user_version = 14;
    `);
    raw.close();

    initDatabase(tmpDbPath);
    const db = getDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    db.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(p.id);
    expect(auditRows(db, p.id)).toEqual([
      expect.objectContaining({ status_changed: 1, credentials_changed: 0, updated_at_changed: 0 }),
    ]);
  });
});
