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
  priorBaseline,
  populationIds,
  preSpendPopulationRefusal,
  type EvalBaseline,
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
  it("the current scoring generation is 2", () => {
    expect(SCORING_VERSION).toBe(2);
  });

  it("a baseline with no scoringVersion is generation 1 → older-scoring refusal naming the re-capture", () => {
    const msg = scoringVersionMismatch({ overall: 36.7 });
    expect(msg).toMatch(/older scoring/);
    expect(msg).toMatch(/re-capture with --run --update-baseline/);
    expect(msg).toMatch(/scoringVersion 1, current 2/);
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
    const p = populationDigests(["s-b", "s-a"], ["s-c"]);
    expect(p.toolSelectionProbedIds).toEqual(
      [caseIdDigest("s-b"), caseIdDigest("s-a")].sort(),
    );
    expect(p.toolSelectionExcludedIds).toEqual([caseIdDigest("s-c")]);
    expect(JSON.stringify(p)).not.toContain("s-a");
  });

  it("a case the baseline probed that is now excluded is an error naming it", () => {
    const baseline = populationDigests(["s-1", "s-2"], ["s-3"]);
    const drift = populationDrift(baseline, ["s-1"], ["s-2", "s-3"]);
    expect(drift.newlyExcluded).toEqual(["s-2"]);
    expect(drift.error).toBe(
      "scoping/registry changed the scored population: fix it or re-capture (1 case(s) the baseline probed are now excluded: s-2)",
    );
  });

  it("new, removed and newly-probed cases are counts, not errors", () => {
    const baseline = populationDigests(["s-1", "s-2"], ["s-3"]);
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

  it("an unchanged population has no drift", () => {
    const baseline = populationDigests(["s-1"], ["s-3"]);
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
    ).toEqual({ probedIds: ["s-1"], excludedIds: ["s-2"] });
  });

  it("refuses before spend when a baseline-probed case is now excluded", async () => {
    const baseline = populationDigests(["s-1", "s-2"], []);
    expect(
      await preSpendPopulationRefusal(baseline, free(["s-1"], ["s-2"])),
    ).toMatch(/now excluded: s-2\)$/);
  });

  it("allows an unchanged or grown population", async () => {
    const baseline = populationDigests(["s-1"], ["s-3"]);
    expect(
      await preSpendPopulationRefusal(baseline, free(["s-1", "s-9"], ["s-3"])),
    ).toBeNull();
  });
});
