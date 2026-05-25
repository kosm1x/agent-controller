/**
 * Judgment prompt — V8.1 Phase 6 (spec §10, "the Conway shift").
 *
 * Renders the reflection prompt that teaches the agent to CONSTRUCT
 * judgments, not summarize state. `renderJudgmentPrompt` takes the
 * pre-assembled inputs (the orchestrator `constructBriefing` does the data
 * assembly) and produces the prompt string.
 *
 * RECONCILIATION vs §10/§12: the prompt ships as a code-module template, not
 * a formally-registered S5 skill — a versionable/testable/auditable code
 * module delivers §11's "version it, test it, audit it" goal; formal
 * `skill__construct_morning_brief` certification is a follow-up. The
 * "discarded-briefings history" discipline rule references promote/discard
 * state that lands in Phase 8 — `recentlyDiscarded` is wired through now and
 * renders as "none" until then.
 */

import type { CohortMember } from "../cohort/self-defining.js";
import type { DetectionSignal } from "../detection/signals.js";
import type { Briefing } from "./schema.js";

export interface ObjectiveContext {
  id: string;
  title: string;
  description: string;
}

export interface GeneralEventContext {
  eventId: string;
  title: string;
  summary: string;
}

export interface EpisodicSample {
  eventId: string;
  /** A short representative chunk from the episodic source. */
  text: string;
}

export interface JudgmentPromptInput {
  surface: Briefing["surface"];
  activeObjectives: ObjectiveContext[];
  /** Conway Pattern 2 self-defining cohort — the grounding context. */
  cohort: CohortMember[];
  /** Top general events from the bounded-diff window (caller caps to ~8). */
  generalEvents: GeneralEventContext[];
  /** Episodic samples (caller caps to ~3 per event, ~24 total). */
  episodicSamples: EpisodicSample[];
  /** Phase 5 detector output. */
  detectionSignals: DetectionSignal[];
  /** Subjects of briefings the operator discarded in the last 7d (Phase 8 wires real data). */
  recentlyDiscarded: string[];
  /**
   * Ordered labels of the data sources backing this brief. A judgment's
   * `evidence_indices` are 0-based indices into THIS list; the orchestrator
   * builds `verified_against` parallel to it so the schema invariant holds.
   * Source-level (not item-level) citation — see `construct.ts` reconciliation.
   */
  evidenceSources: string[];
}

const COHORT_KIND_LABEL: Record<CohortMember["member_kind"], string> = {
  project: "proyecto",
  objective: "objetivo",
  thread: "hilo",
};

