/**
 * Ritual delivery policy — decides whether a completed ritual's text is
 * broadcast to the operator or kept on disk/DB only, and what text goes out.
 *
 * Phase 0.3 of docs/planning/jarvis-usability-plan-2026-08-22.md, operator
 * ruling 2 (2026-08-22):
 *   - `evolution-log` and `day-narrative` are never broadcast (they are
 *     committed/persisted by their own rituals; the evening message is the
 *     nightly close).
 *   - `pm-daily-rebalance` is change-only: 22 consecutive zero-order reports
 *     with the same 198 rejections were pushed at 04:00 MX. Deliver only when
 *     orders were planned/filled, the run reports an error, or the report's
 *     numeric fingerprint differs from the last DELIVERED one.
 *
 * Phase 5 (2026-08-24) turns this into the single seam for EVERY ritual and
 * scheduled-task broadcast (scheduled tasks pass `schedule:<id>`):
 *   5.3 `skill-evolution` joins the suppressed set (persisted to memory +
 *       `mc-ctl task`); `nightly-close` is word-capped on Telegram (the full
 *       report is the email).
 *   5.5 a muted ritual (`/rituales silencio hasta …`) is deferred, not sent.
 *   5.1/5.2 items already sent in the last 14 days are dropped
 *       (SENT_BEFORE_FILTER_RITUALS); zero new items → `no_new_items`.
 *   5.4 the signal digest gets the ≥10 % moves lead line prepended.
 *   5.6 reading budget: PUSH_CAP pushes / WORD_CAP words per MX day. Morning
 *       Sync and nightly-close always deliver (they count); everything else
 *       over the cap is deferred into the next Morning Sync.
 *
 * Every decision is recorded in `ritual_deliveries` (delivered 0/1 + reason
 * + words + MX day) so the metrics script can count silences and deferrals.
 */

import { getDatabase } from "../db/index.js";
import { sanitizeDeliverable } from "../messaging/deliverable-filter.js";
import { RITUALS_TIMEZONE } from "./config.js";
import {
  activeMuteUntil,
  enqueueDeferral,
  isMorningSync,
} from "./ritual-controls.js";
import {
  SENT_BEFORE_FILTER_RITUALS,
  ensureSentItemsTable,
  filterSentBefore,
  recordSentItems,
} from "./sent-before.js";
import { movesLeadLine, safeTrackedMoves } from "./signal-moves.js";

export const SUPPRESSED_RITUALS: ReadonlySet<string> = new Set([
  "evolution-log",
  "day-narrative",
  "skill-evolution",
]);

export const CHANGE_ONLY_RITUALS: ReadonlySet<string> = new Set([
  "pm-daily-rebalance",
]);

/**
 * Rituals whose full text ALSO goes out by email (their templates require /
 * instruct gmail_send). Schedules with `delivery = "both"` join this set via
 * DeliveryOptions.
 */
export const EMAILED_RITUALS: ReadonlySet<string> = new Set([
  "signal-intelligence",
  "market-morning-scan",
  "nightly-close",
]);

/**
 * 5.6 reading budget — plan-literal, per MX calendar day, ALL pushes counted
 * (R2 audit C2: with the anchors outside the caps the layer delivered 6
 * pushes / ~1,350 words and deferred the whole afternoon). The two anchors
 * (Morning Sync, nightly-close) always deliver and count; everything else:
 *   - is word-capped per push (5.3) — emailed content to
 *     EMAILED_PUSH_WORD_CAP (the inbox has the rest), Telegram-only content
 *     to TELEGRAM_PUSH_WORD_CAP with the full text kept behind
 *     `/rituales completo <id>` (R1 audit C2: nothing becomes unreachable);
 *   - emailed pushes may take at most EMAILED_SHARE of the day, so the
 *     06:00/07:00 scans cannot spend what the operator-scheduled readings
 *     (Posthumanismo, the tweet report, PM changes) need;
 *   - over the caps → deferred into the next delivered Morning Sync, full
 *     text still reachable by id.
 * Push slots are reserved for anchors not yet delivered today
 * (`anchorsPending`); words are NOT reserved for them — the close is ~130
 * words (cap 250) and reserving its cap would defer the operator's own
 * readings daily — so a day ends at ≤ 1400 words + the close.
 * Arithmetic the operator should know: the anchors are ~350 words and 2 of
 * the 4 slots, so 2 pushes / ~350 words a day remain for the optional layer
 * in fire order; a 400–600-word daily reading arrives capped at 250 with its
 * `/rituales completo <id>` handle.
 */
