/**
 * usability-metrics — the §0 KPI table of
 * docs/planning/jarvis-usability-plan-2026-08-22.md, computed from mc.db.
 *
 *   ./mc-ctl usability [days]         (default 7)
 *   npx tsx scripts/usability-metrics.ts [days] [--json]
 *
 * Read-only (opens the DB with `readonly: true`). Every number here is the
 * same measurement the 2026-08-22 critic swarm used, so a weekly run shows
 * movement against the review's baseline instead of a new yardstick.
 *
 * Sources:
 *   - `conversations` (bank mc-jarvis, source router): "User: …\nJarvis: …"
 *     exchange records — the user-message patterns (friction, incantations).
 *   - `tasks` (title LIKE 'Chat:%'): status mix, latency, delivered reply
 *     text (`output.text`) — harness strings, English-first, empty replies.
 *   - `tasks` ritual/scheduled rows + `ritual_deliveries`: pushes/day, words/day,
 *     silences (a silenced ritual is a success, not a miss).
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { extractDeliverableText } from "../src/lib/deliverable.js";
import { PUSH_CAP, WORD_CAP } from "../src/rituals/delivery-policy.js";

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
const asJson = args.includes("--json");
const dbPath = process.env.MC_DB_PATH ?? resolve(process.cwd(), "data/mc.db");

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const since = `datetime('now', '-${days} days')`;
// task_trace_events.ts is ISO-8601 with a 'T' — compare against the same shape.
const sinceIso = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days')`;

// --- patterns (mirror the review's regexes) --------------------------------
const SCOPE_ASK_RE =
  /no est[áa] en (?:el )?scope|no aparece en (?:mi|tu) lista|p[íi]deme con "usa|actívalo con "usa|no est[áa] disponible en esta ronda/i;
/** Exactly the plan's §0 definition — keep comparable to the 25–32 baseline. */
const INCANTATION_RE = /^\s*usa (?:shell|gemini|schedule|tweet|file_|git_)/i;
const FRICTION_RE =
  /^\s*(?:contin[uú]a|sigue|termina|no agotes|administra tus turnos|otra vez|te dije|no,? |no\.|mal\b|incorrecto|est[áa] mal|inventaste|revisa tus fuentes|eso no|no es (?:eso|lo que)|\?$)/i;
/**
 * Harness strings. `[Task failed] …` and `[positive feedback acknowledged]`
 * are NOT here: in `conversations` they are the router's own memory records
 * for a failed turn / a thumbs-up, never delivered text.
 */
