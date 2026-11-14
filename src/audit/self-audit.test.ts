/**
 * V8 substrate S2 — self-audit tests.
 *
 * Pure analytic tests use synthetic Sample[]; metric runners read the real
 * recall_audit + cost_ledger schema from initDatabase(":memory:"), so a
 * renamed column fails here instead of yielding 0 samples in audit-claim.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  auditAggregate,
  parseWindow,
  renderAuditResult,
  type Sample,
} from "./self-audit.js";

describe("auditAggregate — pure core", () => {
  it("verifies a healthy aggregate with sufficient n", () => {
    const samples: Sample[] = Array.from({ length: 50 }, () => ({ value: 1 }));
    const r = auditAggregate(samples, { claim: "test" });
    expect(r.verified).toBe(true);
    expect(r.mean).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("flags small-n when below minN", () => {
    const samples: Sample[] = Array.from({ length: 5 }, () => ({ value: 0.5 }));
    const r = auditAggregate(samples, { claim: "test", minN: 30 });
    expect(r.verified).toBe(false);
    expect(r.warnings).toContain("small-n");
    expect(r.notes.some((n) => n.includes("n=5"))).toBe(true);
  });

  it("flags single-bucket-dominance when one bucket holds ≥70% with diverging mean", () => {
    // 80 samples in 'big' bucket at value=1, 20 in 'small' bucket at value=0
    // Aggregate = 0.8, big mean = 1.0, delta = 0.2 >= 0.15 → dominance
    const samples: Sample[] = [
      ...Array.from({ length: 80 }, () => ({ bucket: "big", value: 1 })),
      ...Array.from({ length: 20 }, () => ({ bucket: "small", value: 0 })),
    ];
    const r = auditAggregate(samples, { claim: "test" });
    expect(r.warnings).toContain("single-bucket-dominance");
    expect(r.stratification[0].bucket).toBe("big");
    expect(r.stratification[0].n).toBe(80);
  });

  it("does NOT flag dominance when bucket dominates but means align", () => {
    const samples: Sample[] = [
      ...Array.from({ length: 80 }, () => ({ bucket: "big", value: 0.5 })),
      ...Array.from({ length: 20 }, () => ({ bucket: "small", value: 0.5 })),
    ];
    const r = auditAggregate(samples, { claim: "test" });
    expect(r.warnings).not.toContain("single-bucket-dominance");
  });

  it("flags stratification-divergence when small-but-real bucket diverges", () => {
    // The canonical 2026-05-03 case — both buckets are real but their
    // means diverge sharply. Big bucket dominates (also triggers
    // single-bucket-dominance), but the divergence flag fires too.
    const samples: Sample[] = [
      ...Array.from({ length: 69 }, () => ({
        bucket: "mc-operational",
        value: 0.88,
      })),
      ...Array.from({ length: 50 }, () => ({
        bucket: "mc-jarvis",
        value: 0.07,
      })),
    ];
    const r = auditAggregate(samples, { claim: "trilogy headline" });
    expect(r.warnings).toContain("stratification-divergence");
    // The headline (~0.54) hides both bucket means
    expect(r.notes.some((n) => n.includes("mc-jarvis"))).toBe(true);
  });

  it("ignores buckets below minBucketN for divergence (no false positives on n=1 noise)", () => {
    const samples: Sample[] = [
      ...Array.from({ length: 100 }, () => ({ bucket: "main", value: 0.5 })),
      // single noisy outlier — n=2 bucket at value=1
      { bucket: "noise", value: 1 },
      { bucket: "noise", value: 1 },
    ];
    const r = auditAggregate(samples, { claim: "test", minBucketN: 10 });
    expect(r.warnings).not.toContain("stratification-divergence");
    // ...but the bucket should still appear in stratification with an
    // informational note
    expect(r.stratification.find((b) => b.bucket === "noise")?.n).toBe(2);
    expect(
      r.notes.some((n) => n.includes("noise") && n.includes("noise")),
    ).toBe(true);
  });

  it("flags baseline-divergence when relative delta exceeds threshold", () => {
    const samples: Sample[] = Array.from({ length: 100 }, () => ({
      value: 0.45,
    }));
    const r = auditAggregate(samples, {
      claim: "test",
      baseline: 0.222,
      baselineDivergenceRel: 0.5,
    });
    // 0.45 vs 0.222 → relative delta ~1.0, > 0.5
    expect(r.warnings).toContain("baseline-divergence");
    expect(r.baselineDelta).toBeCloseTo(0.228, 2);
  });

  it("does not flag baseline-divergence when delta is small", () => {
    const samples: Sample[] = Array.from({ length: 100 }, () => ({
      value: 0.25,
    }));
    const r = auditAggregate(samples, {
      claim: "test",
      baseline: 0.222,
      baselineDivergenceRel: 0.5,
    });
    expect(r.warnings).not.toContain("baseline-divergence");
  });

  it("returns empty stratification when no samples carry buckets", () => {
    const samples: Sample[] = Array.from({ length: 30 }, () => ({ value: 1 }));
    const r = auditAggregate(samples, { claim: "test" });
    expect(r.stratification).toEqual([]);
  });

  it("handles n=0 gracefully (no NaN, not verified)", () => {
    const r = auditAggregate([], { claim: "empty" });
    expect(r.n).toBe(0);
    expect(r.mean).toBe(0);
    expect(r.verified).toBe(false);
    expect(r.warnings).toContain("small-n");
  });

  it("respects custom minN", () => {
    const samples: Sample[] = Array.from({ length: 15 }, () => ({ value: 1 }));
    const lax = auditAggregate(samples, { claim: "test", minN: 10 });
    expect(lax.verified).toBe(true);
    const strict = auditAggregate(samples, { claim: "test", minN: 50 });
    expect(strict.verified).toBe(false);
    expect(strict.warnings).toContain("small-n");
  });

  it("computes accurate mean for non-uniform samples", () => {
    const samples: Sample[] = [
      ...Array.from({ length: 30 }, () => ({ value: 1 })),
      ...Array.from({ length: 70 }, () => ({ value: 0 })),
    ];
    const r = auditAggregate(samples, { claim: "test" });
    expect(r.mean).toBeCloseTo(0.3, 5);
    expect(r.sum).toBe(30);
  });
});

describe("parseWindow", () => {
  it.each([
    ["24h", "-24 hours", "24h"],
    ["7d", "-7 days", "7d"],
    ["120m", "-120 minutes", "120m"],
    ["1h", "-1 hours", "1h"],
  ])("parses %s correctly", (input, modifier, label) => {
    const w = parseWindow(input);
    expect(w.modifier).toBe(modifier);
    expect(w.label).toBe(label);
  });

  it.each(["24", "1y", "abc", "h", "", "1h ; DROP TABLE"])(
    "rejects invalid window '%s'",
    (input) => {
      expect(() => parseWindow(input)).toThrow();
    },
  );
});

describe("renderAuditResult", () => {
  it("includes claim, n, verdict, warnings, and stratification in output", () => {
    const samples: Sample[] = [
      ...Array.from({ length: 80 }, () => ({ bucket: "big", value: 1 })),
      ...Array.from({ length: 20 }, () => ({ bucket: "small", value: 0 })),
    ];
    const r = auditAggregate(samples, {
      claim: "trilogy utility",
      baseline: 0.5,
    });
    const out = renderAuditResult(r);
    expect(out).toContain("trilogy utility");
    expect(out).toContain("n=100");
    expect(out).toContain("Stratification");
    expect(out).toContain("big");
    expect(out).toContain("small");
    expect(out).toContain("WARNINGS");
  });

  it("renders verified result without warning section", () => {
    const samples: Sample[] = Array.from({ length: 50 }, () => ({ value: 1 }));
    const r = auditAggregate(samples, { claim: "healthy" });
    const out = renderAuditResult(r);
    expect(out).toContain("VERIFIED");
    expect(out).not.toContain("Warnings:");
  });
});

// ---------------------------------------------------------------------------
// Metric runners — DB-backed
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import { closeDatabase, initDatabase } from "../db/index.js";

let testDb: Database.Database;

beforeEach(() => {
  testDb = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("runAudit — utility metric", () => {
  it("reproduces the trilogy bank-stratified split from synthetic data", async () => {
    // 69 mc-operational rows at 88% utility; 50 mc-jarvis rows at 7%
    const ins = testDb.prepare(
      "INSERT INTO recall_audit (bank, query, source, was_used) VALUES (?, 'q', ?, ?)",
    );
    for (let i = 0; i < 69; i++)
      ins.run("mc-operational", "hindsight", i < 61 ? 1 : 0); // ~88%
    for (let i = 0; i < 50; i++)
      ins.run("mc-jarvis", "hindsight", i < 4 ? 1 : 0); // ~8%

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({
      metric: "utility",
      window: "24h",
      stratifyBy: "bank",
    });

    // The aggregate sits between the two extremes
    expect(r.n).toBe(119);
    expect(r.mean).toBeCloseTo((61 + 4) / 119, 2);
    expect(r.stratification).toHaveLength(2);
    expect(
      r.stratification.find((b) => b.bucket === "mc-operational")?.mean,
    ).toBeCloseTo(61 / 69, 2);
    expect(
      r.stratification.find((b) => b.bucket === "mc-jarvis")?.mean,
    ).toBeCloseTo(4 / 50, 2);
    expect(r.warnings).toContain("stratification-divergence");
  });

  it("respects the time window — only rows in last N hours counted", async () => {
    const ins = testDb.prepare(
      "INSERT INTO recall_audit (bank, query, source, was_used, created_at) VALUES (?, 'q', ?, ?, datetime('now', ?))",
    );
    // 30 fresh rows in window
    for (let i = 0; i < 30; i++) ins.run("a", "hindsight", 1, "-10 minutes");
    // 30 stale rows outside window
    for (let i = 0; i < 30; i++) ins.run("a", "hindsight", 0, "-2 hours");

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({ metric: "utility", window: "1h" });
    expect(r.n).toBe(30);
    expect(r.mean).toBe(1);
  });

  it("excludes rows where was_used IS NULL (pending matches)", async () => {
    const ins = testDb.prepare(
      "INSERT INTO recall_audit (bank, query, source, was_used) VALUES (?, 'q', ?, ?)",
    );
    for (let i = 0; i < 20; i++) ins.run("a", "hindsight", 1);
    for (let i = 0; i < 80; i++) ins.run("a", "hindsight", null);

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({ metric: "utility", window: "24h" });
    expect(r.n).toBe(20);
  });

  // Shadow rows are computed, never injected: they measure relevance, not
  // delivered utility or latency, so only a stratified view shows them.
  it("keeps precedents-shadow rows out of the unstratified utility and latency headlines", async () => {
    const ins = testDb.prepare(
      "INSERT INTO recall_audit (bank, query, source, was_used, latency_ms) VALUES ('a', 'q', ?, ?, ?)",
    );
    for (let i = 0; i < 10; i++) ins.run("hindsight", 1, 100);
    for (let i = 0; i < 10; i++) ins.run("precedents-shadow", 0, 900);

    const { runAudit } = await import("./self-audit.js");
    const utility = runAudit({ metric: "utility", window: "24h" });
    expect(utility.n).toBe(10);
    expect(utility.mean).toBe(1);
    const latency = runAudit({ metric: "latency", window: "24h" });
    expect(latency.n).toBe(10);
    expect(latency.mean).toBe(100);
    const bySource = runAudit({
      metric: "utility",
      window: "24h",
      stratifyBy: "source",
    });
    expect(bySource.n).toBe(20);
    expect(
      bySource.stratification.find((b) => b.bucket === "precedents-shadow")?.n,
    ).toBe(10);
  });
});

describe("runAudit — cache-hit metric", () => {
  it("computes cache_read / prompt ratio and stratifies by agent_type", async () => {
    const ins = testDb.prepare(
      "INSERT INTO cost_ledger (run_id, task_id, agent_type, prompt_tokens, cache_read_tokens) VALUES ('r', 't', ?, ?, ?)",
    );
    // fast: 50 rows, 90% cache hit
    for (let i = 0; i < 50; i++) ins.run("fast", 1000, 900);
    // heavy: 50 rows, 20% cache hit
    for (let i = 0; i < 50; i++) ins.run("heavy", 1000, 200);

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({
      metric: "cache-hit",
      window: "24h",
      stratifyBy: "agent_type",
    });
    expect(r.mean).toBeCloseTo(0.55, 2);
    expect(r.stratification.find((b) => b.bucket === "fast")?.mean).toBeCloseTo(
      0.9,
      2,
    );
    expect(
      r.stratification.find((b) => b.bucket === "heavy")?.mean,
    ).toBeCloseTo(0.2, 2);
    expect(r.warnings).toContain("stratification-divergence");
  });

  it("skips rows with prompt_tokens=0 to avoid divide-by-zero", async () => {
    const ins = testDb.prepare(
      "INSERT INTO cost_ledger (run_id, task_id, agent_type, prompt_tokens, cache_read_tokens) VALUES ('r', 't', ?, ?, ?)",
    );
    for (let i = 0; i < 30; i++) ins.run("fast", 1000, 800);
    for (let i = 0; i < 30; i++) ins.run("fast", 0, 0); // junk rows

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({ metric: "cache-hit", window: "24h" });
    expect(r.n).toBe(30);
  });
});

describe("runAudit — latency metric (continuous)", () => {
  it("uses adaptive divergence threshold for ms-scale values", async () => {
    const ins = testDb.prepare(
      "INSERT INTO recall_audit (bank, query, source, latency_ms) VALUES (?, 'q', ?, ?)",
    );
    // sqlite: 50 rows at ~400ms; hindsight: 50 rows at ~5000ms
    // aggregate ~2700ms; 15% threshold = ~405ms; both buckets diverge
    for (let i = 0; i < 50; i++) ins.run("a", "sqlite-only", 400 + (i % 10));
    for (let i = 0; i < 50; i++)
      ins.run("a", "hindsight-success", 5000 + (i % 100));

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({
      metric: "latency",
      window: "24h",
      stratifyBy: "source",
    });
    expect(r.n).toBe(100);
    // aggregate ~2700ms
    expect(r.mean).toBeGreaterThan(2000);
    expect(r.mean).toBeLessThan(3000);
    expect(r.warnings).toContain("stratification-divergence");
  });
});

describe("runAudit — cost metric (continuous)", () => {
  it("aggregates cost_usd and stratifies", async () => {
    const ins = testDb.prepare(
      "INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd) VALUES ('r', 't', ?, ?)",
    );
    for (let i = 0; i < 30; i++) ins.run("fast", 0.001);
    for (let i = 0; i < 30; i++) ins.run("heavy", 0.05);
    // Outside the 24-hour window: never counted.
    const stale = testDb.prepare(
      "INSERT INTO cost_ledger (run_id, task_id, agent_type, cost_usd, created_at) VALUES ('r', 't', ?, ?, datetime('now','-2 days'))",
    );
    for (let i = 0; i < 10; i++) stale.run("heavy", 5);

    const { runAudit } = await import("./self-audit.js");
    const r = runAudit({
      metric: "cost",
      window: "24h",
      stratifyBy: "agent_type",
    });
    expect(r.n).toBe(60);
    expect(r.sum).toBeCloseTo(30 * 0.001 + 30 * 0.05, 5);
    // heavy bucket dominates and diverges → flagged
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("runAudit — error handling", () => {
  it("rejects unknown metric", async () => {
    const { runAudit } = await import("./self-audit.js");
    expect(() =>
      runAudit({ metric: "frobozz" as never, window: "24h" }),
    ).toThrow(/Unknown metric/);
  });

  it("propagates parseWindow errors", async () => {
    const { runAudit } = await import("./self-audit.js");
    expect(() =>
      runAudit({ metric: "utility", window: "1y" as never }),
    ).toThrow(/Invalid window/);
  });
});

describe("runAudit — SQL injection guard on stratifyBy", () => {
  // stratifyBy is interpolated into SQL (column references can't be bound).
  // The TS union is a compile-time-only constraint; JSON.parse from the CLI
  // can deliver any string. The runtime allowlist must reject unknowns.
  it.each([
    ["utility", "bank); DROP TABLE recall_audit;--"],
    ["utility", "1=1"],
    ["utility", ""],
    ["cache-hit", "agent_type, (SELECT * FROM cost_ledger) AS x"],
    ["cache-hit", "task_id"], // real column but not allowlisted
    ["latency", "result_count"], // real column but not allowlisted
    ["cost", "cost_usd"], // real column but not allowlisted
  ])(
    "rejects injection-shaped stratifyBy '%s' for metric '%s'",
    async (metric, stratify) => {
      const { runAudit } = await import("./self-audit.js");
      expect(() =>
        runAudit({
          metric: metric as never,
          window: "24h",
          stratifyBy: stratify,
        }),
      ).toThrow(/Invalid stratifyBy/);
    },
  );

  it("accepts undefined stratifyBy (no-op)", async () => {
    const { runAudit } = await import("./self-audit.js");
    expect(() => runAudit({ metric: "utility", window: "24h" })).not.toThrow();
  });

  it("accepts each allowlisted column without throwing", async () => {
    const { runAudit } = await import("./self-audit.js");
    const allowed: Array<[string, string]> = [
      ["utility", "bank"],
      ["utility", "source"],
      ["utility", "match_type"],
      ["cache-hit", "agent_type"],
      ["cache-hit", "model"],
      ["latency", "bank"],
      ["latency", "source"],
      ["cost", "agent_type"],
      ["cost", "model"],
    ];
    for (const [metric, col] of allowed) {
      expect(() =>
        runAudit({
          metric: metric as never,
          window: "24h",
          stratifyBy: col,
        }),
      ).not.toThrow();
    }
  });
});

describe("auditAggregate — default-handling regressions", () => {
  // Caller passing {minN: undefined} (e.g., from JSON.parse output where the
  // field was absent and jq's null-elision didn't fire) used to clobber the
  // default via spread. Fixed 2026-05-03 by destructuring with `=` defaults.
  it("treats explicit undefined as 'use default' for minN", () => {
    const samples: Sample[] = Array.from({ length: 50 }, () => ({ value: 1 }));
    const r = auditAggregate(samples, {
      claim: "test",
      minN: undefined,
    });
    expect(r.verified).toBe(true);
    expect(r.warnings).not.toContain("small-n");
  });

  it("treats explicit undefined as 'use default' for minDivergencePct", () => {
    const samples: Sample[] = [
      ...Array.from({ length: 60 }, () => ({ bucket: "a", value: 1 })),
      ...Array.from({ length: 40 }, () => ({ bucket: "b", value: 0 })),
    ];
    // aggregate=0.6, a=1.0 (delta 0.4), b=0 (delta 0.6) — both > default 0.10
    const r = auditAggregate(samples, {
      claim: "test",
      minDivergencePct: undefined,
    });
    expect(r.warnings).toContain("stratification-divergence");
  });
});
