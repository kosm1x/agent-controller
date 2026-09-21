/**
 * validate-jev-scope-chain — the EQUAL-INPUTS retest of TypeSafe Jev as the
 * scope classifier (docs/planning/jev-decision-layer-plan-2026-09-21.md §5,
 * "Phase B retest"). The rule below was registered in that doc BEFORE --run.
 *
 * Why a retest: the first replay (validate-jev-scope.ts, FAIL 09-21) sent Jev
 * the message alone. Live gives its classifier more, and this harness gives
 * Jev the same:
 *   1. the message, normalized with `normalizeForMatching`;
 *   2. `recent_context` — the router's exact string: the previous thread turn
 *      and the message itself, 150 chars each, rebuilt from the
 *      `conversations` rows that existed when the message arrived;
 *   3. the classifier prompt's RULES and annotated examples, verbatim;
 *   4. the sticky chain — the router's own `decideActiveGroups`, 45-min TTL,
 *      walking the thread in order, with JEV'S OWN earlier answers as the
 *      prior. Live's recorded groups are never fed into Jev's scope.
 *
 * Population: every router turn on the `telegram` thread since task metadata
 * started carrying `threadId` (2026-08-17 23:38 UTC), in order — including turns that
 * called no tool, because they still move the sticky prior. A repeat of the
 * previous message within 10 minutes (scope-miss re-run or a re-send) is
 * merged into one turn: called tools are unioned, live's groups stay those of
 * the FIRST row (the second row is usually the router's scope-miss re-run —
 * live's first run missed there, so such a turn is unscoreable for any
 * classifier and is reported separately). Ground truth: the tools the turn
 * really called.
 *
 * What stays tilted toward live, and cannot be fixed offline: the tools a turn
 * called were chosen FROM live's scope, so live scores 100 % by construction
 * and a tool only Jev would have offered can never count for Jev. Restart
 * times are known only since the journal starts; the verdict ignores restarts
 * and `--restarts <file>` reports how much they move the result.
 *
 * PASS (Spanish turns; threshold picked on the first half of the window,
 * judged on the second): run not stopped early · ≥ 90 % of sent requests
 * answered · p95 over every sent request ≤ 800 ms · ≥ 80 scored second-half
 * turns · coverage ≥ 95 % · mean groups ≤ live + 1. Unanswered turns are
 * scored on the regex fallback the router would use. No prompt or threshold
 * change after the run counts toward this verdict.
 *
 * DRY by default (DB read-only, no network). `--run` SENDS to
 * api.typesafe.ai, per request: the user message, the first 150 chars of the
 * previous thread turn (usually Jarvis's own reply), and the classifier
 * prompt's RULES, examples and group descriptions verbatim (they name internal
 * projects and hosts). A credential-shaped message is never sent; a
 * credential-shaped context turn goes out as "[omitted]". No retry: a vendor
 * 429/5xx counts against the answer rate. Results land in data/ (git-ignored,
 * 0600) and hold the text that was sent, never the text that was withheld —
 * delete after the decision.
 * Exit codes: 0 PASS · 1 FAIL/STOP · 2 self-test passed (never a result).
 *
 *   npx tsx scripts/validate-jev-scope-chain.ts               # dry + controls
 *   npx tsx scripts/validate-jev-scope-chain.ts --self-test   # verdict path, fabricated answers
 *   npx tsx scripts/validate-jev-scope-chain.ts --run         # sends + spends
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  VALID_GROUPS,
  withDeterministicGroups,
} from "../src/messaging/scope-classifier.js";
import {
  DEFAULT_SCOPE_PATTERNS,
  detectActiveGroups,
  scopeToolsForMessage,
} from "../src/messaging/scope.js";
import { normalizeForMatching } from "../src/messaging/normalize.js";
import {
  STICKY_SCOPE_TTL_MS,
  decideActiveGroups,
  isPoisonedExchange,
} from "../src/messaging/router.js";
import {
  buildToolOwners,
  isSpanish,
  looksSensitive,
  parseAnswers,
  parseGroupDescriptions,
  pct,
  percentile,
  selectGroups,
  turnCoverage,
  type PassRule,
} from "../src/tuning/jev-scope-replay.js";
import {
  buildChainQuestions,
  buildChainState,
  evaluateChain,
  judgeChain,
  parseClassifierGuidance,
  parseExchanges,
  recentContextOf,
  recentUserMessagesOf,
  simulateChain,
  type ChainDeps,
  type ChainTurn,
  type TurnScope,
} from "../src/tuning/jev-scope-chain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const THREAD = "telegram";
/** Registered population: turns recorded before this instant (UTC). */
const WINDOW_END_UTC = "2026-09-21 19:45:00";
const THREAD_BUFFER_SIZE = 15; // router.ts
const REPEAT_WINDOW_MS = 10 * 60_000;
const MIN_TURNS = 600;
const CONCURRENCY = 4;
const REQUEST_DEADLINE_MS = 5_000;
const CLIENT_DEADLINE_MS = 1_200;
const FAILING_RUN = { after: 40, minAnswerRate: 0.5 };
const USD_PER_MTOK = 0.042;
const GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const PASS: PassRule = {
  coverage: 0.95,
  extraGroups: 1,
  p95Ms: 800,
  minAnswerRate: 0.9,
  minHeldScored: 80,
};

