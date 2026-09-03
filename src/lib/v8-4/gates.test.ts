/**
 * V8.4 completion ledger — the harness-owned gates table and its invariants:
 * additions only, met needs evidence, abandoned is final, unknown mode = off.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, initDatabase } from "../../db/index.js";
import {
  abandonPlanGatesForGoals,
  declareGates,
  formatLedgerBlock,
  freezeGates,
  gateSpecsFromGoal,
  isLiteralSourcedCheck,
  gatesMode,
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
      "Gates: 1/3 met · FAILED: G3 (exit 1) · unverified: G2",
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
