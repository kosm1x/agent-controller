/**
 * v7.7 Spine 2 — seed signals tests.
 *
 * Two concerns:
 *   1. The 14 seed rows are well-formed (count, names, valid JSON columns,
 *      cadence/priority enums match schema CHECK constraints).
 *   2. seedSignalsIdempotent() is idempotent across repeated calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SEED_SIGNALS, seedSignalsIdempotent } from "./seed-signals.js";
import { initDatabase, closeDatabase, getDatabase } from "../../db/index.js";
import {
  GATE_CACHEABLE_AGENT_PREFIX,
  GATE_CACHEABLE_AGENT_TYPES,
  GATE_COLD_START_AGENT_TYPES,
} from "../../briefing/activation-gate.js";

beforeEach(() => initDatabase(":memory:"));
afterEach(() => closeDatabase());

/** The cache-ratio seed query's population: its `IN (...)` names and `LIKE` prefix. */
function cacheRatioPopulation(): { names: string[]; prefix: string } {
  const q = SEED_SIGNALS.find(
    (s) => s.signal_name === "s1_tool_cache_read_ratio",
  )!.baseline_query;
  const lists = [...q.matchAll(/agent_type IN \(([^)]*)\)/g)];
  const likes = [...q.matchAll(/agent_type LIKE '([^'%]*)%'/g)];
  expect(lists).toHaveLength(1);
  expect(likes).toHaveLength(1);
  const names = [...lists[0][1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return { names, prefix: likes[0][1] };
}

describe("s1_tool_cache_read_ratio — same population as the §13 cache gate", () => {
  // The drift signal and the gate measure one thing; a job type that one
  // counts and the other does not makes them disagree with no failure.
  it("the seed's IN list equals GATE_CACHEABLE_AGENT_TYPES as a set, and its LIKE prefix equals GATE_CACHEABLE_AGENT_PREFIX", () => {
    const { names, prefix } = cacheRatioPopulation();
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...GATE_CACHEABLE_AGENT_TYPES].sort());
    expect(prefix).toBe(GATE_CACHEABLE_AGENT_PREFIX);
    // The whole query, so no extra clause, lost grouping or other window can
    // widen the population while the parsed names still match.
    const list = GATE_CACHEABLE_AGENT_TYPES.map((n) => `'${n}'`).join(",");
    expect(
      SEED_SIGNALS.find((s) => s.signal_name === "s1_tool_cache_read_ratio")!
        .baseline_query,
    ).toBe(
      `SELECT CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(prompt_tokens), 0) FROM cost_ledger WHERE (agent_type IN (${list}) OR agent_type LIKE '${GATE_CACHEABLE_AGENT_PREFIX}%') AND created_at > datetime('now', '-1 day')`,
    );
  });

  it("no structurally cold-start job type is in the seed population", () => {
    const { names, prefix } = cacheRatioPopulation();
    for (const cold of GATE_COLD_START_AGENT_TYPES) {
      expect(names).not.toContain(cold);
      expect(cold.startsWith(prefix)).toBe(false);
    }
  });

  it("rows of excluded job types do not move the ratio", () => {
    const db = getDatabase();
    const insert = db.prepare(
      "INSERT INTO cost_ledger (run_id, task_id, agent_type, prompt_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("r1", "t1", "fast", 100, 90);
    insert.run("r2", "t2", "skill:demo", 100, 70);
    // Cold-start and never-cacheable rows: 0 cache reads over 100 prompt tokens each.
    insert.run("r3", "t3", "nanoclaw", 100, 0);
    insert.run("r4", "t4", "swarm", 100, 0);
    insert.run("r5", "t5", "heavy", 100, 0);
    insert.run("r6", "t6", "chat:demo", 100, 0);
    // A listed type outside the one-day window (aged by SQLite's own clock).
    db.prepare(
      "INSERT INTO cost_ledger (run_id, task_id, agent_type, prompt_tokens, cache_read_tokens, created_at) VALUES ('r7', 't7', 'fast', 100, 0, datetime('now', '-2 days'))",
    ).run();
    const q = SEED_SIGNALS.find(
      (s) => s.signal_name === "s1_tool_cache_read_ratio",
    )!.baseline_query;
    const row = db.prepare(q).get() as Record<string, number | null>;
    expect(Object.values(row)[0]).toBeCloseTo(0.8, 10);
  });
});

