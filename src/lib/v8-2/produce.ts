/**
 * V8.2 judgment-assembly producer (spec §4 Flow A) — the first live consumer of
 * the dormant P0–P8 substrate. For each selected judgment in a just-constructed
 * morning brief it runs the full pipeline:
 *
 *   derive question → decompose (§7) → gatherEvidence → should-multi-option (§8)
 *   → [RAPID-D] → author prose with [K] (§9) → resolveCitations (§9) →
 *   INSERT judgments row + attributed_claims → critic loop (§11) → confidence
 *   (§12) + hedge floor (§10) → finalize the row.
 *
 * SHADOW DISCIPLINE: this writes `judgments` / `attributed_claims` rows and runs
 * the critic, but the rows are NOT delivered to the operator — the brief still
 * delivers its V8.1 prose. Surfacing V8.2 judgments is the post-shadow
 * activation step. The whole pass is flag-gated (`isV82ProducerEnabled`) and
 * called inside a try/catch in `runMorningSurface`, so a failure here can never
 * break the live brief.
 *
 * LEDGER INVARIANT (the silent-failure axis): the SAME ordered `EvidenceRef[]`
 * from `gatherEvidence` is rendered to the author, passed to `resolveCitations`,
 * to `runCriticLoop`, and to `computeConfidence`. Any reorder makes every `[K]`
 * resolve to the wrong evidence with no error — so the array is threaded
 * unchanged through one judgment's whole pipeline.
 */

import type Database from "better-sqlite3";
import type { Briefing, Judgment } from "../../briefing/schema.js";
import { getDatabase } from "../../db/index.js";
import { createLogger } from "../logger.js";
import {
  decomposeQuestion,
  gatherEvidence,
  DecompositionError,
} from "./decompose.js";
import { shouldRunMultiOption } from "./should-multi-option.js";
import { runMultiOption } from "./multi-option.js";
import { authorJudgment } from "./author.js";
import {
  resolveCitations,
  persistAttributedClaims,
  replaceAttributedClaims,
  type ResolvedClaim,
  type UnresolvedClaim,
} from "./cite.js";
import { runCriticLoop, type ReAuthorFn } from "./critic.js";
import {
  computeConfidence,
  registerMatchesColor,
  downgradeColorFloor,
  type ConfidenceColor,
} from "./confidence.js";
import {
  insertJudgment,
  updateJudgmentProse,
  updateJudgmentVerdict,
  normalizePosture,
  type JudgmentRow,
} from "./judgments-store.js";
import { STRATEGIC_VOICE_PRINCIPLE_ID } from "./strategic-voice.js";
import type { ReRunJudgmentFn } from "./concession.js";
import {
  EvidenceRefSchema,
  ProposedOptionSchema,
  type EvidenceRef,
  type ProposedOption,
} from "./types.js";

const log = createLogger("v8-2:produce");

/** Per-brief cap on how many judgments get the (cost-heavy) deep pipeline.
 *  Matches the spec's "2-3 option-bearing judgments ≈ 10-22 calls/brief"
 *  envelope. Env-overridable, but HARD-clamped at ABS_MAX so a config typo
 *  (e.g. `=100`) can't fan out into ~1000 Sonnet calls in one brief. */
const DEFAULT_MAX_JUDGMENTS_PER_BRIEF = 3;
const ABS_MAX_JUDGMENTS_PER_BRIEF = 6;

function maxJudgmentsPerBrief(): number {
  const raw = process.env.V82_MAX_JUDGMENTS_PER_BRIEF;
  if (!raw) return DEFAULT_MAX_JUDGMENTS_PER_BRIEF;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_MAX_JUDGMENTS_PER_BRIEF;
  return Math.min(n, ABS_MAX_JUDGMENTS_PER_BRIEF);
}