const HARNESS_RE =
  /\[error_max_turns|\[timeout after|^\s*STATUS:\s*(?:DONE|BLOCKED|NEEDS)|Goal complet(?:ed|ado)|Partial response below|OAuth access token has been revoked/im;
const EN_MARKERS =
  /\b(?:the|and|with|this|that|I'll|let me|here's|you|your|file|verify|check|summary|found|now|will)\b/gi;
const ES_MARKERS =
  /\b(?:el|la|los|las|de|que|para|con|una|está|aquí|hoy|ya|sí|tengo|listo|esto|eso)\b/gi;

function englishLeading(text: string): boolean {
  const head = text.slice(0, 300);
  const en = (head.match(EN_MARKERS) ?? []).length;
  const es = (head.match(ES_MARKERS) ?? []).length;
  return en >= 4 && en > es * 2;
}

function pct(n: number, d: number): string {
  return d === 0 ? "–" : `${((100 * n) / d).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

// --- user-side: exchanges ---------------------------------------------------
const exchanges = db
  .prepare(
    `SELECT content FROM conversations
     WHERE bank = 'mc-jarvis' AND source = 'router' AND created_at > ${since}`,
  )
  .all() as { content: string }[];

let userMsgs = 0,
  friction = 0,
  incantations = 0,
  scopeAskReplies = 0,
  harness = 0,
  englishFirst = 0,
  emptyReplies = 0;
for (const { content } of exchanges) {
  const m = /^User:\s*([\s\S]*?)\nJarvis:\s*([\s\S]*)$/.exec(content);
  if (!m) continue;
  const user = m[1].trim();
  const jarvis = m[2];
  userMsgs++;
  // Delivery hygiene is measured on the DELIVERED text: the router retains
  // the sanitized reply here, while `tasks.output` keeps the pre-filter
  // runner output (R1 audit W5 — measuring `output` would pin the KPI at its
  // baseline forever).
  if (HARNESS_RE.test(jarvis)) harness++;
  if (jarvis.trim() && englishLeading(jarvis)) englishFirst++;
  if (jarvis.trim().length === 0) emptyReplies++;
  if (INCANTATION_RE.test(user)) {
    incantations++;
    friction++;
  } else if (FRICTION_RE.test(user)) {
    // Short approvals ("ok", "sí", "va", "👍") are satisfaction, not friction
    // (R1 audit W7) — only the explicit patterns count.
    friction++;
  }
  if (SCOPE_ASK_RE.test(jarvis)) scopeAskReplies++;
}

// --- task-side: chat replies ------------------------------------------------
const chatTasks = db
  .prepare(
    `SELECT status, created_at, started_at, completed_at, output
     FROM tasks WHERE title LIKE 'Chat:%' AND created_at > ${since}`,
  )
  .all() as {
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  output: string | null;
}[];

/** Same field preference the router uses (src/lib/deliverable.ts). */
function deliveredText(output: string | null): string {
  if (!output) return "";
  try {
    return extractDeliverableText(JSON.parse(output)) ?? "";
  } catch {
    return output;
  }
}

const statusMix: Record<string, number> = {};
const latencies: number[] = [];
let rawHarness = 0;
for (const t of chatTasks) {
  statusMix[t.status] = (statusMix[t.status] ?? 0) + 1;
  if (t.completed_at) {
    const secs =
      (Date.parse(t.completed_at + "Z") - Date.parse(t.created_at + "Z")) /
      1000;
    if (Number.isFinite(secs) && secs >= 0) latencies.push(secs);
  }
  // Pre-filter runner output: how often the harness PRODUCED a marker (the
  // filter's workload), as opposed to `harness` above (what was delivered).
  if (HARNESS_RE.test(deliveredText(t.output))) rawHarness++;
}
latencies.sort((a, b) => a - b);

// --- proactive layer --------------------------------------------------------
const pushes = db
  .prepare(
    `SELECT title, created_at, json_extract(output, '$.text') AS reply
     FROM tasks
     WHERE created_at > ${since}
       AND status IN ('completed','completed_with_concerns')
       AND (title LIKE '[Scheduled]%' OR title LIKE 'Morning Sync%' OR title LIKE 'Nightly close%'
            OR title LIKE 'Signal intelligence%' OR title LIKE 'PM daily rebalance%'
            OR title LIKE 'Evolution log%' OR title LIKE 'Day log narrative%'
            OR title LIKE 'Skill evolution%' OR title LIKE 'Market %scan%')`,
  )
  .all() as { title: string; created_at: string; reply: string | null }[];

// Phase 5: the ledger records EVERY ritual + scheduled decision with reason,
// words and MX day. Silences (unchanged / no_new_items) and deferrals (budget /
// muted → next Morning Sync) are subtracted from the task-row push count; the
// delivered word total comes from the ledger when it has the column.
let silenced = 0;
let deferred = 0;
let ledgerWords: number | null = null;
let ledgerPushes: number | null = null;
/** SQLite `datetime('now')` shape of the window start, for coverage checks against MIN(created_at). */
const sinceStamp = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
try {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN delivered = 0 AND reason IN ('unchanged','no_new_items') THEN 1 ELSE 0 END) AS silenced,
         SUM(CASE WHEN delivered = 0 AND reason IN ('budget','muted') THEN 1 ELSE 0 END) AS deferred
       FROM ritual_deliveries WHERE created_at > ${since}`,
    )
    .get() as { silenced: number | null; deferred: number | null };
  silenced = row.silenced ?? 0;
  deferred = row.deferred ?? 0;
  // Ledger words only when the ledger COVERS the whole window (R1 audit W3:
  // one post-deploy day ÷ 7 understated the KPI ~86 %); otherwise the task
  // rows' word count stands, as before Phase 5.
  const w = db
    .prepare(
      `SELECT SUM(words) AS w, COUNT(*) AS n, MIN(created_at) AS first FROM ritual_deliveries
       WHERE delivered = 1 AND words IS NOT NULL`,
    )
    .get() as { w: number | null; n: number; first: string | null };
  if (w.n > 0 && w.first !== null && w.first <= sinceStamp) {
    // Ledger-covered window: pushes AND words come from the ledger — every
    // Telegram push (rituals + schedules) has a row, email-only schedules do
    // not (R2 audit W2: the task-row count charged Pharma's email as a push).
    const inWindow = db
      .prepare(
        `SELECT SUM(words) AS w, COUNT(*) AS n FROM ritual_deliveries
         WHERE delivered = 1 AND words IS NOT NULL AND created_at > ${since}`,
      )
      .get() as { w: number | null; n: number };
    ledgerWords = inWindow.w ?? 0;
    ledgerPushes = inWindow.n;
  }
} catch {
  /* table appears with the first post-deploy ritual */
}
// Suppressed-by-title rituals are removed here; `silenced` above counts only
// change-only / no-new-items silences, so the two never overlap (R1 audit W6).
const suppressedTitles = /^(?:Evolution log|Day log narrative|Skill evolution)/;
const delivered = pushes.filter((p) => !suppressedTitles.test(p.title));
const pushWords = delivered.reduce(
  (acc, p) => acc + (p.reply ?? "").split(/\s+/).filter(Boolean).length,
  0,
);
const effectiveDays = Math.max(1, days);
const pushesPerDay =
  (ledgerPushes ?? Math.max(0, delivered.length - silenced - deferred)) / effectiveDays;
const wordsPerDay = (ledgerWords ?? pushWords) / effectiveDays;

// repeats: same scheduled title prefix delivered > 2 consecutive days with the
// same first 120 chars of reply (coarse; the exact topic check lives in the plan)
const byPrefix = new Map<string, string[]>();
for (const p of delivered) {
  const key = p.title.replace(/ — \d{4}-\d{2}-\d{2}.*$/, "");
  const head = (p.reply ?? "").replace(/\s+/g, " ").slice(0, 120);
  byPrefix.set(key, [...(byPrefix.get(key) ?? []), head]);
}
let repeats = 0;
for (const heads of byPrefix.values()) {
  let run = 1;
  for (let i = 1; i < heads.length; i++) {
    run = heads[i] === heads[i - 1] && heads[i] ? run + 1 : 1;
    if (run === 3) repeats++;
  }
}
// Phase 5 (R3 audit W3): once the sent-before ledger covers the window, a
// repeat is an ITEM delivered on ≥3 distinct days — the granularity every
// Phase-5 mechanism acts on (the task-row heuristic above cannot move).
let ledgerCovered = ledgerPushes !== null;
try {
  const first = db
    .prepare("SELECT MIN(created_at) AS first FROM ritual_sent_items")
    .get() as { first: string | null };
  if (first.first !== null && first.first <= sinceStamp) {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT item_key FROM ritual_sent_items WHERE created_at > ${since}
           GROUP BY ritual_id, item_key HAVING COUNT(DISTINCT substr(created_at, 1, 10)) >= 3)`,
      )
      .get() as { n: number };
    repeats = r.n;
  } else {
    ledgerCovered = false;
  }
} catch {
  /* table appears with the first post-deploy ritual */
}

// --- provenance (usability Phase 3) -----------------------------------------
// Artifact writes checked by the handler gate, how many were rejected, how
// many unsourced figures the model ATTEMPTED to write (rejected or not —
// the plan's exit criterion is this number trending to 0, i.e. the model
// reaching for the tool before the write; R1 audit W1: the "accepted"
// variant is 0 by construction under enforce and cannot fail), chat
// figures annotated inline, and citations dropped. All from task_trace_events.
const prov = db
  .prepare(
    `SELECT
       COUNT(*) AS checked,
       SUM(CASE WHEN json_extract(attrs,'$.rejected') = 1 THEN 1 ELSE 0 END) AS rejected,
       COALESCE(SUM(json_extract(attrs,'$.unsourced')), 0) AS unsourced_attempted
     FROM task_trace_events
     WHERE name = 'provenance.checked' AND ts >= ${sinceIso} AND json_extract(attrs,'$.error') IS NULL`,
  )
  .get() as {
  checked: number;
  rejected: number | null;
  unsourced_attempted: number;
};
const numbersRow = db
  .prepare(
    `SELECT COUNT(*) AS audits,
            SUM(CASE WHEN json_extract(attrs,'$.unverified') > 0 THEN 1 ELSE 0 END) AS with_unverified,
            COALESCE(SUM(json_extract(attrs,'$.annotated')), 0) AS annotated
     FROM task_trace_events WHERE name = 'numbers.audited' AND ts >= ${sinceIso}`,
  )
  .get() as {
  audits: number;
  with_unverified: number | null;
  annotated: number;
};
const citeRow = db
  .prepare(
    `SELECT COUNT(*) AS checks, COALESCE(SUM(json_extract(attrs,'$.missing')), 0) AS missing,
            COALESCE(SUM(json_extract(attrs,'$.unreachable')), 0) AS unreachable
     FROM task_trace_events WHERE name = 'citations.checked' AND ts >= ${sinceIso} AND json_extract(attrs,'$.error') IS NULL`,
  )
  .get() as { checks: number; missing: number; unreachable: number };

// --- continuity & recovery (usability Phase 4) ------------------------------
// All from the conversations router bank (delivered text is the source of
// truth). Exit criteria: 0 "no agotes tus turnos" / bare "continúa"-after-
// failure in 14 days; stops answered with the one-line "Detenido:".
const contRow = (like: string): number =>
  (
    db
      .prepare(
        // source filter: auto-persist rows are verbatim twins of the router
        // rows and double-count unanchored LIKE metrics (R3 audit W4).
        `SELECT COUNT(*) AS n FROM conversations
         WHERE bank = 'mc-jarvis' AND content LIKE ?
           AND source != 'auto-persist'
           AND created_at >= datetime('now', '-${days} days')`,
      )
      .get(like) as { n: number }
  ).n;
const stopsHonoured = contRow("%Jarvis: Detenido:%");
const noAgotes = contRow("%no agotes%");
// One term only — SQLite LIKE is case-insensitive for ASCII, so a second
// "User: contin%" term counted every row exactly twice (R2 audit W6).
const bareContinua = contRow("User: Contin%");
const sigoAsks = contRow("%¿Sigo?%");

// --- output -----------------------------------------------------------------
const out = {
  window_days: days,
  exchanges: userMsgs,
  friction_rate: pct(friction, userMsgs),
  friction_count: friction,
  tool_incantations: incantations,
  scope_ask_replies: scopeAskReplies,
  chat_tasks: chatTasks.length,
  status_mix: statusMix,
  concerns_rate: pct(
    statusMix["completed_with_concerns"] ?? 0,
    chatTasks.length,
  ),
  latency_p50_s: quantile(latencies, 0.5),
  latency_p90_s: quantile(latencies, 0.9),
  over_600s: latencies.filter((s) => s > 600).length,
  harness_strings_delivered: harness,
  harness_strings_produced: rawHarness,
  english_first_replies: englishFirst,
  empty_replies: emptyReplies,
  pushes_per_day: Number(pushesPerDay.toFixed(1)),
  push_words_per_day: Math.round(wordsPerDay),
  rituals_silenced: silenced,
  rituals_deferred: deferred,
  ledger_covered: ledgerCovered,
  ritual_repeats_gt2: repeats,
  artifact_writes_checked: prov.checked,
  artifact_writes_rejected: prov.rejected ?? 0,
  unsourced_figures_attempted: prov.unsourced_attempted,
  figures_annotated_per_day: Number((numbersRow.annotated / days).toFixed(1)),
  replies_with_unverified_figures: numbersRow.with_unverified ?? 0,
  citations_dropped: citeRow.missing,
  citations_unreachable: citeRow.unreachable,
  stops_honoured: stopsHonoured,
  no_agotes_msgs: noAgotes,
  continua_msgs: bareContinua,
  sigo_asks: sigoAsks,
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const row = (k: string, v: unknown, target: string) =>
    console.log(
      `  ${k.padEnd(30)} ${String(v).padStart(10)}   target ${target}`,
    );
  console.log(`\nJarvis usability — last ${days} day(s)  (${dbPath})\n`);
  console.log("  USER SEAT");
  row("exchanges", out.exchanges, "—");
  row("friction rate", out.friction_rate, "≤ 8%");
  row("tool incantations", out.tool_incantations, "≤ 3");
  row("scope-ask replies", out.scope_ask_replies, "0");
  console.log("  RELIABILITY");
  row("chat tasks", out.chat_tasks, "—");
  row("with concerns", out.concerns_rate, "↓");
  row(
    "latency p50 / p90 (s)",
    `${out.latency_p50_s ?? "–"} / ${out.latency_p90_s ?? "–"}`,
    "25 / 90",
  );
  row("turns > 600 s", out.over_600s, "0");
  console.log("  DELIVERY HYGIENE");
  row("harness strings delivered", out.harness_strings_delivered, "0");
  row("  (produced by runners)", out.harness_strings_produced, "—");
  row("English-first replies", out.english_first_replies, "0");
  row("empty replies", out.empty_replies, "0");
  console.log("  PROACTIVE LAYER");
  row("pushes / day", out.pushes_per_day, `≤ ${PUSH_CAP}`);
  row("push words / day", out.push_words_per_day, `≤ ${WORD_CAP}`);
  row("rituals silenced (no change)", out.rituals_silenced, "—");
  row("rituals deferred → Morning Sync", out.rituals_deferred, "—");
  row("ritual repeats > 2 days", out.ritual_repeats_gt2, "0");
  if (!out.ledger_covered) {
    console.log(
      `    (Phase 5 ledger does not cover ${days} d yet — pushes/words/repeats above are the pre-Phase-5 task-row estimate; use a shorter window)`,
    );
  }
  console.log("  PROVENANCE");
  row("artifact writes checked", out.artifact_writes_checked, "—");
  row("  rejected (unsourced)", out.artifact_writes_rejected, "↓");
  row("unsourced figures attempted", out.unsourced_figures_attempted, "→ 0");
  row("figures marked (sin verificar)/day", out.figures_annotated_per_day, "↓");
  row(
    "citations dropped / unreachable",
    `${out.citations_dropped} / ${out.citations_unreachable}`,
    "0 / —",
  );
  console.log("  CONTINUITY (Phase 4)");
  row("stops honoured (Detenido:)", out.stops_honoured, "all");
  row('"no agotes tus turnos" msgs', out.no_agotes_msgs, "0");
  row('user "continúa" msgs', out.continua_msgs, "→ 0");
  row("double-cap ¿Sigo? asks", out.sigo_asks, "↓");
  console.log(
    "\n  Script baseline, same regexes, 45d to 2026-08-22: friction 7.3% · incantations 25 · scope-asks 15 · harness 17 · English 16 · empty 0 · 10.5 pushes/day · 3,355 words/day · p50 47s · p90 176s\n" +
      "  (The critic review's human-read figures are wider — friction ~17–26%, scope-asks 37 — because they count corrections the regexes do not; compare against the script line.)\n",
  );
}
db.close();
