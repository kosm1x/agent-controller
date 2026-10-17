/**
 * Pure verdict math for the model-swap eval gate (`scripts/eval-gate.ts`).
 *
 * No I/O, no LLM, no DB — just the PASS/FAIL/regression arithmetic so it can be
 * unit-tested without spend (`src/tuning/gate.test.ts`). The gate script owns
 * env inheritance, DB reads, scoring (via the existing eval-runner), and
 * printing; this module owns "did the candidate regress past tolerance?",
 * "is the baseline comparable?" and "may --percase-out write there?" (that
 * one with its file-system checks injected).
 */

import { createHash } from "node:crypto";
import type { CaseScore, CaseSourceGroup, EvalResult } from "./types.js";
import {
  dirname as dirnamePath,
  isAbsolute as isAbsolutePath,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";

export interface EvalBaseline {
  /** Incumbent composite score (0-100) the CURRENT prod model config achieves. */
  overall: number;
  /**
   * Regression tolerance, in composite points on the 0-100 scale.
   * Optional in the file — falls back to {@link DEFAULT_EPSILON}.
   */
  epsilon?: number;
  /** Optional per-metric incumbents (informational only — not gated). */
  subscores?: {
    toolSelection: number;
    scopeAccuracy: number;
    classification: number;
    scopePrompt?: number;
  };
  /**
   * Scoring generation the incumbent was captured under ({@link SCORING_VERSION}).
   * Absent = 1 (pre-2026-10-04: all expected tools, proportional).
   */
  scoringVersion?: number;
  /**
   * Sorted {@link caseIdDigest}s of the tool_selection cases the incumbent
   * run PROBED / EXCLUDED. Digests, not ids: mined ids embed a short hash of
   * the user's message, flywheel ids a task id, and this file is public.
   */
  toolSelectionProbedIds?: string[];
  toolSelectionExcludedIds?: string[];
  /**
   * Sorted {@link caseIdDigest}s of the scope_accuracy cases the incumbent
   * replayed through the LLM scope classifier (scope_prompt rows, v4).
   */
  scopePromptCaseIds?: string[];
  /** sha256 of the `classifierSystemPrompt()` the incumbent was captured with (provenance). */
  classifierPromptSha256?: string;
  /** Whether the Jev-first classifier chain was on at capture (`jevScopeEnabled()`; never a key). */
  classifierJevEnabled?: boolean;
  /** Free-form provenance metadata (model, capturedAt, source, note...) — ignored by the math. */
  [key: string]: unknown;
}

/**
 * Generation of the tool_selection scoring. A baseline captured under another
 * generation is not comparable and the gate refuses to give a verdict.
 *  1 — every expected tool scored proportionally (absent in older files).
 *  2 — 2026-10-04: offered-only (unreachable expected tools are not scored;
 *      a case with nothing checkable offered is excluded and counted; one
 *      with only an offered forbidden tool is scored forbidden-only),
 *      any-hit for multi-tool cases (`first_tools` ignored),
 *      Google/WP/CRM/skills/memory tools registered in the gate regardless
 *      of env.
 *  3 — 2026-10-06: multi-round probe (`probeRounds`), an expected tool hit in
 *      any round counts.
 *  4 — 2026-10-17 (queue 3j): scope_prompt — every active scope_accuracy
 *      case is replayed through `classifyScopeGroups` (live
 *      `classifierSystemPrompt()`, record-derived GROUPS lines included) and
 *      scored with the scope_accuracy metric; it takes 0.15 of the scope
 *      weight in the composite (regex scope 0.15). The baseline records the
 *      replayed population (`scopePromptCaseIds`).
 */
export const SCORING_VERSION = 4;

/**
 * Null when the baseline was captured under the current scoring, else the
 * message the gate prints before exiting 2 (no PASS/FAIL is meaningful).
 */
export function scoringVersionMismatch(baseline: EvalBaseline): string | null {
  const v = baseline.scoringVersion ?? 1;
  if (v === SCORING_VERSION) return null;
  return v < SCORING_VERSION
    ? `baseline captured under an older scoring (scoringVersion ${v}, current ${SCORING_VERSION}); re-capture with --run --update-baseline`
    : `baseline captured under a NEWER scoring (scoringVersion ${v}, current ${SCORING_VERSION}); this checkout's scorer is older than the baseline — update the checkout`;
}

// ------------------------------------------------------------ CLI parsing

export interface EvalGateArgs {
  run: boolean;
  updateBaseline: boolean;
  epsilon?: string;
  promptEpsilon?: string;
  percaseOut?: string;
  casesFile?: string;
  probeSystem?: string;
  probeRounds?: string;
}

const GATE_BOOL_FLAGS = { "--run": "run", "--update-baseline": "updateBaseline" } as const;
const GATE_VALUE_FLAGS = {
  "--epsilon": "epsilon",
  "--prompt-epsilon": "promptEpsilon",
  "--percase-out": "percaseOut",
  "--cases-file": "casesFile",
  "--probe-system": "probeSystem",
  "--probe-rounds": "probeRounds",
} as const;

/** Model rounds per tool_selection probe in a gate run (scoring version 3). */
export const DEFAULT_PROBE_ROUNDS = 3;

/**
 * `--probe-rounds=<1-5>`: absent = {@link DEFAULT_PROBE_ROUNDS}; any other
 * value makes the run an EXPERIMENT (the incumbent was captured at the
 * default). A non-integer or out-of-range value is an error (exit 2).
 */
export function parseProbeRounds(
  value: string | undefined,
):
  | { ok: true; rounds: number; experiment: boolean }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, rounds: DEFAULT_PROBE_ROUNDS, experiment: false };
  }
  if (!/^[1-5]$/.test(value)) {
    return { ok: false, error: `--probe-rounds takes an integer 1-5 (got "${value}")` };
  }
  const rounds = Number(value);
  return { ok: true, rounds, experiment: rounds !== DEFAULT_PROBE_ROUNDS };
}

