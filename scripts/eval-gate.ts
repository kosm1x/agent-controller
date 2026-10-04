/**
 * Model-swap eval GATE (operator/agent run, NOT CI-by-default).
 *
 * WHY THIS EXISTS
 * ---------------
 * mission-control steers an LLM via large system prompts + hundreds of tool
 * descriptions. The Sonnet-5 attempt was REVERTED because it degraded
 * tool-adherence + delivery — and that was detected only in PROD, via cache-read
 * metrics, AFTER deploy. A scoring harness already exists (`src/tuning/`,
 * scorer: tool-selection 50% / scope 30% / classification 20%) but it gates
 * NOTHING — it runs nightly as a curiosity, not from deploy.sh or any model-swap
 * procedure. This wraps that same scorer into a pass/fail gate you run
 * DELIBERATELY, BEFORE changing a model id / system prompt / tool description:
 *
 *     npm run eval:gate -- --run          # score current config, PASS/FAIL vs incumbent
 *
 * It reuses `runEvaluation()` (the injectable eval-runner) and the existing
 * scorer verbatim — it does NOT re-implement scoring. New code is only: env
 * inheritance, builtin-tool registration, baseline compare (src/tuning/gate.ts),
 * and printing.
 *
 * HONEST SCOPE / LIMITATIONS (read before trusting a PASS)
 * -------------------------------------------------------
 *  - One probe per case: each `tool_selection` case is ONE inference call that
 *    sees only the first round (no tool executes). So:
 *      * only expected tools that were OFFERED (in the definitions sent) are
 *        scored; an expected tool this process never registered, or that the
 *        message's regex scoping cut, is "unreachable" and not scored;
 *      * a case with nothing checkable offered (no expected tool, no
 *        forbidden tool) is EXCLUDED — not probed, not scored (neither 0
 *        nor 1) — and counted; one whose only offered tool is a forbidden
 *        one is scored forbidden-only (1 unless it is called);
 *      * a case with several offered expected tools scores 1 if the model
 *        called at least one of them ("any-hit"; a multi-step task's later
 *        tools cannot appear in one probe), a single-tool case 1/0; each
 *        forbidden tool called costs 2 (clamped at 0). The miner's
 *        `first_tools` is recorded but NOT scored (no round boundaries yet).
 *    Every run PRINTS the case counts, the excluded cases and the unreachable
 *    slots (not registered / scoped out), so a shrinking scored population is
 *    visible, never silent. `--percase-out` keeps the per-case detail
 *    (`proportionalScore` = the old hits/n rule, for comparison).
 *  - Signal volume: the scope + classification cases are DETERMINISTIC (no
 *    LLM) — they never move on a model swap and dilute the signal. Scope
 *    accuracy currently rests on the hand-written cases only: the mined
 *    scope cases are inactive. A model-
 *    swap gate lives or dies on the probed tool_selection cases; the counts
 *    printed below say how many there are. Tighten epsilon below ~2.0 only
 *    with >=150 probed cases.
 *  - Registry composition: the builtin source (its WordPress/CRM/gws groups
 *    regardless of env), Google, skills and memory (backend_independent)
 *    sources — src/tuning/gate-tools.ts. MCP-server tools (`mcp__*`) and the
 *    SDK's `ToolSearch` are never registered here (unreachable). The live
 *    service's registry differs, so this gate's ABSOLUTE score is not
 *    comparable to nightly `tune_runs` numbers; it is a self-consistent
 *    RELATIVE comparator. => The incumbent MUST be captured BY THIS GATE
 *    (`--update-baseline`) under the current `SCORING_VERSION`
 *    (src/tuning/gate.ts); a baseline from another scoring version exits 2
 *    before any spend. Nightly `tune_runs` scores are not comparable across
 *    the 2026-10-04 scoring change either (they carry no scoring version).
 *  - Scored population: the baseline stores sha256 digests of the probed and
 *    excluded tool_selection case ids. A compare run in which a case the
 *    baseline PROBED is now EXCLUDED exits 2 (scoping or the registry moved
 *    the population) — checked for free before the paid run and again after
 *    it; new and removed cases are printed as counts only. An errored probe
 *    (scored 0) means no verdict, and no capture. The baseline is written
 *    atomically (temp file + rename); a corrupt one is repaired by a capture.
 *  - Never opens the live data/mc.db: it scores against a snapshot copy
 *    (runEvaluation writes nothing). No tune_runs row is written.
 *
 * INCUMBENT SOURCE — a committed JSON, not "latest tune_runs row". Rationale:
 * the tune_runs table has no flag distinguishing a real full run from a dry /
 * near-instant one (the two most-recent rows on 2026-07-05 completed in <1s with
 * score 60.35 — dry artefacts), stores no duration, and its estimated cost can't
 * tell them apart — so "most recent row" is not robust. A committed file is
 * reviewable in git (a moved gate floor is a visible diff), stable, and can't be
 * silently shifted by a curiosity run. It is the deliberate, human-blessed floor.
 *
 * USAGE
 *   npm run eval:gate                        # DRY: free evals only, no spend, exit 3
 *   npm run eval:gate -- --run               # REAL: one LLM call per PROBED tool-selection case (~$5.60 / ~15 min at 263 cases, measured 2026-09-19), PASS/FAIL
 *   npm run eval:gate -- --run --update-baseline   # set the incumbent to the current score
 *   npm run eval:gate -- --run --epsilon=1.0       # override tolerance for this run
 *   npm run eval:gate -- --run --percase-out=data/predeploy/eval-percase.json
 *       # also write per-case results (tool names + scores, no messages; mode
 *       # 600; only under the repo's gitignored data/; excluded cases included
 *       # with `excluded: true`)
 *   Flags take --flag=value; an unknown flag or a valueless value flag
 *   (`--probe-system jarvis`) exits 2 before anything is spent.
 *   EXPERIMENT (exit 4, no verdict; refuses --update-baseline):
 *   npm run eval:gate -- --run --cases-file=<json array of case ids>
 *   npm run eval:gate -- --run --probe-system=jarvis   # probe gets the external
 *       # Jarvis system prompt (router.ts buildExternalJarvisSystemPrompt);
 *       # off by default — the default probe sends no system message
 *
 * EXIT CODES
 *   0 = PASS (>= incumbent - epsilon)  |  1 = FAIL (regressed beyond epsilon)
 *   2 = error, no verdict. Before any spend: bad/unknown flag, missing or
 *       unreadable baseline, other-scoring-version baseline, baseline without
 *       population ids, a case the baseline probed is now excluded (checked
 *       with a free mock pass). After the run: any tool_selection probe
 *       errored (compare: no verdict; --update-baseline: nothing written);
 *       --update-baseline probed 0 or < 50 % of active tool_selection cases
 *       (nothing written); the drift re-check; no cases; thrown.
 *   3 = DRY (no --run)  |  4 = EXPERIMENT run scored (--cases-file / --probe-system), no verdict
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 0) Arguments first: a malformed flag exits 2 before anything is read or spent.
const {
  parseEvalGateArgs,
  percaseOutRefusal,
  preSpendRefusal,
  readBaseline,
} = await import("../src/tuning/gate.js");
const parsedArgs = parseEvalGateArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
  console.error(`[eval-gate] ${parsedArgs.error}`);
  process.exit(2);
}
const {
  run: doRun,
  updateBaseline: doUpdate,
  epsilon: epsilonArg,
  percaseOut,
  casesFile,
  probeSystem,
} = parsedArgs.args;

// 1) Inherit the live service's env (INFERENCE_*, keys, TZ) via /proc — never printed.
//    Mirrors scripts/validate-swarm.ts so the gate hits the REAL inference backend.
function loadLiveEnv(): string | null {
  let pid = process.env.MC_PID ?? "";
  if (!pid) {
    try {
      pid = execSync("systemctl show -p MainPID --value mission-control", {
        encoding: "utf8",
      }).trim();
    } catch {
      /* ignore */
    }
  }
  if (pid && pid !== "0" && existsSync(`/proc/${pid}/environ`)) {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const kv of raw.split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) {
        const k = kv.slice(0, i);
        if (!(k in process.env)) process.env[k] = kv.slice(i + 1);
      }
    }
    return pid;
  }
  return null;
}
const livePid = loadLiveEnv();

