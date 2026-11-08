/**
 * Tombstones (MEMORY_TOMBSTONES): the write side and the read side.
 *
 * When JME supersedes or expires a fact, the `conversations` rows that
 * carried the old value are untouched and keep coming back through recall. A
 * tombstone records the old value's terms so the recall filter
 * (SqliteMemoryBackend.recall, through silencedBy below) can silence those rows:
 *
 *   terms     the old fact's code / figure / acronym candidates
 *             (codeTermCandidates, kept whole) that the new text does not
 *             hold, that no live jme_facts row still holds, and that are
 *             rare in TOMBSTONE_BANK;
 *   new_terms the new text's code / figure / acronym candidates that the old
 *             text does not hold and that are rare in TOMBSTONE_BANK (a row
 *             carrying one is the correction itself, or newer news).
 *
 * Rare is Port 2's floor rule: held as a phrase by at least one and at most
 * rareDocThreshold(bank rows) rows of the bank. A code common in the bank
 * ("2026", "CDMX") would silence unrelated rows (qa R2 W1).
 *
 * Words are never terms (qa R1 W1/W2): rarity would have to be counted in
 * the fact's own bank, and a jme_facts row carries none (the consolidator
 * runs over every episodic turn, unscoped). TOMBSTONE_BANK is the one bank
 * the filter applies to: JME episodes are written only from the operator's
 * Telegram exchange, which the router retains in that bank.
 *
 * Only a supersede and the expiry of a transient fact (TRANSIENT_FACT_RE)
 * write one: a reword restates the fact, and any other expired fact aged out
 * by its TTL, its value was never shown false (qa R1 W3, qa R2 W2); both
 * trace a skip (traceTombstoneSkipped).
 *
 * Mode `off` writes nothing and runs no statement. `record` and `on` write
 * and trace (`memory.tombstone`, counts only); only `on` filters recall.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { secretSpans } from "../lib/secret-refs.js";
import { errMsg } from "../lib/err-msg.js";
import { emitTraceEvent } from "../observability/task-trace.js";
import { codeTermCandidates, ftsTokens, hasTokenRun, keywordDocFrequency, rareDocThreshold } from "./fts-terms.js";

// ---------------------------------------------------------------------------
// The read side: SqliteMemoryBackend.recall filters through loadTombstones + silencedBy
// ---------------------------------------------------------------------------
//
// A row is silenced when, for one tombstone, all three hold: the row was
// created before the tombstone; it holds one of the tombstone's terms (a
// contiguous run of folded FTS tokens, as the recall floor matches); it holds
// none of the tombstone's new terms. The filter applies to every layer (FTS,
// embeddings, LIKE, the newest-rows fallback). `off` loads nothing and runs no
// statement; `record` counts what it would drop and returns the `off` result;
// `on` drops.

export type TombstoneMode = "off" | "record" | "on";

/** MEMORY_TOMBSTONES: "record" and "on" are the only non-default values; anything else is off. */
export function tombstoneMode(env: NodeJS.ProcessEnv = process.env): TombstoneMode {
  const v = env.MEMORY_TOMBSTONES;
  return v === "on" ? "on" : v === "record" ? "record" : "off";
}

export type TombstoneReason = "superseded" | "reworded" | "expired";

export interface Tombstone {
  id: number;
  /** `YYYY-MM-DD HH:MM:SS` UTC, like conversations.created_at. */
  createdAt: string;
  factId: number;
  reason: TombstoneReason;
  /** Token runs (rareTermCandidates terms split on spaces). */
  terms: string[][];
  newTerms: string[][];
}

/** The bank whose recalls tombstones filter: where the router retains the exchanges JME consolidates (router.ts). */
export const TOMBSTONE_BANK = "mc-jarvis";

let tombstoneCache: { db: object; list: Tombstone[] } | null = null;

/** Drop the loaded tombstones; recordTombstone calls it after every write. */
export function clearTombstoneCache(): void {
  tombstoneCache = null;
}

interface TombstoneRow {
  id: number;
  created_at: string;
  fact_id: number;
  reason: TombstoneReason;
  terms: string;
  new_terms: string;
}

