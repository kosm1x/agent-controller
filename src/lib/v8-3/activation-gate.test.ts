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
  /** `decisions.thread_id` (legacy source fallback: 'background' literal ⇒ background). */
  threadId?: string;
  /** When set, also lands a `proposed` event carrying `{source}` (2026-08-17 payload). */
  source?: string;
}): void {
  const db = getDatabase();
  const info = db
    .prepare(
      `INSERT INTO decisions
         (capability, judgment_id, autonomy_level, status, capability_token_json,
          payload_json, reversal_op_json, proposed_at, thread_id)
       VALUES ('task_edit', ?, ?, 'committed', '{}', '{}', ?, ?, ?)`,
    )
    .run(
      opts.judgmentId ?? null,
      opts.autonomyLevel,
      opts.reversalOp ?? null,
      opts.proposedAt ?? new Date().toISOString(),
      opts.threadId ?? "t",
    );
  if (opts.source !== undefined) {
    db.prepare(
      `INSERT INTO decision_events (decision_id, sequence_no, event_kind, payload_json, occurred_at)
       VALUES (?, 1, 'proposed', ?, ?)`,
    ).run(
      info.lastInsertRowid,
      JSON.stringify({ route: "confirm", source: opts.source }),
      new Date().toISOString(),
    );
  }
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

  // Seam-origin stratification (2026-08-17, deferred R2 of the 08-08 seam
  // ship): the shadow fill is reported BY SOURCE so a promotion decision cannot
  // cite a 100%-background fill as operator-exercised. Informational only —
  // the verdict never keys on it (a veto here would rank nothing).
  it("stratifies the 7d shadow by source: payload `source` wins, legacy rows fall back to thread_id; buckets sum to the total; verdict unaffected", () => {
    seedCapabilities();
    // 2026-08-17+ rows: source persisted on the proposed event
    insertDecision({ autonomyLevel: 1, threadId: "telegram:1", source: "operator" });
    insertDecision({ autonomyLevel: 1, threadId: "telegram:1", source: "interactive" });
    insertDecision({ autonomyLevel: 1, threadId: "background", source: "background" });
    insertDecision({ autonomyLevel: 1, threadId: "background", source: "background" });
    // legacy rows (no proposed payload source): thread_id decides
    insertDecision({ autonomyLevel: 1, threadId: "background" });
    insertDecision({ autonomyLevel: 1, threadId: "background" });
    insertDecision({ autonomyLevel: 1, threadId: "telegram:1" });
    // an unknown label counts as background so the buckets still sum
    insertDecision({ autonomyLevel: 1, threadId: "x", source: "someday" });
    // outside the window: excluded from BOTH the total and the buckets
    insertDecision({
      autonomyLevel: 1,
      threadId: "telegram:1",
      source: "operator",
      proposedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    const g = evaluateV83Gate();
    expect(g.shadowDecisions).toBe(8);
    expect(g.shadowBySource).toEqual({
      interactive: 2,
      operator: 1,
      background: 5,
    });
    expect(
      g.shadowBySource.interactive +
        g.shadowBySource.operator +
        g.shadowBySource.background,
    ).toBe(g.shadowDecisions);
    expect(g.checks.shadowVolume.detail).toContain(
      "by source: interactive 2 · operator 1 · background 5",
    );
    expect(g.verdict).toBe("pass"); // ≥7, all L1 — stratification is a readout, not a gate
  });

  // Audit R2-A1 (2026-08-02): checks 5/6 are violation counts over L≥3
  // decisions — a population empty by construction until an L3 promotion
  // exists. Both therefore PASS having examined nothing, and `promotion.ts`
  // writes those lines into a permanent ADR as promotion evidence. The pass is
  // correct (they are regression detectors, and demanding a non-empty L≥3
  // population would deadlock the gate forever); what was wrong is that a
  // vacuous ✓ was indistinguishable from a verified one. These two tests pin
  // the distinction — before the fix both cases produced identical output.
  it("marks linkage/reversibility VACUOUS when no L≥3 decision exists (passed without examining anything)", () => {
    seedCapabilities();
    insertN(7); // all L1 — the real steady state today
    const g = evaluateV83Gate();

    expect(g.verdict).toBe("pass");
    expect(g.checks.linkageIntegrity.pass).toBe(true);
    expect(g.checks.linkageIntegrity.vacuous).toBe(true);
    expect(g.checks.linkageIntegrity.detail).toContain("nothing to verify");
    expect(g.checks.reversibilityCoverage.vacuous).toBe(true);
    // A check with a real population is never marked vacuous.
    expect(g.checks.shadowVolume.vacuous).toBeFalsy();
  });

  it("is NOT vacuous once real L≥3 decisions exist, and reports the denominator", () => {
    seedCapabilities();
    const jid = seedJudgmentId();
    insertN(7);
    // Two compliant L≥3 decisions: linked AND carrying a reversal op.
    for (let i = 0; i < 2; i++)
      insertDecision({
        autonomyLevel: 3,
        judgmentId: jid,
        reversalOp: '{"op":"undo"}',
      });

    const g = evaluateV83Gate();
    expect(g.verdict).toBe("pass");
    expect(g.checks.linkageIntegrity.vacuous).toBe(false);
    expect(g.checks.linkageIntegrity.detail).toContain("all 2 L≥3 decision(s)");
    expect(g.checks.reversibilityCoverage.vacuous).toBe(false);
    expect(g.checks.reversibilityCoverage.detail).toContain(
      "all 2 L≥3 decision(s)",
    );
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
