import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import {
  promoteCapabilityL1toL2,
  renderPromotionAdr,
  type PromotionDone,
} from "./promotion.js";

const SIX = [
  "gmail_send",
  "northstar_sync",
  "task_edit",
  "jarvis_file_delete",
  "skill_run",
  "schedule_task",
];

function seedCapabilities(
  names: string[] = SIX,
  gateConfig = '{"reversible_required":true,"max_level":2}',
): void {
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO capability_autonomy
       (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
        blast_radius, reversible_default, override_window_start_at, description)
     VALUES (?, 1, '{}', ?, 0,
             'persistent', 1, datetime('now'), 'x')`,
  );
  for (const n of names) insert.run(n, gateConfig);
}

/** ≥7 clean L1 shadow decisions inside the 7-day window → §14 gate passes. */
function makeGatePass(): void {
  const insert = getDatabase().prepare(
    `INSERT INTO decisions
       (capability, judgment_id, autonomy_level, status, capability_token_json,
        payload_json, proposed_at, thread_id)
     VALUES ('task_edit', NULL, 1, 'committed', '{}', '{}', ?, 't')`,
  );
  for (let i = 0; i < 7; i++) insert.run(new Date().toISOString());
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("promoteCapabilityL1toL2 — guards", () => {
  it("refuses an unseeded capability and lists what IS seeded", () => {
    seedCapabilities();
    makeGatePass();
    const r = promoteCapabilityL1toL2("no_such_cap", { confirm: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusedBy).toBe("unseeded");
    expect(r.reason).toContain("jarvis_file_delete");
  });

  it("refuses when the capability is not at L1 (already promoted)", () => {
    seedCapabilities();
    makeGatePass();
    getDatabase()
      .prepare(`UPDATE capability_autonomy SET level = 2 WHERE capability = ?`)
      .run("task_edit");
    const r = promoteCapabilityL1toL2("task_edit", { confirm: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusedBy).toBe("level");
    expect(r.reason).toContain("already promoted");
  });

  it("refuses when gate_config caps the capability below L2", () => {
    seedCapabilities(SIX, '{"reversible_required":true,"max_level":1}');
    makeGatePass();
    const r = promoteCapabilityL1toL2("task_edit", { confirm: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusedBy).toBe("max_level");
  });

  it("refuses on unparseable gate_config (never assumes permissive)", () => {
    seedCapabilities(SIX, "not json");
    makeGatePass();
    const r = promoteCapabilityL1toL2("task_edit", { confirm: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusedBy).toBe("max_level");
  });

  it("refuses while the §14 gate is insufficient_data (thin shadow) — exit-code class 'gate'", () => {
    seedCapabilities();
    // no decisions inserted → shadow volume 0
    const r = promoteCapabilityL1toL2("task_edit", { confirm: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusedBy).toBe("gate");
    expect(r.reason).toContain("insufficient_data");
    // nothing written
    const row = getDatabase()
      .prepare(
        `SELECT level, promoted_at FROM capability_autonomy WHERE capability = 'task_edit'`,
      )
      .get() as { level: number; promoted_at: string | null };
    expect(row.level).toBe(1);
    expect(row.promoted_at).toBeNull();
  });
});

describe("promoteCapabilityL1toL2 — dry run and execution", () => {
  it("all guards green WITHOUT confirm → dry run, no write", () => {
    seedCapabilities();
    makeGatePass();
    const r = promoteCapabilityL1toL2("jarvis_file_delete", { confirm: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.executed).toBe(false);
    expect(r.promotedAt).toBeNull();
    const row = getDatabase()
      .prepare(
        `SELECT level FROM capability_autonomy WHERE capability = 'jarvis_file_delete'`,
      )
      .get() as { level: number };
    expect(row.level).toBe(1);
  });

  it("all guards green WITH confirm → L2, promoted_at set, integral + window reset", () => {
    seedCapabilities();
    makeGatePass();
    const db = getDatabase();
    db.prepare(
      `UPDATE capability_autonomy
          SET override_integral = 3.5,
              override_window_start_at = '2020-01-01T00:00:00.000Z'
        WHERE capability = 'jarvis_file_delete'`,
    ).run();

    const r = promoteCapabilityL1toL2("jarvis_file_delete", { confirm: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.executed).toBe(true);
    expect(r.promotedAt).toBeTruthy();

    const row = db
      .prepare(
        `SELECT level, promoted_at, override_integral, override_window_start_at
           FROM capability_autonomy WHERE capability = 'jarvis_file_delete'`,
      )
      .get() as {
      level: number;
      promoted_at: string;
      override_integral: number;
      override_window_start_at: string;
    };
    expect(row.level).toBe(2);
    expect(row.promoted_at).toBe(r.promotedAt);
    expect(row.override_integral).toBe(0);
    expect(row.override_window_start_at).toBe(r.promotedAt);
  });

  it("second confirm on the same capability refuses (L2 is not L1)", () => {
    seedCapabilities();
    makeGatePass();
    const first = promoteCapabilityL1toL2("task_edit", { confirm: true });
    expect(first.ok).toBe(true);
    const second = promoteCapabilityL1toL2("task_edit", { confirm: true });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusedBy).toBe("level");
  });

  it("does not touch any other capability's row", () => {
    seedCapabilities();
    makeGatePass();
    promoteCapabilityL1toL2("task_edit", { confirm: true });
    const others = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM capability_autonomy WHERE level = 1`)
      .get() as { n: number };
    expect(others.n).toBe(SIX.length - 1);
  });
});

describe("renderPromotionAdr", () => {
  it("renders a MADR-style record carrying the gate evidence at promotion time", () => {
    seedCapabilities();
    makeGatePass();
    const r = promoteCapabilityL1toL2("skill_run", { confirm: true });
    expect(r.ok && r.executed).toBe(true);
    const adr = renderPromotionAdr(r as PromotionDone);
    expect(adr).toContain("skill_run L1 → L2");
    expect(adr).toContain("**Status:** accepted");
    expect(adr).toContain("shadowVolume");
    expect(adr).toContain("gated on V8.2 §17");
  });
});