const RUN = process.argv.includes("--run");
const SELF_TEST = process.argv.includes("--self-test");
const restartsArg = process.argv.indexOf("--restarts");

type ScopeOptions = Parameters<typeof scopeToolsForMessage>[3];

const utcMs = (sqliteUtc: string): number =>
  Date.parse(`${sqliteUtc.replace(" ", "T")}Z`);

function parseList(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function loadTurns(): { turns: ChainTurn[]; merged: number } {
  const db = new Database(join(ROOT, "data/mc.db"), {
    readonly: true,
    fileMustExist: true,
  });
  const rows = db
    .prepare(
      `SELECT s.id, s.message, s.active_groups, s.tools_in_scope, s.tools_called, s.created_at
         FROM scope_telemetry s JOIN tasks k ON k.task_id = s.task_id
        WHERE json_extract(k.metadata, '$.threadId') = ? AND s.created_at < ?
        ORDER BY s.id`,
    )
    .all(THREAD, WINDOW_END_UTC) as {
    id: number;
    message: string;
    active_groups: string;
    tools_in_scope: string;
    tools_called: string;
    created_at: string;
  }[];
  const exchanges = db
    .prepare(
      `SELECT content, created_at FROM conversations
        WHERE bank = 'mc-jarvis'
          AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value = ?)
        ORDER BY created_at, id`,
    )
    .all(THREAD) as { content: string; created_at: string }[];
  db.close();

  const turns: ChainTurn[] = [];
  let merged = 0;
  let seen = 0; // exchanges written strictly before the current turn
  for (const r of rows) {
    const atMs = utcMs(r.created_at);
    const last = turns[turns.length - 1];
    if (
      last &&
      last.message === normalizeForMatching(r.message) &&
      atMs - last.atMs <= REPEAT_WINDOW_MS
    ) {
      last.called = [
        ...new Set([...last.called, ...parseList(r.tools_called)]),
      ];
      merged++;
      continue;
    }
    while (seen < exchanges.length && exchanges[seen].created_at < r.created_at)
      seen++;
    const message = normalizeForMatching(r.message);
    turns.push({
      id: r.id,
      atMs,
      raw: r.message,
      message,
      called: parseList(r.tools_called),
      liveGroups: parseList(r.active_groups),
      liveTools: parseList(r.tools_in_scope),
      spanish: isSpanish(message),
      history: parseExchanges(
        exchanges
          .slice(Math.max(0, seen - THREAD_BUFFER_SIZE), seen)
          .map((e) => e.content),
        isPoisonedExchange,
      ),
      sendable: !mustNotLeave(r.message) && !mustNotLeave(message),
    });
  }
  return { turns, merged };
}

/** Credential-shaped text, and third parties' e-mail addresses, stay here. */
const mustNotLeave = (text: string): boolean =>
  looksSensitive(text) || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);

/** What is sent as `recent_context`; credential-shaped turns go out omitted. */
const safeContext = (turn: ChainTurn): { text: string; omitted: number } =>
  recentContextOf(turn.history, turn.raw, mustNotLeave);

