/**
 * Sent-before ledger — usability plan Phase 5.1/5.2.
 *
 * Every delivered ritual/schedule result is split into ITEMS (bullet lines,
 * numbered lines, bold-title lines, URL-bearing lines, markdown table rows);
 * each item is recorded in `ritual_sent_items` with an exact key and a token
 * signature. Two consumers:
 *   - the delivery seam drops items already sent in the last
 *     SENT_BEFORE_DAYS for the rituals in SENT_BEFORE_FILTER_RITUALS
 *     (Signal 14/21 repeats); a text left with zero new items is not sent;
 *   - `sentBeforeBlock` renders the recently-sent heads as a prompt block for
 *     rituals whose delivery the seam never sees (Pharma emails itself) and
 *     for essay-shaped ones (Posthumanismo) where dropping lines is wrong.
 *
 * Identity (R1 audit W1 — a whole-line hash deduped 3.5 % of real items and
 * zero findings): the URL when present; otherwise the enumerator/score-
 * stripped TITLE prefix, exact; and a near-duplicate match when the
 * significant-token Jaccard of two items is ≥ JACCARD_MIN (a renumbered or
 * reworded repeat of the same finding). Tokens are Unicode classes, never
 * `[a-z0-9]`.
 */

import { createHash } from "node:crypto";
import { getDatabase } from "../db/index.js";

export const SENT_BEFORE_DAYS = 14;
export const JACCARD_MIN = 0.6;
const MIN_TOKENS_FOR_JACCARD = 3;

/** Rituals whose broadcast text is filtered line-by-line at the seam. */
export const SENT_BEFORE_FILTER_RITUALS: ReadonlySet<string> = new Set([
  "signal-intelligence",
]);

const ENUM_RE = /^\s*(?:[-•*–—]|\d{1,2}[.)])\s+/;
const ITEM_LINE_RE = /^\s*(?:[-•*–—]|\d{1,2}[.)])\s+\S/;
const BOLD_TITLE_RE = /^\s*\*\*[^*\n]{6,}\*\*\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const URL_RE = /https?:\/\/[^\s)>\]]+/i;
/** Meta/footer lines that repeat by design and must never count as items. */
const META_LINE_RE =
  /^\s*(?:→|(?:[-•*]\s*)?(?:📊\s*)?\**(?:meta|fuentes?|sources?|acci[oó]n)\**\s*:)/i;
/** Trailing score/priority tails: `| Relevancia: 8/10`, `Relevance: 9, Risk: HIGH → Priority: **13.5**`. */
const SCORE_TAIL_RE =
  /\s*(?:\||—|–)?\s*(?:relevanc[ie]a?|risk|riesgo|priorit[yá]|prioridad)\s*:.*$/i;

export interface SentItem {
  /** Raw line as delivered. */
  line: string;
  key: string;
  /**
   * Findings (bullets, numbered, table rows, URL lines) may be dropped by the
   * seam; bold-title headings are recorded for the prompt block but never
   * cut out of a delivered text (a heading repeating daily is structure,
   * not a repeated finding).
   */
  droppable: boolean;
  /** Sorted significant tokens (≥4 chars), space-joined. */
  tokens: string;
  /** First 120 chars, single-spaced — what the prompt block shows. */
  head: string;
}