export const PUSH_CAP = 4;
export const WORD_CAP = 1400;
export const EMAILED_PUSH_WORD_CAP = 120;
export const TELEGRAM_PUSH_WORD_CAP = 250;
/** One emailed push a day; its words = the cap plus the pointer line. */
export const EMAILED_SHARE = { pushes: 1, words: EMAILED_PUSH_WORD_CAP + 30 } as const;
export const RITUAL_WORD_CAPS: ReadonlyMap<string, number> = new Map([
  ["nightly-close", 250],
]);

export function isAnchor(ritualId: string, opts: DeliveryOptions): boolean {
  if (ritualId === "nightly-close") return true;
  return (
    opts.scheduleId !== undefined &&
    opts.displayName !== undefined &&
    isMorningSync({ schedule_id: opts.scheduleId, name: opts.displayName })
  );
}

export type DeliveryReason =
  | "default"
  | "suppressed"
  | "orders"
  | "error"
  | "changed"
  | "unchanged"
  | "first"
  | "no_new_items"
  | "muted"
  | "budget";

export interface DeliveryDecision {
  deliver: boolean;
  reason: DeliveryReason;
  fingerprint: string | null;
  /** The text to broadcast when `deliver` — filtered / capped / lead-lined. */
  text: string;
  words: number;
  /** Items dropped by the sent-before filter (0 when not applicable). */
  droppedItems: number;
}

