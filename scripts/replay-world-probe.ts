/**
 * Dream-RSI Phase 0 — replay-world measurement probe (read-only, $0).
 *
 * Plan: docs/planning/dream-rsi-replay-evaluator-2026-09-16.md §4 Phase 0.
 * Re-runs the deterministic scope-regex policy over the recorded turns in
 * `scope_telemetry` with ZERO inference and reports whether that "world"
 * ranks known policies the way the paid eval does (§0b exit gate).
 *
 *   npx tsx scripts/replay-world-probe.ts            # all slices, text report
 *   npx tsx scripts/replay-world-probe.ts --json     # machine-readable
 *
 * Objective (§3.1): a recorded turn is a HIT for a candidate policy when every
 * tool the model actually called (`tools_called`) is inside the tool set the
 * candidate would have placed in scope; the cost term is |tools in scope|.
 * UNREVEALED: when the candidate scopes a tool the recorded turn never had in
 * scope, the recorded outcome says nothing about it — the turn is counted as
 * ABSTAIN and excluded from the revealed hit-rate (never credited).
 *
 * Limits (stated, not hidden):
 *  - Conversation history is not recorded per turn, so inheritance from
 *    prior messages is replayed with an empty history (both policies alike).
 *  - ~94 % of live turns are classified semantically; the recorded scope is
 *    the classifier's, the replayed scope is the regex fallback's. The replay
 *    therefore measures the FALLBACK policy against outcomes mostly produced
 *    by another policy — exactly the leverage ceiling §3 names.
 *  - Only tools a scope policy can emit count (`getAllAvailableTools`):
 *    harness tools (ToolSearch, LSP, MCP servers) are called on ~39 % of
 *    turns and no candidate can ever scope them (qa C1, 2026-09-18).
 *  - Two policies reveal different turn sets, so the ranking is a PAIRED
 *    comparison on the turns both reveal, with a sign test on the discordant
 *    pairs (qa C2). Aggregate rates are printed for context only.
 *  - The tool tables drifted during the window (e.g. `memory_forget` joined
 *    CORE on 09-12); the always-on set (CORE + MISC as of today) is exempt
 *    from the unrevealed check, but the abstain rate still tracks row age
 *    (qa W1/W2). A Phase 1 world would have to freeze the universe per row.
 *  - 45 % of rows are synthetic (fast-runner inserts for tasks that bypass
 *    the router: `active_groups = []`, prompt truncated to 500 chars). The
 *    `router` slice keeps only rows with ≥ 1 recorded group.
 *
 * Opens data/mc.db READ-ONLY through better-sqlite3 (never `?immutable=1`).
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import {
  CODE_SCOPE_PATTERNS,
  detectActiveGroups,
  getAllAvailableTools,
  scopeToolsForMessage,
} from "../src/messaging/scope.js";
import { scoreScopeAccuracy } from "../src/tuning/scorer.js";
import { deserializeSandbox } from "../src/tuning/variant-store.js";
import type { ScopePattern } from "../src/tuning/types.js";

const DB_PATH = resolve(process.cwd(), "data/mc.db");
const JSON_OUT = process.argv.includes("--json");
const APRIL_VARIANT = "var-tune-1775545200807";
const EVAL_OPTIONS = {
  hasGoogle: true,
  hasWordpress: true,
  hasMemory: false,
  hasCrm: true,
};

interface TelemetryRow {
  id: number;
  message: string;
  active_groups: string;
  tools_in_scope: string;
  tools_called: string;
  feedback_signal: string;
  created_at: string;
}

interface ReplayResult {
  policy: string;
  turns: number;
  nonScopable: number; // tools_called non-empty but none a policy can emit
  informative: number; // ≥ 1 scopable tool called
  revealed: number; // informative AND candidate scope ⊆ recorded scope ∪ always-on
  abstain: number; // informative AND candidate scoped an unrevealed tool
  hits: number; // over revealed
  hitRateRevealed: number;
  hitRateAll: number; // over informative, unrevealed tools counted as-is
  meanToolsInScope: number;
  // policy-independent population: every informative turn, hit-or-miss
  byFeedback: Record<string, { n: number; hitRate: number }>;
  /** per-turn outcome for paired comparison: id → { revealed, hit } */
  perTurn: Map<number, { revealed: boolean; hit: boolean }>;
}