// --------------------------------------------- tool_selection breakdown

export type ProbeOutcome =
  | "hitRound1"
  | "hitRound2Plus"
  | "forbiddenOnlyPass"
  | "violation"
  | "calledOther"
  | "calledNothing"
  | "errored";

export interface SourceGroupBreakdown {
  group: CaseSourceGroup;
  cases: number;
  outcomes: Record<ProbeOutcome, number>;
  /** Weighted tool_selection subscore of this group, 0-100. */
  subscore: number;
}

/**
 * Counts-only breakdown of the probed tool_selection cases by source group x
 * outcome, from the `details` the eval runner wrote (`sourceGroup`,
 * `hitRound`, `calledByRound`, `violations`, `scoring`, `error`). The outcomes
 * partition the probed cases, first match wins: errored (the probe threw) ·
 * violation (a forbidden tool was called, whatever else happened — scores 0) ·
 * forbiddenOnlyPass (no expected tool offered, score 1) · hitRound1 /
 * hitRound2Plus (score > 0 with an expected-tool hit) · calledOther ·
 * calledNothing. Groups with no probed case are omitted.
 */
export function toolSelectionBreakdown(
  perCase: CaseScore[],
): SourceGroupBreakdown[] {
  const groups: CaseSourceGroup[] = ["seed", "mined", "flywheel"];
  return groups.flatMap((group) => {
    const rows = perCase.filter(
      (c) =>
        c.category === "tool_selection" &&
        ((c.details.sourceGroup as CaseSourceGroup | undefined) ?? "seed") === group,
    );
    if (rows.length === 0) return [];
    const outcomes: Record<ProbeOutcome, number> = {
      hitRound1: 0,
      hitRound2Plus: 0,
      forbiddenOnlyPass: 0,
      violation: 0,
      calledOther: 0,
      calledNothing: 0,
      errored: 0,
    };
    let wSum = 0;
    let wScore = 0;
    for (const c of rows) {
      const hitRound = c.details.hitRound as number | null | undefined;
      const called = ((c.details.calledByRound as string[][] | undefined) ?? []).flat();
      const violations = (c.details.violations as string[] | undefined) ?? [];
      if (c.details.error !== undefined) outcomes.errored++;
      else if (violations.length > 0) outcomes.violation++;
      else if (c.details.scoring === "forbidden_only" && c.score === 1)
        outcomes.forbiddenOnlyPass++;
      else if (c.score > 0 && hitRound === 1) outcomes.hitRound1++;
      else if (c.score > 0 && typeof hitRound === "number")
        outcomes.hitRound2Plus++;
      else if (called.length > 0) outcomes.calledOther++;
      else outcomes.calledNothing++;
      const w = c.weight ?? 1.0;
      wSum += w;
      wScore += c.score * w;
    }
    return [
      {
        group,
        cases: rows.length,
        outcomes,
        subscore: wSum > 0 ? (wScore / wSum) * 100 : 0,
      },
    ];
  });
}

