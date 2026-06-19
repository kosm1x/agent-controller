/**
 * V8.2 Phase 4 — citation pass + `[N]` resolver (spec §9).
 *
 * The single most load-bearing pass for epistemic discipline. After the
 * judgment pass produces prose carrying `[K]` markers (K ∈ 1..N, indexing the
 * runner-built evidence ledger — the Perplexity poka-yoke: the LLM picks slot
 * indices, never URLs/ids), THIS module does the DETERMINISTIC, no-LLM
 * resolution:
 *
 *   1. `resolveCitations` — walk the prose sentence-by-sentence, extract every
 *      `[K]`, validate K ∈ {1..N}. A sentence with ≥1 VALID marker becomes ONE
 *      resolved claim (a shared `claim_id`) whose evidence refs are pulled from
 *      `ledger[K-1]`; a multi-source `[1][3]` sentence carries two refs under
 *      that one claim_id, `[1][1]` is deduped to one. A markerless sentence that
 *      asserts a non-trivial fact (number / date / name / state-claim) is
 *      flagged CANDIDATE-UNRESOLVED for the §11 critic (Phase 6) to adjudicate
 *      (drop vs accept-as-editorial-framing). Pure editorial sentences are
 *      ignored — they are not claims.
 *   2. `toAttributedClaimRows` / `persistAttributedClaims` — flatten the resolved
 *      claims to one `attributed_claims` row PER evidence ref (the normalized
 *      Phase-1 schema) and INSERT them with `resolver_status='resolved'`.
 *
 * SCHEMA-DRIVEN INVARIANT: `attributed_claims.evidence_kind/evidence_id/
 * evidence_excerpt/retrieved_at` are all NOT NULL (Phase-1 DDL). An unresolved
 * claim has NO evidence, so it CANNOT be a row — unresolved candidates are
 * TRANSIENT, returned in-memory for the critic. Only resolved claims persist.
 * This is why `resolveCitations` returns `{resolved, unresolved}` separately.
 *
 * POSTURE: additive + dormant. The table exists (Phase 1) — no DDL, no restart.
 * The first producer is a later judgment-assembly phase that generates the prose
 * + ledger and calls `resolveCitations`/`persistAttributedClaims`; Phase 4 ships
 * the resolver + persistence + tests only. Nothing in the running service calls
 * in yet. The §9 drop-vs-surface predicate lives beside the §8 skip predicate,
 * in `should-surface.ts`.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { createLogger } from "../logger.js";
import type { AttributedClaimRow, EvidenceRef } from "./types.js";

const log = createLogger("v8-2:cite");

// ── result shapes ─────────────────────────────────────────────────────────────

/** A sentence with ≥1 valid `[K]` marker → one persistable, evidence-backed claim. */
export interface ResolvedClaim {
  /** Per-judgment counter grouping this claim's 1+ evidence rows. */
  claim_id: number;
  /** The sentence text (markers retained; `prose_offset` indexes the original). */
  claim_text: string;
  /** Character offset of the sentence in the source prose. */
  prose_offset: number;
  /** 1+ evidence refs (multi-source `[1][3]` → two, deduped on slot index). */
  evidence_refs: EvidenceRef[];
  resolver_status: "resolved";
}

export type UnresolvedReason =
  | "no_marker_factual" // a factual sentence with no markers at all
  | "invalid_marker_only"; // every marker pointed outside the ledger (1..N)

/** A factual sentence with no VALID citation — handed to the §11 critic, never persisted. */
export interface UnresolvedClaim {
  claim_text: string;
  prose_offset: number;
  reason: UnresolvedReason;
  /** Out-of-range marker indices seen on the sentence (empty for `no_marker_factual`). */
  invalid_markers: number[];
}

export interface CitationStats {
  sentences: number;
  resolved_claims: number;
  unresolved_claims: number;
  /** Count of `[K]` markers with K ∉ {1..N} across the whole prose. */
  invalid_markers: number;
  /**
   * `resolved / (resolved + unresolved)` — a Phase-4 DIAGNOSTIC of how well the
   * prose cited itself. Distinct from the §17 activation gate, which reads
   * `attributed_claims.resolver_status` on persisted rows. 1.0 when the prose
   * makes no factual claims at all.
   */
  resolver_hit_rate: number;
}

export interface CitationResult {
  resolved: ResolvedClaim[];
  unresolved: UnresolvedClaim[];
  stats: CitationStats;
}

export interface ResolveOptions {
  /** First `claim_id` to assign (default 0). Per-judgment numbering. */
  startClaimId?: number;
}

