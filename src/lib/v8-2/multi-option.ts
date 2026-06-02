/**
 * V8.2 Phase 3 — multi-option pass (RAPID-D) (spec §8).
 *
 * The hardest design choice in V8.2: a single-LLM "give me 3 alternatives"
 * collapses to safe, predictable, near-identical options. RAPID-D fixes this
 * with ROLE-ASSIGNED diversity — four prompted roles, three of them adversarial
 * to each other, then a synthesizer that must reconcile them into A/B/C:
 *
 *   1. Analyst          — the most-likely interpretation / default option.
 *   2. Seeker           — re-weights the SAME evidence into a different reading.
 *   3. Devil's Advocate — what would FALSIFY the default; the negative-result case.
 *   4. Synthesizer      — sees 1-3, proposes A/B/C with tradeoffs, ranks them.
 *
 * Roles 1-3 run in PARALLEL (free-text); the Synthesizer runs after, in a
 * forced-tool call (`submit_options`) whose Zod schema IS the option array
 * ([[forced-structured-output-via-mcp-tool]], same sink pattern as
 * `src/audit/critic.ts` and `decompose.ts`). Four LLM calls per pass.
 *
 * DIVERSITY GATE (advisory in R2): after the Synthesizer, pairwise cosine of the
 * option `summary` embeddings via the live 1536-d Gemini embedder (no new dep).
 * If `max(similarity) > θ`, retry the Synthesizer (budget 2) nudged toward
 * orthogonal axes; then GRACEFULLY DEGRADE to `options=[]` — never fabricate
 * A/B/C (spec §8 "Do not fake A/B/C"; the `StrategicJudgment` refine pins
 * `proposed_options.length ∈ {0,3}`). The gate is ADVISORY: cosine on 1-2
 * sentence summaries is a weak proxy for *strategic* diversity (textual
 * near-opposites like "ship now" / "don't ship now" score high-similarity), so
 * θ is a conservative default favoring false-negatives, env-overridable, and a
 * high retry-rate is a §17 watchpoint (>30% ⇒ review), not a silent failure. If
 * embeddings are unavailable the gate degrades to logging-only and the options
 * are accepted as-is (the Synthesizer's own distinctness rubric carries them).
 *
 * §15 / §18-Q8 DECISION (made here, as the spec delegates it): the four roles
 * are VERSIONED PROMPT MODULES, **not** S5 skills. The S5 critic-gate + version
 * ceremony is heavier than the value for four internal, never-operator-invoked
 * prompt strings. They live as versioned in-code constants (`RAPID_D_*_V1` /
 * `RAPID_D_PROMPT_VERSION`) following the Phase 2 `DECOMPOSE_SYSTEM_PROMPT`
 * precedent — which keeps them under typecheck + pinned tests and avoids a
 * runtime file-load path. `prompt_modules/` stays reserved for Phase 5's
 * strategic-voice principle, which is a genuine shared cache-prefix block.
 *
 * POSTURE: additive + dormant. No schema change (`ProposedOption` already lives
 * in `types.ts` from Phase 1; no new table). The first real producer is a later
 * phase's judgment-assembly pass; Phase 3 ships the module + skip predicate +
 * tests only. The running service is untouched until a producer calls in.
 */

import { z } from "zod";
import {
  queryClaudeSdk,
  SONNET_MODEL_ID,
  type InlineSdkTool,
} from "../../inference/claude-sdk.js";
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { cosineSimilarity, embed } from "../../memory/embeddings.js";
import { createLogger } from "../logger.js";
import {
  OPTION_LABELS,
  OptionLabelSchema,
  ProposedOptionSchema,
  type EvidenceRef,
  type ProposedOption,
  type RapidDRole,
} from "./types.js";

const log = createLogger("v8-2:multi-option");

// ── versioned prompt modules (§15 decision: in-code, NOT S5 skills) ───────────

/** Bump when any RAPID-D role prompt below changes; stamped onto the trail. */
export const RAPID_D_PROMPT_VERSION = "v1";

/** The three free-text perspective roles (the Synthesizer is forced-tool). */
export const PERSPECTIVE_ROLES = [
  "analyst",
  "seeker",
  "devils_advocate",
] as const;
export type PerspectiveRole = (typeof PERSPECTIVE_ROLES)[number];