function makeDeps(options: ScopeOptions, ttlMs: number): ChainDeps {
  return {
    decide: decideActiveGroups,
    regexGroups: (message, recent) =>
      detectActiveGroups(message, recent, DEFAULT_SCOPE_PATTERNS),
    scope: (message, recent, groups) =>
      scopeToolsForMessage(
        message,
        recent,
        DEFAULT_SCOPE_PATTERNS,
        options,
        groups,
      ),
    ttlMs,
  };
}

/** The env-dependent scoper options are not readable here; pick the combination
 * that best reproduces LIVE's recorded scope from LIVE's recorded groups. */
function fitOptions(turns: ChainTurn[]): ScopeOptions {
  const recent = turns.slice(-200);
  let best: { options: ScopeOptions; exact: number } | null = null;
  for (let mask = 0; mask < 16; mask++) {
    const options: ScopeOptions = {
      hasGoogle: !!(mask & 1),
      hasWordpress: !!(mask & 2),
      hasMemory: !!(mask & 4),
      hasCrm: !!(mask & 8),
    };
    const deps = makeDeps(options, STICKY_SCOPE_TTL_MS);
    let exact = 0;
    for (const t of recent) {
      const tools = new Set(
        deps.scope(
          t.message,
          recentUserMessagesOf(t.history, t.raw),
          new Set(t.liveGroups.filter((g) => VALID_GROUPS.has(g))),
        ),
      );
      if (
        tools.size === t.liveTools.length &&
        t.liveTools.every((x) => tools.has(x))
      )
        exact++;
    }
    if (!best || exact > best.exact) best = { options, exact };
  }
  console.log(
    `Scoper options fitted on the last ${recent.length} turns: ${JSON.stringify(best!.options)} reproduces live's recorded tool list exactly on ${best!.exact}`,
  );
  return best!.options;
}

function billedTokens(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("usage" in body))
    return undefined;
  const usage = body.usage;
  if (typeof usage !== "object" || usage === null || !("input_tokens" in usage))
    return undefined;
  return typeof usage.input_tokens === "number"
    ? usage.input_tokens
    : undefined;
}

function apiKey(): string | null {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const m = /^TYPESAFE_API_KEY=(.+)$/m.exec(
      readFileSync(join(ROOT, ".env"), "utf-8"),
    );
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

async function ask(
  turn: ChainTurn,
  state: unknown,
  questions: unknown,
  groups: string[],
  key: string,
): Promise<{ status: number; raw?: unknown }> {
  const started = performance.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    turn.latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      turn.error = `http_${res.status}`;
      return { status: res.status };
    }
    const raw: unknown = await res.json();
    turn.latencyMs = Math.round(performance.now() - started);
    turn.inputTokens = billedTokens(raw);
    const answers = parseAnswers(raw, groups);
    if (answers) turn.nouls = answers.nouls;
    else turn.error = "malformed_body";
    return { status: res.status, raw };
  } catch (err) {
    turn.latencyMs = Math.round(performance.now() - started);
    turn.error = err instanceof Error ? err.name : "unknown";
    return { status: 0 };
  }
}

