/**
 * Pure helpers for the Jev scope-replay harness (`scripts/validate-jev-scope.ts`,
 * plan: docs/planning/jev-decision-layer-plan-2026-09-21.md §5 Phase B).
 *
 * Nothing here touches the network, the DB or process.env. The group
 * descriptions and the group→tool ownership are both DERIVED from production
 * (`CLASSIFIER_SYSTEM_PROMPT`, `scopeToolsForMessage`) by the caller — this file
 * never carries its own copy of either.
 */

export interface JevQuestion {
  type: "noul" | "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ReplayRow {
  message: string;
  called: string[];
  liveGroups: string[];
  /** `tools_in_scope` as the live turn recorded it. */
  liveTools: string[];
  spanish: boolean;
  /** group → P(yes). Absent when the request failed. */
  nouls?: Record<string, number>;
  /** The ranking question's pick (`none` or a group). */
  rank?: string;
  /** Set for every request that was sent, failed ones included. */
  latencyMs?: number;
  /** What the vendor billed for the request (`usage.input_tokens`). */
  inputTokens?: number;
  error?: string;
}

export interface ToolOwners {
  /** Tools in scope with no group active — calling one needs no group. */
  baseline: Set<string>;
  owners: Map<string, Set<string>>;
}

/** The production scoper: selected groups → groups after injections + tools. */
export type ScopeFor = (
  message: string,
  groups: Set<string>,
) => { groups: Set<string>; tools: string[] };

export type TurnCoverage = "covered" | "missed" | "no_group_needed";

const NOUL_PREFIX = "g_";

/** `- group: description` lines of the classifier prompt, valid groups only. */
export function parseGroupDescriptions(
  prompt: string,
  valid: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of prompt.split("\n")) {
    const m = /^- ([a-z_]+): (.+)$/.exec(line.trim());
    if (m && valid.has(m[1]) && !out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

/**
 * One request: one noul per group plus a ranking choice. Descriptions go in
 * VERBATIM — their negations are deliberate ("is northstar_write, NOT
 * destructive"), and a rewrite of them would be graded instead of Jev.
 */
export function buildQuestions(
  descriptions: ReadonlyMap<string, string>,
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  const rank: Record<string, string> = {
    none: "No capability group is needed; a plain reply is enough.",
  };
  for (const [group, description] of descriptions) {
    rank[group] = description;
    questions[`${NOUL_PREFIX}${group}`] = {
      type: "noul",
      instructions: `Does handling this message need the "${group}" capability group?`,
      criteria: {
        true: description,
        false: "Handling the message needs nothing from this group.",
      },
    };
  }
  questions.rank = {
    type: "choice",
    instructions: "Which capability group is most needed for this message?",
    criteria: rank,
  };
  return questions;
}

/** Per-group probabilities + the rank pick out of a systemone response body. */
export function parseAnswers(
  body: unknown,
  groups: Iterable<string>,
): { nouls: Record<string, number>; rank?: string } | null {
  const answers = (
    body as { answers?: Record<string, { noul?: unknown; choice?: unknown }> }
  )?.answers;
  if (!answers || typeof answers !== "object") return null;
  const nouls: Record<string, number> = {};
  for (const g of groups) {
    const p = answers[`${NOUL_PREFIX}${g}`]?.noul;
    if (typeof p !== "number" || p < 0 || p > 1) return null;
    nouls[g] = p;
  }
  const rank = answers.rank?.choice;
  return { nouls, rank: typeof rank === "string" ? rank : undefined };
}

/**
 * Ownership derived from the production scoper: a tool belongs to every group
 * whose activation alone brings it into scope.
 */
export function buildToolOwners(
  groups: Iterable<string>,
  toolsFor: (active: Set<string>) => string[],
): ToolOwners {
  const baseline = new Set(toolsFor(new Set()));
  const owners = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const tool of toolsFor(new Set([g]))) {
      if (baseline.has(tool)) continue;
      if (!owners.has(tool)) owners.set(tool, new Set());
      owners.get(tool)!.add(g);
    }
  }
  return { baseline, owners };
}

/**
 * Was every group-owned tool the turn called inside `inScope`?
 * Tools nobody owns (baseline, or reached through tool search) need no group.
 */