export interface DeliveryOptions {
  /** Schedule name — titles deferrals; the Morning Sync fallback identity. */
  displayName?: string;
  /** DB schedule id — the Morning Sync identity (V82_SYNC_SCHEDULE_ID). */
  scheduleId?: string;
  /** The schedule also emails its result (`delivery = "both"`). */
  emailed?: boolean;
  /** Operator-triggered run (`/run`): never muted, never budget-deferred. */
  forced?: boolean;
  now?: Date;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Words the operator will actually read: counted AFTER the deliverable filter (R1 audit W4). */
export function deliveredWords(text: string): number {
  try {
    return countWords(sanitizeDeliverable(text).text);
  } catch {
    return countWords(text);
  }
}

/**
 * Error EVENTS only. "stale" is deliberately absent: the PM prompt instructs
 * the model to write "Alertas: (stale markets, …)" so every normal report
 * contains the word (R1 audit W1 — 3 of 6 real reports matched it). A
 * negated mention ("Sin stale-position abort", report 8473) is not an event.
 */
const ERROR_RE =
  /(?<!\b(?:sin|no hay|no hubo|ning[uú]n[ao]?)\s+(?:[\w-]+\s+){0,2})\b(?:error|abort\w*|fall[óo]|exception|no pude|timeout)\b|❌/i;

/**
 * `Órdenes: 0/0/0`, `Órdenes: 0 planned / 0 filled / 0 rejected`,
 * `**Órdenes:** 0 planeadas / 0 ejecutadas / 0 rechazadas` — the first two
 * numbers (planned, filled) decide "activity".
 */
const ORDERS_RE = /[ÓO]rdenes:?\**[^\d\n]*(\d+)[^\d\n]+(\d+)[^\d\n]+(\d+)/i;

/**
 * Numeric fingerprint of the report: the Universo / Pesos / Rechazos /
 * Órdenes figures, captured by field — not by line, because the real format
 * puts `Equity … | Cash … | Órdenes: …` on ONE line and the Alertas bullets
 * say "sin órdenes" (R1 audit W1). Prices, horizon years and dates are thus
 * never part of the comparison. A missing field fingerprints as "?".
 */
const FIELD_RES: ReadonlyArray<RegExp> = [
  /Universo:?\**\s*(\d+)/i,
  /Pesos:?\**\s*\+?(\d+)[^\d\n]+(\d+)/i,
  /Rechazos:?\**\s*(\d+)/i,
  ORDERS_RE,
];

export function fingerprintReport(text: string): string {
  const parts: string[] = [];
  for (const re of FIELD_RES) {
    const m = re.exec(text);
    parts.push(m ? m.slice(1).join("/") : "?");
  }
  return parts.join("|");
}

function base(
  deliver: boolean,
  reason: DeliveryReason,
  fingerprint: string | null,
  text: string,
): DeliveryDecision {
  return { deliver, reason, fingerprint, text, words: countWords(text), droppedItems: 0 };
}

/** Phase 0 decision (suppressed / change-only / default) — pure. */
export function decideRitualDelivery(
  ritualId: string,
  text: string,
  lastDeliveredFingerprint: string | null,
): DeliveryDecision {
  if (SUPPRESSED_RITUALS.has(ritualId)) {
    return base(false, "suppressed", null, text);
  }
  if (!CHANGE_ONLY_RITUALS.has(ritualId)) {
    return base(true, "default", null, text);
  }
  const fingerprint = fingerprintReport(text);
  const m = ORDERS_RE.exec(text);
  if (m && (Number(m[1]) > 0 || Number(m[2]) > 0)) {
    return base(true, "orders", fingerprint, text);
  }
  if (ERROR_RE.test(text)) {
    return base(true, "error", fingerprint, text);
  }
  if (lastDeliveredFingerprint === null) {
    return base(true, "first", fingerprint, text);
  }
  if (fingerprint !== lastDeliveredFingerprint) {
    return base(true, "changed", fingerprint, text);
  }
  return base(false, "unchanged", fingerprint, text);
}

/**
 * Cut `text` to at most `cap` words at a line boundary and append the
 * pointer. A text within the cap is returned untouched.
 */
export function capWords(text: string, cap: number, pointer: string): string {
  if (countWords(text) <= cap) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const w = countWords(line);
    if (used + w > cap) break;
    kept.push(line);
    used += w;
  }
  if (kept.length === 0) {
    kept.push(text.split(/\s+/).filter(Boolean).slice(0, cap).join(" "));
  }
  return `${kept.join("\n").trimEnd()}\n\n${pointer}`;
}

// --- ledger ----------------------------------------------------------------

export function ensureRitualDeliveriesTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ritual_deliveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ritual_id   TEXT NOT NULL,
      task_id     TEXT,
      fingerprint TEXT,
      delivered   INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ritual_deliveries_ritual
      ON ritual_deliveries(ritual_id, created_at);
  `);
  const cols = new Set(
    (db.prepare("PRAGMA table_info(ritual_deliveries)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("words")) db.exec("ALTER TABLE ritual_deliveries ADD COLUMN words INTEGER");
  if (!cols.has("day")) db.exec("ALTER TABLE ritual_deliveries ADD COLUMN day TEXT");
  if (!cols.has("anchor")) db.exec("ALTER TABLE ritual_deliveries ADD COLUMN anchor INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("emailed")) db.exec("ALTER TABLE ritual_deliveries ADD COLUMN emailed INTEGER NOT NULL DEFAULT 0");
}

export function lastDeliveredFingerprint(ritualId: string): string | null {
  const row = getDatabase()
    .prepare(
      "SELECT fingerprint FROM ritual_deliveries WHERE ritual_id = ? AND delivered = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(ritualId) as { fingerprint: string | null } | undefined;
  return row?.fingerprint ?? null;
}

export function mxDay(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: RITUALS_TIMEZONE });
}

export interface BudgetUsed {
  pushes: number;
  words: number;
  emailedPushes: number;
  emailedWords: number;
}

/** Pushes and words already delivered on the given MX day — anchors included (plan-literal). */
export function budgetUsed(day: string): BudgetUsed {
  return getDatabase()
    .prepare(
      `SELECT COUNT(*) AS pushes, COALESCE(SUM(words), 0) AS words,
              COALESCE(SUM(CASE WHEN emailed = 1 AND anchor = 0 THEN 1 ELSE 0 END), 0) AS emailedPushes,
              COALESCE(SUM(CASE WHEN emailed = 1 AND anchor = 0 THEN words ELSE 0 END), 0) AS emailedWords
       FROM ritual_deliveries WHERE delivered = 1 AND day = ?`,
    )
    .get(day) as BudgetUsed;
}

export const ANCHOR_COUNT = 2;

/**
 * Anchors (Morning Sync, nightly-close) not yet delivered today. Optional
 * pushes must leave a slot for each — otherwise the 23:50 close lands as a
 * 5th push every day (14-day replay: 4.5 pushes/day, max 5).
 */
export function anchorsPending(day: string): number {
  const row = getDatabase()
    .prepare(
      "SELECT COUNT(DISTINCT ritual_id) AS n FROM ritual_deliveries WHERE delivered = 1 AND anchor = 1 AND day = ?",
    )
    .get(day) as { n: number };
  return Math.max(0, ANCHOR_COUNT - row.n);
}

export function recordRitualDelivery(
  ritualId: string,
  taskId: string,
  decision: DeliveryDecision,
  day = mxDay(),
  flags: { anchor?: boolean; emailed?: boolean } = {},
): void {
  getDatabase()
    .prepare(
      "INSERT INTO ritual_deliveries (ritual_id, task_id, fingerprint, delivered, reason, words, day, anchor, emailed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ritualId,
      taskId,
      decision.fingerprint,
      decision.deliver ? 1 : 0,
      decision.reason,
      decision.words,
      day,
      flags.anchor ? 1 : 0,
      flags.emailed ? 1 : 0,
    );
}

/**
 * One-call wrapper for the router / dynamic scheduler: ensure tables, run the
 * pipeline, record. Any DB failure falls back to DELIVER the original text
 * (a broken ledger must not silence the operator).
 */
export function applyRitualDeliveryPolicy(
  ritualId: string,
  taskId: string,
  rawText: string,
  opts: DeliveryOptions = {},
): DeliveryDecision {
  try {
    ensureRitualDeliveriesTable();
    ensureSentItemsTable();
    const now = opts.now ?? new Date();
    const day = mxDay(now);
    const title = opts.displayName ?? ritualId;

    const anchor = isAnchor(ritualId, opts);
    const emailed = EMAILED_RITUALS.has(ritualId) || opts.emailed === true;
    const flags = { anchor, emailed };

    const last = CHANGE_ONLY_RITUALS.has(ritualId)
      ? lastDeliveredFingerprint(ritualId)
      : null;
    let decision = decideRitualDelivery(ritualId, rawText, last);
    if (!decision.deliver) {
      recordRitualDelivery(ritualId, taskId, decision, day, flags);
      return decision;
    }
    const fingerprint = decision.fingerprint;
    const reason = decision.reason;
    let text = rawText;

    // 5.1 sent-before: drop items already sent; nothing new → silence.
    if (SENT_BEFORE_FILTER_RITUALS.has(ritualId)) {
      const f = filterSentBefore(ritualId, text);
      if (f.items > 0 && f.dropped >= f.items) {
        decision = { ...base(false, "no_new_items", fingerprint, text), droppedItems: f.dropped };
        recordRitualDelivery(ritualId, taskId, decision, day, flags);
        return decision;
      }
      if (f.dropped > 0) {
        text = `${f.text}\n\n(${f.dropped} ${f.dropped === 1 ? "señal ya enviada omitida" : "señales ya enviadas omitidas"})`;
      }
      decision = { ...decision, droppedItems: f.dropped };
    }

    // 5.4 signal digest lead line — deterministic, model cannot omit it.
    if (ritualId === "signal-intelligence") {
      const lead = movesLeadLine(safeTrackedMoves(now));
      if (lead) {
        if (/\bestables?\b|\bsin cambios\b/i.test(text)) {
          console.warn(
            `[rituals] signal-intelligence wrote "estables" while a tracked series moved — lead line prepended`,
          );
        }
        text = `${lead}\n\n${text}`;
      }
    }

    // 5.1 ledger for next time: the filtered text BEFORE any cap (R2 audit
    // C1: ledgering the capped text left the digest's tail unseen and the
    // filter inert). An item dropped today was recorded when first sent.
    const ledgerText = text;

    // 5.3 word cap. Anchors: only their explicit cap. Others: emailed →
    // pointer to the inbox; Telegram-only → full text stored, pointer to
    // `/rituales completo <id>`.
    const explicitCap = RITUAL_WORD_CAPS.get(ritualId);
    if (anchor) {
      if (explicitCap !== undefined) {
        text = capWords(text, explicitCap, `📄 Completo en el correo · mc-ctl task ${taskId}`);
      }
    } else if (emailed) {
      text = capWords(text, explicitCap ?? EMAILED_PUSH_WORD_CAP, `📄 Completo en el correo · mc-ctl task ${taskId}`);
    } else if (countWords(text) > (explicitCap ?? TELEGRAM_PUSH_WORD_CAP)) {
      const id = enqueueDeferral(ritualId, taskId, title, text, "capped");
      console.log(
        `[rituals] ${ritualId}: capped ${countWords(text)} → ${explicitCap ?? TELEGRAM_PUSH_WORD_CAP} words, full text = /rituales completo ${id}`,
      );
      text = capWords(text, explicitCap ?? TELEGRAM_PUSH_WORD_CAP, `📄 Completo: /rituales completo ${id}`);
    }

    const words = deliveredWords(text);
    const exempt = opts.forced === true || anchor;

    if (!exempt) {
      const defer = (why: "muted" | "budget", cause: string = why): DeliveryDecision => {
        // Always queued — nothing expires and the id is reachable from the
        // phone even while the Morning Sync is paused (R2 audit C3/W3).
        const id = enqueueDeferral(ritualId, taskId, title, text, why);
        console.log(`[rituals] ${ritualId}: deferred (${cause}) → /rituales completo ${id}`);
        const d = { ...decision, deliver: false, reason: why, text, words };
        recordRitualDelivery(ritualId, taskId, d, day, flags);
        return d;
      };
      // 5.5 mute → defer.
      if (activeMuteUntil(ritualId, now)) return defer("muted");
      // 5.6 reading budget → defer.
      const used = budgetUsed(day);
      const overPushes = used.pushes + anchorsPending(day) >= PUSH_CAP;
      const overWords = used.words + words > WORD_CAP;
      const overEmailedShare =
        emailed &&
        (used.emailedPushes >= EMAILED_SHARE.pushes ||
          used.emailedWords + words > EMAILED_SHARE.words);
      if (overPushes || overWords || overEmailedShare) {
        const cause = [overPushes && "push-cap", overWords && "word-cap", overEmailedShare && "emailed-share"]
          .filter(Boolean)
          .join("+");
        return defer("budget", `budget: ${cause}`);
      }
    }

    decision = { ...decision, deliver: true, reason, text, words };
    recordRitualDelivery(ritualId, taskId, decision, day, flags);
    recordSentItems(ritualId, taskId, ledgerText);
    return decision;
  } catch (err) {
    console.error(`[rituals] delivery-policy failed (delivering):`, err);
    return base(true, "default", null, rawText);
  }
}
