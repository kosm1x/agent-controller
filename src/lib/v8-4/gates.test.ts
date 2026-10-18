/**
 * V8.4 completion ledger — the harness-owned gates table and its invariants:
 * additions only, met needs evidence, abandoned is final, unknown mode = off.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "../../db/index.js";
import { gateRefusalsTotal } from "./gate-metrics.js";
import {
  abandonPlanGatesForGoals,
  declareGates,
  formatLedgerBlock,
  freezeGates,
  gateSpecsFromGoal,
  isLiteralSourcedCheck,
  gatesMode,
  namesGuessedKbRoot,
  hasGates,
  ledgerSummaryJson,
  ledgerVerdict,
  listGates,
  parseAbandonLines,
  parseGateSpecs,
  recordGateResult,
  renderGatesBlock,
} from "./gates.js";

beforeEach(() => {
  initDatabase(":memory:");
});
afterEach(() => {
  closeDatabase();
});

async function refusals(source: string, reason: string): Promise<number> {
  const m = await gateRefusalsTotal.get();
  return m.values.find((v) => v.labels.source === source && v.labels.reason === reason)?.value ?? 0;
}

describe("gatesMode", () => {
  it("defaults to off and treats unknown values as off (dormant is the safe direction)", () => {
    expect(gatesMode({})).toBe("off");
    expect(gatesMode({ TASK_GATES_MODE: "banana" })).toBe("off");
    expect(gatesMode({ TASK_GATES_MODE: "SHADOW " })).toBe("shadow");
    expect(gatesMode({ TASK_GATES_MODE: "enforce" })).toBe("enforce");
  });
});

describe("parseGateSpecs", () => {
  it("accepts a JSON string or array and normalizes", () => {
    const specs = parseGateSpecs(
      '[{"criterion":" three tiers render ","check":"node c.js","expect":"3/3"},{"criterion":"manual one"}]',
    );
    expect(specs).toEqual([
      { criterion: "three tiers render", check: "node c.js", expect: "3/3" },
      { criterion: "manual one" },
    ]);
    expect(parseGateSpecs("")).toEqual([]);
    expect(parseGateSpecs(null)).toEqual([]);
  });

  it("rejects malformed entries loudly", () => {
    expect(() => parseGateSpecs("{}")).toThrow(/array/);
    expect(() => parseGateSpecs([{ check: "x" }])).toThrow(/criterion/);
    expect(() => parseGateSpecs([{ criterion: "c", id: "bad id!" }])).toThrow(
      /id/,
    );
    expect(() => parseGateSpecs([{ criterion: "c", kind: "shell" }])).toThrow(
      /requires a check/,
    );
    expect(() => parseGateSpecs([{ criterion: "c", kind: "weird" }])).toThrow(
      /kind/,
    );
    expect(() => parseGateSpecs([{ criterion: "c", check: "" }])).toThrow(
      /check/,
    );
  });

  it("refuses an expect that cannot fail, names the fix, and keeps the grammar + blank expect", () => {
    expect(() =>
      parseGateSpecs([{ criterion: "c", check: "grep -c x f", expect: "/[0-9]/" }]),
    ).toThrow(/names only digits.*gt 0/);
    expect(() =>
      parseGateSpecs([{ criterion: "c", check: "wc -l f", expect: "/^[1-9][0-9]*$/m" }]),
    ).toThrow(/names only digits/);
    expect(() =>
      parseGateSpecs([{ criterion: "c", check: "wc -l f", expect: "gte ten" }]),
    ).toThrow(/not a test/);
    expect(
      parseGateSpecs([
        { criterion: "c", check: "grep -c x f", expect: "gt 0" },
        { criterion: "d", check: "curl -s u", expect: "/[0-9a-f]{7}/" },
        { criterion: "e", check: "test -f f", expect: "" },
      ]),
    ).toEqual([
      { criterion: "c", check: "grep -c x f", expect: "gt 0" },
      { criterion: "d", check: "curl -s u", expect: "/[0-9a-f]{7}/" },
      { criterion: "e", check: "test -f f", expect: "" },
    ]);
  });
});

describe("declareGates / listGates / freezeGates", () => {
  it("auto-assigns G<n> ids, infers kind, and never overwrites an existing gate", () => {
    const n = declareGates(
      "t1",
      [
        { criterion: "typecheck", check: "npx tsc --noEmit" },
        { criterion: "eyeball it" },
        { id: "land", criterion: "landed", kind: "landing" },
      ],
      "submission",
    );
    expect(n).toBe(3);
    const rows = listGates("t1");
    expect(rows.map((r) => [r.gate_id, r.check_kind, r.state])).toEqual([
      ["G1", "shell", "pending"],
      ["G2", "manual", "pending"],
      ["land", "landing", "pending"],
    ]);
    // Re-declaring G1 with a different criterion is IGNORED — additions only.
    const again = declareGates(
      "t1",
      [{ id: "G1", criterion: "something else" }],
      "plan",
    );
    expect(again).toBe(0);
    expect(listGates("t1")[0]!.criterion).toBe("typecheck");
    // A new id is still accepted later (harness landing gate at completion).
    expect(
      declareGates(
        "t1",
        [{ id: "G-landing", criterion: "x", kind: "landing" }],
        "harness",
      ),
    ).toBe(1);
    expect(hasGates("t1")).toBe(true);
    expect(hasGates("nope")).toBe(false);
  });

  it("auto ids skip taken ones", () => {
    declareGates(
      "t2",
      [
        { id: "G1", criterion: "a" },
        { id: "G2", criterion: "b" },
      ],
      "submission",
    );
    declareGates("t2", [{ criterion: "c" }], "submission");
    expect(listGates("t2").map((r) => r.gate_id)).toEqual(["G1", "G2", "G3"]);
  });

  it("rejects an invalid explicit id", () => {
    expect(() =>
      declareGates("t3", [{ id: "has space", criterion: "a" }], "submission"),
    ).toThrow(/not valid/);
  });

  it("freeze stamps frozen_at once", () => {
    declareGates("t4", [{ criterion: "a" }], "submission");
    expect(listGates("t4")[0]!.frozen_at).toBeNull();
    freezeGates("t4");
    const first = listGates("t4")[0]!.frozen_at;
    expect(first).not.toBeNull();
    freezeGates("t4");
    expect(listGates("t4")[0]!.frozen_at).toBe(first);
  });
});

describe("recordGateResult", () => {
  beforeEach(() => {
    declareGates(
      "t5",
      [{ criterion: "a", check: "true" }, { criterion: "b" }],
      "submission",
    );
  });

  it("met REQUIRES evidence — a checkbox is a claim, evidence is the proof", () => {
    expect(() =>
      recordGateResult("t5", "G1", { state: "met", evidence: "   " }),
    ).toThrow(/requires evidence/);
    expect(
      recordGateResult("t5", "G1", { state: "met", evidence: "3/3 ok" }),
    ).toBe(true);
    expect(listGates("t5")[0]).toMatchObject({
      state: "met",
      evidence: "3/3 ok",
    });
    expect(listGates("t5")[0]!.checked_at).not.toBeNull();
  });

  it("failed records evidence; a rerun can flip failed→met and met→failed", () => {
    recordGateResult("t5", "G1", { state: "failed", evidence: "exit 1" });
    expect(listGates("t5")[0]!.state).toBe("failed");
    recordGateResult("t5", "G1", { state: "met", evidence: "ok now" });
    expect(listGates("t5")[0]!.state).toBe("met");
    recordGateResult("t5", "G1", { state: "failed", evidence: "regressed" });
    expect(listGates("t5")[0]!.state).toBe("failed");
  });

  it("abandoned needs a reason, is final, and never comes back", () => {
    expect(() =>
      recordGateResult("t5", "G2", { state: "abandoned", reason: "" }),
    ).toThrow(/reason/);
    expect(
      recordGateResult("t5", "G2", { state: "abandoned", reason: "no oracle" }),
    ).toBe(true);
    expect(recordGateResult("t5", "G2", { state: "met", evidence: "x" })).toBe(
      false,
    );
    expect(
      recordGateResult("t5", "G2", { state: "abandoned", reason: "again" }),
    ).toBe(false);
    expect(listGates("t5")[1]).toMatchObject({
      state: "abandoned",
      abandon_reason: "no oracle",
    });
  });

  it("a MET gate cannot be abandoned (nothing to surrender)", () => {
    recordGateResult("t5", "G1", { state: "met", evidence: "ok" });
    expect(
      recordGateResult("t5", "G1", { state: "abandoned", reason: "why" }),
    ).toBe(false);
  });

  it("unknown gate id changes nothing", () => {
    expect(
      recordGateResult("t5", "G9", { state: "failed", evidence: "x" }),
    ).toBe(false);
  });
});

describe("parseAbandonLines", () => {
  it("parses ABANDON lines with optional dash and trailing colon", () => {
    const text = [
      "Done with most of it.",
      "ABANDON: G2 no test oracle available",
      "  ABANDON: g-1.2 — sandbox has no network",
      "ABANDON: G3:",
      "not an ABANDON: G4 line because it does not start the line",
    ].join("\n");
    expect(parseAbandonLines(text)).toEqual([
      { gateId: "G2", reason: "no test oracle available" },
      { gateId: "g-1.2", reason: "sandbox has no network" },
      { gateId: "G3", reason: "(no reason given)" },
    ]);
  });
});

describe("ledgerVerdict", () => {
  const row = (over: Partial<ReturnType<typeof listGates>[number]>) =>
    ({
      task_id: "t",
      gate_id: "G",
      criterion: "c",
      check_kind: "shell",
      check_cmd: "true",
      expect: null,
      state: "pending",
      evidence: null,
      abandon_reason: null,
      source: "submission",
      frozen_at: null,
      checked_at: null,
      created_at: "",
      ...over,
    }) as ReturnType<typeof listGates>[number];

  it("none / met / failed dominates / unverified for pending", () => {
    expect(ledgerVerdict([]).verdict).toBe("none");
    expect(ledgerVerdict([row({ state: "met", evidence: "ok" })]).verdict).toBe(
      "met",
    );
    expect(
      ledgerVerdict([
        row({ state: "met", evidence: "ok" }),
        row({ gate_id: "H", state: "abandoned", abandon_reason: "r" }),
      ]).verdict,
    ).toBe("met");
    expect(
      ledgerVerdict([
        row({ state: "failed", evidence: "x" }),
        row({ gate_id: "H", state: "pending" }),
      ]).verdict,
    ).toBe("failed");
    expect(ledgerVerdict([row({ state: "pending" })]).verdict).toBe(
      "unverified",
    );
  });

  it("an all-ABANDONED ledger is unverified (met: 0), never met", () => {
    const v = ledgerVerdict([
      row({ state: "abandoned", abandon_reason: "check rejected by shell guard" }),
      row({ gate_id: "H", state: "abandoned", abandon_reason: "undefined $X" }),
    ]);
    expect(v.verdict).toBe("unverified");
    expect(v.met).toBe(0);
    expect(v.abandoned).toBe(2);
  });

  it("met WITHOUT evidence counts as pending (unmet), never as met", () => {
    const v = ledgerVerdict([row({ state: "met", evidence: "" })]);
    expect(v.verdict).toBe("unverified");
    expect(v.met).toBe(0);
    expect(v.pending).toBe(1);
  });
});

describe("rendering", () => {
  it("renderGatesBlock shows CHECK/EXPECT, landing and manual variants plus the ABANDON syntax", () => {
    declareGates(
      "t6",
      [
        {
          criterion: "typecheck passes",
          check: "npx tsc --noEmit",
          expect: "/^$/",
        },
        { criterion: "reads well" },
        { id: "G-landing", criterion: "landed", kind: "landing" },
      ],
      "submission",
    );
    const block = renderGatesBlock(listGates("t6"));
    expect(block).toContain("## Acceptance gates");
    expect(block).toContain(
      "- G1: typecheck passes [CHECK: npx tsc --noEmit → EXPECT: /^$/]",
    );
    expect(block).toContain("- G2: reads well [manual");
    expect(block).toContain("- G-landing: landed [harness verifies");
    expect(block).toContain("ABANDON: <gate id> <reason>");
    expect(renderGatesBlock([])).toBe("");
  });

  it("formatLedgerBlock + ledgerSummaryJson list failed, unverified and abandoned explicitly", () => {
    declareGates(
      "t7",
      [
        { criterion: "a", check: "true" },
        { criterion: "b" },
        { criterion: "c", check: "false" },
      ],
      "submission",
    );
    recordGateResult("t7", "G1", { state: "met", evidence: "ok" });
    recordGateResult("t7", "G3", { state: "failed", evidence: "exit 1" });
    const rows = listGates("t7");
    expect(formatLedgerBlock(rows)).toBe(
      "Gates: 1/3 met · verdict failed · FAILED: G3 (exit 1) · unverified: G2",
    );
    recordGateResult("t7", "G2", { state: "abandoned", reason: "no oracle" });
    expect(formatLedgerBlock(listGates("t7"))).toContain(
      "ABANDONED: G2 (no oracle)",
    );
    const json = ledgerSummaryJson(listGates("t7"), "shadow");
    expect(json).toMatchObject({
      mode: "shadow",
      verdict: "failed",
      total: 3,
      met: 1,
      failed: 1,
      abandoned: 1,
    });
    expect((json.gates as Array<{ id: string }>).map((g) => g.id)).toEqual([
      "G1",
      "G2",
      "G3",
    ]);
    expect(formatLedgerBlock([])).toBe("");
  });
});

// Task 60c6bf31 (2026-10-12): ONE verdict — ledgerVerdict over the FULL
// ledger — reaches the footer and the JSON; read-back rows are counted apart.
describe("one verdict across ledgerVerdict, formatLedgerBlock and ledgerSummaryJson", () => {
  type GateRow = ReturnType<typeof listGates>[number];
  const row = (over: Partial<GateRow>): GateRow => ({
    task_id: "t",
    gate_id: "G",
    criterion: "c",
    check_kind: "shell",
    check_cmd: "true",
    expect: null,
    state: "pending",
    evidence: null,
    abandon_reason: null,
    source: "plan",
    frozen_at: null,
    checked_at: null,
    created_at: "",
    ...over,
  });
  const rb = (over: Partial<GateRow> = {}): GateRow =>
    row({
      gate_id: "RB-1234abcd",
      check_kind: "manual",
      check_cmd: 'readback:{"tool":"fake_write","data":{}}',
      source: "harness",
      ...over,
    });
  const verdicts = (rows: GateRow[]) => ({
    ledger: ledgerVerdict(rows).verdict,
    footer: formatLedgerBlock(rows).match(/· verdict (\w+)/)?.[1] ?? "none",
    json: ledgerSummaryJson(rows, "enforce").verdict,
  });

  it("abandoned plan gate + met read-back (the 60c6bf31 row set) → met, met, met", () => {
    const rows = [
      row({
        gate_id: "g1.1",
        state: "abandoned",
        evidence: "check rejected by shell guard: write to '/x;' outside allowed paths",
        abandon_reason: "check rejected by shell guard: write to '/x;' outside allowed paths",
      }),
      rb({ state: "met", evidence: "KB x.md releído" }),
    ];
    expect(verdicts(rows)).toEqual({ ledger: "met", footer: "met", json: "met" });
    expect(formatLedgerBlock(rows)).toBe(
      "Gates: 0/1 met · readback 1/1 met · verdict met · ABANDONED: g1.1 (check rejected by shell guard: write to '/x;' outside allowed paths)",
    );
    const json = ledgerSummaryJson(rows, "enforce");
    expect(json).toMatchObject({ total: 1, met: 0, abandoned: 1, readback: { total: 1, met: 1 } });
  });

  it("failed plan gate + met read-back → failed, failed, failed", () => {
    const rows = [
      row({ state: "failed", evidence: "exit 1" }),
      rb({ state: "met", evidence: "ok" }),
    ];
    expect(verdicts(rows)).toEqual({ ledger: "failed", footer: "failed", json: "failed" });
  });

  it("met plan gate + FAILED read-back → failed everywhere (the footer no longer reads all-met)", () => {
    const rows = [
      row({ state: "met", evidence: "ok" }),
      rb({ state: "failed", evidence: "no existe" }),
    ];
    expect(verdicts(rows)).toEqual({ ledger: "failed", footer: "failed", json: "failed" });
    expect(formatLedgerBlock(rows)).toBe(
      "Gates: 1/1 met · readback 0/1 met · verdict failed",
    );
  });

  it("all pending → unverified everywhere; no rows → none and no footer", () => {
    const rows = [row({ state: "pending" }), rb({ state: "pending" })];
    expect(verdicts(rows)).toEqual({
      ledger: "unverified",
      footer: "unverified",
      json: "unverified",
    });
    expect(verdicts([])).toEqual({ ledger: "none", footer: "none", json: "none" });
    expect(formatLedgerBlock([])).toBe("");
  });

  it("read-back rows alone render no English block (their Spanish lines speak)", () => {
    expect(formatLedgerBlock([rb({ state: "met", evidence: "ok" })])).toBe("");
  });

  it("an explicit verdict argument is what both renderers state", () => {
    const rows = [row({ state: "met", evidence: "ok" })];
    expect(formatLedgerBlock(rows, "failed")).toBe("Gates: 1/1 met · verdict failed");
    expect(ledgerSummaryJson(rows, "enforce", "failed").verdict).toBe("failed");
  });
});

describe("gateSpecsFromGoal", () => {
  it("turns planner object-form criteria into <goal>.<n> shell gates and drops junk", () => {
    const specs = gateSpecsFromGoal("g-2", {
      gates: [
        { criterion: "tests pass", check: "npx vitest run", expect: "passed" },
        { criterion: "no check" },
        "string",
        { criterion: "", check: "x" },
        { criterion: "typecheck", check: "npx tsc --noEmit" },
      ],
    });
    expect(specs).toEqual([
      {
        id: "g-2.1",
        criterion: "tests pass",
        check: "npx vitest run",
        expect: "passed",
        kind: "shell",
      },
      {
        id: "g-2.5",
        criterion: "typecheck",
        check: "npx tsc --noEmit",
        kind: "shell",
      },
    ]);
    expect(gateSpecsFromGoal("g", undefined)).toEqual([]);
    expect(gateSpecsFromGoal("g", { gates: "nope" })).toEqual([]);
  });

  it("abandons a plan gate whose expect cannot fail (live ledger 2026-09-12: /[0-9]/ on grep -c was MET by 0) and keeps comparators", () => {
    const specs = gateSpecsFromGoal("g-7", {
      gates: [
        { criterion: "model output present", check: "grep -c 'MODEL OUTPUT' w37.md", expect: "/[0-9]/" },
        { criterion: "model output present", check: "grep -c 'MODEL OUTPUT' w37.md", expect: "gt 0" },
        { criterion: "titles exist", check: "grep -h '^title' w3*.md", expect: "/[1-9]/" },
        { criterion: "blank expect still means exit code", check: "test -f w37.md", expect: "  " },
        { criterion: "oversize regex", check: "grep x f", expect: "/" + "a".repeat(600) + "/" },
      ],
    });
    expect(specs).toEqual([
      {
        id: "g-7.1",
        criterion: "model output present",
        kind: "manual",
        abandonReason: expect.stringMatching(/^expect cannot fail — expect \/\[0-9\]\/ names only digits/),
      },
      { id: "g-7.2", criterion: "model output present", check: "grep -c 'MODEL OUTPUT' w37.md", expect: "gt 0", kind: "shell" },
      {
        id: "g-7.3",
        criterion: "titles exist",
        kind: "manual",
        abandonReason: expect.stringMatching(/names only digits/),
      },
      { id: "g-7.4", criterion: "blank expect still means exit code", check: "test -f w37.md", kind: "shell" },
      {
        id: "g-7.5",
        criterion: "oversize regex",
        kind: "manual",
        abandonReason: "expect cannot fail — expect is longer than 500 chars",
      },
    ]);
    // The abandoned row lands in the ledger as a visible surrender, never MET.
    expect(declareGates("t-expect", specs, "plan")).toBe(5);
    const rows = listGates("t-expect");
    expect(rows.map((r) => [r.gate_id, r.state])).toEqual([
      ["g-7.1", "abandoned"],
      ["g-7.2", "pending"],
      ["g-7.3", "abandoned"],
      ["g-7.4", "pending"],
      ["g-7.5", "abandoned"],
    ]);
    expect(rows[0]!.abandon_reason).toMatch(/expect cannot fail/);
    // Verdict level: abandoned rows neither pass nor demote; pending ones keep it unverified.
    expect(ledgerVerdict(rows)).toMatchObject({ verdict: "unverified", met: 0, failed: 0 });
    // A ledger whose ONLY gates were refused proved nothing: unverified with
    // met:0 (was "met" with met:0 until 2026-09-18 — changed deliberately when
    // guard-rejected checks started abandoning instead of failing, qa W4).
    expect(ledgerVerdict(rows.filter((r) => r.state === "abandoned"))).toMatchObject({
      verdict: "unverified",
      met: 0,
      abandoned: 3,
    });
  });

  it("declareGates is the floor: a producer that skips validation still cannot land a can't-fail expect as pending", async () => {
    const before = await refusals("declare", "unsettleable_expect");
    expect(
      declareGates(
        "t-floor",
        [
          { criterion: "raw", check: "grep -c x f", expect: "/[0-9]/" },
          { criterion: "fine", check: "grep -c x f", expect: "gt 0" },
        ],
        "submission",
      ),
    ).toBe(2);
    expect(listGates("t-floor").map((r) => [r.gate_id, r.state])).toEqual([
      ["G1", "abandoned"],
      ["G2", "pending"],
    ]);
    expect(listGates("t-floor")[0]!.abandon_reason).toMatch(/expect cannot fail/);
    expect(await refusals("declare", "unsettleable_expect")).toBe(before + 1);
  });

  it("the refusal counter ticks at the write-time doors, not on a stored re-parse", async () => {
    const specBefore = await refusals("spec", "unsettleable_expect");
    const planBefore = await refusals("plan", "unsettleable_expect");
    expect(() =>
      parseGateSpecs([{ criterion: "c", check: "wc -l f", expect: "/[1-9]/" }]),
    ).toThrow();
    expect(await refusals("spec", "unsettleable_expect")).toBe(specBefore + 1);
    gateSpecsFromGoal("g-m", { gates: [{ criterion: "c", check: "wc -l f", expect: "/[1-9]/" }] });
    expect(await refusals("plan", "unsettleable_expect")).toBe(planBefore + 1);
    // Stored payload (a schedule's gates column) degrades to an abandoned spec, silently for the metric.
    const stored = parseGateSpecs(
      [{ criterion: "c", check: "wc -l f", expect: "/[1-9]/" }],
      { onUnsettleableExpect: "abandon" },
    );
    expect(stored).toEqual([
      {
        criterion: "c",
        check: "wc -l f",
        expect: "/[1-9]/",
        abandonReason: expect.stringMatching(/^expect cannot fail/),
      },
    ]);
    expect(await refusals("spec", "unsettleable_expect")).toBe(specBefore + 1);
  });

  it("produced ids are declarable (id charset) even for odd goal ids", () => {
    const specs = gateSpecsFromGoal("goal with spaces!", {
      gates: [{ criterion: "c", check: "test -f README.md" }],
    });
    expect(specs[0]!.id).toBe("goal-with-spaces-.1");
    expect(declareGates("t8", specs, "plan")).toBe(1);
  });

  it("refuses literal-sourced checks — the planner's echo gates of 2026-09-03 (task e63ac8dc) observe nothing", () => {
    const literal = [
      "echo 'verify via gdocs_read on returned doc id'",
      "echo 'verify via gdocs_read' | grep -q 'gdocs_read' && echo 'Plan de Acción'",
      "printf 'ok\n'",
      "true",
      "false",
      ":",
      "FOO=1 echo done",
      "  echo;",
      "(echo x)",
      "{ echo x; }",
      "bash -c 'echo x'",
      'sh -c "echo ok"',
      "/bin/echo x",
      "/usr/bin/printf ok",
      "command echo x",
      "builtin echo x",
    ];
    for (const check of literal) {
      expect(isLiteralSourcedCheck(check), check).toBe(true);
    }
    const observing = [
      "grep -q 'Plan de Acción' /root/claude/jarvis-kb/projects/x.md",
      "curl -sf https://example.com | grep -q ok",
      "test -f README.md && echo ok",
      "npx vitest run src/x.test.ts",
      'sqlite3 data/mc.db "SELECT count(*) FROM tasks"',
      "cat out.txt",
      "echoing=1 cat out.txt", // not a bare `echo`
    ];
    for (const check of observing) {
      expect(isLiteralSourcedCheck(check), check).toBe(false);
    }

    const specs = gateSpecsFromGoal("g-5", {
      gates: [
        {
          criterion: "Doc reachable",
          check: "echo 'verify via gdocs_read'",
          expect: "Plan de Acción",
        },
        { criterion: "Doc has title", check: "grep -q 'Plan' /tmp/doc.txt" },
      ],
    });
    expect(specs.map((s) => s.id)).toEqual(["g-5.1", "g-5.2"]);
    // Refused visibly: the row is declared ABANDONED with the reason, so the
    // ledger lists the surrender instead of a gap (doctrine 3).
    expect(specs[0]).toMatchObject({
      kind: "manual",
      abandonReason: expect.stringContaining("literal-sourced"),
    });
    expect(specs[0]!.check).toBeUndefined();
    expect(specs[1]).toMatchObject({ kind: "shell" });

    expect(declareGates("t9", specs, "plan")).toBe(2);
    const rows = listGates("t9");
    expect(rows.find((r) => r.gate_id === "g-5.1")).toMatchObject({
      state: "abandoned",
      abandon_reason: expect.stringContaining("echo 'verify via gdocs_read'"),
      check_cmd: null,
    });
    const v = ledgerVerdict(rows);
    expect(v).toMatchObject({ total: 2, abandoned: 1, pending: 1, failed: 0 });
    expect(v.verdict).toBe("unverified"); // never "none": the surrender counts

    // The API / ritual door refuses the same shape outright.
    expect(() =>
      parseGateSpecs([{ criterion: "x", check: "echo ok", expect: "ok" }]),
    ).toThrow(/literal-sourced/);
    expect(
      parseGateSpecs([{ criterion: "x", check: "test -f README.md" }]),
    ).toHaveLength(1);
  });

  it("abandonPlanGatesForGoals surrenders only the pending PLAN gates of the named goals (early exit, qa R2 #4)", () => {
    declareGates(
      "t10",
      [
        { id: "g-1.1", criterion: "a", check: "test -f a" },
        { id: "g-10.1", criterion: "b", check: "test -f b" }, // prefix cousin
        { id: "g-2.1", criterion: "c", check: "test -f c" },
        { id: "g-2.2", criterion: "d", check: "test -f d" },
        { id: "g_3.1", criterion: "e", check: "test -f e" }, // LIKE wildcard in id
      ],
      "plan",
    );
    declareGates(
      "t10",
      [{ id: "S1", criterion: "op", check: "test -f s" }],
      "submission",
    );
    recordGateResult("t10", "g-2.2", { state: "met", evidence: "seen" });

    expect(
      abandonPlanGatesForGoals(
        "t10",
        ["g-2", "g_3", "g-9"],
        "goal unfinished — orchestrator timeout",
      ),
    ).toBe(2); // g-2.1 (pending) + g_3.1; g-2.2 already met, g-9 has none
    const by = Object.fromEntries(listGates("t10").map((r) => [r.gate_id, r]));
    expect(by["g-2.1"]).toMatchObject({
      state: "abandoned",
      abandon_reason: "goal unfinished — orchestrator timeout",
    });
    expect(by["g_3.1"]!.state).toBe("abandoned");
    expect(by["g-2.2"]!.state).toBe("met");
    expect(by["g-1.1"]!.state).toBe("pending");
    expect(by["g-10.1"]!.state).toBe("pending"); // "g-1." must not match "g-10."
    expect(by["S1"]!.state).toBe("pending"); // submission gates are never touched
    expect(abandonPlanGatesForGoals("t10", [], "x")).toBe(0);
  });
});

describe("namesGuessedKbRoot — a check on the KB root guessed one level up (queue 4d, 2026-10-17)", () => {
  // Synthetic layout: KB at /x/kb (top dirs below); /x/projects does not exist.
  const files = new Set([
    "/x/kb/projects/bet-book/README.md",
    "/x/kb/directives/core.md",
    "/x/repo/src/foo.test.ts",
  ]);
  const deps = {
    kbRoot: "/x/kb",
    kbTopDirs: ["projects", "directives", "workspace", "logs"],
    exists: (p: string) => files.has(p),
  };

  it("the live shape: an absolute path on the guessed root is refused", () => {
    expect(namesGuessedKbRoot("grep -c '^# ' /x/projects/bet-book/README.md", deps)).toBe(true);
    expect(namesGuessedKbRoot("wc -c < /x/projects/bet-book/capitulo-4-draft-1.md", deps)).toBe(true);
    expect(namesGuessedKbRoot("grep -c x '/x/projects/bet-book/README.md'", deps)).toBe(true);
  });

  it("a write-shaped command on the guessed root is refused too", () => {
    expect(namesGuessedKbRoot("cp /tmp/a /x/projects/bet-book/README.md", deps)).toBe(true);
  });

  it("an absolute token that exists on disk is not refused", () => {
    const withReal = { ...deps, exists: (p: string) => p === "/x/projects/bet-book/README.md" || files.has(p) };
    expect(namesGuessedKbRoot("grep -c '^# ' /x/projects/bet-book/README.md", withReal)).toBe(false);
  });

  it("a not-yet-written file inside an existing first-level dir of the guessed root names that real tree, not the KB", () => {
    const withRepo = { ...deps, exists: (p: string) => p === "/x/projects/real-repo" || files.has(p) };
    expect(namesGuessedKbRoot("test -f /x/projects/real-repo/index.html", withRepo)).toBe(false);
    expect(namesGuessedKbRoot("test -f /x/projects/bet-book/index.html", withRepo)).toBe(true);
  });

  it("correct absolute KB paths and relative KB paths are NOT refused (they keep running)", () => {
    for (const cmd of [
      "grep -c x /x/kb/projects/bet-book/README.md",
      "grep -c x directives/core.md",
      "grep -c x projects/bet-book/README.md",
      "npx vitest run src/foo.test.ts",
    ]) {
      expect(namesGuessedKbRoot(cmd, deps), cmd).toBe(false);
    }
  });

  it("a trailing-slash directory token, a dot segment, other roots and non-KB dirs are not refused", () => {
    for (const cmd of [
      "ls /x/logs/",
      "grep -c x /x/projects/bet-book/../../../mission-control/package.json",
      "grep -c x /x/projects/./bet-book/README.md",
      "grep -c x $HOME/projects/bet-book/README.md",
      "curl -s https://example.com/projects/bet-book/README.md",
      "grep -c x /y/projects/bet-book/README.md",
      "grep -c x /x/mission-control/src/index.ts",
      "grep -c x /x/projects",
    ]) {
      expect(namesGuessedKbRoot(cmd, deps), cmd).toBe(false);
    }
  });

  it("without injected top dirs it reads the KB root's directories (files are not top dirs)", () => {
    const kb = mkdtempSync(join(tmpdir(), "gate-kbpath-"));
    try {
      mkdirSync(join(kb, "projects"));
      writeFileSync(join(kb, "INDEX.md"), "x\n");
      const d = { kbRoot: kb, exists: () => false };
      const up = dirname(kb);
      expect(namesGuessedKbRoot(`grep -c x ${up}/projects/a.md`, d)).toBe(true);
      expect(namesGuessedKbRoot(`grep -c x ${up}/INDEX.md/a`, d)).toBe(false);
      expect(namesGuessedKbRoot(`grep -c x ${up}/notes/a.md`, d)).toBe(false);
    } finally {
      rmSync(kb, { recursive: true, force: true });
    }
  });
});

describe("gateSpecsFromGoal — a check on a guessed KB root lands ABANDONED (queue 4d)", () => {
  let kbRoot: string;
  let savedKb: string | undefined;
  beforeEach(() => {
    kbRoot = mkdtempSync(join(tmpdir(), "gate-kbspec-"));
    mkdirSync(join(kbRoot, "zz4dproj/bet-book"), { recursive: true });
    savedKb = process.env.JARVIS_KB_MIRROR_DIR;
    process.env.JARVIS_KB_MIRROR_DIR = kbRoot;
  });
  afterEach(() => {
    if (savedKb === undefined) delete process.env.JARVIS_KB_MIRROR_DIR;
    else process.env.JARVIS_KB_MIRROR_DIR = savedKb;
    rmSync(kbRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("refuses visibly, keeps the criterion, leaves relative and correct KB checks alone, and keeps the numbering", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await refusals("plan", "kb_path_check");
    const guessed = `grep -c '^# ' ${join(dirname(kbRoot), "zz4dproj/bet-book/README.md")}`;
    const correct = `grep -c '^# ' ${join(kbRoot, "zz4dproj/bet-book/README.md")}`;
    const specs = gateSpecsFromGoal("g-3", {
      gates: [
        { criterion: "README has chapter headings", check: guessed, expect: "gte 1" },
        { criterion: "draft written", check: "wc -c < zz4dproj/bet-book/capitulo-4-draft-1.md", expect: "gt 0" },
        { criterion: "same README by its real path", check: correct, expect: "gte 1" },
        { criterion: "typecheck", check: "npx tsc --noEmit" },
      ],
    });
    expect(specs).toEqual([
      {
        id: "g-3.1",
        criterion: "README has chapter headings",
        kind: "manual",
        abandonReason: `check names a guessed KB root — the harness read-back proves the write: ${guessed}`,
      },
      {
        id: "g-3.2",
        criterion: "draft written",
        check: "wc -c < zz4dproj/bet-book/capitulo-4-draft-1.md",
        expect: "gt 0",
        kind: "shell",
      },
      { id: "g-3.3", criterion: "same README by its real path", check: correct, expect: "gte 1", kind: "shell" },
      { id: "g-3.4", criterion: "typecheck", check: "npx tsc --noEmit", kind: "shell" },
    ]);
    expect(await refusals("plan", "kb_path_check")).toBe(before + 1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[gates\] g-3: plan gate 1 abandoned — check names a guessed KB root: grep -c/),
    );

    // Declared: ABANDONED with the reason, no check stored, never FAILED.
    expect(declareGates("t-kbspec", specs, "plan")).toBe(4);
    const rows = listGates("t-kbspec");
    expect(rows.map((r) => [r.gate_id, r.state, r.check_kind])).toEqual([
      ["g-3.1", "abandoned", "manual"],
      ["g-3.2", "pending", "shell"],
      ["g-3.3", "pending", "shell"],
      ["g-3.4", "pending", "shell"],
    ]);
    expect(rows[0]!.check_cmd).toBeNull();
    expect(rows[0]!.abandon_reason).toMatch(/^check names a guessed KB root — the harness read-back proves the write: grep -c/);
    expect(ledgerVerdict(rows)).toMatchObject({ failed: 0, abandoned: 1, pending: 3 });
    expect(formatLedgerBlock(rows)).not.toContain("FAILED");
  });
});
