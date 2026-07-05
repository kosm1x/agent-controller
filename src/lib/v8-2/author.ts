/**
 * V8.2 §9 — the judgment author.
 *
 * The one V8.2 LLM call that emits FREE-TEXT prose carrying inline `[K]`
 * citation markers (every other V8.2 call is forced-tool). cite.ts's resolver
 * walks PROSE — `splitSentences` / `extractMarkers` — so a forced-tool JSON
 * schema could not express "a sentence ending in `[K]`". The free-text
 * precedent is the RAPID-D perspective call (`runPerspective`), not the
 * synthesizer.
 *
 * Cache discipline (§10): `systemPrompt = strategicVoiceSystemPrompt()`
 * byte-identical across every V8.2 call; per-call content lives in the user
 * prompt via `composeV82UserPrompt`, led by the canonical
 * `JUDGMENT_CITATION_CONTRACT_V1` (the `[K]`-marker producer contract whose
 * FIRST consumer this is) + the author role instructions.
 *
 * Ledger render: `[i+1] (kind id) excerpt`, 1-based — IDENTICAL to the index
 * `resolveCitations` resolves against (`[K]` → `ledger[K-1]`) and to the
 * contract's "evidence[1..N]" framing. The caller MUST pass the SAME ordered
 * `EvidenceRef[]` here and to `resolveCitations`, or every citation mis-resolves.
 */

import { queryClaudeSdk, SONNET_MODEL_ID } from "../../inference/claude-sdk.js";
import {
  strategicVoiceSystemPrompt,
  composeV82UserPrompt,
  JUDGMENT_CITATION_CONTRACT_V1,
} from "./strategic-voice.js";
import { createLogger } from "../logger.js";
import type { EvidenceRef, ProposedOption } from "./types.js";
import { errMsg } from "../err-msg.js";

const log = createLogger("v8-2:author");

/** Heavier than decompose (30s) — prose synthesis over a full ledger. */
const DEFAULT_TIMEOUT_MS = 45_000;

/** The author's role/task framing — its "hat", led ahead of the task body. The
 *  citation contract (`JUDGMENT_CITATION_CONTRACT_V1`) is prepended separately
 *  so it can version independently of this role text. */
export const AUTHOR_ROLE_INSTRUCTIONS = `You are writing ONE strategic judgment about the subject below — a crisp, decision-useful assessment, not a summary of the evidence. In 2 to 5 sentences: state where things actually stand, then what you would do about it. Take a clear posture; do not hedge to dodge commitment — but match the strength of your language to the strength of the evidence (the citation discipline below governs this).

Claim discipline (load-bearing): ground every factual specific — a cause, a status, a date, what happened or why — in an evidence-ledger item and carry its [K]. Do NOT assert specifics the ledger does not contain. In particular, never infer a cause, a backstory, or a trajectory from silence or absence: a subject being unmentioned or quiet means only that — not that it is stalling, failing, or at risk. When the evidence is thin (few ledger items, or it establishes only that the subject is quiet/unmentioned), scope the judgment to what the evidence supports — name the observable fact, state plainly what is NOT known, and commit to a clear next step (find out X, or decide Y), not a diagnosed cause. This is scoping, not hedging: you still take a clear posture; you simply do not manufacture certainty about what you cannot see. An unsupported claim is rejected downstream and wastes the whole judgment, so a tight evidence-bound judgment beats a confident fabricated one. If a reviewer flagged a claim as unsupported, REMOVE it — do not re-assert it in softer words.

If decision options A/B/C are provided, weigh them briefly and name the one you lean toward and why. Write prose only: no headings, no bullet lists, no tool calls, no preamble.`;

export interface AuthorInput {
  /** The strategic question (typically derived from the V8.1 judgment). */
  question: string;
  /** A pre-rendered BriefingContext digest — NOT full rows (§7). */
  contextSummary: string;
  /** The evidence ledger from `gatherEvidence` — the SAME array passed to
   *  `resolveCitations`. 1-based as the model sees it. */
  ledger: EvidenceRef[];
  /** RAPID-D options (length 3 or 0) to weigh, when the judgment earned them. */
  options: ProposedOption[];
  subject: string;
  /** Posture (persisted vocab) — context for the author, not a constraint. */
  posture: string;
  /** When set, a critic critique / operator note the revision must address. */
  critique?: string;
}