/** Cost-ledger note (audit follow-up): the producer calls `queryClaudeSdk`
 *  directly (to control the §10 cache prefix), so its spend does NOT flow through
 *  the `infer()` adapter's `recordCost`. Complete capture needs token usage
 *  threaded out of author/decompose/critic/multi-option — a multi-module change
 *  tracked as the top V8.2-producer follow-up. While shadowing, gross spend is
 *  still bounded/observable via the hourly $2 budget cap + journalctl. */

/** Selection priority — deepen the decision-worthy judgments first. Stable
 *  within a priority band (preserves brief order). */
function priority(j: Judgment): number {
  if (j.posture === "highest_leverage") return 0;
  if (j.posture === "at_risk") return 1;
  if (j.kind === "recurring_blocker") return 2;
  return 3;
}

/** Pick the top `max` judgments by priority. A quiet brief (all observational)
 *  still yields up to `max` so the §17 shadow accrues volume. */
export function selectJudgments(
  judgments: Judgment[],
  max: number,
): Judgment[] {
  return judgments
    .map((j, idx) => ({ j, idx }))
    .sort((a, b) => priority(a.j) - priority(b.j) || a.idx - b.idx)
    .slice(0, max)
    .map((x) => x.j);
}

/** Phrase a V8.1 judgment as a strategic question for decomposition / authoring. */
export function deriveStrategicQuestion(j: Judgment): string {
  return `What is the right course of action on ${j.subject}? Context: ${j.why}`;
}

/** A compact BriefingContext digest — NOT full rows (§7). The focus judgment's
 *  own framing plus a one-line view of the sibling judgments and active
 *  objectives, so the author/decompose calls see the brief's shape. */