export function turnCoverage(
  called: readonly string[],
  inScope: ReadonlySet<string>,
  { owners }: ToolOwners,
): TurnCoverage {
  let needed = false;
  for (const tool of called) {
    if (!owners.has(tool)) continue;
    needed = true;
    if (!inScope.has(tool)) return "missed";
  }
  return needed ? "covered" : "no_group_needed";
}

export function selectGroups(
  nouls: Record<string, number>,
  threshold: number,
): Set<string> {
  return new Set(
    Object.entries(nouls)
      .filter(([, p]) => p >= threshold)
      .map(([g]) => g),
  );
}

/**
 * Messages that may carry a credential never leave the box (plan §8). Biased
 * toward dropping: a lost row costs nothing, a sent secret cannot be recalled.
 */
export function looksSensitive(text: string): boolean {
  return (
    /(api[_-]?key|token|password|passwd|secret|contrase[nñ]a|credencial|bearer)/i.test(
      text,
    ) ||
    // "palabras clave" is SEO talk; "la clave es …" / "clave Verano2026" is a secret.
    /(?<!palabras?\s)\bclave\s*(de acceso\s*)?(es\b|[:=]|\S{6,})/i.test(text) ||
    /\b(pass|pwd)\b|\b(la|mi|su|tu) contra\b/i.test(text) ||
    /(\b(AKIA|ASIA)[A-Z0-9]{12,}|xox[bap]-|gh[pousr]_|github_pat_|\bsk-|-----BEGIN|:\/\/[^\s/:@]+:[^\s/@]+@)/.test(
      text,
    ) ||
    /[A-Za-z0-9+/_-]{32,}/.test(text) ||
    // 13–19 digits, contiguous or in card-style groups of four.
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/.test(text)
  );
}