// ── sentence + marker extraction ──────────────────────────────────────────────

/** Matches a `[K]` citation marker; K is the captured integer. */
const MARKER_RE = /\[(\d+)\]/g;

/**
 * Split prose into sentences, tracking each sentence's character offset in the
 * original string. A boundary is a run of `.!?` followed by whitespace or EOL —
 * so a decimal like `3.5` or an index like `v1` does NOT split (no trailing
 * space after the `.`). Abbreviations ("Inc.") may over-split; that only yields
 * finer-grained claims, which is harmless for a citation resolver.
 */
export function splitSentences(
  prose: string,
): { text: string; offset: number }[] {
  const sentences: { text: string; offset: number }[] = [];
  const n = prose.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(prose[i])) i++; // skip leading whitespace
    if (i >= n) break;
    const start = i;
    while (i < n) {
      if (/[.!?]/.test(prose[i])) {
        let j = i;
        while (j < n && /[.!?]/.test(prose[j])) j++; // consume terminator run
        if (j >= n || /\s/.test(prose[j])) {
          i = j;
          break; // real boundary: terminator(s) + whitespace/EOL
        }
        i = j; // terminator mid-token (e.g. "3.5") — keep scanning
      } else {
        i++;
      }
    }
    const text = prose.slice(start, i).trim();
    if (text.length > 0) sentences.push({ text, offset: start });
  }
  return sentences;
}

/** Every `[K]` integer in the text, in order (duplicates preserved). */
export function extractMarkers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MARKER_RE)) out.push(Number(m[1]));
  return out;
}

function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, " ");
}

// ── non-trivial-fact heuristics (§9: number / date / name / state-claim) ──────
// Deliberately RECALL-biased: a false flag only adds a sentence to the §11
// critic's review queue (the precision stage), whereas a missed factual claim
// would slip through uncited. Tuned against the cite.test.ts fixtures.
// KNOWN FN (qa-W1): a proper-name-SUBJECT sentence (capitalized first token,
// so the name check exempts it) with a verb NOT in hasStateClaim's list can
// still read as "editorial". This heuristic is only the backstop; the producer
// prompt's [K]-marker-on-facts contract is the real guarantee (see hasStateClaim).

/** A number / quantity / percentage. */
export function hasNumber(s: string): boolean {
  return /\d/.test(s);
}

/** A weekday / month / relative-day token (EN + ES), with no digit required. */
export function hasDate(s: string): boolean {
  return (
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday)\b/i.test(
      s,
    ) ||
    /\b(ene|abr|ago|dic|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|hoy|ma[ñn]ana|ayer)\b/i.test(
      s,
    )
  );
}

/** Sentence-connectors that are capitalized but are NOT proper names. */
const NAME_STOPWORDS = new Set([
  "Next",
  "Then",
  "However",
  "Consider",
  "Here",
  "There",
  "This",
  "That",
  "These",
  "Those",
  "Note",
  "First",
  "Second",
  "Third",
  "Finally",
  "Also",
  "But",
  "And",
  "So",
  "Yet",
  "Still",
  "Now",
  "Today",
  "Tomorrow",
  "Yesterday",
  "Meanwhile",
  "Therefore",
  "Thus",
  "Overall",
  "Given",
  "While",
  "Although",
]);

/**
 * A proper name: a capitalized word (or acronym) AFTER the first token (the
 * leading word of a sentence is capitalized by convention, so it is exempt),
 * excluding capitalized connectors.
 */
export function hasProperName(s: string): boolean {
  const tokens = s.trim().split(/\s+/).slice(1);
  return tokens.some((t) => {
    const w = t.replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}].*$/u, "");
    return w.length >= 2 && /^\p{Lu}/u.test(w) && !NAME_STOPWORDS.has(w);
  });
}

/** Strong domain state-verbs + copula-followed-by-evaluative-object. Bare
 *  copulas ("are the options") are excluded — too common in editorial prose.
 *  The verb list is deliberately broad on the BUSINESS-STATE axis (signed /
 *  cancelled / lost / churned / shrank …) because the dangerous failure
 *  direction here is a FALSE NEGATIVE — a proper-name-subject sentence whose
 *  verb is unlisted (e.g. "Acme reorganized") slips through as "editorial" and
 *  never reaches the §11 critic (qa-W1). This list narrows but does not close
 *  that gap; the real safety net is the producer prompt's contract that factual
 *  sentences carry a [K] marker (so they take the resolved path, not this one).
 *  Erring toward over-flagging is fine — the §11 critic is the precision stage. */