const flagEpsilon = epsilonArg !== undefined ? Number(epsilonArg) : undefined;
// An experiment run scores a subset or a non-default probe: never a verdict
// against (or a write of) the incumbent, which was captured on neither.
const experiment = casesFile !== undefined || probeSystem !== undefined;

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_PATH = fileURLToPath(
  new URL("../src/tuning/eval-baseline.json", import.meta.url),
);

// Flag checks BEFORE the ~400 MB snapshot and any spend.
function badFlag(msg: string): never {
  console.error(`[eval-gate] ${msg}`);
  process.exit(2);
}
if (probeSystem !== undefined && probeSystem !== "jarvis") {
  badFlag(`--probe-system takes only "jarvis" (got "${probeSystem}")`);
}
if (experiment && doUpdate) {
  badFlag(
    "--update-baseline refuses --cases-file / --probe-system: the incumbent is the full default-probe run.",
  );
}
let caseIds: string[] | undefined;
if (casesFile !== undefined) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(casesFile, "utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((x) => typeof x === "string")
    ) {
      throw new Error("not a non-empty JSON array of case-id strings");
    }
    caseIds = parsed;
  } catch (err) {
    badFlag(
      `--cases-file ${casesFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
const percaseDeps = {
  repoRoot: REPO_ROOT,
  realpath: (p: string) => realpathSync(p),
  isSymlink: (p: string) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  isGitIgnored: (dir: string) => {
    try {
      execFileSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", dir]);
      return true;
    } catch {
      return false;
    }
  },
};
let percaseOutPath: string | undefined;
if (percaseOut !== undefined) {
  const refusal = percaseOutRefusal(percaseOut, percaseDeps);
  if (refusal) badFlag(`--percase-out refused: ${refusal}`);
  percaseOutPath = resolve(REPO_ROOT, percaseOut);
}

// A compare run needs a comparable baseline: check it BEFORE any spend. The
// same never-throwing read gives --update-baseline its `prior` (a corrupt
// file is repaired by a capture, not fatal after the paid run).
const baselineRead = readBaseline(() =>
  existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, "utf8") : null,
);
{
  const refusal = preSpendRefusal({
    run: doRun,
    updateBaseline: doUpdate,
    experiment,
    baseline: baselineRead,
    baselinePath: BASELINE_PATH,
  });
  if (refusal) badFlag(`NO VERDICT (nothing spent): ${refusal}. exit 2.`);
}

// 2) Init a SNAPSHOT of the db BEFORE importing any runtime that calls
//    getDatabase(). initDatabase() migrates the schema, and the working tree
//    may carry a migration the live service has not deployed (snapshot
//    convention, validate-tool-search.ts).
const { initDatabase } = await import("../src/db/index.js");
const dbPath =
  process.env.MC_DB_PATH ?? "/root/claude/mission-control/data/mc.db";
const snapDir = mkdtempSync(join(tmpdir(), "eval-gate-")); // mode 0700
// The copy is ~400 MB; every exit path is a process.exit(), and a signal
// becomes one.
process.on("exit", () => rmSync(snapDir, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => process.exit(sig === "SIGINT" ? 130 : 143));
}
const snapPath = join(snapDir, "mc.db");
// VACUUM INTO over a read-only connection: one consistent file. Copying
// mc.db, -wal and -shm one after another raced the live service's
// checkpoints (audit 2026-09-22 R1 W5).
const { default: Database } = await import("better-sqlite3");
const live = new Database(dbPath, { readonly: true, fileMustExist: true });
live.prepare("VACUUM INTO ?").run(snapPath);
live.close();
initDatabase(snapPath);

const { getActiveTestCases } = await import("../src/tuning/schema.js");
const { runEvaluation } = await import("../src/tuning/eval-runner.js");
const {
  compareToBaseline,
  resolveEpsilon,
  baselineCaptureRefusal,
  countErroredProbes,
  erroredProbeRefusal,
  populationDigests,
  populationDrift,
  populationIds,
  preSpendPopulationRefusal,
  priorBaseline,
  percaseOutputRows,
  DEFAULT_EPSILON,
  SCORING_VERSION,
} = await import("../src/tuning/gate.js");
import type { EvalResult, SandboxConfig } from "../src/tuning/types.js";
import type { EvalBaseline } from "../src/tuning/gate.js";

/** Who could be scored — printed on EVERY run (no silent shrink). */
function printReachability(r: EvalResult): void {
  const probed = r.perCase.filter((c) => c.category === "tool_selection");
  const re = r.reachability;
  console.log(
    `  tool_selection: probed ${probed.length}   excluded ${re.casesExcluded} (nothing checkable offered — not scored)`,
  );
  console.log(
    `  expected-tool slots: offered ${re.slotsOffered}   not registered ${re.slotsNotRegistered}   scoped out ${re.slotsScopedOut}`,
  );
  if (re.casesExcluded > 0) {
    const tally = new Map<string, number>();
    for (const c of re.excludedCases) {
      for (const k of ["notRegistered", "scopedOut"] as const) {
        for (const t of (c.details[k] as string[] | undefined) ?? []) {
          const key = `${t} (${k === "notRegistered" ? "not registered" : "scoped out"})`;
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
      }
    }
    console.log(
      `  excluded cases: ${re.excludedCases.map((c) => c.caseId).join(", ")}`,
    );
    console.log(
      `  their unreachable tools: ${[...tally].map(([k, n]) => `${k} x${n}`).join(", ")}`,
    );
  }
}

function printAggregate(r: EvalResult): void {
  console.log("─".repeat(48));
  console.log(`  Composite:        ${r.compositeScore.toFixed(2)} / 100`);
  console.log(
    `  Tool selection:   ${r.subscores.toolSelection.toFixed(2)} / 100  (weight 50%)`,
  );
  console.log(
    `  Scope accuracy:   ${r.subscores.scopeAccuracy.toFixed(2)} / 100  (weight 30%)`,
  );
  console.log(
    `  Classification:   ${r.subscores.classification.toFixed(2)} / 100  (weight 20%)`,
  );
  console.log(
    `  Cases: ${r.perCase.length} scored   tokens: ${r.totalTokens}   est.cost: $${r.estimatedCostUsd.toFixed(2)}   ${(r.durationMs / 1000).toFixed(1)}s`,
  );
  printReachability(r);
  console.log("─".repeat(48));
}

async function main(): Promise<void> {
  const allCases = getActiveTestCases();
  const cases = caseIds
    ? allCases.filter((c) => caseIds!.includes(c.case_id))
    : allCases;
  const nCases = cases.length;
  const nToolSel = cases.filter((c) => c.category === "tool_selection").length;

  if (nCases === 0) {
    console.error(
      caseIds
        ? "[eval-gate] None of the --cases-file ids is an active test case."
        : "[eval-gate] No active test cases in mc.db. Seed first: npm run tune:baseline",
    );
    process.exit(2);
  }

  console.log(
    `[eval-gate] livePid=${livePid ?? "?"} db=${dbPath} (snapshot) cases=${nCases} (tool_selection=${nToolSel})${caseIds ? ` SUBSET of ${allCases.length} (--cases-file; ${caseIds.length} ids)` : ""}`,
  );
  if (!caseIds && nToolSel < 100) {
    console.log(
      `[eval-gate] NOTE: only ${nToolSel} tool_selection cases — enough for a gross`,
    );
    console.log(
      "[eval-gate]       tool-adherence collapse, too few for subtle regressions.",
    );
  }

  // Register the gate's tool population (src/tuning/gate-tools.ts) on both
  // paths: reachability is free to compute, so DRY shows the scored
  // population a --run would probe. Same setup as validate-swarm.ts plus the
  // sources production adds beside builtin.
  const { toolRegistry } = await import("../src/tools/registry.js");
  const { registerEvalGateTools } =
    await import("../src/tuning/gate-tools.js");
  await registerEvalGateTools(toolRegistry);
  console.log(
    `[eval-gate] registered ${toolRegistry.list().length} tools (builtin + Google + skills + memory; no MCP servers)`,
  );

  const sandbox: SandboxConfig = {};
  if (probeSystem === "jarvis") {
    const { buildExternalJarvisSystemPrompt } =
      await import("../src/messaging/router.js");
    sandbox.probeSystemPrompt = (tools) => {
      const { stable, variable } = buildExternalJarvisSystemPrompt(tools);
      return variable ? `${stable}\n\n${variable}` : stable;
    };
    console.log(
      "[eval-gate] EXPERIMENT: probe gets the external Jarvis system prompt (--probe-system=jarvis)",
    );
  }
  const filter = caseIds ? { caseIds } : undefined;
  const mockInfer = async () => ({ toolsCalled: [], tokensUsed: 0 });

  // ---- DRY (no --run): free deterministic evals only, no spend ----
  if (!doRun) {
    const res = await runEvaluation(sandbox, filter, mockInfer);
    console.log(
      "\n[eval-gate] DRY — LLM NOT called (tool_selection is mock=0).",
    );
    console.log(
      `  Scope accuracy:   ${res.subscores.scopeAccuracy.toFixed(2)} / 100  (deterministic)`,
    );
    console.log(
      `  Classification:   ${res.subscores.classification.toFixed(2)} / 100  (deterministic)`,
    );
    printReachability(res);
    console.log(
      "\n[eval-gate] Harness wired OK. Pass --run for the real gate (~$5.60, ~15 min — measured 2026-09-19 at 263 cases). exit 3.",
    );
    process.exit(3);
  }

  if (doUpdate && !doRun) {
    console.error(
      "[eval-gate] --update-baseline requires --run (never write a baseline from a mock score).",
    );
    process.exit(2);
  }

  // A compare run's scored population is decided before any probe: check it
  // against the baseline's for free (mock inference) BEFORE spending.
  if (!doUpdate && !experiment) {
    if (baselineRead === null || baselineRead instanceof Error) {
      console.error("[eval-gate] baseline unavailable. exit 2.");
      process.exit(2);
    }
    const refusal = await preSpendPopulationRefusal(baselineRead, () =>
      runEvaluation(sandbox, filter, mockInfer),
    );
    if (refusal) {
      console.error(
        `[eval-gate] NO VERDICT (nothing spent): ${refusal}. exit 2.`,
      );
      process.exit(2);
    }
  }

  console.log("[eval-gate] running real eval...\n");
  const res = await runEvaluation(sandbox, filter); // default inferFn = real adapter
  printAggregate(res);

  if (percaseOut !== undefined && percaseOutPath) {
    // Scored cases, then excluded ones (`excluded: true`). Tool names and
    // scores only — the evaluators put no message text in `details`, and an
    // evaluator error is reduced to its class name. The path is re-checked
    // now (the run took minutes) and opened without following a symlink.
    const refusal = percaseOutRefusal(percaseOut, percaseDeps);
    if (refusal) {
      console.error(`[eval-gate] --percase-out refused at write time: ${refusal}. Nothing written.`);
    } else {
      const fd = openSync(
        percaseOutPath,
        fsConstants.O_CREAT |
          fsConstants.O_WRONLY |
          fsConstants.O_TRUNC |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        fchmodSync(fd, 0o600);
        writeSync(
          fd,
          JSON.stringify(
            percaseOutputRows([
              ...res.perCase,
              ...res.reachability.excludedCases,
            ]),
            null,
            2,
          ) + "\n",
        );
      } finally {
        closeSync(fd);
      }
      console.log(`[eval-gate] per-case results (mode 600): ${percaseOutPath}`);
    }
  }

  if (experiment) {
    console.log(
      "\n[eval-gate] EXPERIMENT run (--cases-file / --probe-system): scored, no verdict, baseline untouched. exit 4.",
    );
    process.exit(4);
  }

  const { probedIds, excludedIds } = populationIds(res);
  const errored = countErroredProbes(res.perCase);
  console.log(`  errored tool_selection probes: ${errored}`);

  // ---- --update-baseline: set the incumbent to what we just measured ----
  if (doUpdate) {
    const captureRefusal = baselineCaptureRefusal(
      probedIds.length,
      nToolSel,
      errored,
    );
    if (captureRefusal) {
      console.error(`\n[eval-gate] ${captureRefusal}. Baseline NOT written. exit 2.`);
      process.exit(2);
    }
    // Read before the run with the safe reader: {} when absent or corrupt.
    const prior = priorBaseline(baselineRead);
    const next: EvalBaseline = {
      overall: Number(res.compositeScore.toFixed(4)),
      epsilon: prior.epsilon ?? DEFAULT_EPSILON,
      scoringVersion: SCORING_VERSION,
      subscores: {
        toolSelection: Number(res.subscores.toolSelection.toFixed(4)),
        scopeAccuracy: Number(res.subscores.scopeAccuracy.toFixed(4)),
        classification: Number(res.subscores.classification.toFixed(4)),
      },
      model: process.env.INFERENCE_PRIMARY_PROVIDER
        ? `INFERENCE_PRIMARY_PROVIDER=${process.env.INFERENCE_PRIMARY_PROVIDER}`
        : "unknown",
      capturedAt: new Date().toISOString(),
      nCases,
      toolSelectionCases: nToolSel,
      toolSelectionProbed: probedIds.length,
      toolSelectionExcluded: excludedIds.length,
      // Digests, not ids: mined ids embed a hash of the user's message.
      ...populationDigests(probedIds, excludedIds),
      source:
        "Captured by eval-gate --update-baseline (gate registry: src/tuning/gate-tools.ts). Gate-native incumbent.",
      note: "Refresh with `npm run eval:gate -- --run --update-baseline` after a confirmed-good model swap. epsilon is composite points on the 0-100 scale.",
    };
    // Atomic: temp file in the same directory, then rename over the target.
    const tmpPath = `${BASELINE_PATH}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmpPath, BASELINE_PATH);
    console.log(
      `\n[eval-gate] Incumbent baseline UPDATED -> overall ${next.overall} (epsilon ${next.epsilon}, scoringVersion ${SCORING_VERSION}).`,
    );
    console.log(`[eval-gate] Wrote ${BASELINE_PATH}. Commit it. exit 0.`);
    process.exit(0);
  }

  // ---- Compare against the committed incumbent ----
  // Existence, parse, scoringVersion, population ids and population drift
  // were checked before any spend; drift is re-checked on the real result.
  const baseline = baselineRead;
  if (baseline === null || baseline instanceof Error) {
    console.error("[eval-gate] baseline unavailable. exit 2.");
    process.exit(2);
  }
  const erroredRefusal = erroredProbeRefusal(errored);
  if (erroredRefusal) {
    console.error(`\n[eval-gate] NO VERDICT: ${erroredRefusal}. exit 2.`);
    process.exit(2);
  }
  const drift = populationDrift(baseline, probedIds, excludedIds);
  console.log(
    `\n  population vs baseline: ${drift.newSinceBaseline} new case(s), ${drift.goneSinceBaseline} removed/deactivated, ${drift.newlyProbed} baseline-excluded now probed, ${drift.newlyExcluded.length} baseline-probed now excluded`,
  );
  if (drift.error) {
    console.error(`\n[eval-gate] NO VERDICT: ${drift.error}. exit 2.`);
    process.exit(2);
  }
  const epsilon = resolveEpsilon(baseline.epsilon, flagEpsilon);
  const g = compareToBaseline(res.compositeScore, baseline.overall, epsilon);

  console.log(
    `\n  incumbent ${g.incumbent.toFixed(2)}  candidate ${g.overall.toFixed(2)}  delta ${g.delta >= 0 ? "+" : ""}${g.delta.toFixed(2)}`,
  );
  console.log(
    `  threshold ${g.threshold.toFixed(2)} (incumbent - epsilon ${g.epsilon})`,
  );
  console.log(
    `\nVERDICT: ${g.verdict}${g.verdict === "FAIL" ? " — tool-adherence/scope REGRESSION beyond tolerance. Do NOT ship this swap." : " — no regression beyond tolerance."}`,
  );
  process.exit(g.verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error("[eval-gate] ERROR:", err);
  process.exit(2);
});
