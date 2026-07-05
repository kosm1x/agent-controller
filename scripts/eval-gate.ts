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
 *  - Case volume: 416 active cases (103 seeded + 313 mined) — but only 55 are
 *    `tool_selection` (39 seed + 16 mined). Tool-selection is the 50%-weight
 *    signal that actually catches the Sonnet-5 tool-adherence failure mode.
 *    55 cases catch a GROSS collapse; they are too few to catch a subtle
 *    single-tool regression within run-to-run LLM noise. Grow tool_selection to
 *    >=150 before tightening epsilon below ~2.0. The other 361 cases (scope +
 *    classification) are DETERMINISTIC (no LLM) — they never move on a model
 *    swap, so they dilute the signal you care about. A model-swap gate mostly
 *    lives or dies on those 55 tool_selection cases.
 *  - Registry composition: this harness registers ONLY the builtin tool source
 *    (~160 tools), like scripts/validate-swarm.ts. The live nightly runs in-process
 *    with the FULL ~257-tool registry. So this gate's ABSOLUTE score is not
 *    comparable to nightly `tune_runs` numbers. It is a self-consistent RELATIVE
 *    comparator: incumbent and candidate are scored under the identical harness.
 *    => The stored incumbent MUST be captured BY THIS GATE (`--update-baseline`),
 *    not borrowed from the nightly. The committed eval-baseline.json ships
 *    PROVISIONAL until the operator does that once.
 *  - Read-only: scores against the live data/mc.db but only READS cases
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
 *   npm run eval:gate -- --run               # REAL: ~55 LLM calls (~$1.65), PASS/FAIL
 *   npm run eval:gate -- --run --update-baseline   # set the incumbent to the current score
 *   npm run eval:gate -- --run --epsilon=1.0       # override tolerance for this run
 *
 * EXIT CODES
 *   0 = PASS (>= incumbent - epsilon)  |  1 = FAIL (regressed beyond epsilon)
 *   2 = error (no cases / missing baseline / thrown)  |  3 = DRY (no --run)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const args = process.argv.slice(2);
const doRun = args.includes("--run");
const doUpdate = args.includes("--update-baseline");
const epsilonArg = args.find((a) => a.startsWith("--epsilon="));
const flagEpsilon = epsilonArg ? Number(epsilonArg.split("=")[1]) : undefined;

const BASELINE_PATH = fileURLToPath(
  new URL("../src/tuning/eval-baseline.json", import.meta.url),
);

// 2) Init the LIVE db BEFORE importing any runtime that calls getDatabase().
//    Read-only usage: runEvaluation only reads test cases; no run row is written.
const { initDatabase } = await import("../src/db/index.js");
const dbPath =
  process.env.MC_DB_PATH ?? "/root/claude/mission-control/data/mc.db";
initDatabase(dbPath);

const { getActiveTestCases } = await import("../src/tuning/schema.js");
const { runEvaluation } = await import("../src/tuning/eval-runner.js");
const { compareToBaseline, resolveEpsilon, DEFAULT_EPSILON } =
  await import("../src/tuning/gate.js");
import type { EvalResult } from "../src/tuning/types.js";
import type { EvalBaseline } from "../src/tuning/gate.js";

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
    `  Cases: ${r.perCase.length}   tokens: ${r.totalTokens}   est.cost: $${r.estimatedCostUsd.toFixed(2)}   ${(r.durationMs / 1000).toFixed(1)}s`,
  );
  console.log("─".repeat(48));
}

async function main(): Promise<void> {
  const cases = getActiveTestCases();
  const nCases = cases.length;
  const nToolSel = cases.filter((c) => c.category === "tool_selection").length;

  if (nCases === 0) {
    console.error(
      "[eval-gate] No active test cases in mc.db. Seed first: npm run tune:baseline",
    );
    process.exit(2);
  }

  console.log(
    `[eval-gate] livePid=${livePid ?? "?"} db=${dbPath} cases=${nCases} (tool_selection=${nToolSel})`,
  );
  if (nToolSel < 100) {
    console.log(
      `[eval-gate] NOTE: only ${nToolSel} tool_selection cases — enough for a gross`,
    );
    console.log(
      "[eval-gate]       tool-adherence collapse, too few for subtle regressions.",
    );
  }

  // ---- DRY (no --run): free deterministic evals only, no spend ----
  if (!doRun) {
    const mockInfer = async () => ({ toolsCalled: [], tokensUsed: 0 });
    const res = await runEvaluation({}, undefined, mockInfer);
    console.log(
      "\n[eval-gate] DRY — LLM NOT called (tool_selection is mock=0).",
    );
    console.log(
      `  Scope accuracy:   ${res.subscores.scopeAccuracy.toFixed(2)} / 100  (deterministic)`,
    );
    console.log(
      `  Classification:   ${res.subscores.classification.toFixed(2)} / 100  (deterministic)`,
    );
    console.log(
      "\n[eval-gate] Harness wired OK. Pass --run for the real gate (~$1.65). exit 3.",
    );
    process.exit(3);
  }

  if (doUpdate && !doRun) {
    console.error(
      "[eval-gate] --update-baseline requires --run (never write a baseline from a mock score).",
    );
    process.exit(2);
  }

  // ---- REAL (--run): register builtin tools so the model has real tools to
  //      select (else tool_selection is degenerate). Same setup as validate-swarm.ts.
  const { toolRegistry } = await import("../src/tools/registry.js");
  const { ToolSourceManager } = await import("../src/tools/source.js");
  const { BuiltinToolSource } = await import("../src/tools/sources/builtin.js");
  const sourceManager = new ToolSourceManager();
  sourceManager.addSource(new BuiltinToolSource());
  await sourceManager.initAll(toolRegistry);
  console.log(
    `[eval-gate] registered ${toolRegistry.list().length} builtin tools; running real eval...\n`,
  );

  const res = await runEvaluation(); // default inferFn = real adapter
  printAggregate(res);

  // ---- --update-baseline: set the incumbent to what we just measured ----
  if (doUpdate) {
    const prior: Partial<EvalBaseline> = existsSync(BASELINE_PATH)
      ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as EvalBaseline)
      : {};
    const next: EvalBaseline = {
      overall: Number(res.compositeScore.toFixed(4)),
      epsilon: prior.epsilon ?? DEFAULT_EPSILON,
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
      source:
        "Captured by eval-gate --update-baseline (builtin-only registry). Gate-native incumbent.",
      note: "Refresh with `npm run eval:gate -- --run --update-baseline` after a confirmed-good model swap. epsilon is composite points on the 0-100 scale.",
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log(
      `\n[eval-gate] Incumbent baseline UPDATED -> overall ${next.overall} (epsilon ${next.epsilon}).`,
    );
    console.log(`[eval-gate] Wrote ${BASELINE_PATH}. Commit it. exit 0.`);
    process.exit(0);
  }

  // ---- Compare against the committed incumbent ----
  if (!existsSync(BASELINE_PATH)) {
    console.error(
      `[eval-gate] No baseline at ${BASELINE_PATH}. Establish one: npm run eval:gate -- --run --update-baseline`,
    );
    process.exit(2);
  }
  const baseline = JSON.parse(
    readFileSync(BASELINE_PATH, "utf8"),
  ) as EvalBaseline;
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
