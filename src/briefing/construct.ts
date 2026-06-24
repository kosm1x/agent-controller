/**
 * constructBriefing — V8.1 Phase 6 orchestrator (spec §9/§10/§11).
 *
 * Composes the substrate built in Phases A/4/5:
 *   scope (Phase 4) + cohort (Phase A) + general-events retrieval (Spine 4)
 *   + detection signals (Phase 5)
 *     → render the §10 judgment prompt
 *     → infer() the judgments
 *     → wrap as a Briefing
 *     → submitReport() through the S2 critic
 *     → persist to proposed_briefings.
 *
 * NOT triggered yet — Phase 7 wires the N-turn / cron / idle triggers. Until
 * then `constructBriefing` has zero production cost.
 *
 * RECONCILIATIONS (designed to ground truth):
 *   - Evidence is SOURCE-level, not item-level: `verified_against` is one
 *     citation per data source (tasks / objectives / general_events /
 *     cohort), and the judgment `evidence_indices` cite which sources back
 *     each judgment. Item-level (per-signal) citations are a refinement.
 *   - The judgment runs through `infer()` directly — a pure structured-JSON
 *     transform needs no tool-runner. Phase 4's `runReflection` stays the
 *     tool-using reflection harness; the two reflection paths do not nest.
 */

import { createHash, randomUUID } from "node:crypto";
import { getDatabase } from "../db/index.js";
import { toIsoUtc } from "../lib/timezone.js";
import { getCohort } from "../cohort/self-defining.js";
import { buildReflectionScope } from "../reflection/scope.js";
import type { ReflectionCursorName } from "../reflection/cursors.js";
import type { ReflectionTrigger } from "../reflection/scope.js";
import { runDetection } from "../detection/index.js";
import { retrieveForBriefing } from "../events/retrieval.js";
import { infer } from "../inference/adapter.js";
import { SONNET_MODEL_ID } from "../inference/claude-sdk.js";
import { recordReflectionCost } from "../budget/service.js";
import { submitReport } from "../audit/submit-report.js";
import type { DataSourceCitation } from "../audit/report-schema.js";
import { renderJudgmentPrompt } from "./judgment-prompt.js";
import {
  BriefingSchema,
  validateBriefingInvariants,
  type Briefing,
} from "./schema.js";
import {
  getRecentlyDiscardedSubjects,
  insertProposedBriefing,
} from "./storage.js";

const MS_PER_DAY = 86_400_000;
const SYSTEM_PROMPT =
  "You are a background reflection process. You return ONLY valid JSON " +
  "conforming to the requested shape — no prose, no code fences.";

export interface ConstructBriefingOptions {
  surface?: Briefing["surface"];
  cursorName?: ReflectionCursorName;
  trigger?: ReflectionTrigger;
}

export type ConstructBriefingResult =
  | { ok: true; briefing: Briefing }
  | {
      ok: false;
      stage:
        | "assembly"
        | "inference"
        | "parse"
        | "schema"
        | "invariants"
        | "s2";
      detail: string;
    };

