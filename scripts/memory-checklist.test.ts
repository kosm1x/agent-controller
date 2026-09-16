/**
 * memory-checklist evaluator — pure-function contract.
 *
 * Invariants:
 *   1. Always exactly 10 rows, numbered 1..10, each with evidence text.
 *   2. Rows that can only go green in a later phase (4, 9 red; 10 amber) are
 *      pinned today and name the phase — the checklist must not flatter the
 *      current state.
 *   3. Rollback (7) is green: `mc-ctl skills revert` exists (plan G8 correction).
 *   4. Ritual freshness (8): unreachable metrics → amber, stale → red, fresh → green.
 *   5. parseRitualAges reads prom text into seconds-since-success.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateChecklist,
  parseRitualAges,
  type ChecklistInputs,
} from "./memory-checklist.js";

const BASE: ChecklistInputs = {
  episodicRows24h: 12,
  recallAudit24h: 40,
  precedentRows7d: 0,
  precedentUsed7d: 0,
  userFacts: 272,
  userFactsStale90d: 149,
  jmeFactsLive: 480,
  jmeFactsExpiredUnpruned: 2,
  triples: 2400,
  triplesClosed: 2378,
  skillsActive: 115,
  skillsCertified: 4,
  skillVersions30d: 16,
  kbSkillFiles: 10,
  ritualAgeSec: { "skill-evolution": 3600, "nightly-close": 7200 },
};

describe("evaluateChecklist", () => {
  it("returns 10 numbered rows with evidence", () => {
    const rows = evaluateChecklist(BASE);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of rows) expect(r.evidence.length).toBeGreaterThan(10);
  });

  it("keeps the not-yet-built items red and names their phase", () => {
    const byN = Object.fromEntries(evaluateChecklist(BASE).map((r) => [r.n, r]));
    expect(byN[4].status).toBe("red");
    expect(byN[4].phase).toBe("P2");
    expect(byN[9].status).toBe("red");
    expect(byN[9].phase).toBe("P3");
    expect(byN[7].status).toBe("green");
  });

  it("precedents: red with no rows, amber when logged but never re-derived, green once re-derived", () => {
    const at = (rows: number, used: number) =>
      evaluateChecklist({ ...BASE, precedentRows7d: rows, precedentUsed7d: used })[1].status;
    expect(at(0, 0)).toBe("red");
    expect(at(20, 0)).toBe("amber");
    expect(at(20, 3)).toBe("green");
  });

  it("ritual freshness: unreachable → amber, stale → red, fresh → green", () => {
    const at = (ages: ChecklistInputs["ritualAgeSec"]) =>
      evaluateChecklist({ ...BASE, ritualAgeSec: ages })[7];
    expect(at(null).status).toBe("amber");
    expect(at(null).evidence).toContain("unreachable");
    expect(at({ "skill-evolution": 3 * 86_400, "nightly-close": 100 }).status).toBe("red");
    expect(at({ "skill-evolution": 100 }).status).toBe("red"); // nightly-close missing
    expect(at(BASE.ritualAgeSec).status).toBe("green");
  });

  it("forgetting: stays amber even with zero counters — no runForgetting() exists yet (P5)", () => {
    expect(evaluateChecklist(BASE)[9].status).toBe("amber");
    const empty = evaluateChecklist({ ...BASE, jmeFactsExpiredUnpruned: 0, userFactsStale90d: 0 })[9];
    expect(empty.status).toBe("amber");
    expect(empty.phase).toBe("P5 runForgetting()");
  });
});

describe("parseRitualAges", () => {
  it("maps ritual_id to seconds since the published epoch", () => {
    const text = [
      "# HELP mc_ritual_last_success_timestamp x",
      'mc_ritual_last_success_timestamp{ritual_id="skill-evolution"} 1000',
      'mc_ritual_last_success_timestamp{ritual_id="nightly-close"} 1500',
      'mc_other_metric{ritual_id="nightly-close"} 9',
    ].join("\n");
    expect(parseRitualAges(text, 2000)).toEqual({
      "skill-evolution": 1000,
      "nightly-close": 500,
    });
  });

  it("clamps a future timestamp to 0 and ignores unrelated lines", () => {
    expect(parseRitualAges('mc_ritual_last_success_timestamp{ritual_id="a"} 5000', 2000)).toEqual({ a: 0 });
    expect(parseRitualAges("nothing here", 2000)).toEqual({});
  });
});