/** Crude on purpose: the split only has to separate es-MX chat from English. */
export function isSpanish(text: string): boolean {
  if (/[áéíóúñ¿¡]/i.test(text)) return true;
  const hits = text
    .toLowerCase()
    .match(
      /\b(el|la|los|las|que|de|para|con|una|un|por|como|esta|este|del|al|es|y|en|mi|me|se|lo|qué|cómo)\b/g,
    );
  return (hits?.length ?? 0) >= 2;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

export interface Evaluation {
  answered: number;
  /** Answered turns that called at least one group-owned tool. */
  scored: number;
  covered: number;
  coverage: number;
  /** Mean asked groups active AFTER the scoper's injections — same basis as live. */
  meanGroups: number;
  meanTools: number;
  /** Scored turns whose rank pick owns at least one tool the turn called. */
  rankHits: number;
}

/** Scores answered rows only — `judge` is what refuses a thinly answered run. */
export function evaluate(
  rows: readonly ReplayRow[],
  threshold: number,
  owners: ToolOwners,
  scopeFor: ScopeFor,
): Evaluation {
  let answered = 0;
  let scored = 0;
  let covered = 0;
  let groupsTotal = 0;
  let toolsTotal = 0;
  let rankHits = 0;
  for (const row of rows) {
    const nouls = row.nouls;
    if (!nouls) continue;
    answered++;
    const scope = scopeFor(row.message, selectGroups(nouls, threshold));
    groupsTotal += [...scope.groups].filter((g) => g in nouls).length;
    toolsTotal += scope.tools.length;
    const result = turnCoverage(row.called, new Set(scope.tools), owners);
    if (result === "no_group_needed") continue;
    scored++;
    if (result === "covered") covered++;
    if (row.called.some((t) => owners.owners.get(t)?.has(row.rank ?? "")))
      rankHits++;
  }
  return {
    answered,
    scored,
    covered,
    coverage: scored ? covered / scored : NaN,
    meanGroups: answered ? groupsTotal / answered : NaN,
    meanTools: answered ? toolsTotal / answered : NaN,
    rankHits,
  };
}

/** Largest threshold whose coverage on `rows` still meets the bar, or null. */
export function pickThreshold(
  rows: readonly ReplayRow[],
  grid: readonly number[],
  minCoverage: number,
  owners: ToolOwners,
  scopeFor: ScopeFor,
): number | null {
  const passing = grid.filter(
    (t) => evaluate(rows, t, owners, scopeFor).coverage >= minCoverage,
  );
  return passing.length ? Math.max(...passing) : null;
}

export interface PassRule {
  coverage: number;
  extraGroups: number;
  p95Ms: number;
  /** Share of SENT requests that must come back usable. */
  minAnswerRate: number;
  /** Scored rows the held-out half needs before its coverage means anything. */
  minHeldScored: number;
}

export interface Verdict {
  pass: boolean;
  threshold: number | null;
  answerRate: number;
  /** Over every sent request: a timeout is a slow answer, not a missing one. */
  p95Ms: number;
  tuneRows: number;
  heldRows: number;
  held: Evaluation | null;
  liveMeanGroups: number;
  checks: { text: string; ok: boolean }[];
}

export const pct = (n: number): string =>
  Number.isNaN(n) ? "n/a" : `${(n * 100).toFixed(1)}%`;

/**
 * The PASS rule. Spanish rows only; the threshold is picked on the even half
 * and judged on the odd half. Unanswered requests cannot help a run pass: they
 * count against the answer rate and their latency stays in the p95. A run that
 * stopped early (`stopped` = why) never passes, however good its remnant looks.
 */
export function judge(
  rows: readonly ReplayRow[],
  grid: readonly number[],
  rule: PassRule,
  owners: ToolOwners,
  scopeFor: ScopeFor,
  stopped: string | null = null,
): Verdict {
  const sent = rows.filter((r) => r.latencyMs !== undefined);
  const answerRate = sent.length
    ? sent.filter((r) => r.nouls).length / sent.length
    : 0;
  const p95Ms = percentile(
    sent.map((r) => r.latencyMs!),
    95,
  );
  const spanish = rows.filter((r) => r.spanish && r.nouls);
  const tune = spanish.filter((_, i) => i % 2 === 0);
  const heldRows = spanish.filter((_, i) => i % 2 === 1);
  const threshold = pickThreshold(tune, grid, rule.coverage, owners, scopeFor);
  const held =
    threshold === null ? null : evaluate(heldRows, threshold, owners, scopeFor);
  const liveMeanGroups = heldRows.length
    ? heldRows.reduce(
        (n, r) => n + r.liveGroups.filter((g) => g in r.nouls!).length,
        0,
      ) / heldRows.length
    : NaN;

  const checks = [
    {
      text: stopped
        ? `run stopped early: ${stopped}`
        : "run completed without an early stop",
      ok: stopped === null,
    },
    {
      text: `answer rate ${pct(answerRate)} ≥ ${pct(rule.minAnswerRate)} of ${sent.length} sent`,
      ok: answerRate >= rule.minAnswerRate,
    },
    {
      text: `p95 over every sent request ${p95Ms} ms ≤ ${rule.p95Ms} ms`,
      ok: p95Ms <= rule.p95Ms,
    },
    {
      text:
        threshold === null
          ? `no threshold on the grid reaches ${pct(rule.coverage)} on the tune half (${tune.length} rows)`
          : `threshold ${threshold} reaches ${pct(evaluate(tune, threshold, owners, scopeFor).coverage)} ≥ ${pct(rule.coverage)} on the tune half (${tune.length} rows)`,
      ok: threshold !== null,
    },
  ];
  if (held) {
    checks.push(
      {
        text: `held-out half has ${held.scored} scored rows ≥ ${rule.minHeldScored}`,
        ok: held.scored >= rule.minHeldScored,
      },
      {
        text: `held-out coverage ${pct(held.coverage)} (${held.covered}/${held.scored}) ≥ ${pct(rule.coverage)}`,
        ok: held.coverage >= rule.coverage,
      },
      {
        text: `held-out mean groups ${held.meanGroups.toFixed(2)} ≤ live ${liveMeanGroups.toFixed(2)} + ${rule.extraGroups}`,
        ok: held.meanGroups <= liveMeanGroups + rule.extraGroups,
      },
    );
  }
  return {
    pass: checks.every((c) => c.ok),
    threshold,
    answerRate,
    p95Ms,
    tuneRows: tune.length,
    heldRows: heldRows.length,
    held,
    liveMeanGroups,
    checks,
  };
}
