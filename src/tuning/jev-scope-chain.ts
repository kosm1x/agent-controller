/**
 * Equal-inputs replay of a scope classifier (Jev plan §5, Phase B retest).
 *
 * The live scope is not a function of the message alone. The router gives the
 * classifier the tail of the thread (the previous turn and the message itself,
 * 150 chars each), the classifier prompt carries a
 * RULES block and annotated examples, and the result is unioned with the
 * previous turn's own classification while that is younger than the sticky
 * TTL. The first replay sent the message alone and was scored against tools
 * that were callable only because of that state. Here the candidate gets the
 * same inputs, and its OWN earlier answers form the sticky prior — never the
 * live ones, which would leak the incumbent into the candidate's score.
 *
 * `parseExchanges`, `recentContextOf` and `recentUserMessagesOf` mirror code
 * that is inline in src/messaging/router.ts (`getThreadTurns`, the
 * `recentContext` expression and the scoping wrapper). Keep them identical.
 *
 * Pure: no I/O. scripts/validate-jev-scope-chain.ts does the DB and network.
 */

import {
  percentile,
  pct,
  turnCoverage,
  type JevQuestion,
  type PassRule,
  type ToolOwners,
} from "./jev-scope-replay.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface ChainTurn {
  id: number;
  atMs: number;
  /** As recorded (`msg.text`, first 500 chars). */
  raw: string;
  /** `raw` normalized the way the router does it before classifying. */
  message: string;
  called: string[];
  liveGroups: string[];
  liveTools: string[];
  spanish: boolean;
  /** Thread turns that existed when this message arrived. */
  history: Turn[];
  /** False when the message is credential-shaped: never sent, never scored,
   * and it leaves the chain's prior as it was. */
  sendable: boolean;
  nouls?: Record<string, number>;
  latencyMs?: number;
  inputTokens?: number;
  error?: string;
}

/** router.ts `getThreadTurns`: "User: …\nJarvis: …" rows → turns. */
export function parseExchanges(
  contents: readonly string[],
  isPoisoned: (assistantText: string) => boolean,
): Turn[] {
  const turns: Turn[] = [];
  for (const text of contents) {
    const jarvisIdx = text.indexOf("\nJarvis: ");
    if (jarvisIdx === -1) continue;
    const userText = text.slice("User: ".length, jarvisIdx).trim();
    const assistantText = text.slice(jarvisIdx + "\nJarvis: ".length).trim();
    if (userText) turns.push({ role: "user", content: userText });
    if (assistantText && !isPoisoned(assistantText))
      turns.push({ role: "assistant", content: assistantText });
  }
  return turns;
}

/**
 * router.ts: the `recentContext` string handed to `classifyScopeGroups`. The
 * router appends the CURRENT message to the thread before slicing, so the
 * string is [last history turn, current message] — one turn of history, not
 * two. A turn whose sent slice `isSensitive` goes out as "role: [omitted]";
 * the check is per TURN, because a slice can span several lines.
 */
export function recentContextOf(
  history: readonly Turn[],
  current: string,
  isSensitive: (text: string) => boolean = () => false,
): { text: string; omitted: number } {
  let omitted = 0;
  const text = [...history, { role: "user" as const, content: current }]
    .slice(-2)
    .map((t) => {
      const slice = t.content.slice(0, 150);
      if (!isSensitive(slice)) return `${t.role}: ${slice}`;
      omitted++;
      return `${t.role}: [omitted]`;
    })
    .join("\n");
  return { text, omitted };
}

/**
 * router.ts scoping wrapper: what the pure scoper gets as recent messages. As
 * in the router, the current message is already the thread's last user turn.
 */
export function recentUserMessagesOf(
  history: readonly Turn[],
  current: string,
): string[] {
  const userMsgs = [...history, { role: "user" as const, content: current }]
    .filter((t) => t.role === "user")
    .slice(-4)
    .map((t) => t.content);
  const assistantContext = history
    .filter((t) => t.role === "assistant")
    .slice(-2)
    .map((t) => {
      const googleMatch = t.content.match(
        /\b(emails?|correos?|gmail|calendar|drive|hojas?|sheets?|google|gsheets)/gi,
      );
      const wpMatch = t.content.match(
        /\b(wordpress|wp|posts?|art[ií]culos?|livingjoyfully)/gi,
      );
      return [...(googleMatch ?? []), ...(wpMatch ?? [])].join(" ");
    })
    .filter((s) => s.length > 0);
  return [...userMsgs, ...assistantContext];
}