export interface AuthorResult {
  /** The judgment prose, carrying `[K]` markers. */
  prose: string;
  /** Authoritative cost when the SDK reported one (phantom-$0 abort paths drop
   *  to undefined — never write a phantom cost). */
  costUsd?: number;
}

export interface AuthorOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
}

/** Raised when the author produces no usable prose (empty text / call failure). */
export class AuthorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorError";
  }
}

/** Render the evidence ledger 1-based, matching `resolveCitations` indexing and
 *  the `[K]` contract. Mirrors critic.ts's ledger render so the model sees the
 *  same shape the critic later verifies against. */
export function renderEvidenceLedger(ledger: EvidenceRef[]): string {
  if (ledger.length === 0) return "(no structured evidence retrieved)";
  return ledger
    .map((r, i) => `[${i + 1}] (${r.kind} ${r.id}) ${r.excerpt}`)
    .join("\n");
}

function renderOptions(options: ProposedOption[]): string {
  return [...options]
    .sort((a, b) => a.rank - b.rank)
    .map(
      (o) =>
        `${o.label} (rank ${o.rank}): ${o.summary}` +
        (o.tradeoffs.length ? `\n   tradeoffs: ${o.tradeoffs.join("; ")}` : ""),
    )
    .join("\n");
}

function buildTaskBody(input: AuthorInput): string {
  const optionsBlock =
    input.options.length > 0
      ? `\n\nDecision options under consideration (ranked A/B/C):\n${renderOptions(input.options)}`
      : "";
  const critiqueBlock = input.critique
    ? `\n\nA reviewer flagged the prior draft — revise to address this critique (keep the [K] discipline):\n${input.critique}`
    : "";
  return `Strategic question:\n${input.question}\n\nSubject: ${input.subject} (posture: ${input.posture})\n\nContext summary (not full rows):\n${input.contextSummary}\n\nEvidence ledger:\n${renderEvidenceLedger(input.ledger)}${optionsBlock}${critiqueBlock}\n\nWrite the strategic judgment now.`;
}

/**
 * Author one strategic-judgment prose with `[K]` markers. Free-text SDK call —
 * no tools. Throws `AuthorError` on an empty result or a call failure (the
 * caller decides whether to skip the judgment). Abort/timeout plumbing mirrors
 * decompose.ts: a caller signal short-circuits, a local timeout caps latency,
 * and both are cleaned up in `finally`.
 */
export async function authorJudgment(
  input: AuthorInput,
  options: AuthorOptions = {},
): Promise<AuthorResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.signal?.aborted) {
    throw new AuthorError("author skipped: caller signal already aborted");
  }

  const ac = new AbortController();
  const timeoutHandle = setTimeout(
    () => ac.abort(new Error("author timeout")),
    timeoutMs,
  );
  const onAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await queryClaudeSdk({
      prompt: composeV82UserPrompt(
        `${JUDGMENT_CITATION_CONTRACT_V1}\n\n${AUTHOR_ROLE_INSTRUCTIONS}`,
        buildTaskBody(input),
      ),
      systemPrompt: strategicVoiceSystemPrompt(),
      toolNames: [],
      maxTurns: 2,
      model: options.model ?? SONNET_MODEL_ID,
      abortSignal: ac.signal,
    });
    const prose = res.text.trim();
    if (prose.length === 0) {
      throw new AuthorError("author returned empty prose");
    }
    return {
      prose,
      costUsd: res.costAuthoritative ? res.costUsd : undefined,
    };
  } catch (e) {
    if (e instanceof AuthorError) throw e;
    log.warn(
      { err: errMsg(e) },
      "author call failed",
    );
    throw new AuthorError(
      `author call failed: ${errMsg(e)}`,
    );
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
