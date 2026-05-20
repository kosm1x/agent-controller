import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  COHORT_MAX,
  getCohort,
  getCohortMember,
  getOperatorProfile,
  rollUpCohort,
} from "./self-defining.js";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

/** Insert a project; returns its id. */
function seedProject(id: string, name: string, status = "active"): string {
  getDatabase()
    .prepare(
      "INSERT INTO projects (id, slug, name, status) VALUES (?, ?, ?, ?)",
    )
    .run(id, `slug-${id}`, name, status);
  return id;
}

/** Add `n` project_log rows for a project, all within the activity window. */
function seedActivity(projectId: string, n: number): void {
  const stmt = getDatabase().prepare(
    "INSERT INTO project_log (project_id, action, created_at) VALUES (?, 'edit', datetime('now'))",
  );
  for (let i = 0; i < n; i++) stmt.run(projectId);
}

/** Insert a NorthStar objective into jarvis_files. */
function seedObjective(
  path: string,
  title: string,
  priority: number,
  ageDays = 0,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO jarvis_files (id, path, title, content, priority, updated_at)
       VALUES (?, ?, ?, '', ?, datetime('now', ?))`,
    )
    .run(`f-${path}`, path, title, priority, `-${ageDays} days`);
}

describe("rollUpCohort — scoring", () => {
  it("derives a cohort from projects and objectives", () => {
    seedProject("p-1", "Alpha project");
    seedActivity("p-1", 3);
    seedObjective("NorthStar/obj-a.md", "Objective A", 80);

    const result = rollUpCohort();
    expect(result.candidates).toBe(2);
    expect(result.cohort_size).toBe(2);
    expect(result.by_kind).toEqual({ project: 1, objective: 1 });

    const cohort = getCohort();
    expect(cohort).toHaveLength(2);
    expect(cohort.every((m) => m.active)).toBe(true);
  });

  it("ranks a busy project above an idle one", () => {
    seedProject("p-busy", "Busy");
    seedActivity("p-busy", 8);
    seedProject("p-idle", "Idle"); // no activity

    rollUpCohort();
    const cohort = getCohort({ kind: "project" });
    expect(cohort[0].member_id).toBe("project:p-busy");
    expect(cohort[0].salience).toBeGreaterThan(cohort[1].salience);
    expect(cohort[0].signals.log_count_30d).toBe(8);
  });

  it("scores objectives by priority and recency", () => {
    seedObjective("NorthStar/fresh-hi.md", "Fresh high-priority", 100, 0);
    seedObjective("NorthStar/stale-lo.md", "Stale low-priority", 10, 120);

    rollUpCohort();
    const cohort = getCohort({ kind: "objective" });
    expect(cohort[0].member_id).toBe("objective:NorthStar/fresh-hi.md");
    expect(cohort[0].salience).toBeGreaterThan(cohort[1].salience);
  });

  it("excludes archived and completed projects from candidates", () => {
    seedProject("p-live", "Live", "active");
    seedProject("p-arch", "Archived", "archived");
    seedProject("p-done", "Completed", "completed");

    const result = rollUpCohort();
    expect(result.candidates).toBe(1);
    expect(getCohort().map((m) => m.member_id)).toEqual(["project:p-live"]);
  });

  it("caps the active cohort at COHORT_MAX", () => {
    for (let i = 0; i < COHORT_MAX + 7; i++) {
      seedObjective(`NorthStar/obj-${i}.md`, `Objective ${i}`, 50 + (i % 40));
    }
    const result = rollUpCohort();
    expect(result.candidates).toBe(COHORT_MAX + 7);
    expect(result.cohort_size).toBe(COHORT_MAX);
    expect(result.inactive).toBe(7);
    expect(getCohort()).toHaveLength(COHORT_MAX);
    expect(getCohort({ includeInactive: true })).toHaveLength(COHORT_MAX + 7);
  });
});

describe("rollUpCohort — re-run behaviour", () => {
  it("preserves first_seen_at across runs (idempotent upsert)", () => {
    seedProject("p-1", "Alpha");
    seedActivity("p-1", 2);
    rollUpCohort();
    const firstSeen = getCohortMember("project:p-1")!.first_seen_at;

    seedActivity("p-1", 3); // salience changes
    rollUpCohort();
    const member = getCohortMember("project:p-1")!;
    expect(member.first_seen_at).toBe(firstSeen);
    expect(member.signals.log_count_30d).toBe(5);
  });

  it("deactivates a member that drops out of the candidate set", () => {
    const db = getDatabase();
    seedProject("p-keep", "Keep");
    seedProject("p-drop", "Drop");
    rollUpCohort();
    expect(getCohort()).toHaveLength(2);

    // p-drop is archived → no longer a candidate next run.
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(
      "p-drop",
    );
    rollUpCohort();
    expect(getCohort()).toHaveLength(1);
    expect(getCohortMember("project:p-drop")!.active).toBe(false);
  });
});

describe("operator_profile skeleton (Q3 carve-out)", () => {
  it("the roll-up writes factual attributes for every candidate", () => {
    seedProject("p-1", "Alpha");
    seedActivity("p-1", 4);
    rollUpCohort();

    const profile = getOperatorProfile("project:p-1");
    const keys = profile.map((a) => a.attribute_key).sort();
    expect(keys).toEqual(["member_kind", "salience", "source_ref"]);
    expect(profile.every((a) => a.written_by === "cohort-rollup")).toBe(true);
    expect(
      profile.find((a) => a.attribute_key === "member_kind")!.attribute_value,
    ).toBe("project");
  });

  it("re-running the roll-up updates attribute values in place", () => {
    // Two projects so salience normalization is meaningful (a lone project
    // is always the busiest → always normalized to 1.0).
    seedProject("p-1", "Alpha");
    seedActivity("p-1", 1);
    seedProject("p-2", "Beta");
    seedActivity("p-2", 5);
    rollUpCohort();
    const before = getOperatorProfile("project:p-1").find(
      (a) => a.attribute_key === "salience",
    )!.attribute_value;

    seedActivity("p-1", 9); // p-1 now busiest (10 vs 5)
    rollUpCohort();
    const after = getOperatorProfile("project:p-1").find(
      (a) => a.attribute_key === "salience",
    )!.attribute_value;
    expect(after).not.toBe(before);
    // Still exactly 3 attributes — upsert, not append.
    expect(getOperatorProfile("project:p-1")).toHaveLength(3);
  });

  it("deletes a dropped-out member's attributes on the next roll-up (R1-W2)", () => {
    const db = getDatabase();
    seedProject("p-1", "Alpha");
    seedActivity("p-1", 2);
    rollUpCohort();
    expect(getOperatorProfile("project:p-1")).toHaveLength(3);

    // p-1 archived → no longer a candidate.
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(
      "p-1",
    );
    rollUpCohort();
    expect(getOperatorProfile("project:p-1")).toHaveLength(0);
    // The cohort row itself is kept (active=0), still addressable.
    expect(getCohortMember("project:p-1")!.active).toBe(false);
  });

  it("the written_by CHECK rejects any writer other than cohort-rollup", () => {
    // Q3 anti-mission compliance: operator_profile is structurally write-
    // restricted — V8.2 inference / any other path cannot populate it.
    const db = getDatabase();
    expect(() =>
      db
        .prepare(
          `INSERT INTO operator_profile
             (cohort_member_id, attribute_key, attribute_value, written_by)
           VALUES ('project:p-1', 'preference', 'likes-X', 'v8.2-inference')`,
        )
        .run(),
    ).toThrow();
  });
});

describe("rollUpCohort — edge cases (R1-R3)", () => {
  it("handles an empty candidate set and deactivates prior members", () => {
    seedProject("p-1", "Alpha");
    seedActivity("p-1", 2);
    rollUpCohort();
    expect(getCohort()).toHaveLength(1);

    // All projects archived → zero candidates next run.
    getDatabase().prepare("UPDATE projects SET status = 'archived'").run();
    const result = rollUpCohort();
    expect(result.candidates).toBe(0);
    expect(result.cohort_size).toBe(0);
    expect(getCohort()).toHaveLength(0);
    expect(getCohort({ includeInactive: true })).toHaveLength(1);
    expect(getOperatorProfile("project:p-1")).toHaveLength(0);
  });

  it("clamps recency for an objective with a future updated_at", () => {
    seedObjective("NorthStar/future.md", "Future-dated", 60, -10);
    rollUpCohort();
    const member = getCohortMember("objective:NorthStar/future.md")!;
    expect(member.salience).toBeGreaterThanOrEqual(0);
    expect(member.salience).toBeLessThanOrEqual(1);
  });

  it("treats a malformed updated_at as zero recency (priority-only score)", () => {
    getDatabase()
      .prepare(
        `INSERT INTO jarvis_files (id, path, title, content, priority, updated_at)
         VALUES ('f-bad', 'NorthStar/bad-date.md', 'Bad date', '', 80, 'not-a-date')`,
      )
      .run();
    rollUpCohort();
    const member = getCohortMember("objective:NorthStar/bad-date.md")!;
    // recency 0 → salience = 0.5 * (80/100) = 0.40
    expect(member.salience).toBeCloseTo(0.4, 5);
  });
});

describe("getCohort / getCohortMember", () => {
  it("filters by kind and excludes inactive by default", () => {
    seedProject("p-1", "Alpha");
    seedObjective("NorthStar/o-1.md", "Obj 1", 60);
    rollUpCohort();

    expect(getCohort({ kind: "project" })).toHaveLength(1);
    expect(getCohort({ kind: "objective" })).toHaveLength(1);
    expect(getCohort({ kind: "thread" })).toHaveLength(0);
    expect(getCohortMember("project:p-1")!.member_kind).toBe("project");
    expect(getCohortMember("missing")).toBeNull();
  });
});