function stripMarkdown(s: string): string {
  return s.replace(/\*\*|__|`/g, "");
}

/** The part of an item that names it: enumerator, bold and score tails removed; table cells joined. */
export function itemTitle(line: string): string {
  let s = line.trim();
  if (TABLE_ROW_RE.test(s)) {
    s = s
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" ");
  }
  s = stripMarkdown(s.replace(ENUM_RE, "")).replace(URL_RE, " ");
  s = s.replace(SCORE_TAIL_RE, "");
  return s.replace(/\s+/g, " ").trim();
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Words ≥4 chars plus EVERY number: "18 fuentes escaneadas" and "12 fuentes escaneadas" must differ. */
export function itemTokens(title: string): string[] {
  return [
    ...new Set(normalise(title).split(" ").filter((t) => t.length >= 4 || /^\p{N}+$/u.test(t))),
  ].sort();
}

export function itemKey(line: string): string | null {
  const url = URL_RE.exec(line)?.[0];
  const basis = url
    ? url.replace(/[)>\].,;:]+$/, "").toLowerCase()
    : normalise(itemTitle(line));
  // Very short normalised text ("meta", "acción") is not an item.
  if (!url && basis.length < 12) return null;
  return createHash("sha1").update(basis).digest("hex").slice(0, 20);
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const t of b) if (sa.has(t)) inter++;
  const union = sa.size + new Set(b).size - inter;
  return union === 0 ? 0 : inter / union;
}

/** `next` is the following line: a table row followed by `|---|` is the header, never an item. */
function isItemLine(line: string, next = ""): boolean {
  if (META_LINE_RE.test(line)) return false;
  if (TABLE_ROW_RE.test(line)) {
    if (TABLE_SEP_RE.test(line) || TABLE_SEP_RE.test(next)) return false;
    // A one-word-per-cell row ("| Digest | ✅ |") is status, not a finding.
    return line
      .split("|")
      .some((c) => c.trim().split(/\s+/).filter(Boolean).length >= 3);
  }
  return ITEM_LINE_RE.test(line) || BOLD_TITLE_RE.test(line) || URL_RE.test(line);
}

export function extractItems(text: string): SentItem[] {
  const out: SentItem[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isItemLine(line, lines[i + 1] ?? "")) continue;
    const key = itemKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      line,
      key,
      droppable: !(BOLD_TITLE_RE.test(line) && !URL_RE.test(line)),
      tokens: itemTokens(itemTitle(line)).join(" "),
      head: stripMarkdown(line).replace(/\s+/g, " ").trim().slice(0, 120),
    });
  }
  return out;
}

export function ensureSentItemsTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ritual_sent_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ritual_id  TEXT NOT NULL,
      item_key   TEXT NOT NULL,
      head       TEXT NOT NULL,
      task_id    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ritual_sent_items_lookup
      ON ritual_sent_items(ritual_id, item_key, created_at);
  `);
  const cols = new Set(
    (db.prepare("PRAGMA table_info(ritual_sent_items)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("tokens")) db.exec("ALTER TABLE ritual_sent_items ADD COLUMN tokens TEXT");
}

export interface RecentItem {
  key: string;
  tokens: string[];
  head: string;
}

export function recentSentItems(ritualId: string, days = SENT_BEFORE_DAYS): RecentItem[] {
  const rows = getDatabase()
    .prepare(
      `SELECT item_key, head, tokens FROM ritual_sent_items
       WHERE ritual_id = ? AND created_at >= datetime('now', ?)
       ORDER BY id DESC`,
    )
    .all(ritualId, `-${days} days`) as { item_key: string; head: string; tokens: string | null }[];
  const seen = new Set<string>();
  const out: RecentItem[] = [];
  for (const r of rows) {
    if (seen.has(r.item_key)) continue;
    seen.add(r.item_key);
    out.push({ key: r.item_key, head: r.head, tokens: (r.tokens ?? "").split(" ").filter(Boolean) });
  }
  return out;
}

/** True when `item` repeats one of `recent` (same URL/title, or a ≥0.6-Jaccard rewording). */
export function isRepeat(item: SentItem, recent: RecentItem[]): boolean {
  const toks = item.tokens.split(" ").filter(Boolean);
  for (const r of recent) {
    if (r.key === item.key) return true;
    if (
      toks.length >= MIN_TOKENS_FOR_JACCARD &&
      r.tokens.length >= MIN_TOKENS_FOR_JACCARD &&
      jaccard(toks, r.tokens) >= JACCARD_MIN
    ) {
      return true;
    }
  }
  return false;
}

export function recordSentItems(
  ritualId: string,
  taskId: string | null,
  text: string,
): number {
  const items = extractItems(text);
  if (items.length === 0) return 0;
  const ins = getDatabase().prepare(
    "INSERT INTO ritual_sent_items (ritual_id, item_key, head, task_id, tokens) VALUES (?, ?, ?, ?, ?)",
  );
  const tx = getDatabase().transaction((rows: SentItem[]) => {
    for (const it of rows) ins.run(ritualId, it.key, it.head, taskId, it.tokens);
  });
  tx(items);
  return items.length;
}

export interface SentBeforeResult {
  text: string;
  /** Droppable items (findings) present in the incoming text. */
  items: number;
  dropped: number;
}

/**
 * Remove item lines already sent within the window. Headings, prose and
 * meta lines survive untouched; a dropped bullet's indented continuation
 * lines (`  → Acción: …`) go with it.
 */
export function filterSentBefore(
  ritualId: string,
  text: string,
  days = SENT_BEFORE_DAYS,
): SentBeforeResult {
  const items = extractItems(text).filter((i) => i.droppable);
  if (items.length === 0) return { text, items: 0, dropped: 0 };
  const recent = recentSentItems(ritualId, days);
  const dropKeys = new Set(items.filter((i) => isRepeat(i, recent)).map((i) => i.key));
  if (dropKeys.size === 0) return { text, items: items.length, dropped: 0 };

  const out: string[] = [];
  let dropping = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isItemLine(line, lines[i + 1] ?? "")) {
      const key = itemKey(line);
      dropping = key !== null && dropKeys.has(key);
      if (dropping) continue;
    } else if (dropping && /^\s+\S/.test(line)) {
      continue; // continuation of a dropped bullet
    } else {
      dropping = false;
    }
    out.push(line);
  }
  return {
    text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    items: items.length,
    dropped: dropKeys.size,
  };
}

const BLOCK_MAX_LINES = 40;

/** Prompt block listing recently-sent heads, or "" when nothing was sent. */
export function sentBeforeBlock(
  ritualId: string,
  days = SENT_BEFORE_DAYS,
): string {
  const recent = recentSentItems(ritualId, days);
  if (recent.length === 0) return "";
  const heads = recent.slice(0, BLOCK_MAX_LINES).map((r) => r.head);
  return (
    `\n\n## YA ENVIADO en los últimos ${days} días — NO lo repitas\n` +
    `Si un hallazgo de hoy es el mismo tema que una línea de abajo, omítelo (o menciónalo en una sola frase SOLO si hay un cambio nuevo y di qué cambió). Si no queda nada nuevo, dilo en una línea en vez de rellenar.\n` +
    heads.map((h) => `- ${h}`).join("\n")
  );
}