/** sha256 hex of a label — a stable, schema-valid `query_sha`. */
function querySha(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** Strip ``` fences and extract the first balanced JSON object from LLM text. */
function parseJudgmentJson(raw: string | null): unknown {
  if (!raw) throw new Error("empty inference response");
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Assemble the briefing inputs: the bounded-diff scope (Phase 4) plus the
 * data the §10 prompt needs (objectives, cohort, detection signals, retrieved
 * general events) and the parallel evidence-source citations.
 *
 * `retrieveForBriefing` is async and the DB reads can throw — `constructBriefing`
 * wraps this whole call so a failure is a typed `stage: "assembly"` result,
 * never an unhandled rejection (the audit C1 defect class).
 */
async function assembleBriefingInputs(
  cursorName: ReflectionCursorName,
  trigger: ReflectionTrigger,
  startedAt: Date,
) {
  const db = getDatabase();
  const scope = buildReflectionScope(cursorName, trigger);
  const wallEnd = startedAt.toISOString();
  // asOfTimestamp comes from reflection_cursors.updated_at — a SQLite
  // `datetime('now')` string (`YYYY-MM-DD HH:MM:SS`), which the schema's
  // `z.iso.datetime()` rejects. Normalize to strict ISO; fall back to a day
  // ago when the cursor is absent or its timestamp is unparseable.
  const wallStart =
    toIsoUtc(scope.priorStateSnapshot.asOfTimestamp) ??
    new Date(startedAt.getTime() - MS_PER_DAY).toISOString();

  // Active-project list — the execution surface. Replaces the retired NorthStar
  // objectives read (operator ruling 2026-06-23: NorthStar is a stale compass,
  // not work-truth). Shape kept as {id,title,description} so the downstream
  // judgment prompt + retrieval filter are unchanged.
  const objectives = (
    db
      .prepare(
        `SELECT slug, name, COALESCE(description, '') AS description
           FROM projects WHERE status = 'active'`,
      )
      .all() as { slug: string; name: string; description: string }[]
  ).map((p) => ({
    id: p.slug,
    title: p.name,
    description: p.description.slice(0, 300),
  }));

  const cohort = getCohort();
  const signals = runDetection();
  const retrieval = await retrieveForBriefing({
    active_objective_ids: objectives.map((o) => o.id),
    window: { start: wallStart, end: wallEnd },
  });
  const generalEvents = retrieval.generalEvents.map((e) => ({
    eventId: e.event_id,
    title: e.title,
    summary: e.summary,
  }));
  const episodicSamples = retrieval.episodicSamples.map((s) => ({
    eventId: s.event_id,
    text: s.episodic.snippet ?? s.episodic.title ?? "(no content)",
  }));

  // Evidence sources: one citation per data source, indices aligned with the
  // numbered EVIDENCE SOURCES list the prompt shows the LLM.
  const queriedAt = wallEnd;
  const verifiedAgainst: DataSourceCitation[] = [
    {
      type: "sqlite",
      table: "jarvis_files",
      query_sha: querySha("detection:day-logs"),
      row_count: signals.length,
      queried_at: queriedAt,
    },
    {
      type: "sqlite",
      table: "projects",
      query_sha: querySha("active-projects"),
      row_count: objectives.length,
      queried_at: queriedAt,
    },
    {
      type: "sqlite",
      table: "general_events",
      query_sha: querySha("retrieveForBriefing"),
      row_count: generalEvents.length,
      queried_at: queriedAt,
    },
    {
      type: "sqlite",
      table: "self_defining_cohort",
      query_sha: querySha("cohort"),
      row_count: cohort.length,
      queried_at: queriedAt,
    },
  ];
  const evidenceSources = [
    "day-log — stalled-project detection",
    "active projects",
    "general_events — bounded-diff retrieval",
    "self-defining cohort",
  ];

  return {
    scope,
    wallStart,
    wallEnd,
    objectives,
    cohort,
    signals,
    generalEvents,
    episodicSamples,
    verifiedAgainst,
    evidenceSources,
  };
}

/**
 * Construct one briefing end-to-end. Returns the persisted Briefing, or a
 * typed failure naming the stage that failed (assembly, inference, the LLM
 * produced bad JSON, the schema rejected it, an invariant broke, or S2).
 */
export async function constructBriefing(
  options: ConstructBriefingOptions = {},
): Promise<ConstructBriefingResult> {
  const surface = options.surface ?? "morning";
  const cursorName = options.cursorName ?? "morning_brief";
  const trigger = options.trigger ?? "cron-morning";
  const startedAt = new Date();

  // --- 1+2. Bounded-diff scope + input assembly ----------------------------
  let inputs: Awaited<ReturnType<typeof assembleBriefingInputs>>;
  try {
    inputs = await assembleBriefingInputs(cursorName, trigger, startedAt);
  } catch (err) {
    return {
      ok: false,
      stage: "assembly",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const {
    scope,
    wallStart,
    wallEnd,
    objectives,
    cohort,
    signals,
    generalEvents,
    episodicSamples,
    verifiedAgainst,
    evidenceSources,
  } = inputs;

  // --- 3. Render + infer the judgments -------------------------------------
  const prompt = renderJudgmentPrompt({
    surface,
    activeObjectives: objectives,
    cohort,
    generalEvents,
    episodicSamples,
    detectionSignals: signals,
    // Phase 8: subjects the operator discarded in the last 7d, so the
    // reflector does not re-surface a rejected signal (spec §10 rule 6).
    recentlyDiscarded: getRecentlyDiscardedSubjects(),
    evidenceSources,
  });

  let response;
  try {
    response = await infer({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
      effort: "high",
    });
  } catch (err) {
    // The adapter fails over across providers but ultimately throws — map it
    // to a typed failure so a Phase-7 cron trigger gets a result, not a
    // rejection (audit C1).
    return {
      ok: false,
      stage: "inference",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // §13 instrumentation: tag this briefing's inference cost as
  // `reflection:<surface>` so the activation gate (cache-read ratio) is
  // measurable. Best-effort — never blocks briefing construction.
  recordReflectionCost({
    surface,
    taskId: `briefing:${surface}`,
    model: SONNET_MODEL_ID,
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    costUsd: response.usage.cost_usd,
    cacheReadTokens: response.usage.cache_read_tokens,
    cacheCreationTokens: response.usage.cache_creation_tokens,
  });

  let judgmentPayload: { judgments?: unknown };
  try {
    judgmentPayload = parseJudgmentJson(
      response.content,
    ) as typeof judgmentPayload;
  } catch (err) {
    return {
      ok: false,
      stage: "parse",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // The LLM no longer emits `signal_id` / `highest_leverage_pick`: it cannot
  // reliably generate UUIDs, and a DetectionSignal carries no id to cite, so
  // an LLM-invented signal_id failed `z.uuid()` for every judgment (the
  // 2026-05-22 morning-briefing failure). The orchestrator owns identity
  // instead — assign a UUID per judgment, then derive the pick from the (at
  // most one — invariant 3) highest_leverage judgment. A non-array payload
  // collapses to [] and fails the schema's `.min(1)` next, as before.
  const rawJudgments = Array.isArray(judgmentPayload.judgments)
    ? (judgmentPayload.judgments as Record<string, unknown>[])
    : [];
  const judgments = rawJudgments.map(
    (j): Record<string, unknown> => ({ ...j, signal_id: randomUUID() }),
  );
  const highestLeveragePick = judgments.find(
    (j) => j.posture === "highest_leverage",
  )?.signal_id as string | undefined;

  // --- 4. Validate the briefing BEFORE the S2 pass -------------------------
  // Order matters (audit C2/C3): schema + invariants run first, so a
  // malformed judgment or an out-of-range evidence_index surfaces as
  // 'schema'/'invariants' — not masked as an 's2' failure — and the S2 draft
  // below is built from validated judgments. critic_verdict/concerns are
  // placeholders here; the real values come from the S2 report.
  // The `Math.max(1, …)` floor is load-bearing: BriefingSchema.sample_n is
  // `nonnegative` but the S2 ReportDraftSchema.sample_n is `positive`, so a
  // zero would pass schema then fail S2 with a misleading stage label.
  const sampleN = Math.max(1, signals.length + generalEvents.length);
  const reportId = randomUUID();
  const candidate = {
    briefing_id: randomUUID(),
    surface,
    generated_at: wallEnd,
    source_window: {
      cursor_start_event_id: scope.priorStateSnapshot.asOfEventId,
      cursor_end_event_id: scope.lastProcessedEventId,
      wall_start: wallStart,
      wall_end: wallEnd,
    },
    active_objective_ids: objectives.map((o) => o.id),
    self_defining_grounding: cohort.map((m) => m.member_id),
    general_events_used: generalEvents.map((e) => e.eventId),
    judgments,
    highest_leverage_pick: highestLeveragePick,
    verified_against: verifiedAgainst,
    sample_n: sampleN,
    concerns: [],
    critic_verdict: "skipped_allowlist",
  };

  const parsed = BriefingSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      stage: "schema",
      detail: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  const invariantIssues = validateBriefingInvariants(parsed.data);
  if (invariantIssues.length > 0) {
    return {
      ok: false,
      stage: "invariants",
      detail: invariantIssues.join("; "),
    };
  }

  // --- 5. S2 critic pass (spec §11) — claims built from VALIDATED judgments -
  // Producer-side concerns flag thin evidence up front (audit W4) — the
  // critic sees them and may add its own.
  const producerConcerns: { type: string; detail: string }[] = [];
  if (generalEvents.length === 0) {
    producerConcerns.push({
      type: "stale_data",
      detail: "no general events in the bounded-diff window",
    });
  }
  if (signals.length === 0) {
    producerConcerns.push({
      type: "small_sample",
      detail: "no detection signals in this window",
    });
  }
  if (objectives.length === 0) {
    producerConcerns.push({
      type: "incomplete_coverage",
      detail: "no active projects loaded",
    });
  }
  const s2Result = await submitReport({
    report_id: reportId,
    started_at: startedAt.toISOString(),
    surface: "morning_brief",
    verified_against: verifiedAgainst,
    sample_n: sampleN,
    window: { start: wallStart, end: wallEnd },
    claims: parsed.data.judgments.map((j) => ({
      statement: j.why,
      evidence_index: j.evidence_indices,
    })),
    concerns: producerConcerns,
  });
  if (!s2Result.ok) {
    return {
      ok: false,
      stage: "s2",
      detail: `${s2Result.kind}: ${s2Result.issues.join("; ")}`,
    };
  }

  // --- 6. Attach the S2 verdict + persist ----------------------------------
  const briefing: Briefing = {
    ...parsed.data,
    critic_verdict: s2Result.report.critic_verdict,
    concerns: s2Result.report.concerns,
  };
  insertProposedBriefing(briefing, { s2ReportId: reportId });
  return { ok: true, briefing };
}