/**
 * The RULES bullets and the annotated examples of the classifier prompt,
 * verbatim. The output-format lines are left out: they tell a text model how
 * to answer, and carry no routing knowledge.
 */
export function parseClassifierGuidance(prompt: string): {
  rules: string[];
  examples: string[];
} {
  const lines = prompt.split("\n");
  const start = lines.findIndex((l) => l.trim() === "RULES:");
  const rules: string[] = [];
  if (start !== -1)
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("- ")) break;
      rules.push(line.slice(2).trim());
    }
  const examples = lines
    .map((l) => l.trim())
    .filter((l) => /^\[.*\]\s+\/\/ for /.test(l));
  return { rules, examples };
}

/**
 * One noul per group over a state of `message`, `recent_context`,
 * `classifier_rules` and `classifier_examples`. The group description is the
 * production text VERBATIM, as in the first replay.
 */
export function buildChainQuestions(
  descriptions: ReadonlyMap<string, string>,
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const [group, description] of descriptions)
    questions[`g_${group}`] = {
      type: "noul",
      instructions:
        `Does handling the user's \`message\` need the "${group}" capability group? ` +
        "`recent_context` is the end of the conversation so far; use it to work out what the message refers to. " +
        "`classifier_rules` and `classifier_examples` are the routing policy and take precedence over a literal reading of the group description.",
      criteria: {
        true: description,
        false: "Handling the message needs nothing from this group.",
      },
    };
  return questions;
}

export function buildChainState(
  message: string,
  recentContext: string,
  guidance: { rules: string[]; examples: string[] },
): Record<string, unknown> {
  return {
    message,
    recent_context: recentContext,
    classifier_rules: guidance.rules,
    classifier_examples: guidance.examples,
  };
}

export interface ChainDeps {
  /** router.ts `decideActiveGroups` (sticky union / inherit / regex). */
  decide: (
    semantic: Set<string> | null,
    prior: Set<string> | undefined,
    regexFallback: () => Set<string>,
    message: string,
  ) => { groups: Set<string>; base: Set<string> };
  regexGroups: (message: string, recent: string[]) => Set<string>;
  /** The pure production scoper. It ADDS its injected groups to `groups`. */
  scope: (message: string, recent: string[], groups: Set<string>) => string[];
  ttlMs: number;
  /** Process restarts wipe the in-memory prior. Empty = none known. */
  restartsMs?: readonly number[];
}

export interface TurnScope {
  /** Active groups after the sticky union and the scoper's injections. */
  groups: string[];
  tools: string[];
}

/**
 * Walks the thread in order the way the router does: the prior is the previous
 * turn's BASE classification while it is younger than the TTL and no restart
 * happened in between. `semanticFor` returns null where the classifier gave no
 * answer — the router's regex fallback then decides, exactly as it does live.
 */
export function simulateChain(
  turns: readonly ChainTurn[],
  semanticFor: (turn: ChainTurn) => Set<string> | null,
  deps: ChainDeps,
): TurnScope[] {
  const out: TurnScope[] = [];
  let prior: Set<string> | undefined;
  let priorAt = -Infinity;
  for (const turn of turns) {
    const restarted = (deps.restartsMs ?? []).some(
      (r) => r > priorAt && r <= turn.atMs,
    );
    const withinTtl = turn.atMs - priorAt <= deps.ttlMs;
    const recent = recentUserMessagesOf(turn.history, turn.raw);
    const decision = deps.decide(
      semanticFor(turn),
      withinTtl && !restarted ? prior : undefined,
      () => deps.regexGroups(turn.message, recent),
      turn.message,
    );
    const groups = new Set(decision.groups);
    const tools = deps.scope(turn.message, recent, groups);
    out.push({ groups: [...groups], tools });
    // A turn that was never sent has no classifier answer to remember: the
    // prior stays what it was (neither narrowed to the regex base nor informed
    // by live), and its clock is refreshed as every live turn refreshes it. A
    // prior that was already dead by then stays dead — refreshing the clock
    // must not bring it back.
    if (turn.sendable) prior = new Set(decision.base);
    else if (!withinTtl || restarted) prior = undefined;
    priorAt = turn.atMs;
  }
  return out;
}

export interface ChainEvaluation {
  rows: number;
  scored: number;
  covered: number;
  coverage: number;
  meanGroups: number;
  meanTools: number;
}

