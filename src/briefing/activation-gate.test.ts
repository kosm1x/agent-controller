/**
 * §13 activation-gate evaluator tests (V8.1 Phase 9 + 2026-05-27 spec
 * correction). Real in-memory DB — synthetic `cost_ledger` +
 * `proposed_briefings` rows. See activation-gate.ts header for the spec
 * correction rationale (cache-read measured on cacheable inference, NOT
 * on `reflection:%` — those rows fire too infrequently for cache TTL).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  evaluateActivationGate,
  morningSyncDay,
  RETIRED_MORNING_SYNC_SCHEDULE_IDS,
} from "./activation-gate.js";
import { ensureScheduledTasksTable } from "../rituals/dynamic.js";
import { ensureRitualDeliveriesTable } from "../rituals/delivery-policy.js";

/**
 * Insert a `cost_ledger` row with a given prompt/cache split. Default
 * agent_type `fast` is the dominant cacheable path (n-turn operator runner)
 * — that's the population the gate now measures. Callers may pass a
 * `reflection:*` agent_type when they want to verify those rows are
 * correctly EXCLUDED — see `EXCLUDES reflection:%` test.
 */
function insertCacheableCost(
  promptTokens: number,
  cacheReadTokens: number,
  agentType = "fast",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO cost_ledger
         (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens,
          cost_usd, cache_read_tokens, cache_creation_tokens)
       VALUES (?, 'gate-test', ?, 'sonnet', ?, 100, 0, ?, 0)`,
    )
    .run(crypto.randomUUID(), agentType, promptTokens, cacheReadTokens);
}

/** Insert N cacheable runs, each with the same prompt/cache split. */
function insertCacheableRuns(
  n: number,
  promptEach: number,
  cacheEach: number,
): void {
  for (let i = 0; i < n; i++) insertCacheableCost(promptEach, cacheEach);
}

/** Insert a proposed_briefings row with a given surface + status. */
function insertBriefing(surface: string, status: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO proposed_briefings
         (briefing_id, surface, generated_at, briefing_json, status, expires_at)
       VALUES (?, ?, datetime('now'), '{}', ?, datetime('now','+1 day'))`,
    )
    .run(crypto.randomUUID(), surface, status);
}

beforeEach(() => {
  initDatabase(":memory:");
  // Created lazily by their owning modules in production; the live db has both.
  ensureScheduledTasksTable();
  ensureRitualDeliveriesTable();
});

afterEach(() => {
  closeDatabase();
});

/** The promote-rate SCORING path assumes a live brief surface; production has
 *  it retired (BRIEF_SURFACE_RETIRED, 2026-08-03) — covered by its own
 *  describe block below. Scoring stays real code for a ruling reversal. */
const SCORING = { briefSurfaceRetired: false };

