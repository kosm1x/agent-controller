/**
 * validate-jev-scope — offline replay of TypeSafe Jev as a scope classifier
 * (docs/planning/jev-decision-layer-plan-2026-09-21.md §5 Phase B).
 *
 * Corpus: the most recent distinct `scope_telemetry` messages whose turn
 * called at least one tool AND got at least one scope group. Rows with
 * `active_groups = []` are left out: most are the synthetic rows fast-runner
 * writes for tasks that bypassed the router (rituals, schedules, direct API) —
 * their scope is the task's tool list, no classifier decided it, and their
 * `message` is a task prompt, not user text. Consequence: over-selection on a
 * turn that needed no group at all is NOT measured here.
 * Ground truth: the tools the turn REALLY called.
 * Jev answers one noul per scope group, built from the production group
 * descriptions VERBATIM; the selected groups go through the
 * production scoper (`withDeterministicGroups` + `scopeToolsForMessage`), and a
 * turn is covered when every group-owned tool it called is in that scope.
 * The live classifier scores ~100 % on this measure by construction (a tool
 * can only be called from scope), so the bar is absolute, not relative — the
 * live figure is printed as a sanity check on the measure itself.
 *
 * The threshold is picked on one half of the Spanish rows and judged on the
 * other (`judge` in src/tuning/jev-scope-replay.ts, tested there). PASS:
 * ≥ 90 % of sent requests answered · p95 over EVERY sent request ≤ 800 ms ·
 * held-out half ≥ 80 scored rows · held-out coverage ≥ 95 % · mean groups after
 * injections ≤ live mean + 1 · the run did not stop early. A FAIL ends the Jev
 * scope work.
 *
 * Known limits: telemetry stores the first 500 chars of a message, so long
 * messages are replayed truncated; near-duplicate messages can sit on both
 * sides of the tune/held split.
 *
 * DRY by default: reads data/mc.db READ-ONLY, no network, no key. `--run`
 * SENDS USER MESSAGE TEXT to api.typesafe.ai and spends (cents). `state` is
 * the message text only — never tool output, file contents or KB bodies — and
 * credential-shaped messages are dropped first. The questions carry the
 * classifier prompt's group descriptions, which name our sites and projects.
 * Row-level results land in data/ (git-ignored, mode 0600); that file holds the
 * replayed message text and the raw vendor bodies — delete it when done.
 *
 *   npx tsx scripts/validate-jev-scope.ts            # dry
 *   npx tsx scripts/validate-jev-scope.ts --self-test  # dry + the verdict path on fabricated answers
 *   npx tsx scripts/validate-jev-scope.ts --run      # operator: sends + spends
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
import { scopeToolsForMessage } from "../src/messaging/scope.js";
import {
  buildQuestions,
  buildToolOwners,
  evaluate,
  isSpanish,
  judge,
  looksSensitive,
  parseAnswers,
  parseGroupDescriptions,
  pct,
  percentile,
  turnCoverage,
  type PassRule,
  type ReplayRow,
  type ScopeFor,
  type ToolOwners,
} from "../src/tuning/jev-scope-replay.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const CORPUS_SIZE = 400;
/** Below this the held-out half cannot reach `PASS.minHeldScored` (09-21 rates:
 * 87 % Spanish, 70 % of those scored, half held out ⇒ ~263 rows needed). */
const MIN_USABLE = 300;
const CONCURRENCY = 4;
const REQUEST_DEADLINE_MS = 5_000;
/** The plan's client deadline: a slower answer is a null in production. */
const CLIENT_DEADLINE_MS = 1_200;
/** Stop a run that is mostly failing instead of finishing it on a remnant. */
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
const ALL_ON = {
  hasGoogle: true,
  hasWordpress: true,
  hasMemory: true,
  hasCrm: true,
};