describe("SEED_SIGNALS — static invariants", () => {
  it("exactly 14 seed signals (13 from Spine 2 + recall_coherence_suppression_rate from Spine 6)", () => {
    expect(SEED_SIGNALS.length).toBe(14);
  });

  it("includes the Spine 6 Conway Pattern 3 correspondence-audit signal", () => {
    const sig = SEED_SIGNALS.find(
      (s) => s.signal_name === "recall_coherence_suppression_rate",
    );
    expect(sig).toBeDefined();
    expect(sig!.cadence).toBe("weekly");
    // ACTIVATED 2026-05-23 — V8.1 Phase A wired logRecall + applyOutcomeBias
    // into SqliteMemoryBackend (giving us 213 fresh sqlite-primary rows over
    // 7d) so we recomputed the baseline at 0.0 and flipped enabled=1. Closes
    // queue item S6-recall-audit-dormant. See also the activation
    // baseline_query test below in the substrate-enabled block.
    expect(sig!.enabled).toBe(1);
    expect(sig!.baseline_query).toMatch(/FROM recall_audit/);
  });

  it("every signal name is unique", () => {
    const names = SEED_SIGNALS.map((s) => s.signal_name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every signal has cadence + alert_priority matching schema enums", () => {
    const validCadences = new Set([
      "hourly",
      "every_4h",
      "nightly",
      "weekly",
      "on_event",
    ]);
    const validPriorities = new Set(["P0", "P1", "P2"]);
    for (const s of SEED_SIGNALS) {
      expect(validCadences.has(s.cadence)).toBe(true);
      expect(validPriorities.has(s.alert_priority)).toBe(true);
    }
  });

  it("every baseline_value_json + tolerance_json parses as JSON", () => {
    for (const s of SEED_SIGNALS) {
      expect(() => JSON.parse(s.baseline_value_json)).not.toThrow();
      expect(() => JSON.parse(s.tolerance_json)).not.toThrow();
    }
  });

  it("includes mc_whatsapp_disconnects_total (the 13th — per V7.7-GUIDE Spine 2 add)", () => {
    const names = SEED_SIGNALS.map((s) => s.signal_name);
    expect(names).toContain("mc_whatsapp_disconnects_total");
  });

  it("at most one signal of each source substrate is enabled by default", () => {
    // Substrate-dependent signals MUST be enabled=0 until their substrate ships
    // (per spec §10 bilateral-maturity-friendly principle).
    const enabledBySubstrate: Record<string, number> = {};
    for (const s of SEED_SIGNALS) {
      if (s.enabled !== 0) {
        enabledBySubstrate[s.source_substrate] =
          (enabledBySubstrate[s.source_substrate] ?? 0) + 1;
      }
    }
    // S1 partial (1 cache-ratio signal), S2 (1 critic_unfixable real from Spine 1),
    // S4 (1 cost_per_brief), infra (2 — schema + whatsapp). V8.2 + V8.3 + S5 all 0.
    expect(enabledBySubstrate["V8.2"] ?? 0).toBe(0);
    expect(enabledBySubstrate["V8.3"] ?? 0).toBe(0);
    expect(enabledBySubstrate["S5"] ?? 0).toBe(0);
  });

  it("disabled signals MUST use the awaiting: baseline_query sentinel", () => {
    // Cross-check: don't ship enabled=0 with a real query (defeats the
    // "this signal will fire as soon as you flip enabled=1" expectation).
    for (const s of SEED_SIGNALS) {
      if (s.enabled === 0) {
        expect(s.baseline_query.startsWith("awaiting:")).toBe(true);
      }
    }
  });

  it("enabled signals MUST have a real baseline_query (SQL or prom:)", () => {
    for (const s of SEED_SIGNALS) {
      if (s.enabled !== 0) {
        expect(s.baseline_query.startsWith("awaiting:")).toBe(false);
      }
    }
  });
});

describe("seedSignalsIdempotent — DB integration", () => {
  it("first call inserts all 14, subsequent calls insert 0", () => {
    const first = seedSignalsIdempotent();
    expect(first.inserted).toBe(14);
    expect(first.skipped).toBe(0);

    const second = seedSignalsIdempotent();
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(14);
  });

  it("schema CHECK constraints accept every seed row's enums", () => {
    // If a seed row's cadence or alert_priority doesn't match the table
    // CHECK constraint, the insert throws and the test fails. This is the
    // mechanical check that SEED_SIGNALS + table schema stay in sync.
    expect(() => seedSignalsIdempotent()).not.toThrow();
    const count = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM drift_signals")
      .get() as { c: number };
    expect(count.c).toBe(14);
  });

  it("seeded rows can be queried by cadence", () => {
    seedSignalsIdempotent();
    const hourly = getDatabase()
      .prepare("SELECT signal_name FROM drift_signals WHERE cadence = 'hourly'")
      .all() as Array<{ signal_name: string }>;
    expect(hourly.length).toBeGreaterThan(0);
    expect(hourly.map((r) => r.signal_name)).toContain(
      "mc_whatsapp_disconnects_total",
    );
  });

  it("an existing-but-disabled row stays disabled across re-seed", () => {
    seedSignalsIdempotent();
    // Manually flip one row to disabled
    getDatabase()
      .prepare(
        "UPDATE drift_signals SET enabled = 0 WHERE signal_name = 'cost_per_brief_drift'",
      )
      .run();
    // Re-seed
    seedSignalsIdempotent();
    const row = getDatabase()
      .prepare(
        "SELECT enabled FROM drift_signals WHERE signal_name = 'cost_per_brief_drift'",
      )
      .get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });
});

describe("SEED_SIGNALS — enabled-signal SQL queries parse against initDatabase schema (R1-I3)", () => {
  // Catches the "Spine 1 renames a column" class of regression: every
  // enabled signal's baseline_query must parse + execute against the
  // tables initDatabase creates. SQL that's syntactically valid but
  // references a missing table/column fails at prepare() time.
  it("every enabled signal's baseline_query prepares + executes without throwing", () => {
    const db = getDatabase();
    const enabledSignals = SEED_SIGNALS.filter((s) => s.enabled !== 0);
    expect(enabledSignals.length).toBeGreaterThan(0); // sanity
    for (const s of enabledSignals) {
      if (s.baseline_query.startsWith("prom:")) continue; // prom-only, no SQL
      if (s.baseline_query.startsWith("awaiting:")) continue; // unreachable in enabled-set
      expect(
        () => {
          db.prepare(s.baseline_query).get();
        },
        `signal ${s.signal_name}: ${s.baseline_query.slice(0, 80)}`,
      ).not.toThrow();
    }
  });
});
