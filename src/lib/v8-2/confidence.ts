/**
 * §12 — Confidence compute + §10 hedge-register (the anthropomorphism guard).
 * V8.2 Phase 8.
 *
 * Confidence color is **mechanical**, never LLM-chosen (Lee & See 2004 — an
 * authoritative tone must NOT convey confidence the evidence doesn't back).
 * The color is a deterministic function of three counts:
 *   - distinct_sources   — DISTINCT `(evidence_kind, evidence_id)` (R2: count
 *                          SOURCES, not `[K]` markers — `[1][1]` is one source,
 *                          not three; gameable otherwise).
 *   - contradiction_count — DISTINCT claims the §11 critic proved false
 *                          (`countContradictions`, P6 — live).
 *   - stale_count        — refs older than the retrieval-freshness window;
 *                          `operator_message` is NEVER stale (§13/§18 Q5).
 *
 * Hedge-register enforcement (§10): the §11 critic checks prose-vs-color
 * alignment (green→direct, yellow→hedged, red→uncertainty-foregrounded); a
 * mismatch is `needs_revision`, and after 2 retries the producer applies the
 * mechanical FLOOR — `downgradeColorFloor` (downgrade the color to match the
 * prose; NEVER upgrade). This module ships those deterministic primitives; the
 * judgment-assembly producer (a later phase) wires them into the critic loop.
 *
 * Additive + dormant: no producer computes confidence yet.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { countContradictions } from "./cite.js";
import type { ConfidenceBasis, EvidenceRef } from "./types.js";

export type ConfidenceColor = "green" | "yellow" | "red";

/** Default retrieval-freshness window (days). The V8.1 spec names a
 *  `retrieval_freshness_window` (default 7d); no live config exists, so this is
 *  the canonical default, env-overridable via `MC_RETRIEVAL_FRESHNESS_DAYS`. */
const DEFAULT_FRESHNESS_DAYS = 7;

export function freshnessWindowDays(): number {
  const raw = process.env.MC_RETRIEVAL_FRESHNESS_DAYS;
  if (raw === undefined) return DEFAULT_FRESHNESS_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FRESHNESS_DAYS;
}

export interface ConfidenceOptions {
  /** Write/read db for `countContradictions` (tests inject `:memory:`). */
  db?: Database.Database;
  /** Injectable clock (ISO) for deterministic staleness tests. */
  nowIso?: string;
  /** Override the freshness window (days). Defaults to `freshnessWindowDays()`. */
  freshnessDays?: number;
}

/**
 * Count evidence refs that are STALE (retrieved before now − window).
 * `operator_message` is never stale (§18 Q5 — the operator just said it). A ref
 * whose `retrieved_at` can't be parsed counts as STALE (can't prove freshness →
 * the conservative direction pushes confidence DOWN, never falsely up).
 */
export function countStale(
  refs: EvidenceRef[],
  opts: { nowIso?: string; freshnessDays?: number } = {},
): number {
  const now = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  const windowMs = (opts.freshnessDays ?? freshnessWindowDays()) * 86_400_000;
  let stale = 0;
  for (const r of refs) {
    if (r.kind === "operator_message") continue; // never stale
    const t = Date.parse(r.retrieved_at);
    if (Number.isNaN(t) || now - t > windowMs) stale++;
  }
  return stale;
}

export interface ConfidenceInput {
  /** The persisted judgment's id — needed for the contradiction count. Omit for
   *  a not-yet-persisted judgment (contradiction_count falls to 0). */
  judgmentId?: number;
  /** The judgment's evidence ledger. */
  evidenceRefs: EvidenceRef[];
}

export interface ConfidenceResult {
  color: ConfidenceColor;
  basis: ConfidenceBasis;
}

/**
 * The §12 mechanical confidence color. green = strong & clean (≥3 distinct
 * sources, no contradictions, nothing stale); yellow = some support with at
 * most one contradiction; red = everything else (thin / contradicted / stale).
 */