interface PairedComparison {
  a: string;
  b: string;
  bothRevealed: number;
  hitsA: number;
  hitsB: number;
  discordant: number; // turns where exactly one policy hits
  aOnlyHits: number;
  bOnlyHits: number;
  /** two-sided binomial sign test on discordant pairs */
  signTestP: number;
  winner: string; // a | b | tie
}

interface PaidScopeResult {
  policy: string;
  cases: number;
  weightedScore: number; // 0-100, same scorer the paid eval uses
}

function parseArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** activation.ts merge rule: a variant replaces only the groups it carries. */
function mergeByGroup(
  base: ReadonlyArray<Readonly<ScopePattern>>,
  overrides: ScopePattern[],
): ScopePattern[] {
  const overridden = new Set(overrides.map((p) => p.group));
  return [...base.filter((p) => !overridden.has(p.group)), ...overrides];
}

function feedbackClass(signal: string): string {
  if (signal === "positive" || signal === "implicit_positive")
    return "positive";
  if (
    signal === "negative" ||
    signal === "rephrase" ||
    signal === "implicit_rephrase"
  )
    return "negative";
  return "none";
}

const SCOPE_UNIVERSE = getAllAvailableTools(EVAL_OPTIONS);
/** CORE + MISC as of today: unconditional on every path (qa C4/W2). */
const ALWAYS_ON = new Set(
  scopeToolsForMessage("", [], [], EVAL_OPTIONS, new Set<string>()),
);

function replay(
  policy: string,
  patterns: ScopePattern[],
  rows: TelemetryRow[],
): ReplayResult {
  let nonScopable = 0;
  let informative = 0;
  let revealed = 0;
  let abstain = 0;
  let hits = 0;
  let hitsAll = 0;
  let scopeSum = 0;
  const fb: Record<string, { n: number; hits: number }> = {};
  const perTurn = new Map<number, { revealed: boolean; hit: boolean }>();

  for (const row of rows) {
    const calledRaw = parseArr(row.tools_called);
    // qa C1: harness tools (ToolSearch, LSP, MCP) are never scopable.
    const called = calledRaw.filter((t) => SCOPE_UNIVERSE.has(t));
    const recorded = new Set(parseArr(row.tools_in_scope));
    const scoped = new Set(
      scopeToolsForMessage(row.message, [], patterns, EVAL_OPTIONS),
    );
    scopeSum += scoped.size;
    if (calledRaw.length > 0 && called.length === 0) nonScopable++;
    if (called.length === 0) continue;
    informative++;

    const hit = called.every((t) => scoped.has(t));
    if (hit) hitsAll++;

    // qa W4: feedback classes on the policy-independent population.
    const cls = feedbackClass(row.feedback_signal);
    fb[cls] ??= { n: 0, hits: 0 };
    fb[cls].n++;
    if (hit) fb[cls].hits++;

    const unrevealed = [...scoped].some(
      (t) => !recorded.has(t) && !ALWAYS_ON.has(t),
    );
    perTurn.set(row.id, { revealed: !unrevealed, hit });
    if (unrevealed) {
      abstain++;
      continue;
    }
    revealed++;
    if (hit) hits++;
  }

  const byFeedback: ReplayResult["byFeedback"] = {};
  for (const [k, v] of Object.entries(fb)) {
    byFeedback[k] = { n: v.n, hitRate: v.n ? v.hits / v.n : 0 };
  }

  return {
    policy,
    turns: rows.length,
    nonScopable,
    informative,
    revealed,
    abstain,
    hits,
    hitRateRevealed: revealed ? hits / revealed : 0,
    hitRateAll: informative ? hitsAll / informative : 0,
    meanToolsInScope: rows.length ? scopeSum / rows.length : 0,
    byFeedback,
    perTurn,
  };
}