const PERSPECTIVE_PROMPTS_V1: Record<PerspectiveRole, string> = {
  analyst: `You are the ANALYST in a multi-perspective strategic deliberation.
Produce the MOST LIKELY interpretation of the situation and the default course
of action it implies — the obvious, defensible read. Ground every claim in the
evidence provided; do not speculate beyond it. Write 2-4 sentences. Do NOT list
options or hedge across possibilities — give your single best read.`,

  seeker: `You are the SEEKER in a multi-perspective strategic deliberation.
Re-weight the SAME evidence to surface a DIFFERENT defensible interpretation
than the obvious one — the reading a careful analyst might overlook because it
requires weighting a less-salient signal more heavily. You are a forced
contrarian WITHIN the evidence frame: not contrarian for its own sake, and never
inventing evidence. Write 2-4 sentences naming the alternative reading and what
evidence carries it.`,

  devils_advocate: `You are the DEVIL'S ADVOCATE in a multi-perspective strategic
deliberation. Challenge the default framing: what would FALSIFY the most-likely
interpretation? Make the strongest case that the situation is the OPPOSITE of how
it appears, or that acting on it is the mistake — the negative-result
possibility. Stay grounded in the evidence; argue from it, not around it. Write
2-4 sentences.`,
};

export const SUBMIT_OPTIONS_TOOL_NAME = "submit_options";

const SYNTHESIZER_SYSTEM_PROMPT_V1 = `You are the SYNTHESIZER in a multi-perspective strategic deliberation. You receive three perspectives on ONE strategic situation — the Analyst (most-likely read), the Seeker (alternative read), and the Devil's Advocate (the falsifying / negative-result case) — plus the underlying evidence.

Propose exactly THREE courses of action, labelled A, B, and C, and RANK them 1 (best) through 3. For each option give a one-sentence \`summary\` and a list of explicit \`tradeoffs\` (what you give up by choosing it).

The three options MUST be genuinely DISTINCT strategic choices — not the same action at three intensities, and not three phrasings of one idea. Draw on the tension between the perspectives: a good A/B/C usually maps onto different strategic axes (e.g. act-now vs wait-for-signal vs hedge; build vs buy vs defer; broad vs narrow scope).

You have ONE tool: \`${SUBMIT_OPTIONS_TOOL_NAME}\`. Call it exactly once with all three options. Emit no other text.`;

/** Appended to the Synthesizer prompt on a diversity-gate retry. */
export const RAPID_D_DIVERSITY_RETRY_INSTRUCTION = `

Your previous three options were too similar to one another. Re-propose three options that differ on ORTHOGONAL dimensions — vary the timing, the scope, or who acts, rather than restating one idea three ways. Do not echo the prior options.`;

// ── tunables ──────────────────────────────────────────────────────────────────

/**
 * Diversity threshold against 1536-d Gemini cosine. CONSERVATIVE by design: it
 * fires only on near-duplicate summaries, because textual near-opposites inflate
 * cosine (§8) and a false-positive wastes a retry / forces a needless degrade.
 * R1's 0.82 (a 256-d figure) and 0.18 do NOT transfer to 1536-d and are
 * discarded (§8). The real value is calibrated empirically in the 7-day shadow
 * run via the §17 retry-rate watchpoint (>30% ⇒ the gate is noisy → review /
 * demote to logging-only). Override per deployment with
 * `MC_RAPID_D_DIVERSITY_THETA`.
 */
export const DEFAULT_DIVERSITY_THETA = 0.93;

/** Synthesizer retries the diversity gate is allowed before degrading (§8). */
export const DIVERSITY_RETRY_BUDGET = 2;

/** Need at least this many perspectives to synthesize; else degrade. */
export const MIN_PERSPECTIVES = 2;

/** Hard cap per LLM call. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How many evidence rows to surface to the roles as context. */
const EVIDENCE_DIGEST_CAP = 20;

/** Resolve the diversity θ from env, validating the (0,1] range. */
export function resolveDiversityTheta(): number {
  const raw = process.env.MC_RAPID_D_DIVERSITY_THETA;
  if (raw === undefined || raw === "") return DEFAULT_DIVERSITY_THETA;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    log.warn(
      { raw },
      "invalid MC_RAPID_D_DIVERSITY_THETA (want a number in (0,1]) — using default",
    );
    return DEFAULT_DIVERSITY_THETA;
  }
  return n;
}

// ── result shape ──────────────────────────────────────────────────────────────

export type DegradedReason =
  | "no_diversity" // options were valid but never distinct enough
  | "no_perspectives" // fewer than MIN_PERSPECTIVES roles produced text
  | "synthesizer_failed"; // the Synthesizer never produced a valid A/B/C