function toTombstone(r: TombstoneRow): Tombstone {
  const runs = (json: string) => (JSON.parse(json) as string[]).map((t) => t.split(" "));
  return {
    id: r.id,
    createdAt: r.created_at,
    factId: r.fact_id,
    reason: r.reason,
    terms: runs(r.terms),
    newTerms: runs(r.new_terms),
  };
}

/**
 * Every tombstone that carries a term, newest first — no count cap (queue
 * 4bo (a), ruled 2026-11-08: a capped load let the oldest stop applying and
 * their stale rows return; retention is pruneTombstones' job). Loaded once
 * per database handle and kept until clearTombstoneCache (a recall runs no
 * statement while the cache holds).
 */
export function loadTombstones(): Tombstone[] {
  const db = getDatabase();
  if (tombstoneCache?.db === db) return tombstoneCache.list;
  const rows = db
    .prepare(
      `SELECT id, created_at, fact_id, reason, terms, new_terms FROM memory_tombstones
       WHERE terms != '[]' ORDER BY created_at DESC, id DESC`,
    )
    .all() as TombstoneRow[];
  const list = rows.map(toTombstone);
  tombstoneCache = { db, list };
  return list;
}

/** Per tombstone list: each term run's first token → the positions of the tombstones holding it, ascending. */
const firstTokenIndex = new WeakMap<readonly Tombstone[], Map<string, number[]>>();

function firstTokens(tombs: readonly Tombstone[]): Map<string, number[]> {
  let ix = firstTokenIndex.get(tombs);
  if (ix) return ix;
  ix = new Map();
  tombs.forEach((t, i) => {
    for (const run of t.terms) {
      const at = ix!.get(run[0]);
      if (!at) ix!.set(run[0], [i]);
      else if (at[at.length - 1] !== i) at.push(i);
    }
  });
  firstTokenIndex.set(tombs, ix);
  return ix;
}

/**
 * The first tombstone (in `tombs` order) that silences `row`, if any. A run
 * can match only where its first token is, so only the tombstones indexed
 * under one of the row's tokens are checked: the list is unbounded (queue
 * 4bo (a)), a per-tombstone scan cost ~50 ms per 90-row recall at 10k.
 */
export function silencedBy(
  row: { content: string; created_at: string },
  tombs: readonly Tombstone[],
): Tombstone | undefined {
  const ix = firstTokens(tombs);
  const toks = ftsTokens(row.content);
  const hits = new Set<number>();
  for (const tok of new Set(toks)) for (const i of ix.get(tok) ?? []) hits.add(i);
  for (const i of [...hits].sort((a, b) => a - b)) {
    const t = tombs[i]!;
    if (row.created_at < t.createdAt && hasTokenRun(toks, t.terms) && !hasTokenRun(toks, t.newTerms)) return t;
  }
  return undefined;
}

/**
 * Tombstone retention (queue 4bo (a), ruled 2026-11-08): no count cap; a
 * tombstone lives until what it silences is gone. It is deleted when both hold:
 *
 *   - its jme_facts row (fact_id) no longer exists: while the row exists the
 *     tombstone may be the `superseded` marker recordTombstone reads;
 *   - no TOMBSTONE_BANK row it silences is left, judged by silencedBy itself
 *     (the recall predicate): a row created after the tombstone is never
 *     silenced, so once the older rows that carry the stale value are deleted
 *     (memory consolidation) it can filter nothing again.
 *
 * Recall-neutral by construction. Runs nightly inside pruneExpiredFacts'
 * transaction, after its DELETE. Mode `off` runs no statement. Never throws;
 * returns the count deleted. One bank scan (rows older than the newest
 * candidate), each row's tokens looked up in a first-token index of the
 * candidates' terms.
 */