/**
 * Parse `scripts/eval-gate.ts` arguments. Value flags take `--flag=value`
 * only; an unknown flag, a value flag without `=value` (`--probe-system
 * jarvis` would otherwise run the DEFAULT probe and leave `jarvis` stray), a
 * boolean flag given a value, or a positional argument is an error — the
 * script exits 2 before any spend.
 */
export function parseEvalGateArgs(
  argv: string[],
): { ok: true; args: EvalGateArgs } | { ok: false; error: string } {
  const args: EvalGateArgs = { run: false, updateBaseline: false };
  for (const a of argv) {
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (name in GATE_BOOL_FLAGS) {
      if (eq !== -1) return { ok: false, error: `${name} takes no value` };
      args[GATE_BOOL_FLAGS[name as keyof typeof GATE_BOOL_FLAGS]] = true;
    } else if (name in GATE_VALUE_FLAGS) {
      const value = eq === -1 ? "" : a.slice(eq + 1);
      if (value === "") {
        return { ok: false, error: `${name} needs a value: ${name}=<value>` };
      }
      args[GATE_VALUE_FLAGS[name as keyof typeof GATE_VALUE_FLAGS]] = value;
    } else if (a.startsWith("-")) {
      return { ok: false, error: `unknown flag ${name}` };
    } else {
      return { ok: false, error: `unexpected argument "${a}" (value flags take --flag=value)` };
    }
  }
  return { ok: true, args };
}

// ------------------------------------------------------- pre-spend checks

/**
 * The checks a compare run (`--run` without `--update-baseline`, not an
 * experiment) must pass BEFORE any inference: a baseline exists and parses,
 * was captured under this scoring, and records its scored population. Null =
 * go; else the reason to exit 2. `baseline` is null when the file is absent,
 * an Error when it could not be read or parsed.
 */
export function preSpendRefusal(opts: {
  run: boolean;
  updateBaseline: boolean;
  experiment: boolean;
  baseline: EvalBaseline | null | Error;
  baselinePath: string;
}): string | null {
  if (!opts.run || opts.updateBaseline || opts.experiment) return null;
  const b = opts.baseline;
  if (b === null) {
    return `No baseline at ${opts.baselinePath}. Establish one: npm run eval:gate -- --run --update-baseline`;
  }
  if (b instanceof Error) {
    return `baseline ${opts.baselinePath} unreadable (${b.name}); fix or re-capture with --run --update-baseline`;
  }
  const mismatch = scoringVersionMismatch(b);
  if (mismatch) return mismatch;
  if (
    !Array.isArray(b.toolSelectionProbedIds) ||
    !Array.isArray(b.toolSelectionExcludedIds)
  ) {
    return "baseline records no tool_selection population (toolSelectionProbedIds / toolSelectionExcludedIds); re-capture with --run --update-baseline";
  }
  if (!Array.isArray(b.scopePromptCaseIds)) {
    return "baseline records no scope_prompt population (scopePromptCaseIds); re-capture with --run --update-baseline";
  }
  return null;
}

/** Minimum share of active tool_selection cases a capture must have probed. */
export const MIN_PROBED_SHARE = 0.5;

/**
 * `--update-baseline` refuses a run in which any tool_selection probe ERRORED
 * (an errored probe scores 0: an inference outage would otherwise become a ~0
 * incumbent), or that probed no tool_selection case, or fewer than
 * {@link MIN_PROBED_SHARE} of the active ones: a collapsed population would
 * become an incumbent everything later PASSes against. Null = may write; else
 * the reason to exit 2 with nothing written.
 */