export function hasStateClaim(s: string): boolean {
  return (
    /\b(exceeds?|exceeded|dropped|drops?|increased|increases?|decreased|decreases?|fell|rose|grew|grows?|failed|fails?|completed|blocked|overdue|stalled|slipping|missed|breached|spiked|surged|declined|lagging|delayed|expired|elapsed|cancell?ed|cancels?|lost|loses?|churned|churning|churns?|shr(?:ank|unk|inks?|inking)|signed|renewed|won|secured|launched|shipped|paused|resumed|escalated|halted|abandoned|slashed|cut|raised|remains?\s+\w+)\b/i.test(
      s,
    ) ||
    /\b(is|are|was|were|has|have)\s+(at\s+risk|overdue|blocked|behind|ahead|below|above|down|up|short|stalled|slipping|on\s+track|complete|completed|done|ready|delayed|late|active|inactive|pending|dormant|churning)\b/i.test(
      s,
    )
  );
}

/** A markerless sentence asserts a non-trivial fact if any §9 category fires. */
export function assertsNonTrivialFact(sentence: string): boolean {
  const s = stripMarkers(sentence);
  return hasNumber(s) || hasDate(s) || hasProperName(s) || hasStateClaim(s);
}

// ── resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve `[K]` citations in prose against an evidence ledger (1-indexed: marker
 * `[K]` → `ledger[K-1]`). Deterministic, no LLM. Returns resolved claims (ready
 * to persist), candidate-unresolved sentences (for the §11 critic), and stats.
 */
export function resolveCitations(
  prose: string,
  ledger: EvidenceRef[],
  options: ResolveOptions = {},
): CitationResult {
  const n = ledger.length;
  let claimId = options.startClaimId ?? 0;
  const resolved: ResolvedClaim[] = [];
  const unresolved: UnresolvedClaim[] = [];
  let invalidMarkerCount = 0;

  const sentences = splitSentences(prose);
  for (const { text, offset } of sentences) {
    const valid: number[] = [];
    const invalid: number[] = [];
    for (const k of extractMarkers(text)) {
      if (k >= 1 && k <= n) valid.push(k);
      else invalid.push(k);
    }
    invalidMarkerCount += invalid.length;

    if (valid.length > 0) {
      const uniqueSlots = [...new Set(valid)];
      resolved.push({
        claim_id: claimId++,
        claim_text: text,
        prose_offset: offset,
        evidence_refs: uniqueSlots.map((k) => ledger[k - 1]),
        resolver_status: "resolved",
      });
      if (invalid.length > 0) {
        log.debug(
          { offset, invalid },
          "cite: sentence had out-of-range markers alongside valid ones",
        );
      }
      continue;
    }

    // No valid markers. Flag it for the critic only if it asserts a fact.
    if (assertsNonTrivialFact(text)) {
      unresolved.push({
        claim_text: text,
        prose_offset: offset,
        reason:
          invalid.length > 0 ? "invalid_marker_only" : "no_marker_factual",
        invalid_markers: invalid,
      });
    }
  }

  const totalClaims = resolved.length + unresolved.length;
  return {
    resolved,
    unresolved,
    stats: {
      sentences: sentences.length,
      resolved_claims: resolved.length,
      unresolved_claims: unresolved.length,
      invalid_markers: invalidMarkerCount,
      resolver_hit_rate: totalClaims === 0 ? 1 : resolved.length / totalClaims,
    },
  };
}

// ── persistence ───────────────────────────────────────────────────────────────

/**
 * Flatten resolved claims to `attributed_claims` rows: ONE row per evidence ref
 * (the normalized schema), all carrying the claim's shared `claim_id` and
 * `resolver_status='resolved'`. A multi-source claim with two refs → two rows.
 */
export function toAttributedClaimRows(
  judgmentId: number,
  resolved: ResolvedClaim[],
): Omit<AttributedClaimRow, "id">[] {
  const rows: Omit<AttributedClaimRow, "id">[] = [];
  for (const c of resolved) {
    for (const ref of c.evidence_refs) {
      rows.push({
        judgment_id: judgmentId,
        claim_id: c.claim_id,
        claim_text: c.claim_text,
        prose_offset: c.prose_offset,
        evidence_kind: ref.kind,
        evidence_id: ref.id,
        evidence_excerpt: ref.excerpt,
        retrieved_at: ref.retrieved_at,
        resolver_status: "resolved",
      });
    }
  }
  return rows;
}

/**
 * Persist resolved claims to `attributed_claims` (one row per evidence ref,
 * `resolver_status='resolved'`) inside a single transaction. Returns the number
 * of rows written. Uses the `getDatabase()` singleton unless a db is injected
 * (tests). No-op (returns 0) for an empty resolved set.
 */