async function replay(
  turns: ChainTurn[],
  stateFor: (turn: ChainTurn) => unknown,
  questions: unknown,
  groups: string[],
  key: string,
): Promise<{ raws: unknown[]; stopped: string | null }> {
  const raws: unknown[] = new Array(turns.length).fill(null);
  const queue = turns.map((t, i) => ({ t, i })).filter(({ t }) => t.sendable);
  let next = 0;
  let done = 0;
  let answered = 0;
  let stop: string | null = null;
  const worker = async (): Promise<void> => {
    while (!stop && next < queue.length) {
      const { t, i } = queue[next++];
      const { status, raw } = await ask(t, stateFor(t), questions, groups, key);
      raws[i] = raw ?? null;
      done++;
      if (t.nouls) answered++;
      if (status === 401) stop = "401 — the key was refused";
      else if (
        done >= FAILING_RUN.after &&
        answered / done < FAILING_RUN.minAnswerRate
      )
        stop = `only ${answered}/${done} requests answered`;
      if (done % 100 === 0) console.log(`  … ${done}/${queue.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stop) console.log(`STOPPED early: ${stop}`);
  return { raws, stopped: stop };
}

async function main(): Promise<void> {
  if (SELF_TEST && RUN) {
    console.log(
      "STOP — --self-test sends nothing; do not combine it with --run.",
    );
    process.exit(1);
  }
  const descriptions = parseGroupDescriptions(
    CLASSIFIER_SYSTEM_PROMPT,
    VALID_GROUPS,
  );
  const groups = [...descriptions.keys()];
  const asked = new Set(groups);
  const guidance = parseClassifierGuidance(CLASSIFIER_SYSTEM_PROMPT);
  const questions = buildChainQuestions(descriptions);

  const { turns, merged } = loadTurns();
  console.log(
    `Thread "${THREAD}": ${turns.length} turns (${merged} repeats merged) · ${new Date(turns[0]?.atMs ?? 0).toISOString()} → ${new Date(turns[turns.length - 1]?.atMs ?? 0).toISOString()}`,
  );
  if (turns.length < MIN_TURNS) {
    console.log(`STOP — fewer than ${MIN_TURNS} turns.`);
    process.exit(1);
  }
  const withContext = turns.filter((t) => t.history.length > 0).length;
  const omitted = turns.filter(
    (t) => t.sendable && safeContext(t).omitted > 0,
  ).length;
  console.log(
    `Inputs: ${turns.filter((t) => t.spanish).length} Spanish · ${turns.filter((t) => !t.sendable).length} credential-shaped messages never sent · ${withContext} turns have thread context · ${omitted} sent turns carry an omitted (credential-shaped) context turn · ${turns.filter((t) => t.raw.length >= 500).length} messages were recorded cut at 500 chars (live classified the whole text)`,
  );
  // Re-check what would actually go out (role labels stripped: "user:" is
  // itself login-shaped). Catches a redactor that lets part of a turn through.
  const leaking = turns.filter(
    (t) =>
      t.sendable &&
      mustNotLeave(safeContext(t).text.replace(/^(user|assistant): /gm, "")),
  ).length;
  if (leaking > 0) {
    console.log(
      `STOP — ${leaking} requests would still carry credential-shaped context.`,
    );
    process.exit(1);
  }
  console.log(
    `Guidance sent with every request: ${guidance.rules.length} RULES bullets + ${guidance.examples.length} annotated examples, verbatim; ${groups.length} group questions`,
  );

  const options = fitOptions(turns);
  const deps = makeDeps(options, STICKY_SCOPE_TTL_MS);
  const owners = buildToolOwners(groups, (active) =>
    deps.scope("", [], new Set(active)),
  );

  // Ceiling: the groups live RECORDED for the turn's first run (its final set:
  // sticky union and injections included — the classifier's raw answer is not
  // persisted) through today's scoper, as recorded: an empty recorded set stays
  // empty instead of falling to the regex detector. A turn they cannot cover
  // is unscoreable for ANY classifier: either live's own first
  // pass missed and the scope-miss re-run recovered it, or the tool was
  // regrouped since. Holding a candidate to those turns would fail a classifier
  // that reproduces live exactly.
  const asRecorded = makeDeps(options, -1);
  const liveScopes = simulateChain(
    turns,
    (t) => new Set(t.liveGroups.filter((g) => VALID_GROUPS.has(g))),
    {
      ...asRecorded,
      decide: (semantic, prior, regexFallback, message) =>
        semantic?.size === 0
          ? { groups: new Set<string>(), base: new Set<string>() }
          : asRecorded.decide(semantic, prior, regexFallback, message),
    },
  );
  const unscoreable = new Set<number>();
  turns.forEach((t, i) => {
    if (
      turnCoverage(t.called, new Set(liveScopes[i].tools), owners) === "missed"
    )
      unscoreable.add(t.id);
  });
  const judgeable = (t: ChainTurn): boolean =>
    t.sendable && !unscoreable.has(t.id);
  const spanishJudgeable = (t: ChainTurn): boolean => t.spanish && judgeable(t);
  const live = evaluateChain(
    turns,
    liveScopes,
    spanishJudgeable,
    owners,
    asked,
  );
  const liveRecorded = turns.filter(spanishJudgeable);
  console.log(
    `Ceiling: ${unscoreable.size} turns cannot be covered by the groups live recorded for the turn's first run and are not scored (reported below as information) · live on the rest: ${pct(live.coverage)} (${live.covered}/${live.scored}), ${live.meanGroups.toFixed(2)} groups, ${(liveRecorded.reduce((n, t) => n + t.liveTools.length, 0) / (liveRecorded.length || 1)).toFixed(0)} tools recorded`,
  );

  // Free controls through the SAME chain: what the router does with no
  // classifier answer at all (regex fallback + inheritance).
  const regexScopes = simulateChain(turns, () => null, deps);
  const regex = evaluateChain(
    turns,
    regexScopes,
    spanishJudgeable,
    owners,
    asked,
  );
  const heldFrom = Math.floor(turns.length / 2);
  const regexHeld = evaluateChain(
    turns,
    regexScopes,
    (t: ChainTurn, i: number) => i >= heldFrom && spanishJudgeable(t),
    owners,
    asked,
  );
  console.log(
    `Control — regex fallback through the same chain: ${pct(regex.coverage)} (${regex.covered}/${regex.scored}), ${regex.meanGroups.toFixed(2)} groups, ${regex.meanTools.toFixed(0)} tools · on the judged second half: ${pct(regexHeld.coverage)} (${regexHeld.covered}/${regexHeld.scored}), ${regexHeld.meanGroups.toFixed(2)} groups`,
  );

  const stateFor = (t: ChainTurn): unknown =>
    buildChainState(t.message, safeContext(t).text, guidance);
  const perRequest =
    (JSON.stringify(questions).length +
      JSON.stringify(stateFor(turns[0])).length) /
    4;
  const sendable = turns.filter((t) => t.sendable).length;
  const estimate = ((perRequest * sendable) / 1e6) * USD_PER_MTOK;
  console.log(
    `Request: ${groups.length} questions + state ≈ ${Math.round(perRequest)} tokens × ${sendable} turns · estimated spend ≈ $${estimate.toFixed(2)} (the first replay billed 6 % over the same estimate)`,
  );

  let stopped: string | null = null;
  if (SELF_TEST) {
    // Wiring proof: a classifier that answers live's groups, with the sticky
    // union switched off (live's groups already contain it), must PASS.
    for (const t of turns) {
      if (!t.sendable) continue;
      t.nouls = Object.fromEntries(
        groups.map((g) => [g, t.liveGroups.includes(g) ? 1 : 0]),
      );
      t.latencyMs = 1;
    }
    console.log(
      "\nSELF-TEST — answers fabricated from live's groups, sticky off:",
    );
  } else if (!RUN) {
    console.log(
      `\nSample state:\n${JSON.stringify({ ...(stateFor(turns[0]) as object), message: "<message>", recent_context: "<last two turns>" }, null, 2).slice(0, 900)} …`,
    );
    console.log(
      `\nSample question:\n${JSON.stringify(questions[`g_${groups[0]}`], null, 2)}`,
    );
    console.log(
      `\nDRY — pass --run to send ${sendable} messages with their thread context to ${ENDPOINT} and spend ≈ $${estimate.toFixed(2)}.`,
    );
    return;
  } else {
    const key = apiKey();
    if (!key) {
      console.log("STOP — TYPESAFE_API_KEY is not set.");
      process.exit(1);
    }
    const result = await replay(turns, stateFor, questions, groups, key);
    stopped = result.stopped;
    const out = join(
      ROOT,
      "data",
      `jev-scope-chain-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(
      out,
      JSON.stringify({
        model: MODEL,
        options,
        // Only what was sent, plus the answer: never the unsent thread
        // history, never the text of a message that was withheld.
        turns: turns.map(({ history: _unsent, raw, message, ...t }, i) => ({
          ...t,
          message: t.sendable ? message : null,
          sentContext: t.sendable ? safeContext(turns[i]).text : null,
          response: result.raws[i],
        })),
      }),
      { mode: 0o600 },
    );
    console.log(`Turn-level results: ${out}`);
  }

  const chainDeps = SELF_TEST ? makeDeps(options, -1) : deps;
  const semanticAt =
    (threshold: number) =>
    (t: ChainTurn): Set<string> | null =>
      t.nouls
        ? withDeterministicGroups(t.message, selectGroups(t.nouls, threshold))
        : null;
  const cache = new Map<number, TurnScope[]>();
  const scopesAt = (threshold: number): TurnScope[] => {
    if (!cache.has(threshold))
      cache.set(
        threshold,
        simulateChain(turns, semanticAt(threshold), chainDeps),
      );
    return cache.get(threshold)!;
  };

  const sent = turns.filter((t) => t.latencyMs !== undefined);
  const errors = new Map<string, number>();
  for (const t of sent)
    if (t.error) errors.set(t.error, (errors.get(t.error) ?? 0) + 1);
  const latencies = sent.map((t) => t.latencyMs!);
  const billed = sent.reduce((n, t) => n + (t.inputTokens ?? 0), 0);
  console.log(
    `\nRequests: ${sent.length} sent · ${sent.filter((t) => t.nouls).length} answered · errors ${JSON.stringify(Object.fromEntries(errors))}`,
  );
  console.log(
    `Latency (every sent request): p50 ${percentile(latencies, 50)} ms · p95 ${percentile(latencies, 95)} ms · max ${latencies.length ? Math.max(...latencies) : "n/a"} ms · over the ${CLIENT_DEADLINE_MS} ms client deadline: ${latencies.filter((l) => l > CLIENT_DEADLINE_MS).length}`,
  );
  console.log(
    `Billed: ${billed} input tokens ≈ $${((billed / 1e6) * USD_PER_MTOK).toFixed(3)}`,
  );

  const mid = Math.floor(turns.length / 2);
  for (const [label, include] of [
    ["Spanish, whole window", (t: ChainTurn) => spanishJudgeable(t)],
    [
      "Spanish, first half (tune)",
      (t: ChainTurn, i: number) => i < mid && spanishJudgeable(t),
    ],
    [
      "Spanish, second half (judged)",
      (t: ChainTurn, i: number) => i >= mid && spanishJudgeable(t),
    ],
    [
      "Spanish, second half, no context line omitted (informational)",
      (t: ChainTurn, i: number) =>
        i >= mid && spanishJudgeable(t) && safeContext(t).omitted === 0,
    ],
    [
      "Spanish, turns the groups live recorded for the first run cannot cover (informational, outside the verdict)",
      (t: ChainTurn) => t.spanish && t.sendable && unscoreable.has(t.id),
    ],
    [
      "English/other, whole window",
      (t: ChainTurn) => !t.spanish && judgeable(t),
    ],
  ] as const) {
    console.log(`\n${label}:`);
    for (const threshold of GRID) {
      const e = evaluateChain(
        turns,
        scopesAt(threshold),
        include,
        owners,
        asked,
      );
      console.log(
        `  T=${threshold.toFixed(2)}  coverage ${pct(e.coverage)} (${e.covered}/${e.scored})  groups ${e.meanGroups.toFixed(2)}  tools ${e.meanTools.toFixed(0)}`,
      );
    }
  }

  const verdict = judgeChain(
    turns,
    GRID,
    scopesAt,
    liveScopes,
    judgeable,
    PASS,
    owners,
    asked,
    stopped,
  );
  console.log(
    "\nVerdict — Spanish turns, threshold from the first half, judged on the second:",
  );
  for (const c of verdict.checks)
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.text}`);

  if (restartsArg !== -1 && verdict.threshold !== null) {
    const restartsMs = readFileSync(process.argv[restartsArg + 1], "utf-8")
      .split("\n")
      .map((l) => Date.parse(l.trim()))
      .filter((n) => !Number.isNaN(n));
    const from = Math.min(...restartsMs);
    const inWindow = (t: ChainTurn): boolean =>
      t.atMs >= from && spanishJudgeable(t);
    const plain = evaluateChain(
      turns,
      scopesAt(verdict.threshold),
      inWindow,
      owners,
      asked,
    );
    const wiped = evaluateChain(
      turns,
      simulateChain(turns, semanticAt(verdict.threshold), {
        ...chainDeps,
        restartsMs,
      }),
      inWindow,
      owners,
      asked,
    );
    console.log(
      `\nRestart sensitivity (${restartsMs.length} restarts since ${new Date(from).toISOString()}, not part of the verdict): ignoring restarts ${pct(plain.coverage)} (${plain.covered}/${plain.scored}) · wiping the prior at each restart ${pct(wiped.coverage)} (${wiped.covered}/${wiped.scored})`,
    );
  }

  const word = verdict.pass ? "PASS" : "FAIL";
  console.log(
    SELF_TEST
      ? `\nSELF-TEST ${word} — fabricated answers, NOT a result`
      : `\n${word}`,
  );
  process.exit(verdict.pass ? (SELF_TEST ? 2 : 0) : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