// `withDeterministicGroups` returns a fresh Set and `scopeToolsForMessage`
// ADDS its injected groups to the Set it is given — so after the call `active`
// is the post-injection group set, the same thing live `active_groups` records.
const scopeFor: ScopeFor = (message, groups) => {
  const active = withDeterministicGroups(message, groups);
  const tools = scopeToolsForMessage(message, [], [], ALL_ON, active);
  return { groups: active, tools };
};

function parseList(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function loadCorpus(): { rows: ReplayRow[]; dropped: number } {
  const db = new Database(join(ROOT, "data/mc.db"), {
    readonly: true,
    fileMustExist: true,
  });
  const population = db
    .prepare(
      `SELECT COUNT(DISTINCT message) AS n, MIN(created_at) AS first, MAX(created_at) AS last
         FROM scope_telemetry
        WHERE tools_called NOT IN ('[]', '') AND active_groups NOT IN ('[]', '')`,
    )
    .get() as { n: number; first: string; last: string };
  console.log(
    `Population: ${population.n} distinct routed messages with a tool call and ≥1 live group (${population.first} → ${population.last})`,
  );
  // MAX(id) picks the newest turn of a repeated message; SQLite returns the
  // other columns from that same row.
  const raw = db
    .prepare(
      `SELECT message, active_groups, tools_in_scope, tools_called, MAX(id) AS id
         FROM scope_telemetry
        WHERE tools_called NOT IN ('[]', '') AND active_groups NOT IN ('[]', '')
        GROUP BY message
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(CORPUS_SIZE * 2) as {
    message: string;
    active_groups: string;
    tools_in_scope: string;
    tools_called: string;
  }[];
  db.close();

  const rows: ReplayRow[] = [];
  let dropped = 0;
  for (const r of raw) {
    if (rows.length >= CORPUS_SIZE) break;
    if (looksSensitive(r.message)) {
      dropped++;
      continue;
    }
    rows.push({
      message: r.message,
      called: parseList(r.tools_called),
      liveGroups: parseList(r.active_groups),
      liveTools: parseList(r.tools_in_scope),
      spanish: isSpanish(r.message),
    });
  }
  return { rows, dropped };
}

/** Only the one key this harness needs, and only under --run. */
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

async function ask(
  row: ReplayRow,
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
      body: JSON.stringify({
        state: { message: row.message },
        model: MODEL,
        questions,
      }),
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    row.latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      row.error = `http_${res.status}`;
      return { status: res.status };
    }
    const raw: unknown = await res.json();
    // Time to a usable answer, not to the response headers.
    row.latencyMs = Math.round(performance.now() - started);
    row.inputTokens = billedTokens(raw);
    const answers = parseAnswers(raw, groups);
    if (answers) {
      row.nouls = answers.nouls;
      row.rank = answers.rank;
    } else row.error = "malformed_body";
    return { status: res.status, raw };
  } catch (err) {
    row.latencyMs = Math.round(performance.now() - started);
    row.error = err instanceof Error ? err.name : "unknown";
    return { status: 0 };
  }
}

async function replay(
  rows: ReplayRow[],
  questions: unknown,
  groups: string[],
  key: string,
): Promise<{ raws: unknown[]; stopped: string | null }> {
  const raws: unknown[] = new Array(rows.length).fill(null);
  let next = 0;
  let done = 0;
  let answered = 0;
  let stop: string | null = null;
  const worker = async (): Promise<void> => {
    while (!stop && next < rows.length) {
      const i = next++;
      const { status, raw } = await ask(rows[i], questions, groups, key);
      raws[i] = raw ?? null;
      done++;
      if (rows[i].nouls) answered++;
      if (status === 401) stop = "401 — the key was refused";
      else if (
        done >= FAILING_RUN.after &&
        answered / done < FAILING_RUN.minAnswerRate
      )
        stop = `only ${answered}/${done} requests answered`;
      if ((i + 1) % 50 === 0) console.log(`  … ${i + 1}/${rows.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stop) console.log(`STOPPED early: ${stop}`);
  return { raws, stopped: stop };
}

function report(
  rows: ReplayRow[],
  owners: ToolOwners,
  stopped: string | null,
): boolean {
  const sent = rows.filter((r) => r.latencyMs !== undefined);
  const errors = new Map<string, number>();
  for (const r of sent)
    if (r.error) errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
  const latencies = sent.map((r) => r.latencyMs!);
  console.log(
    `\nRequests: ${sent.length} sent · ${sent.filter((r) => r.nouls).length} answered · errors ${JSON.stringify(Object.fromEntries(errors))}`,
  );
  console.log(
    `Latency (every sent request): p50 ${percentile(latencies, 50)} ms · p95 ${percentile(latencies, 95)} ms · max ${latencies.length ? Math.max(...latencies) : "n/a"} ms · over the ${CLIENT_DEADLINE_MS} ms client deadline: ${latencies.filter((l) => l > CLIENT_DEADLINE_MS).length}`,
  );

  const billed = sent.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
  console.log(
    `Billed: ${billed} input tokens ≈ $${((billed / 1e6) * USD_PER_MTOK).toFixed(3)} (the vendor's own \`usage\` figures, answered requests only)`,
  );

  for (const [label, subset] of [
    ["Spanish", rows.filter((r) => r.spanish)],
    ["English/other", rows.filter((r) => !r.spanish)],
  ] as const) {
    console.log(`\n${label} — threshold grid over ${subset.length} rows:`);
    for (const t of GRID) {
      const e = evaluate(subset, t, owners, scopeFor);
      console.log(
        `  T=${t.toFixed(2)}  coverage ${pct(e.coverage)} (${e.covered}/${e.scored})  groups ${e.meanGroups.toFixed(2)}  tools ${e.meanTools.toFixed(0)}`,
      );
    }
    const e = evaluate(subset, GRID[0], owners, scopeFor);
    console.log(
      `  live scope on the same rows: ${(subset.reduce((n, r) => n + r.liveTools.length, 0) / (subset.length || 1)).toFixed(0)} tools (not part of the PASS rule)`,
    );
    console.log(
      `  rank question alone: its pick owns a called tool in ${pct(e.rankHits / e.scored)} (${e.rankHits}/${e.scored}) of scored turns`,
    );
  }

  const verdict = judge(rows, GRID, PASS, owners, scopeFor, stopped);
  console.log(
    `\nVerdict — Spanish rows, tune half ${verdict.tuneRows} / held-out half ${verdict.heldRows}:`,
  );
  for (const c of verdict.checks)
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.text}`);
  const word = verdict.pass ? "PASS" : "FAIL";
  console.log(
    SELF_TEST
      ? `\nSELF-TEST ${word} — fabricated answers, NOT a result`
      : `\n${word}`,
  );
  return verdict.pass;
}

async function main(): Promise<void> {
  const descriptions = parseGroupDescriptions(
    CLASSIFIER_SYSTEM_PROMPT,
    VALID_GROUPS,
  );
  const undescribed = [...VALID_GROUPS].filter((g) => !descriptions.has(g));
  const groups = [...descriptions.keys()];
  const questions = buildQuestions(descriptions);
  const owners = buildToolOwners(groups, (active) =>
    scopeToolsForMessage("", [], [], ALL_ON, active),
  );

  const { rows, dropped } = loadCorpus();
  console.log(
    `Corpus: ${rows.length} rows (${rows.filter((r) => r.spanish).length} Spanish) · ${dropped} credential-shaped messages dropped`,
  );
  if (rows.length < MIN_USABLE) {
    console.log(`STOP — fewer than ${MIN_USABLE} usable rows.`);
    process.exit(1);
  }

  console.log(
    `Groups: ${groups.length} described${undescribed.length ? ` · NOT in the prompt, so never asked: ${undescribed.join(", ")}` : ""}`,
  );
  console.log(
    `Ownership: ${owners.baseline.size} baseline tools · ${owners.owners.size} group-owned tools`,
  );

  // Sanity check on the measure: the live scope must cover what it called.
  let liveScored = 0;
  let liveCovered = 0;
  let noGroupNeeded = 0;
  // Ceiling: the live groups through THIS harness's scoper. It has no recent
  // turns and only the classifier's groups, so a perfect Jev cannot beat it.
  let ceilingCovered = 0;
  const unowned = new Map<string, number>();
  for (const r of rows) {
    const live = turnCoverage(r.called, new Set(r.liveTools), owners);
    if (live === "no_group_needed") noGroupNeeded++;
    else {
      liveScored++;
      if (live === "covered") liveCovered++;
      const replayed = new Set(
        scopeFor(
          r.message,
          new Set(r.liveGroups.filter((g) => VALID_GROUPS.has(g))),
        ).tools,
      );
      if (turnCoverage(r.called, replayed, owners) === "covered")
        ceilingCovered++;
    }
    for (const t of r.called)
      if (!owners.owners.has(t) && !owners.baseline.has(t))
        unowned.set(t, (unowned.get(t) ?? 0) + 1);
  }
  console.log(
    `Live sanity: coverage ${pct(liveCovered / liveScored)} (${liveCovered}/${liveScored}) · ${noGroupNeeded} turns called only unowned tools (not scored)`,
  );
  console.log(
    `Ceiling: the live classifier groups replayed through this harness cover ${pct(ceilingCovered / liveScored)} (${ceilingCovered}/${liveScored})`,
  );
  const topUnowned = [...unowned.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log(
    `Called tools outside baseline and every described group: ${topUnowned.map(([t, n]) => `${t}×${n}`).join(", ") || "none"}`,
  );

  const questionTokens = JSON.stringify(questions).length / 4;
  const messageTokens = rows.reduce((n, r) => n + r.message.length / 4, 0);
  const estimate =
    ((questionTokens * rows.length + messageTokens) / 1e6) * USD_PER_MTOK;
  console.log(
    `Request: ${Object.keys(questions).length} questions ≈ ${Math.round(questionTokens)} tokens + the message · estimated spend ≥ $${estimate.toFixed(3)} (a floor: the 09-21 one-question probe billed 313 input tokens for ~50 of text; --run prints the billed total)`,
  );

  if (SELF_TEST && RUN) {
    console.log(
      "STOP — --self-test sends nothing; do not combine it with --run.",
    );
    process.exit(1);
  }
  if (SELF_TEST) {
    // Wiring proof for the --run reporting path, no request sent: a classifier
    // that answers exactly the live groups must come out PASS.
    for (const r of rows) {
      r.nouls = Object.fromEntries(
        groups.map((g) => [g, r.liveGroups.includes(g) ? 1 : 0]),
      );
      r.rank = r.liveGroups.find((g) => groups.includes(g)) ?? "none";
      r.latencyMs = 1;
    }
    console.log("\nSELF-TEST — answers fabricated from the live groups:");
    process.exit(report(rows, owners, null) ? 0 : 1);
  }

  if (!RUN) {
    console.log(
      `\nSample question:\n${JSON.stringify(questions[`g_${groups[0]}`], null, 2)}`,
    );
    console.log(
      `\nDRY — pass --run to send ${rows.length} user messages to ${ENDPOINT} and spend ≥ $${estimate.toFixed(2)}.`,
    );
    return;
  }

  const key = apiKey();
  if (!key) {
    console.log("STOP — TYPESAFE_API_KEY is not set.");
    process.exit(1);
  }
  const { raws, stopped } = await replay(rows, questions, groups, key);
  const out = join(
    ROOT,
    "data",
    `jev-scope-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    out,
    JSON.stringify({
      model: MODEL,
      rows: rows.map((r, i) => ({ ...r, raw: raws[i] })),
    }),
    { mode: 0o600 },
  );
  console.log(`Row-level results: ${out}`);
  process.exit(report(rows, owners, stopped) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