/** `asked` limits the group count to groups the candidate was asked about. */
export function evaluateChain(
  turns: readonly ChainTurn[],
  scopes: readonly TurnScope[],
  include: (turn: ChainTurn, index: number) => boolean,
  owners: ToolOwners,
  asked: ReadonlySet<string>,
): ChainEvaluation {
  let rows = 0;
  let scored = 0;
  let covered = 0;
  let groupsTotal = 0;
  let toolsTotal = 0;
  turns.forEach((turn, i) => {
    if (!include(turn, i)) return;
    rows++;
    groupsTotal += scopes[i].groups.filter((g) => asked.has(g)).length;
    toolsTotal += scopes[i].tools.length;
    const result = turnCoverage(turn.called, new Set(scopes[i].tools), owners);
    if (result === "no_group_needed") return;
    scored++;
    if (result === "covered") covered++;
  });
  return {
    rows,
    scored,
    covered,
    coverage: scored ? covered / scored : NaN,
    meanGroups: rows ? groupsTotal / rows : NaN,
    meanTools: rows ? toolsTotal / rows : NaN,
  };
}

export interface ChainVerdict {
  pass: boolean;
  threshold: number | null;
  answerRate: number;
  p95Ms: number;
  tune: ChainEvaluation | null;
  held: ChainEvaluation | null;
  liveMeanGroups: number;
  checks: { text: string; ok: boolean }[];
}

/**
 * Same PASS rule as the first replay, with a split that fits a thread: the
 * threshold is picked on the FIRST half of the window and judged on the SECOND
 * (neighbouring turns share a conversation, so an alternating split would put
 * near-copies on both sides). Spanish, judgeable turns only.
 */
export function judgeChain(
  turns: readonly ChainTurn[],
  grid: readonly number[],
  scopesAt: (threshold: number) => readonly TurnScope[],
  /** Live's recorded groups through the SAME chain — the size baseline. The
   * recorded list alone is pre-injection and would undercount live's scope. */
  liveScopes: readonly TurnScope[],
  judgeable: (turn: ChainTurn) => boolean,
  rule: PassRule,
  owners: ToolOwners,
  asked: ReadonlySet<string>,
  stopped: string | null,
): ChainVerdict {
  const sent = turns.filter((t) => t.latencyMs !== undefined);
  const answerRate = sent.length
    ? sent.filter((t) => t.nouls).length / sent.length
    : 0;
  const p95Ms = percentile(
    sent.map((t) => t.latencyMs!),
    95,
  );
  const mid = Math.floor(turns.length / 2);
  const inTune = (t: ChainTurn, i: number): boolean =>
    i < mid && t.spanish && judgeable(t);
  const inHeld = (t: ChainTurn, i: number): boolean =>
    i >= mid && t.spanish && judgeable(t);

  let threshold: number | null = null;
  let tune: ChainEvaluation | null = null;
  for (const t of [...grid].sort((a, b) => b - a)) {
    const e = evaluateChain(turns, scopesAt(t), inTune, owners, asked);
    if (e.coverage >= rule.coverage) {
      threshold = t;
      tune = e;
      break;
    }
  }
  const held =
    threshold === null
      ? null
      : evaluateChain(turns, scopesAt(threshold), inHeld, owners, asked);
  const liveMeanGroups = evaluateChain(
    turns,
    liveScopes,
    inHeld,
    owners,
    asked,
  ).meanGroups;

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
        threshold === null || tune === null
          ? `no threshold on the grid reaches ${pct(rule.coverage)} on the first half`
          : `threshold ${threshold} reaches ${pct(tune.coverage)} ≥ ${pct(rule.coverage)} on the first half (${tune.covered}/${tune.scored})`,
      ok: threshold !== null,
    },
  ];
  if (held)
    checks.push(
      {
        text: `second half has ${held.scored} scored turns ≥ ${rule.minHeldScored}`,
        ok: held.scored >= rule.minHeldScored,
      },
      {
        text: `second-half coverage ${pct(held.coverage)} (${held.covered}/${held.scored}) ≥ ${pct(rule.coverage)}`,
        ok: held.coverage >= rule.coverage,
      },
      {
        text: `second-half mean groups ${held.meanGroups.toFixed(2)} ≤ live through the same chain ${liveMeanGroups.toFixed(2)} + ${rule.extraGroups}`,
        ok: held.meanGroups <= liveMeanGroups + rule.extraGroups,
      },
    );
  return {
    pass: checks.every((c) => c.ok),
    threshold,
    answerRate,
    p95Ms,
    tune,
    held,
    liveMeanGroups,
    checks,
  };
}
