/**
 * Unit tests for the model-swap eval gate verdict math.
 * Pure arithmetic — no LLM, no DB. The --percase-out rule is exercised on a
 * throwaway temp tree (synthetic paths only).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareToBaseline,
  resolveEpsilon,
  DEFAULT_EPSILON,
  SCORING_VERSION,
  scoringVersionMismatch,
  percaseOutRefusal,
  parseEvalGateArgs,
  preSpendRefusal,
  baselineCaptureRefusal,
  MIN_PROBED_SHARE,
  caseIdDigest,
  populationDigests,
  populationDrift,
  errorClassLabel,
  percaseOutputRows,
  countErroredProbes,
  erroredProbeRefusal,
  readBaseline,
  parseProbeRounds,
  DEFAULT_PROBE_ROUNDS,
  toolSelectionBreakdown,
  priorBaseline,
  populationIds,
  preSpendPopulationRefusal,
  scopePromptRefusal,
  scopePromptBreakdown,
  scopePromptDrift,
  gateDecision,
  parseEpsilonFlag,
  parsePromptEpsilon,
  SCOPE_PROMPT_EPSILON,
  type EvalBaseline,
  type GateDecisionInput,
} from "./gate.js";
import type { CaseScore } from "./types.js";

describe("compareToBaseline", () => {
  it("PASSes when the candidate exactly matches the incumbent", () => {
    const r = compareToBaseline(63.35, 63.35, 2.0);
    expect(r.verdict).toBe("PASS");
    expect(r.regressed).toBe(false);
    expect(r.delta).toBeCloseTo(0, 10);
    expect(r.threshold).toBeCloseTo(61.35, 10);
  });

  it("PASSes when the candidate beats the incumbent", () => {
    const r = compareToBaseline(70, 63.35, 2.0);
    expect(r.verdict).toBe("PASS");
    expect(r.delta).toBeCloseTo(6.65, 10);
  });

  it("PASSes on a small regression WITHIN tolerance", () => {
    const r = compareToBaseline(62.0, 63.35, 2.0); // down 1.35, tol 2.0
    expect(r.verdict).toBe("PASS");
    expect(r.regressed).toBe(false);
    expect(r.delta).toBeCloseTo(-1.35, 10);
  });

  it("PASSes at the exact threshold (inclusive boundary)", () => {
    const r = compareToBaseline(61.35, 63.35, 2.0); // exactly incumbent - epsilon
    expect(r.verdict).toBe("PASS");
    expect(r.regressed).toBe(false);
    expect(r.overall).toBe(r.threshold);
  });

  it("FAILs just below the threshold", () => {
    const r = compareToBaseline(61.34, 63.35, 2.0);
    expect(r.verdict).toBe("FAIL");
    expect(r.regressed).toBe(true);
  });

  it("FAILs on a gross tool-adherence collapse (Sonnet-5 failure mode)", () => {
    const r = compareToBaseline(48.0, 63.35, 2.0);
    expect(r.verdict).toBe("FAIL");
    expect(r.regressed).toBe(true);
    expect(r.delta).toBeCloseTo(-15.35, 10);
  });

  it("applies DEFAULT_EPSILON when epsilon is omitted", () => {
    const r = compareToBaseline(63.35 - DEFAULT_EPSILON, 63.35);
    expect(r.epsilon).toBe(DEFAULT_EPSILON);
    expect(r.verdict).toBe("PASS"); // exactly on the default threshold
  });

  it("rejects a negative epsilon and falls back to DEFAULT_EPSILON", () => {
    const r = compareToBaseline(62, 63.35, -5);
    expect(r.epsilon).toBe(DEFAULT_EPSILON);
    expect(r.verdict).toBe("PASS");
  });

  it("supports epsilon = 0 (zero tolerance: any regression FAILs)", () => {
    expect(compareToBaseline(63.35, 63.35, 0).verdict).toBe("PASS");
    expect(compareToBaseline(63.34, 63.35, 0).verdict).toBe("FAIL");
  });

  it("throws on non-finite inputs (never silently PASS on NaN)", () => {
    expect(() => compareToBaseline(NaN, 63.35, 2)).toThrow();
    expect(() => compareToBaseline(63, Infinity, 2)).toThrow();
  });
});

describe("resolveEpsilon", () => {
  it("prefers the CLI flag over the file value", () => {
    expect(resolveEpsilon(2.0, 5.0)).toBe(5.0);
  });

  it("falls back to the file value when no flag is given", () => {
    expect(resolveEpsilon(3.5, undefined)).toBe(3.5);
  });

  it("falls back to DEFAULT_EPSILON when neither is valid", () => {
    expect(resolveEpsilon(undefined, undefined)).toBe(DEFAULT_EPSILON);
    expect(resolveEpsilon(-1, NaN)).toBe(DEFAULT_EPSILON);
  });

  it("accepts a zero-tolerance override", () => {
    expect(resolveEpsilon(2.0, 0)).toBe(0);
  });
});

describe("scoringVersionMismatch (2026-10-04)", () => {
  it("the current scoring generation is 4 (scope_prompt, queue 3j)", () => {
    expect(SCORING_VERSION).toBe(4);
  });

  it("the committed baseline passes the pre-spend check when captured under v4, else it exits 2 naming the re-capture", () => {
    const committed = readBaseline(() =>
      readFileSync(new URL("./eval-baseline.json", import.meta.url), "utf8"),
    );
    expect(committed).not.toBeInstanceOf(Error);
    const refusal = preSpendRefusal({
      run: true,
      updateBaseline: false,
      experiment: false,
      baseline: committed,
      baselinePath: "/repo/src/tuning/eval-baseline.json",
    });
    // FLIP AT RE-CAPTURE: the committed file is the v3 incumbent until the
    // operator runs `npm run eval:gate -- --run --update-baseline` on the
    // pushed HEAD; then change 3 → SCORING_VERSION and the refusal → null.
    expect((committed as EvalBaseline).scoringVersion).toBe(3);
    expect(refusal).toMatch(/older scoring .*re-capture with --run --update-baseline/);
  });

  it("a full v3 baseline (the pre-3j capture shape) is refused before spend (exit 2 contract)", () => {
    const v3: EvalBaseline = {
      overall: 85.01,
      scoringVersion: 3,
      toolSelectionProbedIds: [],
      toolSelectionExcludedIds: [],
    };
    expect(
      preSpendRefusal({
        run: true,
        updateBaseline: false,
        experiment: false,
        baseline: v3,
        baselinePath: "/repo/src/tuning/eval-baseline.json",
      }),
    ).toBe(
      "baseline captured under an older scoring (scoringVersion 3, current 4); re-capture with --run --update-baseline",
    );
  });

  it("a baseline with no scoringVersion is generation 1 → older-scoring refusal naming the re-capture", () => {
    const msg = scoringVersionMismatch({ overall: 36.7 });
    expect(msg).toMatch(/older scoring/);
    expect(msg).toMatch(/re-capture with --run --update-baseline/);
    expect(msg).toMatch(/scoringVersion 1, current 4/);
  });

  it("an explicitly older version is refused the same way", () => {
    expect(scoringVersionMismatch({ overall: 50, scoringVersion: 1 })).toMatch(
      /older scoring/,
    );
  });

  it("a NEWER baseline than this checkout is refused too (no verdict across generations)", () => {
    expect(
      scoringVersionMismatch({ overall: 50, scoringVersion: SCORING_VERSION + 1 }),
    ).toMatch(/NEWER scoring/);
  });

  it("the current version is comparable (null)", () => {
    expect(
      scoringVersionMismatch({ overall: 50, scoringVersion: SCORING_VERSION }),
    ).toBeNull();
  });
});

describe("percaseOutRefusal (--percase-out)", () => {
  let repo: string;
  let deps: Parameters<typeof percaseOutRefusal>[1];
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-percase-")));
    mkdirSync(join(repo, "data", "out"), { recursive: true });
    mkdirSync(join(repo, "data", "tracked"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "outside"), { recursive: true });
    symlinkSync(join(repo, "outside"), join(repo, "data", "escape"));
    symlinkSync(join(repo, "outside", "f.json"), join(repo, "data", "out", "link.json"));
    deps = {
      repoRoot: repo,
      realpath: (p) => realpathSync(p),
      isSymlink: (p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      },
      // Synthetic ignore rule: data/ is ignored except data/tracked.
      isGitIgnored: (dir) =>
        dir.startsWith(join(repo, "data")) && !dir.endsWith("tracked"),
    };
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("allows a file under the repo's gitignored data/ (relative or absolute)", () => {
    expect(percaseOutRefusal("data/out/p.json", deps)).toBeNull();
    expect(percaseOutRefusal(join(repo, "data", "p.json"), deps)).toBeNull();
  });

  it("refuses a path outside data/", () => {
    expect(percaseOutRefusal("src/p.json", deps)).toMatch(/outside the repo's data/);
    expect(percaseOutRefusal("/tmp/p.json", deps)).toMatch(/outside the repo's data/);
    expect(percaseOutRefusal("data/../src/p.json", deps)).toMatch(
      /outside the repo's data/,
    );
  });

  it("refuses a data/ directory symlinked out of data/", () => {
    expect(percaseOutRefusal("data/escape/p.json", deps)).toMatch(
      /outside the repo's data/,
    );
  });

  it("refuses a target file that is a symlink", () => {
    expect(percaseOutRefusal("data/out/link.json", deps)).toMatch(/symlink/);
  });

  it("refuses a directory git does not ignore", () => {
    expect(percaseOutRefusal("data/tracked/p.json", deps)).toMatch(
      /not gitignored/,
    );
  });

  it("refuses a missing parent directory", () => {
    expect(percaseOutRefusal("data/nope/p.json", deps)).toMatch(/does not exist/);
  });
});


describe("parseEvalGateArgs (N2)", () => {
  it("parses boolean and --flag=value forms", () => {
    expect(
      parseEvalGateArgs([
        "--run",
        "--update-baseline",
        "--epsilon=1.5",
        "--percase-out=data/x/y.json",
        "--cases-file=/tmp/ids.json",
        "--probe-system=jarvis",
      ]),
    ).toEqual({
      ok: true,
      args: {
        run: true,
        updateBaseline: true,
        epsilon: "1.5",
        percaseOut: "data/x/y.json",
        casesFile: "/tmp/ids.json",
        probeSystem: "jarvis",
      },
    });
    expect(parseEvalGateArgs([])).toEqual({
      ok: true,
      args: { run: false, updateBaseline: false },
    });
  });

  it("rejects a valueless value flag (space-separated form)", () => {
    for (const argv of [
      ["--run", "--probe-system", "jarvis"],
      ["--cases-file", "x"],
      ["--percase-out="],
      ["--epsilon"],
    ]) {
      const r = parseEvalGateArgs(argv);
      expect(r.ok).toBe(false);
    }
    const r = parseEvalGateArgs(["--probe-system", "jarvis"]);
    expect(r).toEqual({
      ok: false,
      error: "--probe-system needs a value: --probe-system=<value>",
    });
  });

  it("rejects unknown flags, positional args and valued boolean flags", () => {
    expect(parseEvalGateArgs(["--runn"])).toEqual({
      ok: false,
      error: "unknown flag --runn",
    });
    expect(parseEvalGateArgs(["--dry-run"]).ok).toBe(false);
    expect(parseEvalGateArgs(["-r"]).ok).toBe(false);
    expect(parseEvalGateArgs(["jarvis"]).ok).toBe(false);
    expect(parseEvalGateArgs(["--run=yes"])).toEqual({
      ok: false,
      error: "--run takes no value",
    });
  });
});

const goodBaseline = (): EvalBaseline => ({
  overall: 80,
  scoringVersion: SCORING_VERSION,
  toolSelectionProbedIds: [],
  toolSelectionExcludedIds: [],
  scopePromptCaseIds: [],
});

describe("preSpendRefusal (W4: checked before any inference)", () => {
  const base = {
    run: true,
    updateBaseline: false,
    experiment: false,
    baselinePath: "/repo/src/tuning/eval-baseline.json",
  };

  it("a compare run with a current, populated baseline may spend", () => {
    expect(preSpendRefusal({ ...base, baseline: goodBaseline() })).toBeNull();
  });

  it("refuses a missing, unreadable, older-scoring or population-less baseline", () => {
    expect(preSpendRefusal({ ...base, baseline: null })).toMatch(
      /^No baseline at \/repo\/src\/tuning\/eval-baseline\.json/,
    );
    expect(
      preSpendRefusal({ ...base, baseline: new SyntaxError("bad json") }),
    ).toMatch(/unreadable \(SyntaxError\)/);
    expect(
      preSpendRefusal({ ...base, baseline: { overall: 80 } }),
    ).toBe(
      `baseline captured under an older scoring (scoringVersion 1, current ${SCORING_VERSION}); re-capture with --run --update-baseline`,
    );
    expect(
      preSpendRefusal({
        ...base,
        baseline: { overall: 80, scoringVersion: SCORING_VERSION },
      }),
    ).toMatch(/records no tool_selection population/);
    // v4 without the scope_prompt population (queue 3j)
    const noPrompt = goodBaseline();
    delete noPrompt.scopePromptCaseIds;
    expect(preSpendRefusal({ ...base, baseline: noPrompt })).toBe(
      "baseline records no scope_prompt population (scopePromptCaseIds); re-capture with --run --update-baseline",
    );
  });

  it("does not apply to DRY, --update-baseline or experiment runs", () => {
    expect(
      preSpendRefusal({ ...base, run: false, baseline: null }),
    ).toBeNull();
    expect(
      preSpendRefusal({ ...base, updateBaseline: true, baseline: null }),
    ).toBeNull();
    expect(
      preSpendRefusal({ ...base, experiment: true, baseline: { overall: 1 } }),
    ).toBeNull();
  });
});

describe("baselineCaptureRefusal (W2)", () => {
  it("refuses zero probed cases", () => {
    expect(baselineCaptureRefusal(0, 0, 0)).toMatch(/^refusing to capture: probed 0 of 0/);
    expect(baselineCaptureRefusal(0, 10, 0)).not.toBeNull();
  });

  it("refuses fewer than half the active tool_selection cases, allows exactly half and more", () => {
    expect(MIN_PROBED_SHARE).toBe(0.5);
    expect(baselineCaptureRefusal(49, 100, 0)).toMatch(/probed 49 of 100/);
    expect(baselineCaptureRefusal(50, 100, 0)).toBeNull();
    expect(baselineCaptureRefusal(166, 188, 0)).toBeNull();
  });
});

describe("population digests + drift (W3)", () => {
  it("digests are short sha256 hex, sorted, and do not contain the id", () => {
    const d = caseIdDigest("synthetic-case-1");
    expect(d).toMatch(/^[0-9a-f]{16}$/);
    expect(caseIdDigest("synthetic-case-1")).toBe(d);
    const p = populationDigests(["s-b", "s-a"], ["s-c"], ["sc-y", "sc-x"]);
    expect(p.toolSelectionProbedIds).toEqual(
      [caseIdDigest("s-b"), caseIdDigest("s-a")].sort(),
    );
    expect(p.toolSelectionExcludedIds).toEqual([caseIdDigest("s-c")]);
    expect(p.scopePromptCaseIds).toEqual(
      [caseIdDigest("sc-y"), caseIdDigest("sc-x")].sort(),
    );
    expect(JSON.stringify(p)).not.toContain("s-a");
    expect(JSON.stringify(p)).not.toContain("sc-x");
  });

  it("a case the baseline probed that is now excluded is an error naming it", () => {
    const baseline = populationDigests(["s-1", "s-2"], ["s-3"], []);
    const drift = populationDrift(baseline, ["s-1"], ["s-2", "s-3"]);
    expect(drift.newlyExcluded).toEqual(["s-2"]);
    expect(drift.error).toBe(
      "scoping/registry changed the scored population: fix it or re-capture (1 case(s) the baseline probed are now excluded: s-2)",
    );
  });

  it("new, removed and newly-probed cases are counts, not errors", () => {
    const baseline = populationDigests(["s-1", "s-2"], ["s-3"], []);
    // s-2 removed, s-3 now probed, s-4 new probed, s-5 new excluded.
    const drift = populationDrift(baseline, ["s-1", "s-3", "s-4"], ["s-5"]);
    expect(drift).toEqual({
      newlyExcluded: [],
      newlyProbed: 1,
      newSinceBaseline: 2,
      goneSinceBaseline: 1,
      error: null,
    });
  });

  it("scope_prompt population drift is counts only", () => {
    const baseline = populationDigests([], [], ["sc-1", "sc-2"]);
    expect(scopePromptDrift(baseline, ["sc-1", "sc-3", "sc-4"])).toEqual({
      newSinceBaseline: 2,
      goneSinceBaseline: 1,
    });
    expect(scopePromptDrift(baseline, ["sc-2", "sc-1"])).toEqual({
      newSinceBaseline: 0,
      goneSinceBaseline: 0,
    });
  });

  it("an unchanged population has no drift", () => {
    const baseline = populationDigests(["s-1"], ["s-3"], []);
    expect(populationDrift(baseline, ["s-1"], ["s-3"])).toEqual({
      newlyExcluded: [],
      newlyProbed: 0,
      newSinceBaseline: 0,
      goneSinceBaseline: 0,
      error: null,
    });
  });
});

describe("per-case output rows (N3)", () => {
  it("errorClassLabel keeps only the error class name", () => {
    expect(errorClassLabel("TypeError: cannot read secret-ish thing")).toBe(
      "TypeError",
    );
    expect(errorClassLabel("AbortError")).toBe("AbortError");
    expect(errorClassLabel("Error: synthetic message text")).toBe("Error");
    expect(errorClassLabel("some thrown string with data")).toBe("Error");
  });

  it("replaces details.error with the class name and leaves other rows untouched", () => {
    const ok = { caseId: "s-1", details: { called: ["web_search"] } };
    const bad = {
      caseId: "s-2",
      details: { error: "RangeError: synthetic payload zq9" },
    };
    const out = percaseOutputRows([ok, bad]);
    expect(out[0]).toBe(ok);
    expect(out[1]).toEqual({ caseId: "s-2", details: { error: "RangeError" } });
    expect(JSON.stringify(out)).not.toContain("zq9");
    expect(bad.details.error).toContain("zq9"); // input not mutated
  });
});

describe("errored probes (R2-W1)", () => {
  const row = (
    caseId: string,
    category: CaseScore["category"],
    details: Record<string, unknown>,
  ): CaseScore => ({ caseId, category, score: 0, weight: 1, details });

  it("countErroredProbes counts tool_selection rows with details.error only", () => {
    expect(
      countErroredProbes([
        row("s-1", "tool_selection", { error: "Error" }),
        row("s-2", "tool_selection", { called: [] }),
        row("s-3", "scope_accuracy", { error: "Error" }),
        row("s-4", "tool_selection", { error: "TypeError: x" }),
      ]),
    ).toBe(2);
    expect(countErroredProbes([])).toBe(0);
  });

  it("capture refuses ANY errored probe, even with a full probed population", () => {
    expect(baselineCaptureRefusal(188, 188, 1)).toBe(
      "refusing to capture: 1 tool_selection probe(s) errored — a baseline must come from a clean run",
    );
    expect(baselineCaptureRefusal(163, 188, 163)).toMatch(/163 tool_selection probe\(s\) errored/);
    expect(baselineCaptureRefusal(188, 188, 0)).toBeNull();
  });

  it("compare gives no verdict when any probe errored", () => {
    expect(erroredProbeRefusal(0)).toBeNull();
    expect(erroredProbeRefusal(3)).toBe(
      "3 tool_selection probe(s) errored (scored 0) — rerun when inference is healthy",
    );
  });
});

describe("scope_prompt refusal + breakdown (queue 3j)", () => {
  const sp = (caseId: string, score: number, details: Record<string, unknown> = {}): CaseScore => ({
    caseId,
    category: "scope_prompt",
    score,
    weight: 1,
    details,
  });

  it("a complete, clean scope_prompt population may judge / capture", () => {
    expect(scopePromptRefusal([sp("sc-1", 1), sp("sc-2", 0.5)], 2)).toBeNull();
    expect(scopePromptRefusal([], 0)).toBeNull();
  });

  it("any errored classifier call = no verdict and no capture", () => {
    expect(
      scopePromptRefusal([sp("sc-1", 1), sp("sc-2", 0, { error: "classifier returned null" })], 2),
    ).toBe("1 scope_prompt classifier call(s) errored (scored 0) — rerun when inference is healthy");
  });

  it("fewer scope_prompt rows than active scope_accuracy cases (scorer not wired) is refused", () => {
    expect(scopePromptRefusal([], 43)).toBe(
      "scope_prompt replayed 0 of 43 active scope_accuracy cases — the prompt scorer must run on every one",
    );
    // scope_accuracy rows do not count as replayed
    expect(
      scopePromptRefusal([{ ...sp("sc-1", 1), category: "scope_accuracy" }], 1),
    ).toMatch(/replayed 0 of 1/);
  });

  it("breakdown partitions exact / partial / wrong / errored and weights the subscore", () => {
    const b = scopePromptBreakdown([
      sp("sc-1", 1),
      sp("sc-2", 0.5),
      sp("sc-3", 0),
      sp("sc-4", 0, { error: "Error: x" }),
      { ...sp("sc-5", 1), category: "scope_accuracy" },
    ]);
    expect(b).toEqual({
      cases: 4,
      providers: { unreported: 4 },
      exact: 1,
      partial: 1,
      wrong: 1,
      errored: 1,
      subscore: 37.5,
    });
    expect(
      scopePromptBreakdown([
        sp("sc-1", 1, { provider: "jev" }),
        sp("sc-2", 1, { provider: "sonnet" }),
        sp("sc-3", 1, { provider: "sonnet" }),
        sp("sc-4", 0, { provider: "none", error: "classifier returned null" }),
      ]).providers,
    ).toEqual({ jev: 1, sonnet: 2, none: 1 });
    expect(scopePromptBreakdown([]).subscore).toBe(0);
  });
});

describe("readBaseline / priorBaseline (R2-W2)", () => {
  it("absent file → null; prior {}", () => {
    expect(readBaseline(() => null)).toBeNull();
    expect(priorBaseline(null)).toEqual({});
  });

  it("valid JSON with numeric overall → the baseline; prior carries it", () => {
    const b = readBaseline(() => '{"overall": 81.5, "epsilon": 1.5}');
    expect(b).toEqual({ overall: 81.5, epsilon: 1.5 });
    expect(priorBaseline(b).epsilon).toBe(1.5);
  });

  it("corrupt, non-object, overall-less or unreadable → an Error, never a throw; prior {}", () => {
    for (const text of ["{not json", "[]", "null", "42", '{"epsilon": 2}', '{"overall": "80"}']) {
      const r = readBaseline(() => text);
      expect(r).toBeInstanceOf(Error);
      expect(priorBaseline(r)).toEqual({});
    }
    const unreadable = readBaseline(() => {
      throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
    });
    expect(unreadable).toBeInstanceOf(Error);
    expect(priorBaseline(unreadable)).toEqual({});
  });
});

describe("pre-spend population check (R2-N1)", () => {
  const ts = (caseId: string, excluded = false): CaseScore => ({
    caseId,
    category: "tool_selection",
    score: 0,
    weight: 1,
    ...(excluded ? { excluded: true } : {}),
    details: {},
  });
  const free = (probed: string[], excluded: string[]) => async () => ({
    perCase: [
      ...probed.map((id) => ts(id)),
      { caseId: "sc-1", category: "scope_accuracy" as const, score: 1, weight: 1, details: {} },
    ],
    reachability: {
      casesExcluded: excluded.length,
      excludedCases: excluded.map((id) => ts(id, true)),
      slotsOffered: 0,
      slotsNotRegistered: 0,
      slotsScopedOut: 0,
    },
  });

  it("populationIds takes tool_selection probed ids and the excluded ids", () => {
    expect(
      populationIds({
        perCase: [ts("s-1"), { ...ts("sc-1"), category: "scope_accuracy" }],
        reachability: {
          casesExcluded: 1,
          excludedCases: [ts("s-2", true)],
          slotsOffered: 0,
          slotsNotRegistered: 0,
          slotsScopedOut: 0,
        },
      }),
    ).toEqual({ probedIds: ["s-1"], excludedIds: ["s-2"], scopePromptIds: [] });
    expect(
      populationIds({
        perCase: [
          ts("s-1"),
          { ...ts("sc-1"), category: "scope_accuracy" },
          { ...ts("sc-1"), category: "scope_prompt" },
        ],
        reachability: {
          casesExcluded: 0,
          excludedCases: [],
          slotsOffered: 0,
          slotsNotRegistered: 0,
          slotsScopedOut: 0,
        },
      }).scopePromptIds,
    ).toEqual(["sc-1"]);
  });

  it("refuses before spend when a baseline-probed case is now excluded", async () => {
    const baseline = populationDigests(["s-1", "s-2"], [], []);
    expect(
      await preSpendPopulationRefusal(baseline, free(["s-1"], ["s-2"])),
    ).toMatch(/now excluded: s-2\)$/);
  });

  it("allows an unchanged or grown population", async () => {
    const baseline = populationDigests(["s-1"], ["s-3"], []);
    expect(
      await preSpendPopulationRefusal(baseline, free(["s-1", "s-9"], ["s-3"])),
    ).toBeNull();
  });
});

describe("--probe-rounds (scoring v3)", () => {
  it("parses as a value flag; a valueless spelling is refused", () => {
    const ok = parseEvalGateArgs(["--run", "--probe-rounds=2"]);
    expect(ok.ok && ok.args.probeRounds).toBe("2");
    expect(parseEvalGateArgs(["--probe-rounds"])).toEqual({
      ok: false,
      error: "--probe-rounds needs a value: --probe-rounds=<value>",
    });
  });

  it("absent = default 3, not an experiment; other 1-5 = experiment; else refused", () => {
    expect(DEFAULT_PROBE_ROUNDS).toBe(3);
    expect(parseProbeRounds(undefined)).toEqual({ ok: true, rounds: 3, experiment: false });
    expect(parseProbeRounds("3")).toEqual({ ok: true, rounds: 3, experiment: false });
    expect(parseProbeRounds("1")).toEqual({ ok: true, rounds: 1, experiment: true });
    expect(parseProbeRounds("5")).toEqual({ ok: true, rounds: 5, experiment: true });
    for (const bad of ["0", "6", "2.5", "x", "03", "-1"]) {
      expect(parseProbeRounds(bad).ok).toBe(false);
    }
  });

  it("an experiment needs no baseline (no compare), so preSpendRefusal passes it", () => {
    expect(
      preSpendRefusal({
        run: true,
        updateBaseline: false,
        experiment: true,
        baseline: null,
        baselinePath: "/x",
      }),
    ).toBeNull();
  });
});

describe("toolSelectionBreakdown (counts only)", () => {
  const row = (
    group: string | undefined,
    score: number,
    hitRound: number | null,
    calledByRound: string[][],
    weight = 1,
    extra: Record<string, unknown> = {},
  ): CaseScore => ({
    caseId: `c-${Math.random()}`,
    category: "tool_selection",
    score,
    weight,
    details: { ...(group && { sourceGroup: group }), hitRound, calledByRound, ...extra },
  });
  const none = {
    hitRound1: 0,
    hitRound2Plus: 0,
    forbiddenOnlyPass: 0,
    violation: 0,
    calledOther: 0,
    calledNothing: 0,
    errored: 0,
  };

  it("groups by source x outcome with a weighted subscore per group", () => {
    const rows: CaseScore[] = [
      row("seed", 1, 1, [["t_a"], [], []]),
      row("seed", 1, 2, [["t_b"], ["t_a"], []]),
      row(undefined, 0, null, [["t_b"], [], []]),
      row("seed", 0, null, [[], [], []], 2),
      row("mined", 1, 3, [["t_b"], ["t_c"], ["t_a"]]),
      row("flywheel", 0, null, [], 1),
      // An expected tool hit in round 1 plus a forbidden call: violation, not a hit.
      row("flywheel", 0, 1, [["t_a", "t_x"]], 1, { violations: ["t_x"] }),
      row("flywheel", 1, null, [[]], 1, { scoring: "forbidden_only", violations: [] }),
      {
        caseId: "err",
        category: "tool_selection",
        score: 0,
        weight: 1,
        details: { error: "Error: synthetic outage", sourceGroup: "flywheel" },
      },
      { caseId: "scope", category: "scope_accuracy", score: 1, weight: 1, details: {} },
    ];
    const out = toolSelectionBreakdown(rows);
    expect(out.map((b) => b.group)).toEqual(["seed", "mined", "flywheel"]);
    expect(out[0]).toEqual({
      group: "seed",
      cases: 4,
      outcomes: { ...none, hitRound1: 1, hitRound2Plus: 1, calledOther: 1, calledNothing: 1 },
      subscore: (2 / 5) * 100,
    });
    expect(out[1].outcomes).toEqual({ ...none, hitRound2Plus: 1 });
    expect(out[1].subscore).toBe(100);
    expect(out[2].outcomes).toEqual({
      ...none,
      violation: 1,
      forbiddenOnlyPass: 1,
      calledNothing: 1,
      errored: 1,
    });
    expect(out[2].subscore).toBe(25);
    // Buckets partition the probed cases and agree with the score.
    for (const b of out) {
      const o = b.outcomes;
      expect(Object.values(o).reduce((x, y) => x + y, 0)).toBe(b.cases);
    }
    const o = out[2].outcomes;
    expect(((o.hitRound1 + o.hitRound2Plus + o.forbiddenOnlyPass) / out[2].cases) * 100).toBe(
      out[2].subscore,
    );
  });

  it("omits empty groups", () => {
    expect(toolSelectionBreakdown([])).toEqual([]);
  });
});

describe("--prompt-epsilon + gateDecision (queue 3j R1 W1/W3)", () => {
  it("--prompt-epsilon parses as a value flag; absent = SCOPE_PROMPT_EPSILON 10; bad values are errors", () => {
    expect(SCOPE_PROMPT_EPSILON).toBe(10);
    const a = parseEvalGateArgs(["--run", "--prompt-epsilon=5"]);
    expect(a.ok && a.args.promptEpsilon).toBe("5");
    expect(parseEvalGateArgs(["--prompt-epsilon"]).ok).toBe(false);
    expect(parsePromptEpsilon(undefined)).toEqual({ ok: true, epsilon: 10 });
    expect(parsePromptEpsilon("2.5")).toEqual({ ok: true, epsilon: 2.5 });
    expect(parsePromptEpsilon("0")).toEqual({ ok: true, epsilon: 0 });
    for (const bad of ["-1", "abc", "Infinity", " "]) {
      expect(parsePromptEpsilon(bad).ok).toBe(false);
    }
  });

  it("--epsilon parses strictly (R2 Rec 1): absent = undefined (resolveEpsilon decides); bad values are errors, never a silent fallback", () => {
    expect(parseEpsilonFlag(undefined)).toEqual({ ok: true, epsilon: undefined });
    expect(parseEpsilonFlag("1.5")).toEqual({ ok: true, epsilon: 1.5 });
    expect(parseEpsilonFlag("0")).toEqual({ ok: true, epsilon: 0 });
    for (const bad of ["-1", "abc", "Infinity", "NaN", " ", ""]) {
      const r = parseEpsilonFlag(bad);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("--epsilon takes a number >= 0");
    }
  });

  const incumbent = (): EvalBaseline => ({
    overall: 85,
    epsilon: 2,
    scoringVersion: SCORING_VERSION,
    subscores: { toolSelection: 70, scopeAccuracy: 100, classification: 100, scopePrompt: 90 },
    toolSelectionProbedIds: [],
    toolSelectionExcludedIds: [],
    scopePromptCaseIds: [],
  });
  const input = (o: Partial<GateDecisionInput> = {}): GateDecisionInput => ({
    updateBaseline: false,
    captureRefusal: null,
    erroredRefusal: null,
    promptRefusal: null,
    driftError: null,
    overall: 85,
    scopePrompt: 90,
    baseline: incumbent(),
    epsilon: 2,
    promptEpsilon: SCOPE_PROMPT_EPSILON,
    ...o,
  });

  it("capture: refuses on a tool_selection capture refusal or a scope_prompt refusal, else captures", () => {
    expect(gateDecision(input({ updateBaseline: true, baseline: null }))).toEqual({ action: "capture", reasons: [] });
    expect(gateDecision(input({ updateBaseline: true, captureRefusal: "refusing to capture: x" }))).toEqual({
      action: "refuse",
      reasons: ["refusing to capture: x"],
    });
    expect(gateDecision(input({ updateBaseline: true, promptRefusal: "1 scope_prompt classifier call(s) errored" }))).toEqual({
      action: "refuse",
      reasons: ["1 scope_prompt classifier call(s) errored"],
    });
    // compare-only inputs never block a capture
    expect(gateDecision(input({ updateBaseline: true, erroredRefusal: "e", driftError: "d" })).action).toBe("capture");
  });

  it("compare: refuses on no baseline, an errored probe, a scope_prompt refusal or drift", () => {
    expect(gateDecision(input({ baseline: null }))).toEqual({ action: "refuse", reasons: ["baseline unavailable"] });
    expect(gateDecision(input({ erroredRefusal: "2 tool_selection probe(s) errored" })).reasons).toEqual([
      "2 tool_selection probe(s) errored",
    ]);
    const p = gateDecision(input({ promptRefusal: "scope_prompt replayed 0 of 43" }));
    expect([p.action, p.reasons]).toEqual(["refuse", ["scope_prompt replayed 0 of 43"]]);
    expect(gateDecision(input({ driftError: "scoping/registry changed" })).action).toBe("refuse");
    // a refusal wins over a composite that would PASS
    expect(gateDecision(input({ promptRefusal: "x", overall: 99, scopePrompt: 100 })).action).toBe("refuse");
  });

  it("compare: a scope_prompt subscore on one side only is refused", () => {
    const noBaseSp = incumbent();
    delete noBaseSp.subscores!.scopePrompt;
    expect(gateDecision(input({ baseline: noBaseSp })).reasons).toEqual([
      "baseline records no scope_prompt subscore; re-capture with --run --update-baseline",
    ]);
    expect(gateDecision(input({ scopePrompt: undefined })).reasons).toEqual([
      "this run scored no scope_prompt rows but the baseline has a scope_prompt subscore",
    ]);
    // neither side (no active scope case): composite only
    const r = gateDecision(input({ baseline: noBaseSp, scopePrompt: undefined }));
    expect([r.action, r.prompt]).toEqual(["pass", undefined]);
  });

  it("compare: the composite rule (incumbent - epsilon, inclusive)", () => {
    const pass = gateDecision(input({ overall: 83 }));
    expect([pass.action, pass.composite!.threshold]).toEqual(["pass", 83]);
    const fail = gateDecision(input({ overall: 82.99 }));
    expect(fail.action).toBe("fail");
    expect(fail.reasons).toEqual(["composite 82.99 < threshold 83.00 (incumbent 85.00 - epsilon 2)"]);
  });

  it("compare: the scope_prompt floor FAILS a run the composite epsilon would PASS (W1)", () => {
    // composite unchanged, prompt subscore -13: hidden by the 2-point composite epsilon
    const r = gateDecision(input({ overall: 85, scopePrompt: 77 }));
    expect(r.action).toBe("fail");
    expect(r.prompt).toEqual({ incumbent: 90, candidate: 77, delta: -13, epsilon: 10, floor: 80, regressed: true });
    expect(r.reasons).toEqual(["scope_prompt 77.00 < floor 80.00 (incumbent 90.00 - prompt epsilon 10)"]);
    // inclusive boundary
    expect(gateDecision(input({ scopePrompt: 80 })).action).toBe("pass");
    // the explicit override moves the floor
    expect(gateDecision(input({ scopePrompt: 77, promptEpsilon: 15 })).action).toBe("pass");
    // a bad epsilon never widens the floor
    expect(gateDecision(input({ scopePrompt: 77, promptEpsilon: Number.NaN })).action).toBe("fail");
    // both rules failing: both reasons
    expect(gateDecision(input({ overall: 80, scopePrompt: 70 })).reasons).toHaveLength(2);
  });

  it("compare: an unchanged run PASSes and reports the prompt delta", () => {
    const r = gateDecision(input());
    expect(r.action).toBe("pass");
    expect(r.reasons).toEqual([]);
    expect(r.prompt!.delta).toBe(0);
    expect(r.composite!.verdict).toBe("PASS");
  });
});