describe("evaluateActivationGate", () => {
  it("returns insufficient_data on an empty system", () => {
    const r = evaluateActivationGate(SCORING);
    expect(r.legacyVerdict).toBe("insufficient_data");
    expect(r.cacheReadPct).toBeNull();
    expect(r.cacheableRuns).toBe(0);
  });

  it("PASSES when cache-read ≥80% over ≥20 runs and morning promote-rate ≥60%", () => {
    insertCacheableRuns(20, 1000, 850); // 85% cache-read
    // 7 morning briefs; 5 promoted + 1 discarded = 6 RULED → 83% promote-rate.
    // The `expired` brief is unruled and excluded from the denominator.
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "expired");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheReadPct).toBe(85);
    expect(r.legacy.cacheRead.pass).toBe(true);
    expect(r.legacy.promoteRate.pass).toBe(true);
    expect(r.legacyVerdict).toBe("pass");
  });

  it("FAILS when the cache-read ratio is below 80%", () => {
    insertCacheableRuns(20, 1000, 700); // 70% cache-read
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheReadPct).toBe(70);
    expect(r.legacy.cacheRead.pass).toBe(false);
    expect(r.legacyVerdict).toBe("fail");
  });

  it("FAILS when the morning promote-rate is below 60%", () => {
    insertCacheableRuns(20, 1000, 900); // 90% — cache check passes
    insertBriefing("morning", "promoted");
    insertBriefing("morning", "promoted");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "expired"); // unruled → excluded
    // 2 promoted / 4 RULED = 50%, below the 60% bar.

    const r = evaluateActivationGate(SCORING);
    expect(r.legacy.cacheRead.pass).toBe(true);
    expect(r.legacy.promoteRate.pass).toBe(false);
    expect(r.legacyVerdict).toBe("fail");
  });

  it("is insufficient_data with fewer than 20 cacheable runs", () => {
    insertCacheableRuns(10, 1000, 950);
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(10);
    expect(r.legacy.cacheRead.pass).toBe(false);
    expect(r.legacyVerdict).toBe("insufficient_data");
  });

  it("is insufficient_data while morning briefs are generated but unresolved", () => {
    insertCacheableRuns(20, 1000, 900);
    insertBriefing("morning", "pending");
    insertBriefing("morning", "pending");

    const r = evaluateActivationGate(SCORING);
    expect(r.legacy.promoteRate.pass).toBe(false);
    expect(r.legacy.promoteRate.detail).toContain("only 0 ruled on");
    expect(r.legacyVerdict).toBe("insufficient_data");
  });

  it("excludes cost rows older than the 24h window", () => {
    insertCacheableRuns(20, 1000, 900); // 20 in-window rows at 90%
    // A stale 0%-cache row 2 days old — must NOT drag the ratio down.
    getDatabase()
      .prepare(
        `INSERT INTO cost_ledger
           (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens,
            cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES (?, 't', 'fast', 'sonnet', 9999, 100, 0, 0, 0,
                 datetime('now','-2 days'))`,
      )
      .run(crypto.randomUUID());

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20); // stale row excluded
    expect(r.cacheReadPct).toBe(90); // ratio undragged
  });

  it("EXCLUDES reflection:% rows from the cache-read ratio", () => {
    // 20 cacheable rows at 90% — should drive the ratio.
    insertCacheableRuns(20, 1000, 900);
    // 10 reflection rows at 0% — must NOT drag the ratio down.
    for (let i = 0; i < 10; i++) {
      insertCacheableCost(5000, 0, "reflection:morning");
    }
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20); // reflection rows excluded from count
    expect(r.cacheReadPct).toBe(90); // ratio undragged by reflection 0%
    expect(r.legacy.cacheRead.pass).toBe(true);
  });

  it("EXCLUDES the 3.3 seam-metering row classes (allow-list, not exclusion)", () => {
    // 20 allow-listed rows at 90% — the intended §13 population.
    insertCacheableRuns(20, 1000, 900);
    // New classes written by the claude-sdk seam hook since V8.5 Phase 3.3 —
    // tiny cache-cold aux calls. Under the old NOT-LIKE/NOT-IN filter every
    // one of these would have joined the denominator and dragged 90% → FAIL.
    for (const agentType of [
      "sdk:unattributed",
      "chat:fast-path",
      "aux:scope-classifier",
      "v82:critic",
      "audit:critic",
      "tuning:eval-probe",
    ]) {
      for (let i = 0; i < 5; i++) insertCacheableCost(2000, 0, agentType);
    }
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20); // seam rows excluded from count
    expect(r.cacheReadPct).toBe(90); // ratio undragged
    expect(r.legacy.cacheRead.pass).toBe(true);
  });

  it("KEEPS skill:% prefix rows in the ratio (pre-3.3 population preserved)", () => {
    insertCacheableRuns(18, 1000, 900);
    insertCacheableCost(1000, 900, "skill:weekly-report");
    insertCacheableCost(1000, 900, "skill:kb-cleanup");
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20); // skill:% still counted
    expect(r.cacheReadPct).toBe(90);
  });

  it("EXCLUDES once-daily `heavy` cold-start rows from the cache-read ratio", () => {
    // Mirrors the live 2026-07-10 shape that failed §13: `fast` sits ABOVE the
    // 80% bar, and a single once-daily `heavy` cold start (~47%, a (N-1)/N
    // ceiling at ~1.9 turns) is heavy enough in TOKENS to drag the weighted
    // aggregate under it. Without the exclusion this is 20,960/30,000 = 69.9%
    // → FAIL; with it, 81% → PASS.
    insertCacheableRuns(20, 1000, 810); // fast: 81%, above the bar
    insertCacheableCost(10_000, 4_760, "heavy"); // heavy: 47.6%, cold start
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20); // heavy row excluded from the count
    expect(r.cacheReadPct).toBe(81); // ratio undragged by heavy's cold start
    expect(r.legacy.cacheRead.pass).toBe(true);

    // ...but the excluded row stays VISIBLE and non-gating, so the exclusion
    // can't silently hide a heavy cache regression (audit W1).
    expect(r.excludedColdStart).toEqual({
      runs: 1,
      cacheReadPct: 47.6,
      costUsd: 0,
    });
  });

  it("EXCLUDES `nanoclaw` — one containerized run must not outvote the hot path", () => {
    // The live 2026-08-02 shape. `nanoclaw` sat in the CACHEABLE allow-list
    // despite being colder than `heavy`: fresh container + fresh clone per run,
    // so it can never reuse a prompt-cache prefix. Because the ratio is
    // TOKEN-weighted, ONE 3.13M-token run at 0% cache-read pulled 24h from
    // 94.7% (18 fast runs) down to 76.8% and failed §13 by itself.
    // Token proportions preserved at 1/1000 scale; run COUNT raised to 20 so
    // this isolates the ratio effect rather than tripping GATE_MIN_CACHEABLE_RUNS
    // (live had 18 fast runs, which is separately below that floor).
    insertCacheableRuns(20, 747, 707); // fast: 94.6%, comfortably above the bar
    insertCacheableCost(3_128, 0, "nanoclaw"); // one cold container run, 0%
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20); // nanoclaw row not counted
    expect(r.cacheReadPct).toBeGreaterThanOrEqual(80); // undragged → PASS
    expect(r.legacy.cacheRead.pass).toBe(true);

    // Excluded, never hidden: it still surfaces in the auditable mirror, so a
    // real nanoclaw cache regression stays visible while non-gating.
    expect(r.excludedColdStart.runs).toBe(1);
    expect(r.excludedColdStart.cacheReadPct).toBe(0);
  });

  it("reports excludedColdStart as zero/null when no heavy rows are in the window", () => {
    insertCacheableRuns(20, 1000, 900);
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.excludedColdStart).toEqual({
      runs: 0,
      cacheReadPct: null,
      costUsd: 0,
    });
    expect(r.legacy.cacheRead.pass).toBe(true); // absence never gates
  });

  it("EXCLUDES rows with prompt_tokens = 0 (null-usage pollution)", () => {
    insertCacheableRuns(20, 1000, 900);
    // 5 null-usage rows that would otherwise count as 0% reads.
    for (let i = 0; i < 5; i++) insertCacheableCost(0, 0);

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20);
    expect(r.cacheReadPct).toBe(90);
  });

  // (Audit-R1 dropped: `cost_ledger.prompt_tokens` is `INTEGER NOT NULL
  // DEFAULT 0` per schema.sql — a NULL row cannot be inserted, so the
  // gate's `prompt_tokens > 0` filter never sees one. The `= 0` test above
  // covers the only path that reaches the filter.)

  it("treats exactly 20 runs at exactly 80% cache-read as a pass (>= boundary)", () => {
    insertCacheableRuns(20, 1000, 800); // exactly 80%, exactly 20 runs
    for (let i = 0; i < 5; i++) insertBriefing("morning", "promoted");

    const r = evaluateActivationGate(SCORING);
    expect(r.cacheableRuns).toBe(20);
    expect(r.cacheReadPct).toBe(80);
    expect(r.legacy.cacheRead.pass).toBe(true);
    expect(r.legacyVerdict).toBe("pass");
  });

  it("reports per-surface briefing health", () => {
    insertBriefing("morning", "promoted");
    insertBriefing("morning", "pending");
    insertBriefing("weekly", "discarded");

    const health = evaluateActivationGate(SCORING).briefingHealth;
    const morning = health.find((h) => h.surface === "morning")!;
    expect(morning.generated).toBe(2);
    expect(morning.promoted).toBe(1);
    // promote-rate is over RULED briefs (promoted + discarded), not generated.
    // The `pending` brief carries no verdict, so it neither helps nor hurts:
    // 1/1 = 100%, not 1/2 = 50%. Silence is not a rejection.
    expect(morning.ruled).toBe(1);
    expect(morning.promoteRatePct).toBe(100);
  });

  it("does NOT let an EXPIRED (unanswered) brief count as a rejection", () => {
    // Since promotion requires an explicit "sirve"/"descarta", an unanswered
    // brief expires. Charging that silence against the promote-rate would fail
    // §13 for a reason unrelated to briefing quality.
    insertCacheableRuns(20, 1000, 900);
    for (let i = 0; i < 3; i++) insertBriefing("morning", "promoted"); // ≥ floor
    insertBriefing("morning", "expired");
    insertBriefing("morning", "expired");

    const r = evaluateActivationGate(SCORING);
    const morning = r.briefingHealth.find((h) => h.surface === "morning")!;
    expect(morning.expired).toBe(2);
    expect(morning.ruled).toBe(3);
    expect(morning.promoteRatePct).toBe(100); // 3/3 ruled, NOT 3/5 generated
    expect(r.legacy.promoteRate.pass).toBe(true);
  });

  it("does NOT let a single ruled brief decide the gate (audit W-B)", () => {
    // One discarded brief in a quiet week is 0/1 = 0% → would FAIL §13 on n=1.
    // Below the floor the check must be insufficient_data, never fail.
    insertCacheableRuns(20, 1000, 900);
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "expired");
    insertBriefing("morning", "pending");

    const r = evaluateActivationGate(SCORING);
    expect(r.legacy.promoteRate.pass).toBe(false);
    expect(r.legacy.promoteRate.detail).toContain("only 1 ruled on");
    expect(r.legacyVerdict).toBe("insufficient_data"); // NOT "fail"
  });

  it("is insufficient_data when every morning brief expired unanswered", () => {
    // Zero rulings → the rate is unknowable, not zero. Cadence trap: never fail.
    insertCacheableRuns(20, 1000, 900);
    insertBriefing("morning", "expired");
    insertBriefing("morning", "expired");

    const r = evaluateActivationGate(SCORING);
    expect(r.legacy.promoteRate.pass).toBe(false);
    expect(r.legacy.promoteRate.detail).toContain("only 0 ruled on");
    expect(r.legacyVerdict).toBe("insufficient_data"); // NOT "fail"
  });
});