export function pruneTombstones(): number {
  const mode = tombstoneMode();
  if (mode === "off") return 0;
  try {
    const db = getDatabase();
    const orphans = (
      db
        .prepare(
          `SELECT t.id, t.created_at, t.fact_id, t.reason, t.terms, t.new_terms FROM memory_tombstones t
           WHERE NOT EXISTS (SELECT 1 FROM jme_facts f WHERE f.id = t.fact_id)`,
        )
        .all() as TombstoneRow[]
    ).map(toTombstone);
    const doomed = new Set(orphans.map((t) => t.id));
    const byFirst = new Map<string, Tombstone[]>();
    let newest = "";
    for (const t of orphans) {
      if (t.terms.length === 0) continue;
      if (t.createdAt > newest) newest = t.createdAt;
      for (const run of t.terms) {
        const bucket = byFirst.get(run[0]) ?? [];
        if (!bucket.includes(t)) bucket.push(t);
        byFirst.set(run[0], bucket);
      }
    }
    if (byFirst.size > 0) {
      const rows = db
        .prepare("SELECT content, created_at FROM conversations WHERE bank = ? AND created_at < ?")
        .iterate(TOMBSTONE_BANK, newest) as IterableIterator<{ content: string; created_at: string }>;
      for (const row of rows) {
        const left = new Set<Tombstone>();
        for (const tok of new Set(ftsTokens(row.content))) {
          for (const t of byFirst.get(tok) ?? []) if (doomed.has(t.id)) left.add(t);
        }
        for (let t = silencedBy(row, [...left]); t; t = silencedBy(row, [...left])) {
          doomed.delete(t.id);
          left.delete(t);
        }
      }
    }
    if (doomed.size > 0) {
      const del = db.prepare("DELETE FROM memory_tombstones WHERE id = ?");
      writeWithRetry(() => {
        for (const id of doomed) del.run(id);
      });
      clearTombstoneCache();
    }
    console.log(`[memory] tombstone prune (${mode}): ${doomed.size} pruned of ${orphans.length} whose fact is gone`);
    return doomed.size;
  } catch (err) {
    console.warn(`[memory] tombstone prune failed: ${errMsg(err)}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The write side
// ---------------------------------------------------------------------------

/** task_trace_events key: a tombstone is written by the nightly consolidator, not a task. */
const TOMBSTONE_TRACE_KEY = "memory-tombstones";

/** `YYYY-MM-DD HH:MM:SS` UTC — the format `conversations.created_at` holds. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The text a term may come from: every stored-secret span (what scrubSecrets
 * replaces) and every bracketed placeholder ("[email]", "[oculto · …]")
 * blanked, so no term is a secret or a piece of one.
 */
function termSource(text: string): string {
  let out = text;
  for (const [start, end] of [...secretSpans(text)].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + " " + out.slice(end);
  }
  return out.replace(/\[[^\]]{0,80}\]/g, " ");
}

/**
 * The candidate terms of a tombstone, as space-joined FTS token runs: the old
 * text's code / figure candidates the new text does not hold, and the new
 * text's the old text does not hold (`newText` null = an expiry: no new terms).
 */
export function tombstoneTerms(oldText: string, newText: string | null): { terms: string[]; newTerms: string[] } {
  const [oldSrc, newSrc] = [termSource(oldText), newText === null ? "" : termSource(newText)];
  const [oldToks, newToks] = [ftsTokens(oldSrc), ftsTokens(newSrc)];
  const absent = (candidates: string[], toks: string[]) => candidates.filter((t) => !hasTokenRun(toks, [t.split(" ")]));
  return {
    terms: absent(codeTermCandidates(oldSrc), newToks),
    newTerms: newText === null ? [] : absent(codeTermCandidates(newSrc), oldToks),
  };
}

/**
 * The terms no live jme_facts row other than `factId` holds (live at
 * `liveAt`: not expired, not superseded; an operator-rejected marker at
 * confidence 0 is not a claim and does not count). One statement per
 * tombstone write, reading every live fact's text: nightly only.
 */
function notHeldByLiveFacts(terms: readonly string[], factId: number, liveAt: number): string[] {
  if (terms.length === 0) return [];
  const live = getDatabase()
    .prepare("SELECT fact_text FROM jme_facts WHERE id != ? AND confidence > 0 AND (expires_at IS NULL OR expires_at > ?)")
    .all(factId, liveAt) as Array<{ fact_text: string }>;
  const runs = terms.map((t) => t.split(" "));
  const held = new Set<number>();
  for (const f of live) {
    const toks = ftsTokens(termSource(f.fact_text));
    runs.forEach((run, i) => {
      if (!held.has(i) && hasTokenRun(toks, [run])) held.add(i);
    });
    if (held.size === runs.length) break;
  }
  return terms.filter((_, i) => !held.has(i));
}

/**
 * The terms rare in TOMBSTONE_BANK (qa R2 W1): keywordDocFrequency of the
 * text they came from (`source`, already through termSource), each count
 * capped at threshold + 1 and taken as a phrase, so "kvx 482" counts as
 * itself. A bank row count plus one capped count per candidate of `source`,
 * per tombstone write: nightly only.
 */
function rareInBank(terms: readonly string[], source: string): string[] {
  if (terms.length === 0) return [];
  const rows = (
    getDatabase().prepare("SELECT COUNT(*) AS n FROM conversations WHERE bank = ?").get(TOMBSTONE_BANK) as { n: number }
  ).n;
  const threshold = rareDocThreshold(rows);
  const df = keywordDocFrequency(source, TOMBSTONE_BANK, threshold + 1);
  return terms.filter((t) => {
    const n = df.get(t) ?? 0;
    return n >= 1 && n <= threshold;
  });
}

/**
 * Record a tombstone for `old` (a jme_facts row about to stop being true)
 * at `at` (ms): now for a supersede, the fact's expires_at for an expiry.
 * `liveAt` (default `at`) is the instant a jme_facts row must outlive to
 * count as live: the prune passes its own now. Never throws — a tombstone
 * failure must not fail the JME write that called it. Returns true when a
 * row was written.
 *
 *   - A tombstone with 0 terms filters nothing and is not written, except
 *     for `superseded`: that row is the marker the prune reads, so the
 *     superseded fact does not get a second, exception-free `expired`
 *     tombstone when the nightly prune deletes it.
 *   - `expired` is skipped for a fact that already has a `superseded` one.
 */
export function recordTombstone(
  old: { id: number; factText: string },
  newText: string | null,
  reason: TombstoneReason,
  at: number = Date.now(),
  liveAt: number = at,
): boolean {
  const mode = tombstoneMode();
  if (mode === "off") return false;
  try {
    const db = getDatabase();
    if (
      reason === "expired" &&
      db.prepare("SELECT 1 FROM memory_tombstones WHERE fact_id = ? AND reason = 'superseded' LIMIT 1").get(old.id)
    )
      return false;
    const { terms: candidates, newTerms: newCandidates } = tombstoneTerms(old.factText, newText);
    const terms = rareInBank(notHeldByLiveFacts(candidates, old.id, liveAt), termSource(old.factText));
    const newTerms = newText === null ? [] : rareInBank(newCandidates, termSource(newText));
    const write = terms.length > 0 || reason === "superseded";
    if (write) {
      writeWithRetry(() => {
        db.prepare(
          "INSERT INTO memory_tombstones (created_at, fact_id, reason, terms, new_terms) VALUES (?, ?, ?, ?, ?)",
        ).run(sqliteUtc(at), old.id, reason, JSON.stringify(terms), JSON.stringify(newTerms));
      });
      clearTombstoneCache();
    }
    emitTraceEvent({
      taskId: TOMBSTONE_TRACE_KEY,
      name: "memory.tombstone",
      attrs: { mode, reason, terms: terms.length, newTerms: newTerms.length },
    });
    return write;
  } catch (err) {
    console.warn(`[memory] tombstone write failed (fact #${old.id}, ${reason}): ${errMsg(err)}`);
    return false;
  }
}

/**
 * A site that writes no tombstone, traced as such (record|on): a reword
 * restates the fact, and a non-transient expiry aged out by its TTL.
 */
export function traceTombstoneSkipped(reason: "reworded" | "expired"): void {
  const mode = tombstoneMode();
  if (mode === "off") return;
  emitTraceEvent({
    taskId: TOMBSTONE_TRACE_KEY,
    name: "memory.tombstone",
    attrs: { mode, reason, skipped: true },
  });
}