export function computeConfidence(
  input: ConfidenceInput,
  opts: ConfidenceOptions = {},
): ConfidenceResult {
  const distinct_sources = new Set(
    input.evidenceRefs.map((r) => `${r.kind}:${r.id}`),
  ).size;
  const contradiction_count =
    input.judgmentId != null
      ? countContradictions(input.judgmentId, opts.db ?? getDatabase())
      : 0;
  const stale_count = countStale(input.evidenceRefs, {
    nowIso: opts.nowIso,
    freshnessDays: opts.freshnessDays,
  });

  let color: ConfidenceColor;
  if (distinct_sources >= 3 && contradiction_count === 0 && stale_count === 0) {
    color = "green";
  } else if (distinct_sources >= 1 && contradiction_count <= 1) {
    color = "yellow";
  } else {
    color = "red";
  }

  return {
    color,
    basis: { distinct_sources, contradiction_count, stale_count },
  };
}

// ── §10 hedge-register ────────────────────────────────────────────────────────

/** The linguistic confidence register of a judgment's prose. */
export type Register = "direct" | "hedged" | "uncertain";

/** Strong uncertainty markers (EN + ES) — "we can't tell", "thin evidence",
 *  "may/might", a trailing question. Foreground uncertainty → red prose.
 *  The trailing edge is `(?!\w)` not `\b` (qa-W1): JS `\b` is ASCII-only, so a
 *  trailing `\b` after an accented char ("quizá") never asserts and the marker
 *  is missed — exactly the over-confident-prose-on-red case the §10 floor must
 *  catch. `(?!\w)` asserts end-of-word for ASCII AND accented endings alike. */
const UNCERTAIN_RE =
  /\b(unclear|uncertain|not\s+sure|can'?t\s+tell|cannot\s+tell|thin\s+evidence|insufficient|inconclusive|hard\s+to\s+say|may\b|might\b|possibly|unknown|no\s+(?:podemos|sabemos|est[aá]\s+claro)|incierto|poca\s+evidencia|tal\s+vez|quiz[aá]s?|no\s+queda\s+claro)(?!\w)/i;

/** Softeners (EN + ES) — "likely", "appears", "suggests", "leans". Hedged →
 *  yellow prose. */
const HEDGED_RE =
  /\b(likely|probably|appears?|seems?|suggests?|indicates?|leans?|tends?\s+to|on\s+balance|probable|parece|sugiere|tiende|al\s+parecer|aparentemente)\b/i;

/** Deterministic register of prose — uncertainty wins over hedging wins over
 *  direct (strongest signal first). A trailing "?" forces uncertain. */
export function detectRegister(prose: string): Register {
  const s = prose.trim();
  if (!s) return "direct";
  if (UNCERTAIN_RE.test(s) || /\?\s*$/.test(s)) return "uncertain";
  if (HEDGED_RE.test(s)) return "hedged";
  return "direct";
}

/** The register a given color REQUIRES (§10): green→direct, yellow→hedged,
 *  red→uncertainty-foregrounded. */
export function expectedRegister(color: ConfidenceColor): Register {
  return color === "green"
    ? "direct"
    : color === "yellow"
      ? "hedged"
      : "uncertain";
}

/** Does the prose's register match the color's required register? A mismatch is
 *  the producer's `needs_revision` trigger. */
export function registerMatchesColor(
  prose: string,
  color: ConfidenceColor,
): boolean {
  return detectRegister(prose) === expectedRegister(color);
}

// Confidence ordering for the mechanical floor (higher = more confident).
const COLOR_RANK: Record<ConfidenceColor, number> = {
  red: 1,
  yellow: 2,
  green: 3,
};
const REGISTER_AS_COLOR: Record<Register, ConfidenceColor> = {
  uncertain: "red",
  hedged: "yellow",
  direct: "green",
};

/**
 * Mechanical floor (§10): after 2 critic retries fail to align prose with
 * color, downgrade the color to whatever the PROSE supports — never UPgrade.
 * (A red prose stated directly is the dangerous case; we trust the more-cautious
 * of {color, prose-register}, never let confident language inflate the color.)
 */
export function downgradeColorFloor(
  color: ConfidenceColor,
  prose: string,
): ConfidenceColor {
  const proseColor = REGISTER_AS_COLOR[detectRegister(prose)];
  return COLOR_RANK[proseColor] < COLOR_RANK[color] ? proseColor : color;
}