describe("evaluateActivationGate — brief surface retired (2026-08-03, the production default)", () => {
  it("promote-rate is an annotated skip, and the verdict rides on cache-read alone", () => {
    insertCacheableRuns(20, 1000, 850); // cache passes; zero briefs ruled
    const r = evaluateActivationGate();
    expect(r.legacy.promoteRate.pass).toBe(true);
    expect(r.legacy.promoteRate.detail).toContain("surface retired");
    expect(r.legacyVerdict).toBe("pass");
  });

  it("a cache-read miss still fails — the skip never masks the live check", () => {
    insertCacheableRuns(20, 1000, 700); // 70% < 80%
    const r = evaluateActivationGate();
    expect(r.legacy.promoteRate.pass).toBe(true);
    expect(r.legacyVerdict).toBe("fail");
  });

  it("residual ruled briefs inside the 7d window do not resurrect scoring", () => {
    insertCacheableRuns(20, 1000, 850);
    // Rulings from before the flip — the surface is retired regardless.
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "discarded");
    insertBriefing("morning", "discarded"); // would score 0% and FAIL if live
    const r = evaluateActivationGate();
    expect(r.legacy.promoteRate.pass).toBe(true);
    expect(r.legacyVerdict).toBe("pass");
  });
});

// ── §13 v2 — Morning Sync checks (operator ruling 2026-10-06) ─────────────────

