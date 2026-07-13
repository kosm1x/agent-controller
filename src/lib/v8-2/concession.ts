/**
 * §13 — Concession handler (the consent layer). V8.2 Phase 7.
 *
 * This is V8.2's defining behavior: "I will not fold without evidence." It is
 * EVENT-DRIVEN (not Flow A) — it extends `resolveBriefingOnOperatorReply`
 * (`src/briefing/promote.ts`), which today only does binary promote/discard.
 *
 * Flow B (on an owner-channel reply to a delivered brief that carries ≥1 V8.2
 * judgment):
 *   1. classify the reply  → promote | discard | pushback{judgment_id}
 *      (forced-tool, per §11 discipline; classifier failure falls back to the
 *       legacy DISCARD_RE in promote.ts — NEVER fabricates a pushback).
 *   2. for pushback → the EVIDENCE GATE:
 *        - no evidence  → held_position  (restate w/ reasoning; do NOT re-run,
 *                                          do NOT soften)
 *        - has evidence → updated_with_evidence (append operator_message to the
 *                                          ledger, re-run §9+§11+§12, re-deliver
 *                                          with an explicit "updating on your
 *                                          input" preface — no pretended prior
 *                                          agreement)
 *   3. `conceded_without_evidence` is NEVER written here — it exists only as a
 *      measured failure in the §14 nightly probe (Phase 8).
 *
 * Additive + dormant: the per-judgment re-run reuses Flow A passes via the
 * INJECTED `ReRunJudgmentFn` (mirrors Phase 6's injected `ReAuthorFn`) — the
 * §9 judgment author does not exist yet (it's the producer phase) and §12
 * `computeConfidence` lands in Phase 8. Until a producer writes `judgments`
 * rows, `countJudgmentsForBriefing` is 0 and none of this runs (the reply
 * hot-path stays a pure regex).
 */

import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  queryClaudeSdk,
  SONNET_MODEL_ID,
  type InlineSdkTool,
} from "../../inference/claude-sdk.js";
import {
  insertReflectionFollowup,
  type CheckpointKind,
} from "../../briefing/reflection-followups.js";
import { createLogger } from "../logger.js";
import { hasDate, hasNumber } from "./cite.js";
import {
  appendEvidenceRef,
  getJudgmentById,
  setConcessionKind,
  type JudgmentRow,
} from "./judgments-store.js";
import type { EvidenceRef } from "./types.js";
import { errMsg } from "../err-msg.js";

const log = createLogger("v8-2:concession");

// ── reply classification (forced tool) ────────────────────────────────────────