export function baselineCaptureRefusal(
  probed: number,
  activeToolSelection: number,
  errored: number,
): string | null {
  if (errored > 0) {
    return `refusing to capture: ${errored} tool_selection probe(s) errored — a baseline must come from a clean run`;
  }
  if (probed === 0 || probed < MIN_PROBED_SHARE * activeToolSelection) {
    return `refusing to capture: probed ${probed} of ${activeToolSelection} active tool_selection cases (need > 0 and >= ${MIN_PROBED_SHARE * 100}%) — fix the registry/scoping first`;
  }
  return null;
}

/**
 * scope_prompt rows of a run: how many scored, how many ERRORED (the
 * classifier returned null or threw — scored 0). Null = the population is
 * complete and clean; else the reason for no verdict / no capture (exit 2): an
 * errored call would read as a prompt regression (or become a ~0 incumbent),
 * and a run that replayed fewer cases than the active scope_accuracy ones
 * (the scorer was not wired) has a composite with other weights.
 */
export function scopePromptRefusal(
  perCase: CaseScore[],
  activeScopeCases: number,
): string | null {
  const rows = perCase.filter((c) => c.category === "scope_prompt");
  const errored = rows.filter((c) => c.details.error !== undefined).length;
  if (errored > 0) {
    return `${errored} scope_prompt classifier call(s) errored (scored 0) — rerun when inference is healthy`;
  }
  if (rows.length !== activeScopeCases) {
    return `scope_prompt replayed ${rows.length} of ${activeScopeCases} active scope_accuracy cases — the prompt scorer must run on every one`;
  }
  return null;
}

export interface ScopePromptBreakdown {
  cases: number;
  /** Rows per answering classifier (`details.provider`: jev / sonnet / none / unreported). */
  providers: Record<string, number>;
  /** score 1 (every label right). */
  exact: number;
  /** 0 < score < 1. */
  partial: number;
  /** score 0 with an answer. */
  wrong: number;
  /** null answer or throw (scored 0). */
  errored: number;
  /** Weighted scope_prompt subscore, 0-100. */
  subscore: number;
}

/** Counts-only outcome split of the scope_prompt rows (printed on every --run). */
export function scopePromptBreakdown(perCase: CaseScore[]): ScopePromptBreakdown {
  const rows = perCase.filter((c) => c.category === "scope_prompt");
  const out: ScopePromptBreakdown = {
    cases: rows.length,
    providers: {},
    exact: 0,
    partial: 0,
    wrong: 0,
    errored: 0,
    subscore: 0,
  };
  let wSum = 0;
  let wScore = 0;
  for (const c of rows) {
    const p = typeof c.details.provider === "string" ? c.details.provider : "unreported";
    out.providers[p] = (out.providers[p] ?? 0) + 1;
    if (c.details.error !== undefined) out.errored++;
    else if (c.score >= 1) out.exact++;
    else if (c.score > 0) out.partial++;
    else out.wrong++;
    const w = c.weight ?? 1.0;
    wSum += w;
    wScore += c.score * w;
  }
  out.subscore = wSum > 0 ? (wScore / wSum) * 100 : 0;
  return out;
}

/** tool_selection rows whose probe threw (the evaluator records `details.error`). */
export function countErroredProbes(perCase: CaseScore[]): number {
  return perCase.filter(
    (c) => c.category === "tool_selection" && c.details.error !== undefined,
  ).length;
}

/**
 * A compare run with an errored probe gives no verdict: the probe scored 0,
 * which would read as a model regression (or mask one). Null = may judge.
 */
export function erroredProbeRefusal(errored: number): string | null {
  return errored > 0
    ? `${errored} tool_selection probe(s) errored (scored 0) — rerun when inference is healthy`
    : null;
}

/**
 * Read the committed baseline without throwing: null when absent, an Error
 * when it cannot be read, is not JSON, or has no numeric `overall`. `read`
 * returns the file text, or null when the file does not exist.
 */
export function readBaseline(
  read: () => string | null,
): EvalBaseline | null | Error {
  let text: string | null;
  try {
    text = read();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as EvalBaseline).overall !== "number"
  ) {
    return new TypeError("baseline is not an object with a numeric overall");
  }
  return parsed as EvalBaseline;
}