/** MX noon on 2026-06-15 (MX is UTC-6 year-round). */
const NOW = new Date("2026-06-15T18:00:00Z");
const MS_ID = "sched-ms-test";
let seq = 0;

function msSchedule(name = "Morning Sync (test)"): void {
  getDatabase()
    .prepare(
      `INSERT INTO scheduled_tasks (schedule_id, name, description, cron_expr)
       VALUES (?, ?, 'synthetic', '0 8 * * *')`,
    )
    .run(MS_ID, name);
}

function trace(
  taskId: string,
  name: string,
  attrs: object,
  round?: number,
  tokensIn?: number,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO task_trace_events (task_id, name, round, tokens_in, attrs) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(taskId, name, round ?? null, tokensIn ?? null, JSON.stringify(attrs));
}

interface RunOpts {
  /** MX days before NOW. */
  day?: number;
  delivered?: 0 | 1;
  status?: string;
  /** undefined = no attr on task.completed; null = attr present as JSON null. */
  concernReason?: string | null;
  /** null = no numbers.audited event. */
  audited?: { unverified: number; evidence_chunks: number } | null;
  costs?: number[];
  feedback?: string[];
  scheduleId?: string;
}

/**
 * One fixture builder, in the production shape: a Morning Sync run with its
 * `schedule_runs` row (spawned 08:00 MX = 14:00 UTC), task, trace and ledger
 * rows. A failed or cancelled run gets NO `ritual_deliveries` row — the only
 * writer runs on the success broadcast path — and the scheduler marks its
 * `schedule_runs` row `failed` (a cancel goes through the same failure path).
 */