export const REPLY_CLASSES = ["promote", "discard", "pushback"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export const SUBMIT_REPLY_CLASS_TOOL_NAME = "submit_reply_class";

/** Hard cap on the single classifier LLM call. */
const CLASSIFY_TIMEOUT_MS = 20_000;

/** Cap on free-text echoed back into the ledger / preface (a hostile or huge
 *  reply must not bloat a row or the re-delivery). */
const EVIDENCE_TEXT_CAP = 600;

/** Forward audit horizon for a forward-looking judgment's self-recheck (§13). */
const FOLLOWUP_HORIZON_MS = 72 * 60 * 60 * 1000;

export const CLASSIFIER_SYSTEM_PROMPT_V1 = `You classify the OPERATOR's reply to a delivered strategic brief. You are a router, not an author — return exactly one classification via the submit_reply_class tool and nothing else.

Classes:
- promote  — the operator accepts, acknowledges, asks a follow-up, or otherwise engages WITHOUT disputing a judgment's conclusion. This is the default for any non-rejecting, non-disputing reply.
- discard  — the operator clearly rejects the WHOLE brief ("descártalo", "no me interesa", "archive this").
- pushback — the operator DISPUTES the conclusion of a SPECIFIC judgment ("I don't think the pilot is at risk", "that's wrong about X"). You MUST set judgment_id to the disputed judgment from the list provided. If the reply disputes the brief but names no specific judgment and only one judgment exists, target that one; if several exist and none is identifiable, classify as promote instead (do not guess a target).

Disputing the conclusion is pushback even if the operator is polite. Merely asking a clarifying question is promote, not pushback.`;

const submitReplyClassSchema = {
  class: z
    .enum(REPLY_CLASSES)
    .describe(
      "promote = accepts/engages without disputing; discard = rejects the whole brief; pushback = disputes a specific judgment's conclusion (set judgment_id).",
    ),
  judgment_id: z
    .number()
    .int()
    .optional()
    .describe(
      "REQUIRED iff class='pushback': the id of the disputed judgment, taken from the judgments list in the prompt. Omit for promote/discard.",
    ),
  rationale: z
    .string()
    .describe("One concise sentence: why this class (and which judgment)."),
};

interface ReplyClassCapture {
  class: ReplyClass;
  judgment_id?: number;
  rationale: string;
}

/** Forced `submit_reply_class` tool — Zod validates at the SDK boundary; the
 *  handler only sinks the validated args. Double-call guard: first wins. */
function buildSubmitReplyClassTool(sink: {
  captured: ReplyClassCapture | null;
}): InlineSdkTool {
  return sdkTool(
    SUBMIT_REPLY_CLASS_TOOL_NAME,
    "Submit your classification of the operator's reply. Call exactly once. The schema IS your output.",
    submitReplyClassSchema,
    async (args: {
      class: ReplyClass;
      judgment_id?: number;
      rationale: string;
    }) => {
      if (sink.captured) {
        return {
          content: [
            { type: "text" as const, text: "Classification already recorded." },
          ],
        };
      }
      sink.captured = {
        class: args.class,
        judgment_id:
          typeof args.judgment_id === "number" &&
          Number.isInteger(args.judgment_id)
            ? args.judgment_id
            : undefined,
        rationale: args.rationale,
      };
      return {
        content: [{ type: "text" as const, text: "Classification recorded." }],
      };
    },
  ) as unknown as InlineSdkTool;
}

export interface ClassifyResult {
  /** null = the classifier failed (no tool call / error); the caller falls back
   *  to the legacy DISCARD_RE path. NEVER a fabricated pushback. */
  cls: ReplyClass | null;
  /** Set iff cls==='pushback' and a valid in-brief judgment id was chosen. */
  judgmentId: number | null;
  rationale: string;
  error: boolean;
}

function renderClassifyPrompt(
  replyText: string,
  judgments: JudgmentRow[],
): string {
  const list = judgments
    .map(
      (j) =>
        `[id ${j.id}] (${j.posture}) ${j.subject} — ${j.prose.slice(0, 160)}`,
    )
    .join("\n");
  return `Operator's reply to a delivered strategic brief:\n"${replyText}"\n\nJudgments in this brief (pushback MUST name one by id):\n${list || "(none)"}`;
}

/**
 * Classify an operator reply against the brief's judgments. Forced-tool, no
 * free-text fallback — a missing/failed classification returns `cls=null`
 * (the caller applies the legacy regex), NEVER an invented pushback/concession.
 * A `pushback` with a judgment_id not in the brief is repaired (single-judgment
 * brief → that judgment) or downgraded to `promote` (ambiguous → do not guess).
 */
export async function classifyReply(
  replyText: string,
  judgments: JudgmentRow[],
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<ClassifyResult> {
  // An already-aborted caller signal won't re-fire `addEventListener('abort')`,
  // so short-circuit (qa-nit) — never a fabricated classification.
  if (options.signal?.aborted) {
    return { cls: null, judgmentId: null, rationale: "", error: true };
  }
  const sink: { captured: ReplyClassCapture | null } = { captured: null };
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error("classify timeout")),
    CLASSIFY_TIMEOUT_MS,
  );
  const onAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await queryClaudeSdk({
      prompt: renderClassifyPrompt(replyText, judgments),
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT_V1,
      toolNames: [],
      extraTools: [buildSubmitReplyClassTool(sink)],
      maxTurns: 2,
      model: options.model ?? SONNET_MODEL_ID,
      abortSignal: ac.signal,
      costLedger: { agentType: "v82:concession" },
    });
  } catch (e) {
    if (!sink.captured) {
      log.warn(
        { err: errMsg(e) },
        "classifyReply failed — falling back to legacy regex",
      );
      return { cls: null, judgmentId: null, rationale: "", error: true };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (!sink.captured) {
    return { cls: null, judgmentId: null, rationale: "", error: true };
  }

  const cap = sink.captured;
  if (cap.class !== "pushback") {
    return {
      cls: cap.class,
      judgmentId: null,
      rationale: cap.rationale,
      error: false,
    };
  }

  // pushback — resolve the target judgment.
  const ids = new Set(judgments.map((j) => j.id));
  let judgmentId: number | null =
    cap.judgment_id != null && ids.has(cap.judgment_id)
      ? cap.judgment_id
      : null;
  if (judgmentId == null) {
    if (judgments.length === 1) {
      judgmentId = judgments[0].id; // unambiguous repair
    } else {
      // Ambiguous pushback with no valid target — do not guess; treat as
      // engagement (promote), never a concession.
      log.warn(
        { suggested: cap.judgment_id, n: judgments.length },
        "pushback with no resolvable judgment_id — downgrading to promote",
      );
      return {
        cls: "promote",
        judgmentId: null,
        rationale: cap.rationale,
        error: false,
      };
    }
  }
  return {
    cls: "pushback",
    judgmentId,
    rationale: cap.rationale,
    error: false,
  };
}

// ── evidence gate ─────────────────────────────────────────────────────────────

/** Source-ATTRIBUTION markers (bilingual) — an attribution verb ("said"/"dijo"),
 *  preposition ("per the"/"según"/"por correo"/"en el correo"), or an
 *  attachment ("attached"/"adjunt"/"screenshot") that signals the operator is
 *  CITING something, not merely asserting.
 *
 *  Deliberately NOT bare artifact nouns ("the client"/"el contrato"/…) — qa-R2
 *  W-residual: those fire on a disagreement that merely NAMES an artifact
 *  without citing it ("the client is fine, you're wrong"), the same
 *  fold-without-real-evidence class as C1. A real citation co-carries an
 *  attribution verb ("the customer SAID …" → matches `said`) or a quote (→
 *  QUOTED_SPAN_RE), so dropping the bare nouns loses no genuine evidence while
 *  closing the FP. A bare artifact name with no attribution reads as no-evidence
 *  (conservative hold — the operator can re-state "per the contract …"). */
const EVIDENCE_MARKER_RE =
  /\b(seg[uú]n|dijo|dije|dijeron|coment[oó]|por\s+correo|en\s+el\s+correo|adjunt|said|told\s+me|per\s+the|attached|screenshot|captura)\b/i;

/** A double-quoted span ("...", “...”) — the operator relaying what someone
 *  said. The straight apostrophe is deliberately NOT a delimiter: it is almost
 *  always a contraction ("don't", "that's", "I'm"), which would otherwise
 *  false-match a bare pushback as a quoted span. Relayed single-quoted speech
 *  is rare and, when present, the EVIDENCE_MARKER_RE ("said"/"dijo"/…) catches
 *  it instead. */
const QUOTED_SPAN_RE = /["“][^"”]{3,}["”]/;

/**
 * The §13 evidence gate. Does the operator's reply carry EVIDENCE — a number, a
 * date, a quoted span, or an explicit source/artifact marker ("the customer
 * said …", "per the contract") — as opposed to a bare "are you sure?" /
 * "I disagree, the pilot is not at risk"? Exported because the §14 nightly
 * probe (Phase 8) reuses the SAME detector (spec §13/§14).
 *
 * DELIBERATELY NOT cite.ts `hasStateClaim` / `hasProperName` (qa-C1). Those are
 * RECALL-biased for citation — over-flagging there only adds a sentence to the
 * §11 critic's review queue (harmless). Here the asymmetry is INVERTED: a
 * false-positive routes a bare unsupported disagreement into the
 * fold-WITH-evidence path (re-run + `updated_with_evidence` + the operator's
 * bare assertion appended to the ledger as "evidence") — which is exactly the
 * §13 failure the consent layer exists to prevent. And a pushback NATURALLY
 * restates the disputed claim's own state-vocabulary ("I don't think the pilot
 * is at risk") and names its subject ("you're wrong about Acme"), so those two
 * heuristics fire on precisely the no-evidence case. A false-NEGATIVE here is
 * the safe default — it HOLDS the position (and the operator can re-state with
 * a concrete number/date/source). So the gate requires an evidence-specific
 * signal only.
 */
export function replyCarriesEvidence(replyText: string): boolean {
  const s = replyText.trim();
  if (!s) return false;
  return (
    hasNumber(s) ||
    hasDate(s) ||
    QUOTED_SPAN_RE.test(s) ||
    EVIDENCE_MARKER_RE.test(s)
  );
}

// ── concession handling ───────────────────────────────────────────────────────

export interface ReRunJudgmentResult {
  /** Revised judgment prose (carries `[K]` markers in production). */
  prose: string;
  /** Recomputed §12 confidence color, when the producer's re-run provides it. */
  confidence?: "green" | "yellow" | "red";
}

/** Re-run ONE judgment's §9 author + §11 critic + §12 confidence passes with the
 *  operator's message appended to its ledger. Provided by the judgment-assembly
 *  producer (a later phase) / Phase 8; mocked in tests. Its ABSENCE is the
 *  production-dormant state — the update path defers rather than fabricating. */
export type ReRunJudgmentFn = (
  judgment: JudgmentRow,
  operatorEvidence: EvidenceRef,
) => Promise<ReRunJudgmentResult>;

export type ConcessionKindResult =
  | "held_position"
  | "updated_with_evidence"
  | "deferred_no_rerun";

export interface ConcessionResult {
  judgmentId: number;
  kind: ConcessionKindResult;
  /** The operator-facing re-delivery / restatement text. */
  reply: string;
  /** Set only for updated_with_evidence. */
  triggeringEvidenceText?: string;
}

export interface ConcessionDeps {
  reRunJudgment?: ReRunJudgmentFn;
  db?: Database.Database;
  /** Injectable clock (ISO) for deterministic tests. */
  nowIso?: string;
}

const HELD_PREFACE =
  "Holding this position — the evidence still points the same way:";
/** Spec-exact preface (§13): the re-delivery must not pretend prior agreement. */
const UPDATED_PREFACE = "Updating on your input that";
const DEFERRED_ACK =
  "Noted — I'll factor that in when this judgment is next reviewed.";

function cap(s: string, n = EVIDENCE_TEXT_CAP): string {
  // Collapse internal whitespace/newlines so the ledger excerpt + the "updating
  // on your input …" re-delivery stay single-line and tidy (qa-nit).
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Forward-looking judgment = inherently predictive (at_risk posture) or its
 *  prose/subject makes a future claim. Such a judgment self-schedules a
 *  `verify_resolution` recheck after an evidence-driven update (§13 Devin port:
 *  no fire-and-forget judgment without a future audit point). */
const FORWARD_LOOKING_RE =
  /\b(at\s+risk|may\b|might\b|could\b|will\b|likely|risk\s+of|slip|slipping|projected|expected\s+to|on\s+track|forecast|trend(?:ing)?|deteriorat|worsen|further)\b/i;

export function isForwardLooking(j: JudgmentRow): boolean {
  return (
    j.posture === "at_risk" ||
    FORWARD_LOOKING_RE.test(j.prose) ||
    FORWARD_LOOKING_RE.test(j.subject)
  );
}

/**
 * Handle a classified `pushback` on one judgment (the evidence gate). Returns
 * the concession disposition + the operator-facing reply, or null when the
 * judgment can't be loaded. Does NOT promote/discard the briefing — a pushback
 * keeps the operator in dialogue (the brief stays pending).
 *
 * INVARIANTS:
 *  - `conceded_without_evidence` is never written (only §14 measures it).
 *  - the update path writes `concession_kind='updated_with_evidence'` ONLY
 *    AFTER a successful re-run; if `reRunJudgment` is absent (prod-dormant) or
 *    throws, no concession is recorded and nothing is faked.
 */
export async function handlePushback(
  judgmentId: number,
  replyText: string,
  deps: ConcessionDeps = {},
): Promise<ConcessionResult | null> {
  const db = deps.db;
  const judgment = getJudgmentById(judgmentId, db);
  if (!judgment) {
    log.warn({ judgmentId }, "handlePushback: judgment not found");
    return null;
  }

  // ── no evidence → hold the position (do NOT re-run, do NOT soften) ──────────
  if (!replyCarriesEvidence(replyText)) {
    setConcessionKind(judgment.id, "held_position", null, db);
    log.info({ judgmentId: judgment.id }, "concession: held_position");
    return {
      judgmentId: judgment.id,
      kind: "held_position",
      reply: `${HELD_PREFACE} ${judgment.prose}`,
    };
  }

  // ── has evidence ────────────────────────────────────────────────────────────
  // No producer-provided re-run wired yet → defer (the production-dormant
  // state). Record NO concession_kind — we neither hold (there IS evidence) nor
  // update (we can't re-run). Honest neutral acknowledgment.
  if (!deps.reRunJudgment) {
    log.info(
      { judgmentId: judgment.id },
      "concession: evidence present but no reRunJudgment wired — deferring",
    );
    return {
      judgmentId: judgment.id,
      kind: "deferred_no_rerun",
      reply: DEFERRED_ACK,
    };
  }

  const nowIso = deps.nowIso ?? new Date().toISOString();
  const triggeringEvidenceText = cap(replyText);
  const operatorEvidence: EvidenceRef = {
    kind: "operator_message",
    id: `operator:${nowIso}`,
    excerpt: triggeringEvidenceText,
    retrieved_at: nowIso, // never stale (§18 Q5)
  };

  // Append the operator message to the ledger BEFORE the re-run so the re-run
  // sees it. The concession_kind is written only after the re-run succeeds.
  appendEvidenceRef(judgment.id, operatorEvidence, db);
  const revised = await deps.reRunJudgment(judgment, operatorEvidence);

  setConcessionKind(
    judgment.id,
    "updated_with_evidence",
    triggeringEvidenceText,
    db,
  );

  // Forward-looking judgment self-schedules a resolution recheck (§13).
  if (isForwardLooking(judgment)) {
    const fireAfter = new Date(
      Date.parse(nowIso) + FOLLOWUP_HORIZON_MS,
    ).toISOString();
    insertReflectionFollowup(
      {
        fireAfter,
        checkpointKind: "verify_resolution" satisfies CheckpointKind,
        contextRef: `judgment:${judgment.id}`,
        createdAt: nowIso,
      },
      db,
    );
  }

  log.info(
    { judgmentId: judgment.id },
    "concession: updated_with_evidence (re-ran §9+§11+§12)",
  );
  return {
    judgmentId: judgment.id,
    kind: "updated_with_evidence",
    reply: `${UPDATED_PREFACE} "${triggeringEvidenceText}": ${revised.prose}`,
    triggeringEvidenceText,
  };
}