/** What `--update-baseline` carries over from the prior file: nothing when unreadable. */
export function priorBaseline(
  read: EvalBaseline | null | Error,
): Partial<EvalBaseline> {
  return read === null || read instanceof Error ? {} : read;
}

// --------------------------------------------------- scored population

/**
 * Probed / excluded tool_selection case ids of a result (reachability needs no
 * inference), and the scope_prompt (replayed) case ids — empty for a run
 * without the prompt scorer (DRY, pre-spend).
 */
export function populationIds(
  r: Pick<EvalResult, "perCase" | "reachability">,
): { probedIds: string[]; excludedIds: string[]; scopePromptIds: string[] } {
  return {
    probedIds: r.perCase
      .filter((c) => c.category === "tool_selection")
      .map((c) => c.caseId),
    excludedIds: r.reachability.excludedCases.map((c) => c.caseId),
    scopePromptIds: r.perCase
      .filter((c) => c.category === "scope_prompt")
      .map((c) => c.caseId),
  };
}

/** Short sha256 of a case id — what a public baseline file stores. */
export function caseIdDigest(caseId: string): string {
  return createHash("sha256").update(caseId).digest("hex").slice(0, 16);
}

/** Sorted digests of the probed / excluded tool_selection and the scope_prompt case ids. */
export function populationDigests(
  probedIds: string[],
  excludedIds: string[],
  scopePromptIds: string[],
): {
  toolSelectionProbedIds: string[];
  toolSelectionExcludedIds: string[];
  scopePromptCaseIds: string[];
} {
  const digest = (ids: string[]) => ids.map(caseIdDigest).sort();
  return {
    toolSelectionProbedIds: digest(probedIds),
    toolSelectionExcludedIds: digest(excludedIds),
    scopePromptCaseIds: digest(scopePromptIds),
  };
}

/**
 * scope_prompt population vs the baseline's, counts only (cases come and go
 * with the scope_accuracy set; no exclusion exists for them).
 */
export function scopePromptDrift(
  baseline: Pick<EvalBaseline, "scopePromptCaseIds">,
  scopePromptIds: string[],
): { newSinceBaseline: number; goneSinceBaseline: number } {
  const base = new Set(baseline.scopePromptCaseIds ?? []);
  const current = new Set(scopePromptIds.map(caseIdDigest));
  let newSinceBaseline = 0;
  for (const d of current) if (!base.has(d)) newSinceBaseline++;
  let goneSinceBaseline = 0;
  for (const d of base) if (!current.has(d)) goneSinceBaseline++;
  return { newSinceBaseline, goneSinceBaseline };
}

export interface PopulationDrift {
  /** Current ids (raw) the baseline PROBED that this run EXCLUDED. */
  newlyExcluded: string[];
  /** Baseline-excluded cases this run probed. */
  newlyProbed: number;
  /** Cases in this run the baseline never saw (the mined set grows). */
  newSinceBaseline: number;
  /** Baseline cases absent from this run (removed / deactivated). */
  goneSinceBaseline: number;
  /** Non-null when the verdict is meaningless: the reason to exit 2. */
  error: string | null;
}

/**
 * Compare this run's tool_selection population with the baseline's. A case
 * the baseline probed that is now EXCLUDED means scoping or the registry
 * changed what is scored — no PASS/FAIL. New and removed cases are counts
 * only (the mined set changes nightly).
 */
export function populationDrift(
  baseline: Pick<EvalBaseline, "toolSelectionProbedIds" | "toolSelectionExcludedIds">,
  probedIds: string[],
  excludedIds: string[],
): PopulationDrift {
  const baseProbed = new Set(baseline.toolSelectionProbedIds ?? []);
  const baseExcluded = new Set(baseline.toolSelectionExcludedIds ?? []);
  const newlyExcluded = excludedIds.filter((id) =>
    baseProbed.has(caseIdDigest(id)),
  );
  const newlyProbed = probedIds.filter((id) =>
    baseExcluded.has(caseIdDigest(id)),
  ).length;
  const current = new Set([...probedIds, ...excludedIds].map(caseIdDigest));
  let newSinceBaseline = 0;
  for (const d of current) {
    if (!baseProbed.has(d) && !baseExcluded.has(d)) newSinceBaseline++;
  }
  let goneSinceBaseline = 0;
  for (const d of new Set([...baseProbed, ...baseExcluded])) {
    if (!current.has(d)) goneSinceBaseline++;
  }
  return {
    newlyExcluded,
    newlyProbed,
    newSinceBaseline,
    goneSinceBaseline,
    error:
      newlyExcluded.length > 0
        ? `scoping/registry changed the scored population: fix it or re-capture (${newlyExcluded.length} case(s) the baseline probed are now excluded: ${newlyExcluded.join(", ")})`
        : null,
  };
}