function msRun(o: RunOpts = {}): string {
  const db = getDatabase();
  const taskId = `ms-task-${++seq}`;
  const day = morningSyncDay(NOW, o.day ?? 0);
  const ended = o.status === "failed" || o.status === "cancelled";
  db.prepare(
    `INSERT INTO tasks (task_id, title, description, status) VALUES (?, 'synthetic', 'synthetic', ?)`,
  ).run(taskId, o.status ?? "completed");
  db.prepare(
    `INSERT INTO schedule_runs (schedule_id, task_id, spawned_at, status) VALUES (?, ?, ?, ?)`,
  ).run(
    o.scheduleId ?? MS_ID,
    taskId,
    `${day} 14:00:00`,
    ended ? "failed" : "completed",
  );
  if (!ended)
    db.prepare(
      `INSERT INTO ritual_deliveries (ritual_id, task_id, fingerprint, delivered, reason, day)
       VALUES (?, ?, ?, ?, 'test', ?)`,
    ).run(
      `schedule:${o.scheduleId ?? MS_ID}`,
      taskId,
      taskId,
      o.delivered ?? 1,
      day,
    );
  if (!ended)
    trace(
      taskId,
      "task.completed",
      "concernReason" in o ? { concern_reason: o.concernReason } : {},
    );
  const audited =
    o.audited === undefined ? { unverified: 0, evidence_chunks: 2 } : o.audited;
  if (audited) trace(taskId, "numbers.audited", audited);
  for (const usd of o.costs ?? [0.1])
    db.prepare(
      `INSERT INTO cost_ledger (run_id, task_id, agent_type, model, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, 'fast', 'sonnet', 100, 10, ?)`,
    ).run(crypto.randomUUID(), taskId, usd);
  for (const signal of o.feedback ?? [])
    trace(taskId, "feedback.explicit", { signal });
  return taskId;
}

/** n healthy runs on days 0..n-1, each with concern_reason present (null). */
function healthyRuns(
  n: number,
  extra: (i: number) => RunOpts = () => ({}),
): void {
  for (let i = 0; i < n; i++)
    msRun({ day: i, concernReason: null, ...extra(i) });
}

const evalMs = () => evaluateActivationGate({ now: NOW });