export function renderContextDigest(
  briefing: Briefing,
  focus: Judgment,
): string {
  const siblings = briefing.judgments
    .filter((s) => s.signal_id !== focus.signal_id)
    .map((s) => `- ${s.subject} [${s.posture}/${s.confidence}]`)
    .join("\n");
  return [
    `Morning brief ${briefing.briefing_id} (${briefing.generated_at}).`,
    briefing.active_objective_ids.length > 0
      ? `Active objectives: ${briefing.active_objective_ids.join(", ")}.`
      : "",
    `This judgment — ${focus.subject} (${focus.kind} / ${focus.posture} / ${focus.confidence}): ${focus.why}`,
    siblings ? `Other judgments in this brief:\n${siblings}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseLedger(json: string | null): EvidenceRef[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: EvidenceRef[] = [];
    for (const item of parsed) {
      const r = EvidenceRefSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

function parseOptions(json: string | null): ProposedOption[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: ProposedOption[] = [];
    for (const item of parsed) {
      const r = ProposedOptionSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

/** Append a ref to the ledger unless an equal (kind, excerpt) is already present
 *  — same idempotency key as `appendEvidenceRef`. Used so the concession re-run's
 *  ledger includes the operator's evidence even though the caller passed a
 *  pre-append snapshot. */
function mergeEvidence(
  ledger: EvidenceRef[],
  extra: EvidenceRef,
): EvidenceRef[] {
  if (
    ledger.some((r) => r.kind === extra.kind && r.excerpt === extra.excerpt)
  ) {
    return ledger;
  }
  return [...ledger, extra];
}

/** What the critic-loop reAuthor closure needs to re-author one judgment. */
interface ReauthorContext {
  question: string;
  contextDigest: string;
  options: ProposedOption[];
  subject: string;
  /** Persisted posture vocab. */
  posture: string;
}

/**
 * Shared §11 critic loop → §12 confidence → §10 floor → finalize, used by BOTH
 * the Flow-A producer (`assembleOneJudgment`) and the §13 concession re-run
 * (`reRunJudgment`). Assumes the judgment row + its initial attributed_claims are
 * already persisted. The reAuthor closure persists each revision so the row +
 * claims stay consistent and the FINAL `runCritic` marks contradictions on the
 * FINAL claim set — which `computeConfidence` then reads. Returns the final prose
 * (the loop may have re-authored it) + the floor-adjusted color.
 */
async function runCriticAndFinalize(
  judgmentId: number,
  initial: {
    prose: string;
    claims: ResolvedClaim[];
    unresolved: UnresolvedClaim[];
  },
  ledger: EvidenceRef[],
  ctx: ReauthorContext,
  opts: { db: Database.Database; signal?: AbortSignal; nowIso?: string },
): Promise<{ prose: string; color: ConfidenceColor }> {
  const { db, signal, nowIso } = opts;
  let finalProse = initial.prose;

  const reAuthor: ReAuthorFn = async (input, critique) => {
    try {
      const re = await authorJudgment(
        {
          question: ctx.question,
          contextSummary: ctx.contextDigest,
          ledger: input.ledger,
          options: ctx.options,
          subject: ctx.subject,
          posture: ctx.posture,
          critique,
        },
        { signal },
      );
      const r = resolveCitations(re.prose, input.ledger, { startClaimId: 0 });
      finalProse = re.prose;
      updateJudgmentProse(judgmentId, re.prose, db);
      replaceAttributedClaims(judgmentId, r.resolved, db);
      return {
        prose: re.prose,
        claims: r.resolved,
        unresolved: r.unresolved,
        ledger: input.ledger,
      };
    } catch (err) {
      // A failed re-author degrades to the prior draft (no fabricated revision);
      // the loop runs its 2nd critic on the same prose, then escalates.
      log.warn(
        { judgmentId, err: err instanceof Error ? err.message : String(err) },
        "re-author failed — keeping prior draft",
      );
      return {
        prose: input.prose,
        claims: input.claims,
        unresolved: input.unresolved,
        ledger: input.ledger,
      };
    }
  };

  const loop = await runCriticLoop(
    {
      judgmentId,
      prose: initial.prose,
      claims: initial.claims,
      ledger,
      unresolved: initial.unresolved,
    },
    { reAuthor },
    { writeDb: db, signal },
  );

  // §12 confidence (after the loop → contradiction_count is final) + the §10
  // mechanical floor: never let over-confident prose ship on a weaker color.
  const conf = computeConfidence(
    { judgmentId, evidenceRefs: ledger },
    { db, nowIso },
  );
  const color = registerMatchesColor(finalProse, conf.color)
    ? conf.color
    : downgradeColorFloor(conf.color, finalProse);

  updateJudgmentVerdict(
    judgmentId,
    {
      confidence: color,
      confidenceBasisJson: JSON.stringify(conf.basis),
      criticTrailJson: JSON.stringify({
        verdict: loop.verdict,
        iterations: loop.iterations,
        critique: loop.critique,
      }),
    },
    db,
  );

  return { prose: finalProse, color };
}

interface AssembleOpts {
  nowIso: string;
  signal?: AbortSignal;
  db: Database.Database;
}

/**
 * Assemble ONE strategic judgment end-to-end. Returns the persisted judgment id,
 * or null if the judgment was skipped (decomposition failed). Throws only on an
 * unexpected error (caught per-judgment by the caller).
 */
async function assembleOneJudgment(
  briefing: Briefing,
  j: Judgment,
  contextDigest: string,
  opts: AssembleOpts,
): Promise<number | null> {
  const { nowIso, signal, db } = opts;
  const question = deriveStrategicQuestion(j);

  // 1. Decompose → deterministic evidence ledger (the load-bearing array).
  let ledger: EvidenceRef[];
  try {
    const decomposition = await decomposeQuestion(question, contextDigest, {
      nowIso,
      signal,
    });
    ledger = gatherEvidence(decomposition, { db, nowIso });
  } catch (err) {
    if (err instanceof DecompositionError) {
      log.warn(
        { subject: j.subject, err: err.message },
        "decomposition failed — skipping judgment",
      );
      return null;
    }
    throw err;
  }

  // 2. RAPID-D options (gated). length 3 or 0, never a faked 1/2.
  let options: ProposedOption[] = [];
  if (shouldRunMultiOption(j).run) {
    const rapid = await runMultiOption(
      { question, contextSummary: contextDigest, evidence: ledger },
      { signal },
    );
    options = rapid.options;
  }

  // 3. Author the [K]-marked prose, then resolve citations over the SAME ledger.
  const authored = await authorJudgment(
    {
      question,
      contextSummary: contextDigest,
      ledger,
      options,
      subject: j.subject,
      posture: normalizePosture(j.posture),
    },
    { signal },
  );
  const prose = authored.prose;
  const first = resolveCitations(prose, ledger, { startClaimId: 0 });

  // 4. Persist the judgment row (FK parent), then its resolved claims.
  const judgmentId = insertJudgment(
    {
      briefingId: briefing.briefing_id,
      subject: j.subject,
      posture: j.posture, // normalized inside insertJudgment
      prose,
      createdAt: nowIso,
      signalKind: j.kind,
      evidenceRefsJson: JSON.stringify(ledger),
      proposedOptionsJson: options.length > 0 ? JSON.stringify(options) : null,
      strategicVoicePrincipleId: STRATEGIC_VOICE_PRINCIPLE_ID,
    },
    db,
  );
  persistAttributedClaims(judgmentId, first.resolved, db);

  // 5-6. Critic loop (§11) → confidence (§12) → hedge floor (§10) → finalize.
  await runCriticAndFinalize(
    judgmentId,
    { prose, claims: first.resolved, unresolved: first.unresolved },
    ledger,
    {
      question,
      contextDigest,
      options,
      subject: j.subject,
      posture: normalizePosture(j.posture),
    },
    { db, signal, nowIso },
  );

  return judgmentId;
}

export interface RunJudgmentAssemblyOptions {
  /** Injected clock (ISO) for deterministic tests. */
  nowIso?: string;
  signal?: AbortSignal;
  db?: Database.Database;
  /** Override the per-brief judgment cap (tests). */
  maxJudgments?: number;
}

export interface JudgmentAssemblyResult {
  attempted: number;
  written: number;
  judgmentIds: number[];
}

/**
 * Run the judgment-assembly producer over a just-constructed brief. Selects the
 * top judgments and assembles them CONCURRENTLY — each judgment is independent
 * (own row, own claims, own critic loop; `better-sqlite3` is synchronous so the
 * per-judgment writes can't interleave mid-statement). Concurrency makes the
 * pass wall-clock ≈ the slowest single judgment instead of the sum (~2.5 min vs
 * ~6 min serial), so the morning-surface pass deadline
 * (`JUDGMENT_ASSEMBLY_DEADLINE_MS`, 5 min) reverts from the routine path to a
 * rarely-hit backstop. Tradeoff vs the old serial loop: if the deadline DOES
 * still fire mid-pass, `signal.abort()` reaches every in-flight judgment at once,
 * so each one whose author/decompose step hasn't completed throws and is dropped
 * (the serial loop instead kept the completed prefix and dropped only the tail).
 * Acceptable for a shadow producer — the whole pass is non-fatal and undelivered.
 *
 * Concurrency is bounded by `maxJudgmentsPerBrief()` (default 3, abs max 6); no
 * extra semaphore. At the default this is well within SDK/budget headroom; if the
 * cap is ever raised toward 6, add a concurrency limiter (each judgment fans out
 * several sequential SDK calls, incl. RAPID-D perspectives).
 *
 * Each assembly keeps its own isolation (via `allSettled`) so one failure never
 * sinks the batch, and `judgmentIds` preserves selection (priority) order, not
 * completion order.
 */
export async function runJudgmentAssembly(
  briefing: Briefing,
  options: RunJudgmentAssemblyOptions = {},
): Promise<JudgmentAssemblyResult> {
  const db = options.db ?? getDatabase();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const max = options.maxJudgments ?? maxJudgmentsPerBrief();
  const selected = selectJudgments(briefing.judgments, max);

  // Pre-flight: if the caller already aborted, do no work (mirrors the
  // per-step pre-checks in author/decompose/critic).
  if (options.signal?.aborted) {
    return { attempted: selected.length, written: 0, judgmentIds: [] };
  }

  const settled = await Promise.allSettled(
    selected.map((j) => {
      const contextDigest = renderContextDigest(briefing, j);
      return assembleOneJudgment(briefing, j, contextDigest, {
        nowIso,
        signal: options.signal,
        db,
      });
    }),
  );

  // Collect in selection order so judgmentIds stays priority-ranked. Log each
  // rejection non-fatally, matched back to its subject by index.
  const judgmentIds: number[] = [];
  settled.forEach((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      if (outcome.value != null) judgmentIds.push(outcome.value);
    } else {
      log.error(
        {
          subject: selected[idx].subject,
          err:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        },
        "judgment assembly failed for one judgment (non-fatal)",
      );
    }
  });

  return {
    attempted: selected.length,
    written: judgmentIds.length,
    judgmentIds,
  };
}

/**
 * The §13 concession re-run (`ReRunJudgmentFn`). Re-runs ONE judgment's §9
 * author + §11 critic + §12 confidence with the operator's evidence folded in,
 * persists the revision, and returns the revised prose + recomputed color so the
 * §13 re-delivery shows the updated judgment.
 *
 * `handlePushback` appends the operator_message to the DB row BEFORE calling
 * this, but hands us the PRE-append snapshot, so we fold `operatorEvidence` into
 * the in-memory ledger ourselves (idempotent on (kind, excerpt)) — that ledger
 * is the SAME array threaded to the author render, resolveCitations, the critic,
 * and computeConfidence, so the operator's evidence is citable AND counts as a
 * fresh distinct source (§18 Q5).
 *
 * Throws (AuthorError) on a failed author — handlePushback then writes no
 * concession (the appended evidence is idempotent on the operator's retry), so a
 * transient model failure never fabricates an "updated" outcome.
 */
export const reRunJudgment: ReRunJudgmentFn = async (
  judgment: JudgmentRow,
  operatorEvidence: EvidenceRef,
) => {
  const db = getDatabase();
  // Fold the operator's evidence into the ledger the re-run actually uses (the
  // caller's stale snapshot omits it). This is the load-bearing fix for the
  // §13 "updated_with_evidence" guarantee.
  const ledger = mergeEvidence(
    parseLedger(judgment.evidenceRefsJson),
    operatorEvidence,
  );
  const options = parseOptions(judgment.proposedOptionsJson);
  const question = `Reassess the judgment on ${judgment.subject} in light of the operator's new input.`;
  const contextDigest = `Subject: ${judgment.subject}. The operator pushed back with new information: "${operatorEvidence.excerpt}". Your prior judgment was: ${judgment.prose}`;
  const ctx: ReauthorContext = {
    question,
    contextDigest,
    options,
    subject: judgment.subject,
    posture: judgment.posture,
  };

  // §9 author (initial revision) → resolve → persist over the operator-inclusive
  // ledger, then the shared §11 critic → §12 confidence → §10 floor → finalize
  // (so a concession can be driven down by a contradiction, per spec §13).
  const authored = await authorJudgment({
    question,
    contextSummary: contextDigest,
    ledger,
    options,
    subject: judgment.subject,
    posture: judgment.posture,
    critique: `The operator supplied new evidence: "${operatorEvidence.excerpt}". Update the judgment to account for it; do not pretend prior agreement.`,
  });
  const first = resolveCitations(authored.prose, ledger, { startClaimId: 0 });
  updateJudgmentProse(judgment.id, authored.prose, db);
  replaceAttributedClaims(judgment.id, first.resolved, db);

  const { prose, color } = await runCriticAndFinalize(
    judgment.id,
    {
      prose: authored.prose,
      claims: first.resolved,
      unresolved: first.unresolved,
    },
    ledger,
    ctx,
    { db },
  );

  return { prose, confidence: color };
};