/**
 * Pre-spend population check of a compare run: `evaluateFree` scores the
 * cases with a mock inference (no spend; exclusion is decided before any
 * probe, so the candidate's population is the real run's), then the drift
 * rule applies. Null = may spend; else the reason to exit 2.
 */
export async function preSpendPopulationRefusal(
  baseline: Pick<EvalBaseline, "toolSelectionProbedIds" | "toolSelectionExcludedIds">,
  evaluateFree: () => Promise<Pick<EvalResult, "perCase" | "reachability">>,
): Promise<string | null> {
  const { probedIds, excludedIds } = populationIds(await evaluateFree());
  return populationDrift(baseline, probedIds, excludedIds).error;
}

// ------------------------------------------------------- per-case output

/**
 * An evaluator error string (`String(err)`, e.g. "TypeError: …") reduced to
 * its class name: the message could quote data.
 */
export function errorClassLabel(text: string): string {
  return /^([A-Za-z_$][\w$]*(?:Error|Exception))(?::|$)/.exec(text)?.[1] ?? "Error";
}

/** Per-case rows as `--percase-out` writes them: `details.error` → class name. */
export function percaseOutputRows<T extends { details: Record<string, unknown> }>(
  rows: T[],
): T[] {
  return rows.map((r) =>
    typeof r.details.error === "string"
      ? { ...r, details: { ...r.details, error: errorClassLabel(r.details.error) } }
      : r,
  );
}

/**
 * Where `--percase-out` may write: a file directly or deeper under the repo's
 * `data/` directory, in a directory git ignores, and not through a symlink.
 * Per-case output carries tool names and scores (no messages), but it is
 * derived from real traffic and never belongs in the public repo.
 * I/O is injected so the rule is unit-testable. Returns null when allowed,
 * else the refusal reason.
 */
export function percaseOutRefusal(
  file: string,
  deps: {
    repoRoot: string;
    /** fs.realpathSync — throws when the path does not exist. */
    realpath: (p: string) => string;
    /** fs.lstatSync(p).isSymbolicLink(), false when absent. */
    isSymlink: (p: string) => boolean;
    /** `git check-ignore -q <dir>` succeeded. */
    isGitIgnored: (dir: string) => boolean;
  },
): string | null {
  const abs = resolvePath(deps.repoRoot, file);
  let dataReal: string;
  let dirReal: string;
  try {
    dataReal = deps.realpath(joinPath(deps.repoRoot, "data"));
    dirReal = deps.realpath(dirnamePath(abs));
  } catch {
    return `parent directory of ${abs} (or the repo's data/) does not exist`;
  }
  const rel = relativePath(dataReal, dirReal);
  if (rel === ".." || rel.startsWith("../") || isAbsolutePath(rel)) {
    return `${abs} is outside the repo's data/ directory`;
  }
  if (deps.isSymlink(abs)) return `${abs} is a symlink`;
  if (!deps.isGitIgnored(dirReal)) {
    return `${dirReal} is not gitignored`;
  }
  return null;
}

/**
 * Floor on the scope_prompt SUBSCORE (0-100) on a compare run, queue 3j R1
 * W1: the composite epsilon (2 points) would hide a prompt regression of up
 * to ~13 subscore points (scope_prompt is 0.15 of the composite). 10.0 fails
 * at 5 lost cases of 43 (2.33 points each). Override only with an explicit
 * `--prompt-epsilon=<n>` (refused by --update-baseline); the operator may
 * re-tune the constant.
 */
export const SCOPE_PROMPT_EPSILON = 10.0;