describe("§13 v2 — Morning Sync checks", () => {
  it("passes every check and the verdict on a healthy fortnight", () => {
    msSchedule();
    healthyRuns(14, (i) => (i < 5 ? { feedback: ["positive"] } : {}));
    const r = evalMs();
    for (const c of Object.values(r.checks)) expect(c.status).toBe("pass");
    expect(r.verdict).toBe("pass");
    expect(r.morningSync.runs).toBe(14);
  });

  it("delivery: 13 delivered days pass, 12 fail; the window is exactly 14 MX days", () => {
    msSchedule();
    // No row today ⇒ the window is days 1..14 (ending yesterday).
    for (let d = 1; d <= 13; d++) msRun({ day: d });
    msRun({ day: 15 }); // outside the window
    expect(evalMs().checks.delivery.status).toBe("pass");
    getDatabase()
      .prepare(`UPDATE ritual_deliveries SET delivered = 0 WHERE day = ?`)
      .run(morningSyncDay(NOW, 13));
    const r = evalMs();
    expect(r.checks.delivery.status).toBe("fail");
    expect(r.checks.delivery.detail).toContain("12/14");
  });

  it("delivery fails when no `Morning Sync%` schedule exists", () => {
    msSchedule("Evening Digest");
    healthyRuns(14);
    const r = evalMs();
    expect(r.checks.delivery.status).toBe("fail");
    expect(r.checks.delivery.detail).toContain("no schedule named");
  });

  it("counts runs delivered under a retired Morning Sync schedule id", () => {
    msSchedule();
    healthyRuns(14, () => ({
      scheduleId: RETIRED_MORNING_SYNC_SCHEDULE_IDS[0],
    }));
    const r = evalMs();
    expect(r.morningSync.runs).toBe(14);
    expect(r.checks.delivery.status).toBe("pass");
  });

  it("cleanCompletion: 6 measured is insufficient, 7 with 0 hard defects passes", () => {
    msSchedule();
    healthyRuns(6);
    expect(evalMs().checks.cleanCompletion.status).toBe("insufficient_data");
    msRun({ day: 6, concernReason: null });
    expect(evalMs().checks.cleanCompletion.status).toBe("pass");
  });

  it("cleanCompletion: one hard concern_reason fails; soft reasons are reported, not scored", () => {
    msSchedule();
    healthyRuns(6, (i) =>
      i === 0
        ? { status: "completed_with_concerns", concernReason: "low_confidence" }
        : {},
    );
    msRun({
      day: 6,
      status: "completed_with_concerns",
      concernReason: "max_turns",
    });
    const c = evalMs().checks.cleanCompletion;
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("1 hard defect");
    expect(c.detail).toContain("2 completed_with_concerns");
    expect(c.detail).toContain("low_confidence=1");
  });

  it("cleanCompletion: a failed run (schedule_runs row, NO delivery row) is a hard defect", () => {
    msSchedule();
    healthyRuns(6);
    const failed = msRun({ day: 6, status: "failed" });
    const deliveries = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM ritual_deliveries WHERE task_id = ?`)
      .get(failed) as { n: number };
    expect(deliveries.n).toBe(0); // the production shape
    const r = evalMs();
    expect(r.morningSync.runs).toBe(7);
    expect(r.checks.cleanCompletion.status).toBe("fail");
    expect(r.checks.cleanCompletion.detail).toContain(
      "1 hard defect(s) over 7/7",
    );
  });

  it("delivery: a failed run is also a missing delivered day", () => {
    msSchedule();
    healthyRuns(14, (i) => (i === 3 ? { status: "failed" } : {}));
    const r = evalMs();
    expect(r.morningSync.runs).toBe(14);
    expect(r.checks.delivery.detail).toContain("13/14");
    expect(r.checks.cleanCompletion.status).toBe("fail");
  });

  it("cleanCompletion: an operator-cancelled run is counted, neither measured nor a defect", () => {
    msSchedule();
    healthyRuns(7);
    msRun({ day: 7, status: "cancelled" });
    const c = evalMs().checks.cleanCompletion;
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("0 hard defect(s) over 7/8");
    expect(c.detail).toContain("1 cancelled");
  });

  it("a schedule_runs row still running today is in flight and skipped; an older one counts", () => {
    msSchedule();
    healthyRuns(7);
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO schedule_runs (schedule_id, task_id, spawned_at, status) VALUES (?, ?, ?, 'running')`,
    );
    insert.run(MS_ID, "ms-inflight", `${morningSyncDay(NOW, 0)} 14:00:00`);
    expect(evalMs().morningSync.runs).toBe(7);
    insert.run(MS_ID, "ms-lost", `${morningSyncDay(NOW, 8)} 14:00:00`);
    expect(evalMs().morningSync.runs).toBe(8);
  });

  it("schedule_runs.spawned_at (UTC) is bucketed into its MX day", () => {
    msSchedule();
    const insert = getDatabase().prepare(
      `INSERT INTO schedule_runs (schedule_id, task_id, spawned_at, status) VALUES (?, ?, ?, 'failed')`,
    );
    // Day 13's date at 05:59 UTC = 23:59 MX on day 14 ⇒ outside the window.
    insert.run(MS_ID, "ms-edge-out", `${morningSyncDay(NOW, 13)} 05:59:00`);
    // Day 13's date at 06:00 UTC = 00:00 MX on day 13 ⇒ inside.
    insert.run(MS_ID, "ms-edge-in", `${morningSyncDay(NOW, 13)} 06:00:00`);
    expect(evalMs().morningSync.runs).toBe(1);
  });

  describe("delivery window does not depend on the time of day (audit R1-W4)", () => {
    const AT_0700 = new Date("2026-06-15T13:00:00Z"); // 07:00 MX, before the run
    const AT_1200 = NOW; // 12:00 MX, after today's run
    const at = (now: Date) => evaluateActivationGate({ now }).checks.delivery;

    it("one earlier miss: same verdict at 07:00 and 12:00", () => {
      msSchedule();
      for (let d = 1; d <= 14; d++) if (d !== 5) msRun({ day: d });
      const before = at(AT_0700);
      expect(before.detail).toContain("13/14 MX days ending yesterday");
      msRun({ day: 0 }); // today's 08:00 run delivered
      const after = at(AT_1200);
      expect(after.detail).toContain("13/14 MX days ending today");
      expect(before.status).toBe("pass");
      expect(after.status).toBe(before.status);
    });

    it("no miss: same verdict at 07:00 and 12:00", () => {
      msSchedule();
      for (let d = 1; d <= 14; d++) msRun({ day: d });
      const before = at(AT_0700);
      msRun({ day: 0 });
      const after = at(AT_1200);
      expect(before.detail).toContain("14/14");
      expect(after.detail).toContain("14/14");
      expect(before.status).toBe("pass");
      expect(after.status).toBe(before.status);
    });

    it("a delivered row for today makes the window end today, even before 08:00", () => {
      msSchedule();
      for (let d = 0; d <= 12; d++) msRun({ day: d });
      const c = at(AT_0700);
      expect(c.detail).toContain("13/14 MX days ending today");
      expect(c.status).toBe("pass");
    });
  });

  it("cleanCompletion: a run with concerns but no concern_reason attr is not measured", () => {
    msSchedule();
    healthyRuns(6);
    msRun({ day: 6, status: "completed_with_concerns" }); // no attr
    const c = evalMs().checks.cleanCompletion;
    expect(c.status).toBe("insufficient_data");
    expect(c.detail).toContain("6/7");
  });

  it("grounding: 6 runs insufficient; 1 ungrounded of 7 passes; 2 fail", () => {
    msSchedule();
    healthyRuns(6, (i) => (i === 0 ? { audited: null } : {}));
    expect(evalMs().checks.grounding.status).toBe("insufficient_data");
    msRun({ day: 6 });
    expect(evalMs().checks.grounding.status).toBe("pass");
    msRun({ day: 7, audited: { unverified: 1, evidence_chunks: 3 } });
    expect(evalMs().checks.grounding.status).toBe("fail");
  });

  it("grounding: evidence_chunks 0 is not grounded", () => {
    msSchedule();
    healthyRuns(7, (i) =>
      i < 2 ? { audited: { unverified: 0, evidence_chunks: 0 } } : {},
    );
    expect(evalMs().checks.grounding.status).toBe("fail");
  });

  it("operatorVerdict: 4 rated insufficient; 3/5 = 60% passes; 2/5 fails", () => {
    msSchedule();
    healthyRuns(8, (i) =>
      i < 3
        ? { feedback: ["positive"] }
        : i === 3
          ? { feedback: ["negative"] }
          : {},
    );
    expect(evalMs().checks.operatorVerdict.status).toBe("insufficient_data");
    msRun({ day: 20, feedback: ["negative"] }); // inside the 30-day window
    const c = evalMs().checks.operatorVerdict;
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("3 positive, 2 negative, 5 rated, 4 unrated");
  });

  it("operatorVerdict: 2 positive of 5 rated fails", () => {
    msSchedule();
    healthyRuns(5, (i) => ({ feedback: [i < 2 ? "positive" : "negative"] }));
    expect(evalMs().checks.operatorVerdict.status).toBe("fail");
  });

  it("windows are exactly 14 MX days for runs and 30 for ratings", () => {
    msSchedule();
    healthyRuns(13); // days 0..12
    msRun({ day: 13 }); // last day inside
    msRun({ day: 14 }); // first day outside
    expect(evalMs().morningSync.runs).toBe(14);
    for (let d = 15; d < 18; d++) msRun({ day: d, feedback: ["positive"] });
    msRun({ day: 29, feedback: ["positive"] }); // 4th rating, inside 30
    msRun({ day: 30, feedback: ["positive"] }); // outside 30
    expect(evalMs().checks.operatorVerdict.status).toBe("insufficient_data");
  });

  it("operatorVerdict: the latest feedback.explicit per task wins", () => {
    msSchedule();
    healthyRuns(5, (i) => ({
      feedback: i < 3 ? ["negative", "positive"] : ["positive", "negative"],
    }));
    const c = evalMs().checks.operatorVerdict;
    expect(c.detail).toContain("3 positive, 2 negative, 5 rated");
    expect(c.status).toBe("pass");
  });

  it("costPerRun: 6 runs with ledger rows insufficient; median exactly $0.25 passes; above fails", () => {
    msSchedule();
    healthyRuns(6, () => ({ costs: [0.25] }));
    msRun({ day: 6, costs: [] }); // no ledger row — not counted
    expect(evalMs().checks.costPerRun.status).toBe("insufficient_data");
    msRun({ day: 7, costs: [0.125, 0.125] }); // per-run SUM = 0.25
    expect(evalMs().checks.costPerRun.status).toBe("pass");
    getDatabase()
      .prepare(`UPDATE cost_ledger SET cost_usd = 0.2501 WHERE cost_usd = 0.25`)
      .run();
    expect(evalMs().checks.costPerRun.status).toBe("fail");
  });

  describe("grounding and costPerRun score completed runs only (audit R2-WA)", () => {
    it("12 healthy runs + 2 operator cancels: grounding passes; only delivery scores the cancels", () => {
      msSchedule();
      healthyRuns(12, (i) => (i < 5 ? { feedback: ["positive"] } : {}));
      msRun({ day: 12, status: "cancelled", audited: null });
      msRun({ day: 13, status: "cancelled", audited: null });
      const r = evalMs();
      expect(r.morningSync.runs).toBe(14);
      expect(r.checks.grounding.status).toBe("pass");
      expect(r.checks.grounding.detail).toContain(
        "0 of 12 completed run(s) not grounded, 2 not completed, excluded",
      );
      expect(r.checks.cleanCompletion.status).toBe("pass");
      const failing = Object.entries(r.checks)
        .filter(([, c]) => c.status === "fail")
        .map(([k]) => k);
      expect(failing).toEqual(["delivery"]); // 12/14 delivered days
    });

    it("a failed run is a cleanCompletion hard defect, but not in grounding or the cost median", () => {
      msSchedule();
      healthyRuns(7, (i) => ({ costs: [i < 3 ? 0.1 : 0.3] })); // median $0.30
      // Included, its $0.01 would pull the median to $0.20 and pass.
      msRun({ day: 7, status: "failed", audited: null, costs: [0.01] });
      const r = evalMs();
      expect(r.checks.cleanCompletion.status).toBe("fail");
      expect(r.checks.cleanCompletion.detail).toContain(
        "1 hard defect(s) over 8/8",
      );
      expect(r.checks.grounding.detail).toContain(
        "0 of 7 completed run(s) not grounded, 1 not completed, excluded",
      );
      expect(r.checks.costPerRun.status).toBe("fail");
      expect(r.checks.costPerRun.detail).toContain(
        "median $0.3000 over 7 completed run(s) with ledger rows, 1 not completed, excluded",
      );
    });

    it("a schedule_runs row with no task row and an older lost `running` run are not ungrounded", () => {
      msSchedule();
      healthyRuns(7);
      const db = getDatabase();
      const insert = db.prepare(
        `INSERT INTO schedule_runs (schedule_id, task_id, spawned_at, status) VALUES (?, ?, ?, ?)`,
      );
      insert.run(
        MS_ID,
        "ms-no-task",
        `${morningSyncDay(NOW, 3)} 14:00:00`,
        "failed",
      );
      db.prepare(
        `INSERT INTO tasks (task_id, title, description, status) VALUES ('ms-lost', 'synthetic', 'synthetic', 'running')`,
      ).run();
      insert.run(
        MS_ID,
        "ms-lost",
        `${morningSyncDay(NOW, 8)} 14:00:00`,
        "running",
      );
      const r = evalMs();
      expect(r.morningSync.runs).toBe(9);
      expect(r.checks.grounding.status).toBe("pass");
      expect(r.checks.grounding.detail).toContain(
        "0 of 7 completed run(s) not grounded, 2 not completed, excluded",
      );
    });

    it("fewer than 7 completed runs: grounding and costPerRun are insufficient even with ≥7 runs", () => {
      msSchedule();
      healthyRuns(6);
      msRun({ day: 6, status: "cancelled", audited: null });
      msRun({ day: 7, status: "failed", audited: null });
      const r = evalMs();
      expect(r.morningSync.runs).toBe(8);
      expect(r.checks.grounding.status).toBe("insufficient_data");
      expect(r.checks.costPerRun.status).toBe("insufficient_data");
      expect(r.checks.costPerRun.detail).toContain(
        "over 6 completed run(s) with ledger rows, 2 not completed, excluded",
      );
    });
  });

  it("verdict precedence: fail > insufficient_data > pass", () => {
    msSchedule();
    healthyRuns(14); // operatorVerdict insufficient (0 rated), rest pass
    expect(evalMs().verdict).toBe("insufficient_data");
    msRun({ day: 0, audited: null });
    msRun({ day: 1, audited: null }); // grounding fails
    const r = evalMs();
    expect(r.checks.operatorVerdict.status).toBe("insufficient_data");
    expect(r.verdict).toBe("fail");
  });

  it("the legacy cache ratio below 80% no longer changes the verdict", () => {
    msSchedule();
    healthyRuns(14, (i) => (i < 5 ? { feedback: ["positive"] } : {}));
    insertCacheableRuns(20, 1000, 400); // 40% — the legacy line would fail
    const r = evalMs();
    expect(r.legacy.cacheRead.pass).toBe(false);
    expect(r.legacyVerdict).toBe("fail");
    expect(r.verdict).toBe("pass");
  });

  it("first-turn cache share: null until the attrs are recorded, then cache_read / tokens_in", () => {
    msSchedule();
    healthyRuns(7);
    expect(evalMs().morningSync.firstTurn.cacheReadPct).toBeNull();
    const t = msRun({ day: 7 });
    trace(
      t,
      "turn.completed",
      { cache_read_tokens: 900, cache_creation_tokens: 50 },
      1,
      1000,
    );
    trace(
      t,
      "turn.completed",
      { cache_read_tokens: 0, cache_creation_tokens: 0 },
      2,
      1000,
    );
    const ft = evalMs().morningSync.firstTurn;
    expect(ft.runsWithAttrs).toBe(1);
    expect(ft.cacheReadPct).toBe(90);
    expect(ft.cacheCreationTokens).toBe(50);
  });
});