/** Render a bulleted list, or "(none)" when empty. */
function list(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

/** Filter the detection signals to one kind and render them as lines.
 * Recurring-blocker signals get a richer rendering that includes the temporal
 * spread (first_seen, last_seen, span_days) so the LLM judge doesn't call an
 * 8-day cluster "consecutive days" — see the 2026-05-25 morning-briefing
 * post-mortem where 6 tasks across May 14/19/22/23 were rendered as
 * "23-24 mayo consecutivos" by the LLM. */
function signalsOf(
  signals: DetectionSignal[],
  kind: DetectionSignal["kind"],
): string {
  const filtered = signals.filter((s) => s.kind === kind);
  if (kind === "recurring_blocker") {
    return list(
      filtered.map((s) => {
        const b = s as Extract<DetectionSignal, { kind: "recurring_blocker" }>;
        const span = spanDays(b.firstSeenAt, b.lastSeenAt);
        const spanLabel =
          span <= 0
            ? "same day"
            : span === 1
              ? "spanning 2 days"
              : `spanning ${span + 1} days`;
        return `  - ${b.summary} [first_seen=${b.firstSeenAt}, last_seen=${b.lastSeenAt}, ${spanLabel}]`;
      }),
    );
  }
  return list(filtered.map((s) => `  - ${s.summary}`));
}

/** Whole days between two timestamp strings. Accepts both SQLite
 * `datetime('now')` ("YYYY-MM-DD HH:MM:SS", naive UTC) and ISO 8601 with "Z".
 * Returns 0 on parse failure (under-reports rather than mis-parses). */
function spanDays(firstSeen: string, lastSeen: string): number {
  const a = parseTs(firstSeen);
  const b = parseTs(lastSeen);
  if (a === null || b === null) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}
function parseTs(ts: string): number | null {
  const normalized = /Z$/i.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Render the §10 judgment prompt. The model returns ONLY the `judgments`
 * array — it does NOT emit `signal_id` (it cannot generate reliable UUIDs)
 * or `highest_leverage_pick`. The orchestrator assigns a UUID per judgment,
 * derives the pick from the `highest_leverage` judgment, and fills the
 * briefing wrapper (ids, source_window, the S2
 * `verified_against`/`sample_n`/`concerns`/`critic_verdict` fields).
 */
export function renderJudgmentPrompt(input: JudgmentPromptInput): string {
  const objectives = list(
    input.activeObjectives.map(
      (o) => `  - ${o.title} (${o.id}): ${o.description}`,
    ),
  );
  const cohort = list(
    input.cohort.map(
      (m) => `  - [${COHORT_KIND_LABEL[m.member_kind]}] ${m.label}`,
    ),
  );
  const events = list(
    input.generalEvents.map((e) => `  - ${e.title}: ${e.summary}`),
  );
  const episodic = list(
    input.episodicSamples.map((s) => `  - [${s.eventId}] ${s.text}`),
  );
  const discarded = list(input.recentlyDiscarded.map((d) => `  - ${d}`));
  const sources = list(input.evidenceSources.map((s, i) => `  [${i}] ${s}`));

  return `You are constructing a ${input.surface.toUpperCase()} briefing for Fede. This is a forward-looking judgment, not a summary.

EVIDENCE SOURCES (cite these by 0-based index in each judgment's evidence_indices):
${sources}

INPUTS YOU'VE BEEN GIVEN:
- Active goal context:
${objectives}
- Self-defining memory cohort (Conway Pattern 2 — what Fede actually has live):
${cohort}
- General events from the bounded-diff window:
${events}
- Episodic samples:
${episodic}
- Detection outputs:
  Stalled tasks:
${signalsOf(input.detectionSignals, "stalled_task")}
  Dormant objectives:
${signalsOf(input.detectionSignals, "dormant_objective")}
  Implicit deadlines:
${signalsOf(input.detectionSignals, "implicit_deadline")}
  Recurring blockers:
${signalsOf(input.detectionSignals, "recurring_blocker")}
- Signals the operator already discarded in the last 7 days:
${discarded}

YOUR JOB:
Construct judgments using ONE of four postures per signal:
- AT_RISK: this needs attention — declining momentum or a hard deadline approaching.
- HAS_MOMENTUM: this is moving — protect and amplify, do not disrupt.
- HIGHEST_LEVERAGE: the single most-impactful action available today.
- NOTED: surfaced for awareness, no action needed.

DISCIPLINE:
1. Every judgment MUST cite specific evidence from the input — no generic claims.
2. The self-defining cohort grounds your reasoning — use it for "Fede has historically prioritized X".
3. Pick exactly ONE highest_leverage judgment per briefing, or zero if nothing rises.
4. Maximum 15 judgments. Below 5 is fine — terseness beats padding.
5. Recall mode is COHERENCE — surface what serves goals, not "everything that happened".
6. If a signal appears in the discarded list above, do NOT re-surface it unless materially different.

DO NOT:
- Write prose paragraphs recounting what happened — that is correspondence mode, not your job.
- Recommend actions outside Fede's stated objectives.
- Speak as if you were Jarvis addressing Fede — you are a reflector writing judgments for Jarvis to use.

OUTPUT:
Return ONLY a JSON object, no prose, no code fences:
{
  "judgments": [
    {
      "kind": "stalled_task|dormant_objective|implicit_deadline|recurring_blocker|momentum|self_defining_progress",
      "subject": "<task_id, objective path, blocker signature, etc.>",
      "posture": "at_risk|has_momentum|highest_leverage|noted",
      "confidence": "green|yellow|red",
      "confidence_reason": "<>=10 chars>",
      "why": "<>=20 chars, one paragraph, references evidence>",
      "evidence_indices": [<0-based indices into the EVIDENCE SOURCES list above>]
    }
  ]
}
At least 1 and at most 15 judgments. Do NOT emit id or signal_id fields — the system assigns judgment identity. Give exactly one judgment the posture "highest_leverage" (or none); the system derives the pick from it.`;
}
