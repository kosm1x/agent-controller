import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { evaluateV83Gate } from "./activation-gate.js";

const SIX = [
  "gmail_send",
  "northstar_sync",
  "task_edit",
  "jarvis_file_delete",
  "skill_run",
  "schedule_task",
];

function seedCapabilities(names: string[] = SIX): void {
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO capability_autonomy
       (capability, level, odd_predicate_json, gate_config_json, ux_confirm_flag,
        blast_radius, reversible_default, override_window_start_at, description)
     VALUES (?, 1, '{}', '{"reversible_required":true,"max_level":2}', 0,
             'persistent', 1, datetime('now'), 'x')`,
  );
  for (const n of names) insert.run(n);
}

function insertDecision(opts: {
  autonomyLevel: number;
  judgmentId?: number | null;
  reversalOp?: string | null;
  /** ISO (production format) — the gate normalizes it via datetime(). */
  proposedAt?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO decisions
         (capability, judgment_id, autonomy_level, status, capability_token_json,
          payload_json, reversal_op_json, proposed_at, thread_id)
       VALUES ('task_edit', ?, ?, 'committed', '{}', '{}', ?, ?, 't')`,
    )
    .run(
      opts.judgmentId ?? null,
      opts.autonomyLevel,
      opts.reversalOp ?? null,
      opts.proposedAt ?? new Date().toISOString(),
    );
}

function insertN(n: number, level = 1): void {
  for (let i = 0; i < n; i++) insertDecision({ autonomyLevel: level });
}

/** Insert a real judgment (satisfies decisions.judgment_id FK) → returns its id. */
function seedJudgmentId(): number {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO proposed_briefings
       (briefing_id, surface, generated_at, briefing_json, status, expires_at)
     VALUES ('b', 'morning', datetime('now'), '{}', 'promoted', datetime('now','+1 day'))`,
  ).run();
  const info = db
    .prepare(
      `INSERT INTO judgments (briefing_id, subject, posture, prose, confidence, created_at)
       VALUES ('b', 's', 'at_risk', 'p', 'green', datetime('now'))`,
    )
    .run();
  return Number(info.lastInsertRowid);
}

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

describe("evaluateV83Gate — §14 v1 activation gate", () => {
  it("healthy substrate + thin shadow window → insufficient_data (cadence trap, not fail)", () => {
    seedCapabilities();
    insertN(3); // < 7
    const g = evaluateV83Gate();
    expect(g.checks.schema.pass).toBe(true);
    expect(g.checks.v82Dependency.pass).toBe(true);
    expect(g.checks.seeded.pass).toBe(true);
    expect(g.checks.shadowVolume.pass).toBe(false);
    expect(g.verdict).toBe("insufficient_data");
  });

  it("healthy substrate + ≥7 clean L1 shadow decisions → pass", () => {
    seedCapabilities();
    insertN(7);
    const g = evaluateV83Gate();
    expect(g.shadowDecisions).toBe(7);
    expect(g.verdict).toBe("pass");
  });

  it("missing a capability (5 seeded) → fail (misconfiguration, not insufficient_data)", () => {
    seedCapabilities(SIX.slice(0, 5));
    insertN(3);
    const g = evaluateV83Gate();
    expect(g.checks.seeded.pass).toBe(false);
    expect(g.verdict).toBe("fail");
  });

  it("an L≥3 decision with judgment_id NULL → FAIL regardless of volume (§12 breach)", () => {
    seedCapabilities();
    insertN(7); // enough clean volume
    insertDecision({ autonomyLevel: 4, judgmentId: null, reversalOp: "{}" });
    const g = evaluateV83Gate();
    expect(g.checks.linkageIntegrity.pass).toBe(false);
    expect(g.checks.linkageIntegrity.detail).toMatch(/linkage BREACH/);
    expect(g.verdict).toBe("fail");
  });

  it("an L≥3 decision with no reversal_op → FAIL regardless of volume (§7 breach)", () => {
    seedCapabilities();
    insertN(7);
    // judgment linked (so linkage passes) but NO reversal op → isolates §7 breach
    const jid = seedJudgmentId();
    insertDecision({ autonomyLevel: 4, judgmentId: jid, reversalOp: null });
    const g = evaluateV83Gate();
    expect(g.checks.linkageIntegrity.pass).toBe(true); // isolated: only reversibility fails
    expect(g.checks.reversibilityCoverage.pass).toBe(false);
    expect(g.checks.reversibilityCoverage.detail).toMatch(/§7 BREACH/);
    expect(g.verdict).toBe("fail");
  });

  it("decisions older than 7 days do not count toward the shadow window (datetime-normalized)", () => {
    seedCapabilities();
    // 10 decisions 8 days ago (ISO format) → outside the window
    for (let i = 0; i < 10; i++) {
      insertDecision({
        autonomyLevel: 1,
        proposedAt: "2000-01-01T00:00:00.000Z",
      });
    }
    const g = evaluateV83Gate();
    expect(g.shadowDecisions).toBe(0);
    expect(g.verdict).toBe("insufficient_data");
  });

  it("an L≥3 breach OUTSIDE the 7d window does not fail the gate (windowed)", () => {
    seedCapabilities();
    insertN(7); // clean current volume
    // an unlinked L4 decision from long ago — outside the window, must not count
    insertDecision({
      autonomyLevel: 4,
      judgmentId: null,
      reversalOp: "{}",
      proposedAt: "2000-01-01T00:00:00.000Z",
    });
    const g = evaluateV83Gate();
    expect(g.checks.linkageIntegrity.pass).toBe(true);
    expect(g.verdict).toBe("pass");
  });
});