export interface RapidDResult {
  /** Length 3 (A/B/C) or 0 (graceful degrade) — never 1 or 2 (§8 invariant). */
  options: ProposedOption[];
  /** True ⇒ `options` is empty and `degradedReason` explains why. */
  degraded: boolean;
  degradedReason: DegradedReason | null;
  /**
   * Max pairwise cosine of the accepted/last options' summaries; null when the
   * gate was inert (embeddings unavailable, or degraded before a gate ran).
   */
  maxSimilarity: number | null;
  /** Synthesizer invocations consumed (0 if degraded before synthesis). */
  attempts: number;
  /** The free-text perspectives, kept for the decision trail. */
  perspectives: { role: PerspectiveRole; text: string }[];
  promptVersion: string;
}

export interface RapidDInput {
  /** The strategic question (typically `Decomposition.question`). */
  question: string;
  /** A pre-rendered BriefingContext digest (NOT full rows; §7). */
  contextSummary: string;
  /** The evidence ledger from Phase 2 `gatherEvidence`. */
  evidence: EvidenceRef[];
}

export interface RunMultiOptionOptions {
  /** Override the diversity θ (default: env / `DEFAULT_DIVERSITY_THETA`). */
  theta?: number;
  /** Synthesizer retry budget (default `DIVERSITY_RETRY_BUDGET`). */
  retryBudget?: number;
  /** Per-call timeout (default 30s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
  /** Embedder injection — defaults to the live Gemini `embed`. Tests inject. */
  embedFn?: (text: string) => Promise<Float32Array | null>;
}

/** Raised when a single Synthesizer call fails to yield a valid A/B/C. */
export class SynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthesisError";
  }
}

// ── forced-tool synthesizer ───────────────────────────────────────────────────

/**
 * The Synthesizer's output schema. The model supplies label/summary/tradeoffs/
 * rank; `generated_by_role` is stamped deterministically by us (poka-yoke — the
 * model can't drift the role) exactly as `decompose.ts` stamps question/clock.
 * Distinctness (exactly A/B/C, ranks a 1/2/3 permutation) is enforced AFTER
 * capture in `validateOptions` so we control retry-vs-degrade, not the SDK.
 */
const rawOptionSchema = z.object({
  label: OptionLabelSchema,
  summary: z.string().min(1).describe("One sentence describing the option."),
  tradeoffs: z
    .array(z.string())
    .describe("What you give up by choosing this option."),
  rank: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .describe("1 = best."),
});
type RawOption = z.infer<typeof rawOptionSchema>;

const submitOptionsSchema = {
  options: z
    .array(rawOptionSchema)
    .min(1)
    .max(3)
    .describe("Exactly three options labelled A, B, C, ranked 1 through 3."),
};

function buildSubmitOptionsTool(sink: {
  captured: { options: RawOption[] } | null;
}): InlineSdkTool {
  // Same schema-generic erasure at the createSdkMcpServer boundary as
  // decompose.ts / critic.ts: the SDK runs the Zod parser before the handler,
  // so the runtime shape matches the declaration.
  return sdkTool(
    SUBMIT_OPTIONS_TOOL_NAME,
    "Submit your three ranked options. Call exactly once. The schema IS your output.",
    submitOptionsSchema,
    async (args) => {
      if (sink.captured) {
        throw new Error(
          `${SUBMIT_OPTIONS_TOOL_NAME} called more than once in a single synthesis`,
        );
      }
      sink.captured = { options: args.options };
      return {
        content: [{ type: "text" as const, text: "Options recorded." }],
      };
    },
  ) as unknown as InlineSdkTool;
}

/**
 * Validate a raw option array into ProposedOptions, stamping `generated_by_role`.
 * Throws `SynthesisError` on any structural violation (wrong count, non-A/B/C
 * labels, non-permutation ranks) so the caller can spend a retry or degrade.
 */