export function persistAttributedClaims(
  judgmentId: number,
  resolved: ResolvedClaim[],
  db: Database.Database = getDatabase(),
): number {
  const rows = toAttributedClaimRows(judgmentId, resolved);
  if (rows.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO attributed_claims
       (judgment_id, claim_id, claim_text, prose_offset,
        evidence_kind, evidence_id, evidence_excerpt, retrieved_at, resolver_status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insertMany = db.transaction((rs: Omit<AttributedClaimRow, "id">[]) => {
    for (const r of rs) {
      stmt.run(
        r.judgment_id,
        r.claim_id,
        r.claim_text,
        r.prose_offset,
        r.evidence_kind,
        r.evidence_id,
        r.evidence_excerpt,
        r.retrieved_at,
        r.resolver_status,
      );
    }
  });
  insertMany(rows);
  return rows.length;
}

/**
 * Replace a judgment's `attributed_claims` with a fresh resolved set, in ONE
 * transaction (DELETE then INSERT). Used by the judgment-assembly producer's
 * critic-loop re-author: a revised prose yields a new claim set, so the prior
 * rows (and any `contradicted` marks on them — they describe the SUPERSEDED
 * prose) must be cleared before the new claims land. Returns rows written.
 *
 * Atomic so a concurrent `countContradictions`/resolver-rate read never sees a
 * half-deleted ledger. The judgments row itself is untouched (FK parent stays).
 */
export function replaceAttributedClaims(
  judgmentId: number,
  resolved: ResolvedClaim[],
  db: Database.Database = getDatabase(),
): number {
  const rows = toAttributedClaimRows(judgmentId, resolved);
  const del = db.prepare(`DELETE FROM attributed_claims WHERE judgment_id = ?`);
  const stmt = db.prepare(
    `INSERT INTO attributed_claims
       (judgment_id, claim_id, claim_text, prose_offset,
        evidence_kind, evidence_id, evidence_excerpt, retrieved_at, resolver_status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const replace = db.transaction((rs: Omit<AttributedClaimRow, "id">[]) => {
    del.run(judgmentId);
    for (const r of rs) {
      stmt.run(
        r.judgment_id,
        r.claim_id,
        r.claim_text,
        r.prose_offset,
        r.evidence_kind,
        r.evidence_id,
        r.evidence_excerpt,
        r.retrieved_at,
        r.resolver_status,
      );
    }
  });
  replace(rows);
  return rows.length;
}

/**
 * Mark the given claims as `contradicted` (§11 → §12 wiring).
 *
 * The §11 CRITIC's `submit_critic_verdict.contradicted_claim_ids` lists the
 * claims the verification tools PROVED false against ground truth. This flips
 * EVERY `attributed_claims` row of those claims (a multi-source claim has 2+
 * rows — all are part of one now-contradicted claim) to
 * `resolver_status='contradicted'` for THIS judgment only. Idempotent
 * (re-running flips already-contradicted rows to the same value). Returns the
 * number of ROWS updated (use `countContradictions` for the distinct-claim
 * count that §12 confidence consumes). No-op (returns 0) for an empty id set.
 *
 * `claimIds` are integers from the forced-tool Zod schema; filtered to finite
 * integers defensively in case a future caller passes raw model output.
 */
export function markClaimsContradicted(
  judgmentId: number,
  claimIds: number[],
  db: Database.Database = getDatabase(),
): number {
  const ids = [...new Set(claimIds)].filter((n) => Number.isInteger(n));
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const info = db
    .prepare(
      `UPDATE attributed_claims
          SET resolver_status = 'contradicted'
        WHERE judgment_id = ?
          AND claim_id IN (${placeholders})`,
    )
    .run(judgmentId, ...ids);
  return info.changes;
}

/**
 * Count DISTINCT contradicted claims for a judgment — the `contradiction_count`
 * term in §12's `computeConfidence` (Phase 8). Counts claims, not rows, so a
 * multi-source contradicted claim counts once. Dormant until Phase 8 wires
 * confidence; shipped here because Phase 6 owns the `contradicted` write and
 * the read side is its natural companion + lets the wiring be tested end-to-end.
 */
export function countContradictions(
  judgmentId: number,
  db: Database.Database = getDatabase(),
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT claim_id) AS n
         FROM attributed_claims
        WHERE judgment_id = ? AND resolver_status = 'contradicted'`,
    )
    .get(judgmentId) as { n: number };
  return row.n;
}