/** Two-sided exact binomial sign test, p = 0.5. */
function signTest(k: number, n: number): number {
  if (n === 0) return 1;
  const logC = (n: number, k: number): number => {
    let r = 0;
    for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
    return r;
  };
  const lo = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= lo; i++) p += Math.exp(logC(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** qa C2: rank two policies on the turns BOTH reveal, sign test on discordant pairs. */
function paired(a: ReplayResult, b: ReplayResult): PairedComparison {
  let bothRevealed = 0;
  let hitsA = 0;
  let hitsB = 0;
  let aOnly = 0;
  let bOnly = 0;
  for (const [id, ra] of a.perTurn) {
    const rb = b.perTurn.get(id);
    if (!rb || !ra.revealed || !rb.revealed) continue;
    bothRevealed++;
    if (ra.hit) hitsA++;
    if (rb.hit) hitsB++;
    if (ra.hit && !rb.hit) aOnly++;
    if (rb.hit && !ra.hit) bOnly++;
  }
  const discordant = aOnly + bOnly;
  const p = signTest(aOnly, discordant);
  return {
    a: a.policy,
    b: b.policy,
    bothRevealed,
    hitsA,
    hitsB,
    discordant,
    aOnlyHits: aOnly,
    bOnlyHits: bOnly,
    signTestP: +p.toFixed(4),
    winner: p < 0.05 ? (aOnly > bOnly ? a.policy : b.policy) : "tie",
  };
}

/**
 * overnight-loop.ts replaces the FIRST pattern of the target group as the
 * array stood THAT night (qa W5/R2-C1): locate the slot by the recorded
 * `original_value`, hard-fail if it is gone (the tables drifted), and score
 * the mutation against a base that holds the original in that slot.
 */
function experimentPolicies(
  target: string,
  original: string,
  mutated: string,
): { base: ScopePattern[]; candidate: ScopePattern[] } {
  // Byte-equal source first; else the group's slot sharing the longest
  // prefix with the original (both live patterns were extended in place
  // since 09-08). Under 24 shared chars the lineage is unknown: fail loud.
  const prefixLen = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  let slot = -1;
  let best = 0;
  CODE_SCOPE_PATTERNS.forEach((p, i) => {
    if (p.group !== target) return;
    const n =
      p.pattern.source === original
        ? Infinity
        : prefixLen(p.pattern.source, original);
    if (n > best) {
      best = n;
      slot = i;
    }
  });
  if (slot < 0 || best < 24)
    throw new Error(
      `[probe] no slot descends from the original for group ${target}`,
    );
  const base: ScopePattern[] = [...CODE_SCOPE_PATTERNS];
  base[slot] = { pattern: new RegExp(original, "i"), group: target };
  const candidate: ScopePattern[] = [...base];
  candidate[slot] = { pattern: new RegExp(mutated, "i"), group: target };
  return { base, candidate };
}

function paidScope(
  policy: string,
  patterns: ScopePattern[],
  cases: Array<{ input: string; expected: string; weight: number }>,
): PaidScopeResult {
  let wsum = 0;
  let ssum = 0;
  for (const c of cases) {
    const input = JSON.parse(c.input) as {
      message: string;
      conversationHistory?: Array<{ role: string; content: string }>;
    };
    const recent = (input.conversationHistory ?? [])
      .filter((t) => t.role === "user")
      .map((t) => t.content);
    const groups = detectActiveGroups(input.message, recent, patterns);
    const { score } = scoreScopeAccuracy(JSON.parse(c.expected), groups);
    wsum += c.weight;
    ssum += score * c.weight;
  }
  return {
    policy,
    cases: cases.length,
    weightedScore: wsum ? (ssum / wsum) * 100 : 0,
  };
}

function main(): void {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  const allRows = db
    .prepare(
      `SELECT id, message, active_groups, tools_in_scope, tools_called,
              feedback_signal, created_at
         FROM scope_telemetry ORDER BY id`,
    )
    .all() as TelemetryRow[];
  const since = (days: number): string =>
    new Date(Date.now() - days * 86400_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
  const isRouter = (r: TelemetryRow): boolean =>
    parseArr(r.active_groups).length > 0;
  const slices: Array<[string, TelemetryRow[]]> = [
    ["all", allRows],
    ["router", allRows.filter(isRouter)],
    ["90d", allRows.filter((r) => r.created_at >= since(90))],
    ["30d", allRows.filter((r) => r.created_at >= since(30))],
  ];

  // Policies: current code patterns + the April gen-0 variant (merged by group).
  const current: ScopePattern[] = [...CODE_SCOPE_PATTERNS];
  const aprilRow = db
    .prepare(`SELECT config_json FROM tune_variants WHERE variant_id = ?`)
    .get(APRIL_VARIANT) as { config_json: string } | undefined;
  if (!aprilRow) {
    throw new Error(`[probe] variant ${APRIL_VARIANT} not found — 0b needs it`);
  }
  const aprilCfg = deserializeSandbox(aprilRow.config_json);
  const policies: Array<[string, ScopePattern[]]> = [
    ["current", current],
    [
      "april-variant",
      mergeByGroup(CODE_SCOPE_PATTERNS, aprilCfg.scopePatternOverrides ?? []),
    ],
  ];

  // 0b: every scope_rule experiment the nightly loop ran 09-08…09-15, replayed
  // as candidate = current with the target group's pattern swapped.
  const experiments = db
    .prepare(
      `SELECT experiment_id, target, original_value, mutated_value, baseline_score, mutated_score, status
         FROM tune_experiments
        WHERE surface = 'scope_rule'
          AND created_at >= '2026-09-08' AND created_at < '2026-09-16'
          AND status != 'rejected'
        ORDER BY created_at`,
    )
    .all() as Array<{
    experiment_id: string;
    target: string;
    original_value: string;
    mutated_value: string;
    baseline_score: number;
    mutated_score: number;
    status: string;
  }>;

  // Same population as getActiveTestCases(): seed ∪ mined (qa W7).
  const scopeCases = db
    .prepare(
      `SELECT input, expected, weight FROM tune_test_cases
        WHERE active = 1 AND category = 'scope_accuracy'
       UNION ALL
       SELECT input, expected, weight FROM mined_test_cases
        WHERE active = 1 AND category = 'scope_accuracy'`,
    )
    .all() as Array<{ input: string; expected: string; weight: number }>;

  // 0a
  const replays: Record<string, ReplayResult[]> = {};
  for (const [sliceName, rows] of slices) {
    replays[sliceName] = policies.map(([name, p]) => replay(name, p, rows));
  }

  // 0b
  const paid = policies.map(([name, p]) => paidScope(name, p, scopeCases));
  const rows90 = slices.find(([n]) => n === "90d")![1];
  const currentReplay90 = replays["90d"][0];
  const pairedAprilVsCurrent = paired(currentReplay90, replays["90d"][1]);
  const experimentAgreement = experiments.map((e) => {
    let pol: ReturnType<typeof experimentPolicies>;
    try {
      pol = experimentPolicies(e.target, e.original_value, e.mutated_value);
    } catch {
      return { experiment: e.experiment_id, target: e.target, invalid: true };
    }
    const slotStillCurrent = CODE_SCOPE_PATTERNS.some(
      (p) => p.group === e.target && p.pattern.source === e.original_value,
    );
    const base = replay(`${e.experiment_id}:base`, pol.base, rows90);
    const r = replay(e.experiment_id, pol.candidate, rows90);
    const pc = paired(base, r);
    const basePaid = paidScope(`${e.experiment_id}:base`, pol.base, scopeCases);
    const p = paidScope(e.experiment_id, pol.candidate, scopeCases);
    const paidScopeDelta = +(p.weightedScore - basePaid.weightedScore).toFixed(
      2,
    );
    const recordedDelta = e.mutated_score - e.baseline_score;
    // qa W3: a side with no opinion is a TIE, never a disagreement.
    const replaySign =
      pc.winner === "tie" ? 0 : pc.winner === e.experiment_id ? 1 : -1;
    const paidSign = Math.sign(paidScopeDelta);
    const verdict =
      replaySign === 0 || paidSign === 0
        ? "tie"
        : replaySign === paidSign
          ? "agree"
          : "disagree";
    return {
      experiment: e.experiment_id,
      target: e.target,
      status: e.status,
      slotStillCurrent,
      basePaidScope: +basePaid.weightedScore.toFixed(2),
      pairedBothRevealed: pc.bothRevealed,
      pairedDiscordant: pc.discordant,
      replayWinner: pc.winner,
      signTestP: pc.signTestP,
      paidScopeDelta,
      recordedCompositeDelta: +recordedDelta.toFixed(2),
      verdict,
    };
  });
  const tally = (v: string): number =>
    experimentAgreement.filter((e) => "verdict" in e && e.verdict === v).length;

  // 0c: orchestrator tree density — decision points with ≥ 2 SCORED attempts.
  const c = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  // qa C3: `runs` is one row per task, so an ATTEMPT is a task: a retry
  // (tasks.retry_count > 0, swarm attemptSubtaskRetry), a sibling subtask
  // under the same parent, or a runner fallback. A decision point with ≥ 2
  // SCORED attempts = such a lineage where ≥ 2 members carry a met/failed gate.
  const orchestrator = {
    runsPerTaskMax: c(
      `SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM runs GROUP BY task_id)`,
    ),
    retryTasks90d: c(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE retry_count > 0 AND created_at >= datetime('now','-90 days')`,
    ),
    parentsWithGe2Children90d: c(
      `SELECT COUNT(*) AS n FROM (SELECT parent_task_id FROM tasks
         WHERE parent_task_id IS NOT NULL
           AND created_at >= datetime('now','-90 days')
         GROUP BY parent_task_id HAVING COUNT(*) >= 2)`,
    ),
    tasksWithGe2ScoredGates90d: c(
      `SELECT COUNT(*) AS n FROM (SELECT task_id FROM task_gates
         WHERE created_at >= datetime('now','-90 days')
         GROUP BY task_id HAVING SUM(state IN ('met','failed')) >= 2)`,
    ),
    tasksFailedThenCompleted90d: c(
      `SELECT COUNT(DISTINCT f.task_id) AS n FROM task_trace_events f
         JOIN task_trace_events s ON s.task_id = f.task_id AND s.id > f.id
        WHERE f.name = 'task.failed' AND s.name = 'task.completed'
          AND f.ts >= datetime('now','-90 days')`,
    ),
    fallbackEvents90d: c(
      `SELECT COUNT(*) AS n FROM task_trace_events
        WHERE name = 'task.fallback' AND ts >= datetime('now','-90 days')`,
    ),
    tasksWithGe2Rounds90d: c(
      `SELECT COUNT(*) AS n FROM (SELECT task_id FROM task_trace_events
         WHERE name = 'turn.completed' AND ts >= datetime('now','-90 days')
         GROUP BY task_id HAVING COUNT(DISTINCT round) >= 2)`,
    ),
  };
  const decisionPoints = c(
    `WITH scored AS (
       SELECT task_id FROM task_gates
        WHERE state IN ('met','failed')
          AND created_at >= datetime('now','-90 days')
        GROUP BY task_id
     ),
     lineage AS (
       -- retry: the retried task + its parent
       SELECT t.task_id AS member, t.parent_task_id AS root FROM tasks t
        WHERE t.retry_count > 0 AND t.parent_task_id IS NOT NULL
          AND t.created_at >= datetime('now','-90 days')
       UNION
       SELECT t.parent_task_id, t.parent_task_id FROM tasks t
        WHERE t.retry_count > 0 AND t.parent_task_id IS NOT NULL
          AND t.created_at >= datetime('now','-90 days')
       UNION
       -- siblings under one parent
       SELECT t.task_id, t.parent_task_id FROM tasks t
        WHERE t.created_at >= datetime('now','-90 days')
          AND t.parent_task_id IN (
          SELECT parent_task_id FROM tasks
           WHERE parent_task_id IS NOT NULL
             AND created_at >= datetime('now','-90 days')
           GROUP BY parent_task_id HAVING COUNT(*) >= 2)
     )
     SELECT COUNT(*) AS n FROM (
       SELECT root FROM lineage l JOIN scored s ON s.task_id = l.member
        GROUP BY root HAVING COUNT(DISTINCT l.member) >= 2)`,
  );

  // 0d: membership objective preview — recorded tools-in-scope vs called.
  const inScopeSizes: number[] = [];
  const calledSizes: number[] = [];
  const groupSeen = new Map<string, { active: number; called: Set<string> }>();
  for (const row of rows90) {
    const scope = parseArr(row.tools_in_scope);
    const called = parseArr(row.tools_called);
    inScopeSizes.push(scope.length);
    calledSizes.push(new Set(called).size); // distinct, like tools_in_scope
    for (const g of parseArr(row.active_groups)) {
      const e = groupSeen.get(g) ?? { active: 0, called: new Set<string>() };
      e.active++;
      for (const t of called) e.called.add(t);
      groupSeen.set(g, e);
    }
  }
  const mean = (a: number[]): number =>
    a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const pct = (a: number[], q: number): number => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  // qa C4: marginal tools per group = expansion minus the always-on set
  // (CORE + MISC); `meta` expands to every group by design and is excluded.
  const groupTools = new Map<string, string[]>();
  for (const group of groupSeen.keys()) {
    if (group === "meta") continue;
    groupTools.set(
      group,
      scopeToolsForMessage("", [], [], EVAL_OPTIONS, new Set([group])).filter(
        (t) => !ALWAYS_ON.has(t),
      ),
    );
  }
  const membership = [...groupTools.entries()]
    .map(([group, tools]) => {
      const e = groupSeen.get(group)!;
      const everCalled = tools.filter((t) => e.called.has(t));
      return {
        group,
        turnsActive: e.active,
        marginalTools: tools.length,
        everCalled: everCalled.length,
        neverCalled: tools.length - everCalled.length,
      };
    })
    .sort(
      (a, b) => b.turnsActive * b.neverCalled - a.turnsActive * a.neverCalled,
    );
  // Per-turn, de-duplicated ESTIMATE (not a bound — everCalled is per group,
  // so a tool supplied by a co-active group can be mis-credited either way):
  // recorded tools that are not always-on and that no active group supplying
  // them has ever seen called.
  const neverCalledByGroup = new Map<string, Set<string>>();
  for (const [g, tools] of groupTools) {
    const e = groupSeen.get(g)!;
    neverCalledByGroup.set(g, new Set(tools.filter((t) => !e.called.has(t))));
  }
  let removableSlots = 0;
  let marginalSlots = 0;
  for (const row of rows90) {
    const groups = parseArr(row.active_groups).filter((g) => g !== "meta");
    if (groups.length === 0) continue;
    for (const t of parseArr(row.tools_in_scope)) {
      if (ALWAYS_ON.has(t)) continue;
      const suppliers = groups.filter((g) => groupTools.get(g)?.includes(t));
      if (suppliers.length === 0) continue;
      marginalSlots++;
      if (suppliers.every((g) => neverCalledByGroup.get(g)!.has(t)))
        removableSlots++;
    }
  }
  const membershipPreview = {
    turns: rows90.length,
    routerTurns: rows90.filter(isRouter).length,
    alwaysOnTools: ALWAYS_ON.size,
    meanToolsInScope: +mean(inScopeSizes).toFixed(1),
    p50ToolsInScope: pct(inScopeSizes, 0.5),
    p90ToolsInScope: pct(inScopeSizes, 0.9),
    meanToolsCalled: +mean(calledSizes).toFixed(2),
    totalToolSlots: inScopeSizes.reduce((s, n) => s + n, 0),
    marginalGroupSlots: marginalSlots,
    // ESTIMATE, per-turn de-duplicated, always-on excluded, meta excluded
    estRemovableSlots: removableSlots,
    groups: membership,
  };

  const stripTurns = (r: ReplayResult): Omit<ReplayResult, "perTurn"> => {
    const { perTurn: _p, ...rest } = r;
    return rest;
  };
  const replayPrefersCurrent = pairedAprilVsCurrent.winner === "current";
  const paidPrefersCurrent = paid[0].weightedScore > paid[1].weightedScore;
  const report = {
    generatedAt: new Date().toISOString(),
    db: DB_PATH,
    telemetryRows: allRows.length,
    phase0a: Object.fromEntries(
      Object.entries(replays).map(([k, v]) => [k, v.map(stripTurns)]),
    ),
    phase0b: {
      paidScopeEval: paid,
      pairedAprilVsCurrent,
      // paid eval prefers current (100 vs 88.78); the replay agrees only if
      // the paired sign test names current as the winner.
      rankingVerdict:
        pairedAprilVsCurrent.winner === "tie"
          ? "tie (no resolving power)"
          : replayPrefersCurrent === paidPrefersCurrent
            ? "agree"
            : "disagree",
      experiments: experimentAgreement,
      experimentTally: {
        agree: tally("agree"),
        disagree: tally("disagree"),
        tie: tally("tie"),
      },
      feedbackGate: Object.fromEntries(
        Object.entries(replays["90d"][0].byFeedback),
      ),
    },
    phase0c: {
      ...orchestrator,
      decisionPointsGe2ScoredAttempts: decisionPoints,
    },
    phase0d: membershipPreview,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`replay-world-probe — ${report.generatedAt}`);
  console.log(`telemetry rows: ${allRows.length}\n`);
  console.log("0a. replay (hit = every called tool in candidate scope)");
  for (const [slice, rs] of Object.entries(replays)) {
    for (const r of rs) {
      console.log(
        `  ${slice.padEnd(6)} ${r.policy.padEnd(14)} turns=${r.turns} nonScopable=${r.nonScopable} informative=${r.informative} revealed=${r.revealed} abstain=${r.abstain} hit(revealed)=${(r.hitRateRevealed * 100).toFixed(1)}% hit(all)=${(r.hitRateAll * 100).toFixed(1)}% meanScope=${r.meanToolsInScope.toFixed(1)}`,
      );
    }
  }
  console.log("\n0b. paid scope_accuracy cases (same scorer, zero inference)");
  for (const p of paid)
    console.log(
      `  ${p.policy.padEnd(14)} cases=${p.cases} score=${p.weightedScore.toFixed(2)}`,
    );
  console.log(
    "  paired april vs current (90d):",
    JSON.stringify(pairedAprilVsCurrent),
  );
  console.log(`  ranking verdict: ${report.phase0b.rankingVerdict}`);
  console.log(
    `  scope_rule experiments 09-08…09-15: ${experimentAgreement.length} → ${JSON.stringify(report.phase0b.experimentTally)}`,
  );
  for (const e of experimentAgreement) console.log("   ", JSON.stringify(e));
  console.log("  feedback gate (current, 90d, all informative turns):");
  for (const [k, v] of Object.entries(report.phase0b.feedbackGate))
    console.log(
      `    ${k.padEnd(9)} n=${v.n} hit=${(v.hitRate * 100).toFixed(1)}%`,
    );
  console.log("\n0c. orchestrator tree density (90d)");
  console.log("  ", JSON.stringify(report.phase0c));
  console.log("\n0d. membership preview (90d)");
  const { groups, ...summary } = membershipPreview;
  console.log("  ", JSON.stringify(summary));
  for (const g of groups.slice(0, 12))
    console.log(
      `   ${g.group.padEnd(18)} active=${g.turnsActive} marginal=${g.marginalTools} everCalled=${g.everCalled} neverCalled=${g.neverCalled}`,
    );
}

main();