/**
 * `--prompt-epsilon=<n>`: absent = {@link SCOPE_PROMPT_EPSILON}; a value
 * that is not a finite number >= 0 is an error (exit 2) — never a silent
 * fallback that could widen the floor.
 */
export function parsePromptEpsilon(
  value: string | undefined,
): { ok: true; epsilon: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, epsilon: SCOPE_PROMPT_EPSILON };
  return parseNonNegativeFlag("--prompt-epsilon", value);
}

/**
 * `--epsilon=<n>` (queue 3j R2): absent = undefined ({@link resolveEpsilon}
 * then picks the baseline's value or the default); a value that is not a
 * finite number >= 0 is an error (exit 2), never a silent fallback.
 */
export function parseEpsilonFlag(
  value: string | undefined,
): { ok: true; epsilon: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, epsilon: undefined };
  return parseNonNegativeFlag("--epsilon", value);
}

function parseNonNegativeFlag(
  flag: string,
  value: string,
): { ok: true; epsilon: number } | { ok: false; error: string } {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
    return { ok: false, error: `${flag} takes a number >= 0 (got "${value}")` };
  }
  return { ok: true, epsilon: n };
}

export type GateAction = "capture" | "pass" | "fail" | "refuse";

export interface GateDecisionInput {
  /** --update-baseline (capture) vs a compare run. */
  updateBaseline: boolean;
  /** {@link baselineCaptureRefusal} of the run (read on capture only). */
  captureRefusal: string | null;
  /** {@link erroredProbeRefusal} of the run (read on compare only). */
  erroredRefusal: string | null;
  /** {@link scopePromptRefusal} of the run (both paths). */
  promptRefusal: string | null;
  /** {@link populationDrift}`.error` (read on compare only). */
  driftError: string | null;
  /** Candidate composite (0-100). */
  overall: number;
  /** Candidate scope_prompt subscore; undefined = no scope_prompt row scored. */
  scopePrompt: number | undefined;
  /** The incumbent (compare); null = unavailable. */
  baseline: EvalBaseline | null;
  /** Composite tolerance ({@link resolveEpsilon}). */
  epsilon: number;
  /** scope_prompt subscore floor tolerance ({@link parsePromptEpsilon}). */
  promptEpsilon: number;
}

export interface GateDecision {
  action: GateAction;
  /** Why refuse / fail (empty for capture / pass). */
  reasons: string[];
  /** Composite compare (compare runs that reached a verdict). */
  composite?: GateResult;
  /** scope_prompt floor (compare runs where both sides scored it). */
  prompt?: {
    incumbent: number;
    candidate: number;
    delta: number;
    epsilon: number;
    floor: number;
    regressed: boolean;
  };
}

/**
 * The gate's capture / verdict decision after the paid run, in one place so
 * the fail-closed rules are unit-tested (queue 3j R1 W3). Capture: refuse on
 * a capture refusal or a scope_prompt refusal, else capture. Compare: refuse
 * on no baseline, an errored probe, a scope_prompt refusal, population drift,
 * or a scope_prompt subscore present on one side only; else FAIL when the
 * composite falls below incumbent − epsilon OR the scope_prompt subscore
 * below incumbent − promptEpsilon, else PASS.
 */