export function validateOptions(raw: RawOption[]): ProposedOption[] {
  if (raw.length !== 3) {
    throw new SynthesisError(`expected exactly 3 options, got ${raw.length}`);
  }
  const labels = raw.map((o) => o.label);
  if (
    new Set(labels).size !== 3 ||
    !OPTION_LABELS.every((l) => labels.includes(l))
  ) {
    throw new SynthesisError(
      `options must be exactly A, B, C — got [${labels.join(", ")}]`,
    );
  }
  const ranks = raw.map((o) => o.rank);
  if (new Set(ranks).size !== 3) {
    throw new SynthesisError(
      `ranks must be a permutation of 1, 2, 3 — got [${ranks.join(", ")}]`,
    );
  }
  try {
    return raw.map((o) =>
      ProposedOptionSchema.parse({
        label: o.label,
        summary: o.summary,
        tradeoffs: o.tradeoffs,
        rank: o.rank,
        generated_by_role: "synthesizer" satisfies RapidDRole,
      }),
    );
  } catch (e) {
    throw new SynthesisError(
      `option failed ProposedOption validation: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── diversity gate (pure, embedder-injectable) ────────────────────────────────

/**
 * Max pairwise cosine similarity of the given summaries' embeddings. Returns
 * `null` (gate inert) when there is nothing to compare (<2 summaries) or ANY
 * embedding is unavailable — the gate is advisory, so a missing embedding
 * degrades it to logging-only rather than blocking the options.
 */
export async function computeMaxPairwiseSimilarity(
  summaries: string[],
  embedFn: (text: string) => Promise<Float32Array | null>,
): Promise<number | null> {
  if (summaries.length < 2) return null;
  const vecs = await Promise.all(summaries.map((s) => embedFn(s)));
  if (vecs.some((v) => v === null)) return null;
  let max = -1;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      max = Math.max(max, cosineSimilarity(vecs[i]!, vecs[j]!));
    }
  }
  return max;
}

/** The options are diverse enough when the max pairwise cosine is ≤ θ. */
export function isDiverseEnough(maxSimilarity: number, theta: number): boolean {
  return maxSimilarity <= theta;
}

// ── prompt assembly ───────────────────────────────────────────────────────────

/** Numbered evidence digest shown to every role (capped; unnumbered citations
 *  are Phase 4's concern — here it is context only). */
export function renderEvidenceDigest(evidence: EvidenceRef[]): string {
  if (evidence.length === 0) return "(no structured evidence retrieved)";
  return evidence
    .slice(0, EVIDENCE_DIGEST_CAP)
    .map((e, i) => `[${i + 1}] (${e.kind}) ${e.excerpt}`)
    .join("\n");
}

function buildPerspectivePrompt(input: RapidDInput, digest: string): string {
  return `Strategic question:\n${input.question}\n\nContext summary (not full rows):\n${input.contextSummary}\n\nEvidence:\n${digest}`;
}

function buildSynthesizerPrompt(
  input: RapidDInput,
  digest: string,
  perspectives: { role: PerspectiveRole; text: string }[],
  nudge: string,
): string {
  const persText = perspectives
    .map((p) => `### ${p.role}\n${p.text}`)
    .join("\n\n");
  return `Strategic question:\n${input.question}\n\nContext summary (not full rows):\n${input.contextSummary}\n\nEvidence:\n${digest}\n\nPerspectives:\n\n${persText}${nudge}`;
}

// ── LLM calls (per-call timeout, parent-signal aware) ─────────────────────────

async function runPerspective(
  role: PerspectiveRole,
  input: RapidDInput,
  digest: string,
  opts: { model: string; timeoutMs: number; signal?: AbortSignal },
): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(
    () => ac.abort(new Error(`rapid-d ${role} timeout`)),
    opts.timeoutMs,
  );
  const onAbort = () => ac.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await queryClaudeSdk({
      prompt: buildPerspectivePrompt(input, digest),
      systemPrompt: PERSPECTIVE_PROMPTS_V1[role],
      toolNames: [],
      maxTurns: 2,
      model: opts.model,
      abortSignal: ac.signal,
    });
    const text = res.text.trim();
    return text.length > 0 ? text : null;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), role },
      "rapid-d: perspective call failed",
    );
    return null;
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function runSynthesizer(
  input: RapidDInput,
  digest: string,
  perspectives: { role: PerspectiveRole; text: string }[],
  nudge: string,
  opts: { model: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RawOption[]> {
  const sink: { captured: { options: RawOption[] } | null } = {
    captured: null,
  };
  const submit = buildSubmitOptionsTool(sink);

  const ac = new AbortController();
  const t = setTimeout(
    () => ac.abort(new Error("rapid-d synthesizer timeout")),
    opts.timeoutMs,
  );
  const onAbort = () => ac.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await queryClaudeSdk({
      prompt: buildSynthesizerPrompt(input, digest, perspectives, nudge),
      systemPrompt: SYNTHESIZER_SYSTEM_PROMPT_V1,
      toolNames: [],
      extraTools: [submit],
      maxTurns: 2,
      model: opts.model,
      abortSignal: ac.signal,
    });
  } catch (e) {
    // A timeout that races a successful tool_use still has a valid capture —
    // fall through rather than discard it (mirrors decompose.ts / critic.ts).
    if (!sink.captured) {
      throw new SynthesisError(
        `synthesizer call failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (!sink.captured) {
    throw new SynthesisError(
      "synthesizer did not call submit_options — output was free text",
    );
  }
  return sink.captured.options;
}

// ── orchestration ─────────────────────────────────────────────────────────────

function degraded(
  reason: DegradedReason,
  perspectives: { role: PerspectiveRole; text: string }[],
  attempts: number,
  maxSimilarity: number | null,
): RapidDResult {
  return {
    options: [],
    degraded: true,
    degradedReason: reason,
    maxSimilarity,
    attempts,
    perspectives,
    promptVersion: RAPID_D_PROMPT_VERSION,
  };
}

/**
 * Run the RAPID-D multi-option pass for one strategic situation. Returns either
 * three ranked A/B/C options or a graceful degrade (`options: []`) — never a
 * fabricated 1- or 2-option set. Does NOT throw on the normal failure modes
 * (no perspectives, synthesizer failure, irreducible similarity) — it degrades,
 * because a missing option set is a legitimate outcome the judgment pass handles.
 *
 * Callers should run the cheap `shouldRunMultiOption` skip predicate first; this
 * function assumes the judgment already earned the four calls.
 */
export async function runMultiOption(
  input: RapidDInput,
  options: RunMultiOptionOptions = {},
): Promise<RapidDResult> {
  const theta = options.theta ?? resolveDiversityTheta();
  const retryBudget = options.retryBudget ?? DIVERSITY_RETRY_BUDGET;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model ?? SONNET_MODEL_ID;
  const embedFn = options.embedFn ?? embed;
  const digest = renderEvidenceDigest(input.evidence);

  // An already-aborted caller gets a clean immediate degrade — no LLM calls at
  // all (mirrors decompose.ts's upfront signal check).
  if (options.signal?.aborted) {
    log.warn(
      "rapid-d: caller signal already aborted — degrading to optionless",
    );
    return degraded("no_perspectives", [], 0, null);
  }

  // 1. Perspectives — Analyst ∥ Seeker ∥ Devil's Advocate (free-text).
  const texts = await Promise.all(
    PERSPECTIVE_ROLES.map((role) =>
      runPerspective(role, input, digest, {
        model,
        timeoutMs,
        signal: options.signal,
      }),
    ),
  );
  const perspectives = PERSPECTIVE_ROLES.map((role, i) => ({
    role,
    text: texts[i],
  })).filter(
    (p): p is { role: PerspectiveRole; text: string } => p.text !== null,
  );

  if (perspectives.length < MIN_PERSPECTIVES) {
    log.warn(
      { produced: perspectives.length, need: MIN_PERSPECTIVES },
      "rapid-d: too few perspectives — degrading to optionless",
    );
    return degraded("no_perspectives", perspectives, 0, null);
  }

  // 2. Synthesizer + advisory diversity gate (retry, then graceful degrade).
  const maxAttempts = retryBudget + 1;
  let lastMaxSim: number | null = null;
  let sawValidOptions = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) break;

    let opts: ProposedOption[];
    try {
      const raw = await runSynthesizer(
        input,
        digest,
        perspectives,
        attempt > 1 ? RAPID_D_DIVERSITY_RETRY_INSTRUCTION : "",
        { model, timeoutMs, signal: options.signal },
      );
      opts = validateOptions(raw);
      sawValidOptions = true;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), attempt },
        "rapid-d: synthesizer attempt failed",
      );
      continue; // spend the attempt; retry if budget remains
    }

    const maxSim = await computeMaxPairwiseSimilarity(
      opts.map((o) => o.summary),
      embedFn,
    );
    if (maxSim === null) {
      // Embeddings unavailable — gate is advisory; accept on the Synthesizer's
      // own distinctness rubric and log that the gate did not run (§8).
      log.warn(
        { attempt },
        "rapid-d: diversity gate inert (embeddings unavailable) — accepting options",
      );
      return {
        options: opts,
        degraded: false,
        degradedReason: null,
        maxSimilarity: null,
        attempts: attempt,
        perspectives,
        promptVersion: RAPID_D_PROMPT_VERSION,
      };
    }

    lastMaxSim = maxSim;
    if (isDiverseEnough(maxSim, theta)) {
      return {
        options: opts,
        degraded: false,
        degradedReason: null,
        maxSimilarity: maxSim,
        attempts: attempt,
        perspectives,
        promptVersion: RAPID_D_PROMPT_VERSION,
      };
    }
    log.info(
      { attempt, maxSim, theta },
      "rapid-d: options too similar — retrying synthesizer",
    );
  }

  // Budget exhausted: distinguish "never synthesized" from "never distinct".
  const reason: DegradedReason = sawValidOptions
    ? "no_diversity"
    : "synthesizer_failed";
  log.warn(
    { reason, lastMaxSim, theta },
    "rapid-d: degraded to optionless after exhausting retry budget",
  );
  return degraded(reason, perspectives, maxAttempts, lastMaxSim);
}