export function gateDecision(i: GateDecisionInput): GateDecision {
  const present = (xs: Array<string | null>) =>
    xs.filter((x): x is string => x !== null);
  if (i.updateBaseline) {
    const reasons = present([i.captureRefusal, i.promptRefusal]);
    return reasons.length > 0 ? { action: "refuse", reasons } : { action: "capture", reasons: [] };
  }
  if (i.baseline === null) {
    return { action: "refuse", reasons: ["baseline unavailable"] };
  }
  const reasons = present([i.erroredRefusal, i.promptRefusal, i.driftError]);
  const baseScopePrompt = i.baseline.subscores?.scopePrompt;
  const hasBase = typeof baseScopePrompt === "number" && Number.isFinite(baseScopePrompt);
  const hasRun = i.scopePrompt !== undefined;
  if (hasBase !== hasRun) {
    reasons.push(
      hasRun
        ? "baseline records no scope_prompt subscore; re-capture with --run --update-baseline"
        : "this run scored no scope_prompt rows but the baseline has a scope_prompt subscore",
    );
  }
  if (reasons.length > 0) return { action: "refuse", reasons };

  const composite = compareToBaseline(i.overall, i.baseline.overall, i.epsilon);
  const out: GateDecision = { action: "pass", reasons: [], composite };
  if (composite.regressed) {
    out.reasons.push(
      `composite ${composite.overall.toFixed(2)} < threshold ${composite.threshold.toFixed(2)} (incumbent ${composite.incumbent.toFixed(2)} - epsilon ${composite.epsilon})`,
    );
  }
  if (hasBase && hasRun) {
    const eps = Number.isFinite(i.promptEpsilon) && i.promptEpsilon >= 0 ? i.promptEpsilon : SCOPE_PROMPT_EPSILON;
    const floor = (baseScopePrompt as number) - eps;
    const candidate = i.scopePrompt as number;
    out.prompt = {
      incumbent: baseScopePrompt as number,
      candidate,
      delta: candidate - (baseScopePrompt as number),
      epsilon: eps,
      floor,
      regressed: candidate < floor,
    };
    if (out.prompt.regressed) {
      out.reasons.push(
        `scope_prompt ${candidate.toFixed(2)} < floor ${floor.toFixed(2)} (incumbent ${(baseScopePrompt as number).toFixed(2)} - prompt epsilon ${eps})`,
      );
    }
  }
  if (out.reasons.length > 0) out.action = "fail";
  return out;
}

export type Verdict = "PASS" | "FAIL";

export interface GateResult {
  verdict: Verdict;
  /** Candidate composite score just measured (0-100). */
  overall: number;
  /** Incumbent composite score from the stored baseline (0-100). */
  incumbent: number;
  /** Tolerance actually applied (composite points). */
  epsilon: number;
  /** incumbent - epsilon; the candidate must be >= this to PASS. */
  threshold: number;
  /** overall - incumbent. Negative = candidate scored lower than incumbent. */
  delta: number;
  /** True when the candidate fell below the tolerance floor. */
  regressed: boolean;
}

/**
 * Default regression tolerance, in composite points on the 0-100 scale.
 *
 * The brief's suggested "0.02" was expressed on a 0-1 score scale; the scorer
 * here reports 0-100, so ×100 = 2.0 points. Two points comfortably absorbs the
 * ~0.5-1 point run-to-run wobble of the LLM tool_selection metric while still
 * failing loudly on a gross tool-adherence collapse (the Sonnet-5 failure mode).
 */
export const DEFAULT_EPSILON = 2.0;

/**
 * Resolve the tolerance to apply: an explicit CLI override wins, else the
 * baseline file's value, else {@link DEFAULT_EPSILON}. Negative / non-finite
 * values are rejected (fall through to the next source) so a bad flag or a
 * corrupted file can never widen the gate to "always pass".
 */
export function resolveEpsilon(
  fileEpsilon?: number,
  flagEpsilon?: number,
): number {
  for (const candidate of [flagEpsilon, fileEpsilon]) {
    if (
      candidate !== undefined &&
      Number.isFinite(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  return DEFAULT_EPSILON;
}

/**
 * Compare a freshly measured composite score against the stored incumbent.
 *
 * PASS iff `overall >= incumbent - epsilon`. FAIL (a regression beyond
 * tolerance) otherwise. Boundary is inclusive: landing exactly on the threshold
 * PASSes.
 */
export function compareToBaseline(
  overall: number,
  incumbent: number,
  epsilon: number = DEFAULT_EPSILON,
): GateResult {
  if (!Number.isFinite(overall) || !Number.isFinite(incumbent)) {
    throw new Error(
      `compareToBaseline: non-finite input (overall=${overall}, incumbent=${incumbent})`,
    );
  }
  const eps =
    Number.isFinite(epsilon) && epsilon >= 0 ? epsilon : DEFAULT_EPSILON;
  const threshold = incumbent - eps;
  const delta = overall - incumbent;
  const regressed = overall < threshold;
  return {
    verdict: regressed ? "FAIL" : "PASS",
    overall,
    incumbent,
    epsilon: eps,
    threshold,
    delta,
    regressed,
  };
}
