/**
 * V8.2 Phase 2 — decomposition (spec §7).
 *
 * Turns a strategic question (implied by the V8.1 BriefingContext) into an
 * ANGLES artifact — angles, not answers. Each angle is a specific sub-question
 * (≤120 chars) carrying a STRUCTURED boundary set and real `tool_guidance`.
 *
 * Three units, matching the §7 pipeline:
 *   1. `decomposeQuestion` — ONE forced-tool LLM call: question + a context
 *      summary (NOT full rows) → ≤3 angles. Uses the S2-critic forced-tool
 *      pattern ([[forced-structured-output-via-mcp-tool]]): a one-shot
 *      `submit_decomposition` SDK tool whose Zod schema IS the angles array,
 *      captured via a closure sink. The schema caps angles at 3, so a model
 *      that tries a 4th is rejected by the SDK's Zod parse before the handler
 *      runs — "a question needing 4+ angles is a signal to split it" (§7).
 *   2. `retrieveForAngle` / `gatherEvidence` — DETERMINISTIC retrieval (no LLM)
 *      that honors each angle's structured `boundaries` against the internal
 *      `tasks` substrate, populating the evidence ledger the later phases cite.
 *      The `tool_guidance` enum records WHICH external tool a richer retrieval
 *      should use (crm_query / intel_query / memory_search / …); wiring those
 *      sources is later-phase work — Phase 2 honors boundaries over the one
 *      deterministic, structured substrate available today (the §7 "prefer
 *      task/general_event evidence" path), and NorthStar is deliberately not
 *      auto-queried here (moving-target guard, queue #18).
 *   3. `saveDecomposition` — append-only ADR write to
 *      `decisions/<judgment_id>/decomposition.json` (`reference_adr_eventsourcing`);
 *      never overwrites an existing artifact.
 */

import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  queryClaudeSdk,
  SONNET_MODEL_ID,
  type InlineSdkTool,
} from "../../inference/claude-sdk.js";
import { scrubSecrets } from "../secret-refs.js";
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import {
  strategicVoiceSystemPrompt,
  composeV82UserPrompt,
} from "./strategic-voice.js";
import { getDatabase } from "../../db/index.js";
import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import { sanitizeFtsQuery } from "./critic.js";
import {
  DecompositionAngleSchema,
  DecompositionSchema,
  type Decomposition,
  type DecompositionAngle,
  type EvidenceRef,
} from "./types.js";
import { errMsg } from "../err-msg.js";

const log = createLogger("v8-2:decompose");

// ── forced-tool decomposition ────────────────────────────────────────────────

/** Single-source-of-truth tool name (a typo would silently drift the prompt). */
export const SUBMIT_DECOMPOSITION_TOOL_NAME = "submit_decomposition";

/** Hard cap on a single decomposition LLM call. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Max angles per §7 — also enforced by the tool schema below. */
export const MAX_ANGLES = 3;

/**
 * Decomposition task instructions. Phase 5: these now lead the USER prompt (via
 * `composeV82UserPrompt`); the SDK `systemPrompt` is the shared strategic-voice
 * block (`strategicVoiceSystemPrompt()`) so all V8.2 calls share one cache
 * prefix (§10). The name is retained for call-site/test stability; despite
 * "SYSTEM" it is delivered in the user turn under the SDK single-cache-block
 * constraint ([[sdk_systemprompt_single_cache_block]]).
 */
export const DECOMPOSE_SYSTEM_PROMPT = `You break ONE strategic question into at most ${MAX_ANGLES} retrieval ANGLES — angles, not answers. You do NOT answer the question; you decompose it into the specific sub-questions whose evidence a later step will gather and judge.

Each angle has:
- objective: a single specific sub-question, ≤120 characters. Not a topic — a question with a concrete answer in the data.
- tool_guidance: zero or more of the allowed retrieval tools. Pick the tool(s) whose data would answer THIS angle. Leave empty to let retrieval choose. Prefer task/general-event evidence. Avoid northstar_sync unless the angle is explicitly about NorthStar direction (it is a moving target).
- boundaries: STRUCTURED filters that scope the retrieval — date_from/date_to (ISO dates), status_in (e.g. ["open","blocked"]), exclude_completed (true to drop finished work), limit (max rows). Only include the fields that actually scope this angle.

Rules:
- At most ${MAX_ANGLES} angles. Fewer is better. A question needing 4+ angles should be split into two questions — do NOT pad to ${MAX_ANGLES}.
- Angles must be DISTINCT — each weights different evidence. Do not restate one angle three ways.
- You have ONE tool: \`${SUBMIT_DECOMPOSITION_TOOL_NAME}\`. Call it exactly once with your angles. Emit no other text.`;

export interface DecomposeOptions {
  /** Hard cap on decomposition latency. Default 30s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** ISO timestamp stamped onto the artifact. Injected for determinism. */
  nowIso?: string;
}

/** Raised when the model fails to produce a usable decomposition. */
export class DecompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompositionError";
  }
}

/**
 * The forced-tool schema: the model produces ONLY the angles array. `question`
 * is echoed from the caller's input and `generated_at` is stamped by us — the
 * model never invents either, so it cannot drift the question or the clock.
 */
const submitDecompositionSchema = {
  angles: z
    .array(DecompositionAngleSchema)
    .max(MAX_ANGLES)
    .describe(
      `1 to ${MAX_ANGLES} distinct retrieval angles. Fewer is better; never pad.`,
    ),
};

function buildSubmitDecompositionTool(sink: {
  captured: { angles: DecompositionAngle[] } | null;
}): InlineSdkTool {
  // Schema-generic erasure at the createSdkMcpServer boundary — same rationale
  // as src/audit/critic.ts buildSubmitVerdictTool: the SDK runs the Zod parser
  // before invoking the handler, so the runtime shape matches the declaration.
  return sdkTool(
    SUBMIT_DECOMPOSITION_TOOL_NAME,
    "Submit your decomposition. Call exactly once. The schema IS your output — produce only the angles array.",
    submitDecompositionSchema,
    async (args) => {
      if (sink.captured) {
        throw new Error(
          `${SUBMIT_DECOMPOSITION_TOOL_NAME} called more than once in a single decomposition`,
        );
      }
      sink.captured = { angles: args.angles };
      return {
        content: [{ type: "text" as const, text: "Decomposition recorded." }],
      };
    },
  ) as unknown as InlineSdkTool;
}

/**
 * Decompose a strategic question into ≤3 retrieval angles.
 *
 * The call sees `question` + `contextSummary` (a pre-rendered BriefingContext
 * digest — NOT full rows; §7 "sees the BriefingContext but not full rows").
 * Throws `DecompositionError` if the model returns no tool call or the call
 * fails at the infrastructure layer — the caller (Phase 3) decides whether to
 * skip the judgment. Never silently returns an empty decomposition.
 */
export async function decomposeQuestion(
  question: string,
  contextSummary: string,
  options: DecomposeOptions = {},
): Promise<Decomposition> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const generatedAt = options.nowIso ?? new Date().toISOString();

  if (options.signal?.aborted) {
    throw new DecompositionError(
      `decomposition skipped: caller signal already aborted`,
    );
  }

  const ac = new AbortController();
  const timeoutHandle = setTimeout(
    () => ac.abort(new Error("decomposition timeout")),
    timeoutMs,
  );
  const onAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const sink: { captured: { angles: DecompositionAngle[] } | null } = {
    captured: null,
  };
  const submitDecomposition = buildSubmitDecompositionTool(sink);

  try {
    await queryClaudeSdk({
      prompt: composeV82UserPrompt(
        DECOMPOSE_SYSTEM_PROMPT,
        `Strategic question:\n${question}\n\nContext summary (not full rows):\n${contextSummary}`,
      ),
      systemPrompt: strategicVoiceSystemPrompt(),
      toolNames: [],
      extraTools: [submitDecomposition],
      maxTurns: 2,
      model: SONNET_MODEL_ID,
      abortSignal: ac.signal,
      costLedger: { agentType: "v82:decompose" },
    });
  } catch (e) {
    // The call threw (abort / API error). If the handler already captured the
    // angles, a timeout that races a successful tool_use still has a valid
    // artifact — fall through to finalize rather than discard it (mirrors
    // critic.ts:261 abort-during-handler handling). Only a throw with NOTHING
    // captured is a real call failure.
    if (!sink.captured) {
      throw new DecompositionError(`decomposition call failed: ${errMsg(e)}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (!sink.captured) {
    throw new DecompositionError(
      "model did not call submit_decomposition — output was free text without a tool call",
    );
  }

  // Assemble the full artifact: model-supplied angles + caller question +
  // injected clock. Re-validate through DecompositionSchema so the ≤3-angle cap
  // and angle shape are enforced at THIS boundary too — not only by the SDK's
  // tool-schema parse — and so question/generated_at are pinned into the
  // contract.
  try {
    return DecompositionSchema.parse({
      question,
      angles: sink.captured.angles,
      generated_at: generatedAt,
    });
  } catch (e) {
    throw new DecompositionError(
      `decomposition failed validation: ${errMsg(e)}`,
    );
  }
}

// ── deterministic boundary-honoring retrieval ────────────────────────────────

/**
 * Terminal `tasks` statuses — no further work will happen on the row. An angle
 * with `exclude_completed: true` wants in-flight/actionable work only, so the
 * retrieval drops ALL terminal states, not just the success ones: `failed` and
 * `cancelled` are as finished as `completed` (qa-W2 — omitting `failed` let
 * abandoned work leak through an "exclude finished work" boundary). An angle
 * that specifically wants failed/cancelled work as signal uses `status_in`
 * instead, not `exclude_completed`.
 */
const TERMINAL_TASK_STATUSES = [
  "completed",
  "completed_with_concerns",
  "cancelled",
  "failed",
] as const;

/** Default / ceiling row count when an angle omits / over-asks `limit`. */
export const DEFAULT_ANGLE_LIMIT = 20;
export const MAX_ANGLE_LIMIT = 50;

export interface RetrievalOptions {
  db?: Database.Database;
  /** ISO retrieval timestamp stamped on every EvidenceRef. Injected. */
  nowIso?: string;
  /** Subject (project/entity) the judgment is about. When set, `gatherEvidence`
   *  adds a KB (`jarvis_files`) pass keyed on it (Phase 2 — see below). */
  subject?: string;
}

/** Default / ceiling KB entries pulled per gather. Kept small: the KB pass is
 *  supplemental identity/grounding evidence, and every ref costs author + critic
 *  tokens (more so under the Sonnet-5 tokenizer). */
export const DEFAULT_KB_LIMIT = 5;
export const MAX_KB_LIMIT = 8;

/** Recent day-logs pulled per gather. Kept tiny — freshest few are enough to
 *  ground a "last activity" claim, and each ref costs author + critic tokens. */
export const DEFAULT_DAYLOG_LIMIT = 3;

type TaskEvidenceRow = {
  task_id: string;
  title: string;
  status: string;
  priority: string;
  created_at: string;
};

/**
 * Retrieve `tasks` rows scoped by an angle's structured boundaries → evidence
 * refs (`kind='task'`). This is the deterministic pass §7 calls for: the
 * boundaries map 1:1 onto real `tasks` columns —
 *   status_in        → status IN (...)
 *   date_from/to     → created_at >= / <=
 *   exclude_completed→ status NOT IN (completed, completed_with_concerns, cancelled)
 *   limit            → LIMIT min(limit ?? DEFAULT, MAX)
 * Newest-first. No LLM; pure SQL with bound parameters.
 */
export function retrieveTasksForBoundaries(
  boundaries: DecompositionAngle["boundaries"],
  options: RetrievalOptions = {},
): EvidenceRef[] {
  const db = options.db ?? getDatabase();
  const retrievedAt = options.nowIso ?? new Date().toISOString();

  const where: string[] = [];
  const params: (string | number)[] = [];

  if (boundaries.status_in && boundaries.status_in.length > 0) {
    where.push(`status IN (${boundaries.status_in.map(() => "?").join(",")})`);
    params.push(...boundaries.status_in);
  }
  if (boundaries.date_from) {
    where.push("created_at >= ?");
    params.push(boundaries.date_from);
  }
  if (boundaries.date_to) {
    where.push("created_at <= ?");
    params.push(boundaries.date_to);
  }
  if (boundaries.exclude_completed) {
    where.push(
      `status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(",")})`,
    );
    params.push(...TERMINAL_TASK_STATUSES);
  }

  const limit = Math.min(
    boundaries.limit ?? DEFAULT_ANGLE_LIMIT,
    MAX_ANGLE_LIMIT,
  );

  const sql =
    `SELECT task_id, title, status, priority, created_at FROM tasks` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY created_at DESC LIMIT ?`;

  const rows = db.prepare(sql).all(...params, limit) as TaskEvidenceRow[];

  // No-silent-cap (qa-W3): a full page means there may be MORE matching rows
  // the judge never sees. Surface it rather than truncating invisibly.
  if (rows.length === limit) {
    log.debug(
      { limit, requestedLimit: boundaries.limit ?? null, boundaries },
      "decompose: task retrieval hit the row limit — results may be truncated",
    );
  }

  return rows.map((r) => ({
    kind: "task" as const,
    id: r.task_id,
    excerpt: `[${r.status}/${r.priority}] ${r.title}`,
    retrieved_at: retrievedAt,
  }));
}

/**
 * Retrieve the evidence for a single angle. Phase 2 dispatches every angle to
 * the deterministic `tasks` pass (the structured substrate where boundaries
 * have meaning). `tool_guidance` is preserved on the angle for later phases
 * that wire external sources; it is intentionally NOT yet used to switch
 * retrieval backends here.
 */
export function retrieveForAngle(
  angle: DecompositionAngle,
  options: RetrievalOptions = {},
): EvidenceRef[] {
  return retrieveTasksForBoundaries(angle.boundaries, options);
}

type KbEvidenceRow = { path: string; title: string; snippet: string };

/**
 * Retrieve KB (`jarvis_files`) rows matching a free-text query → evidence refs
 * (`kind='kb_entry'`, `id`=path). Approximates ONE of the critic's `recall_check`
 * queries (lexical `jarvis_files_fts`, bm25 ranked) so the AUTHOR can cite the KB
 * the critic VERIFIES against — before this the ledger was task-only, so the
 * critic could demand a `projects/<subject>/README.md` / timestamp the author had
 * no `[K]` marker for → a correct-but-mis-cited judgment it could never fix. This
 * only NARROWS the asymmetry: it's a single subject-keyed query, whereas the
 * critic runs up to 5 arbitrary recall queries + SQL over 6 tables, so a residual
 * gap remains (a recent-day-log pass in `gatherEvidence` narrows it further).
 * Never throws: if `jarvis_files_fts` is absent (a bare in-memory db) the pass
 * degrades to empty and the ledger stays task-only.
 */
export function retrieveKbForQuery(
  query: string,
  options: RetrievalOptions & { limit?: number } = {},
): EvidenceRef[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const db = options.db ?? getDatabase();
  const retrievedAt = options.nowIso ?? new Date().toISOString();
  const limit = Math.min(options.limit ?? DEFAULT_KB_LIMIT, MAX_KB_LIMIT);

  let rows: KbEvidenceRow[];
  try {
    rows = db
      .prepare(
        `SELECT path, title,
                snippet(jarvis_files_fts, 1, '', '', '…', 16) AS snippet
           FROM jarvis_files_fts WHERE jarvis_files_fts MATCH ?
           ORDER BY bm25(jarvis_files_fts) LIMIT ?`,
      )
      .all(match, limit) as KbEvidenceRow[];
  } catch (e) {
    // FTS table absent / query rejected → degrade to task-only, never throw.
    log.debug(
      { err: errMsg(e) },
      "decompose: KB retrieval unavailable (jarvis_files_fts) — task-only ledger",
    );
    return [];
  }

  // No-silent-cap: a full page means more matching KB entries exist unseen.
  if (rows.length === limit) {
    log.debug(
      { limit, query },
      "decompose: KB retrieval hit the row limit — more matches may exist",
    );
  }

  return rows.map((r) => ({
    kind: "kb_entry" as const,
    id: r.path,
    // Ruling 3c (audit round 4 S2): scrubbed before the cut.
    excerpt: scrubSecrets(
      `${r.title}${r.snippet ? ` — ${r.snippet}` : ""}`,
    ).slice(0, 200),
    retrieved_at: retrievedAt,
  }));
}

type DayLogEvidenceRow = { path: string; content: unknown };

/** Case- and diacritic-insensitive form used by the day-log match. */
const foldText = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Folded, word-bounded match patterns for a (trimmed, non-empty) subject — see
 *  `retrieveRecentDayLogs` for the slug-first project resolution behind them. */
function subjectTerms(db: Database.Database, needle: string): RegExp[] {
  const folded = foldText(needle).trim();
  let identity = [needle];
  try {
    const projects = db.prepare(`SELECT slug, name FROM projects`).all() as {
      slug: string;
      name: string;
    }[];
    const p =
      projects.find((r) => foldText(r.slug).trim() === folded) ??
      projects.find((r) => foldText(r.name).trim() === folded);
    if (p) identity = [p.slug, p.slug.replace(/[-_]/g, " "), p.name];
  } catch {
    // projects absent (bare in-memory db) → raw subject only.
  }
  return [
    ...new Set(identity.map((t) => foldText(t).trim()).filter(Boolean)),
  ].map((t) => {
    // Escaped literal, bounded by a non-letter/digit (or text edge) on both ends.
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u");
  });
}

/** The 160-char window (from 30 before) of `original` around the earliest term
 *  match, or null when no term matches. */
function snippetAround(original: string, terms: RegExp[]): string | null {
  const content = foldText(original);
  const hits = terms.map((t) => content.search(t)).filter((i) => i >= 0);
  if (hits.length === 0) return null;
  // Map the folded offset back onto the original text (folding can shorten
  // it, e.g. a decomposed "e\u0301"), so the snippet is not shifted.
  const target = Math.min(...hits);
  let at = 0;
  let seen = 0;
  for (const ch of original) {
    if (seen >= target) break;
    seen += foldText(ch).length;
    at += ch.length;
  }
  const start = Math.max(0, at - 30);
  return original.slice(start, start + 160);
}

/**
 * Recent day-log entries (`jarvis_files` under `logs/day-logs/`) that MENTION the
 * subject, newest-first → evidence refs (`kind='kb_entry'`, id=path, same shape as
 * KB so they dedup with the KB pass). Day-logs are the operator's declared
 * work-truth source, so putting the freshest ones in the ledger lets the author
 * cite live activity instead of propagating a stale "no work since <date>" /
 * wrong-phase claim out of the uncited briefing narrative — the exact
 * contradiction class the critic disproves against these SAME logs (judgment #46:
 * prose said "no execution since 2026-06-17" while day-logs 06-27/06-28 existed).
 *
 * Deterministic base-table scan matched in JS rather than `jarvis_files_fts`, for
 * two reasons: (1) recency is the point here, and we order by filename date DESC —
 * FTS gives bm25 RELEVANCE, which buries the newest log under the README; (2) the
 * KB pass sanitizes the subject to a noisy token-OR (`salon OR voice OR outreach`),
 * whereas whole-phrase matching keeps precision. The subject is resolved against
 * `projects` (folded; a slug match wins over a name match): a hit matches on the
 * slug, the spaced slug and the full name — a display-name subject rarely appears
 * verbatim in chat logs while its slug does; no hit (or no table) keeps the raw
 * subject. Whole-identity terms only — single tokens would pull unrelated logs
 * into the ledger. Matching folds case AND diacritics on both sides (SQLite
 * `lower()` leaves "Á" as is) and needs a word boundary (no letter/digit) on both
 * ends, so a short slug never matches inside a longer word; a hyphen counts as a
 * boundary. Non-string content rows are skipped. Rows stream newest-first and
 * stop at `limit`. The path GLOB is anchored to the
 * `YYYY-MM-DD.md` date shape so `ORDER BY path DESC` is a true recency sort — a
 * stray `README.md`/nested dir in the namespace (kb-reindex auto-ingests any FS
 * `.md`) would otherwise sort ABOVE all dates and displace the newest logs. Never
 * throws: a missing table degrades to empty.
 */
export function retrieveRecentDayLogs(
  subject: string,
  options: RetrievalOptions & { limit?: number } = {},
): EvidenceRef[] {
  const needle = subject.trim();
  if (!needle) return [];
  const db = options.db ?? getDatabase();
  const retrievedAt = options.nowIso ?? new Date().toISOString();
  const limit = Math.min(options.limit ?? DEFAULT_DAYLOG_LIMIT, MAX_KB_LIMIT);

  const terms = subjectTerms(db, needle);

  const matches: { path: string; snippet: string }[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT path, content FROM jarvis_files
          WHERE path GLOB 'logs/day-logs/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md'
          ORDER BY path DESC`,
      )
      .iterate() as IterableIterator<DayLogEvidenceRow>;
    for (const r of rows) {
      if (typeof r.content !== "string") continue;
      const snippet = snippetAround(r.content, terms);
      if (snippet === null) continue;
      matches.push({ path: r.path, snippet });
      if (matches.length === limit) break;
    }
  } catch (e) {
    // jarvis_files absent (bare in-memory db) → skip, never throw.
    log.debug(
      { err: errMsg(e) },
      "decompose: day-log retrieval unavailable (jarvis_files) — skipped",
    );
    return [];
  }

  if (matches.length === limit) {
    log.debug(
      { limit, subject: needle },
      "decompose: day-log retrieval hit the row limit — older mentions unseen",
    );
  }

  return matches.map((r) => {
    const date = r.path.slice("logs/day-logs/".length).replace(/\.md$/, "");
    return {
      kind: "kb_entry" as const,
      id: r.path,
      // Ruling 3c (audit round 4 S2): scrubbed before the cut.
      excerpt: scrubSecrets(`day-log ${date}: …${r.snippet.trim()}…`).slice(
        0,
        200,
      ),
      retrieved_at: retrievedAt,
    };
  });
}

/** Most KB refs one critique can pull into the re-author ledger. */
export const MAX_CRITIQUE_KB_PATHS = 5;
/** Most distinct path tokens looked up per critique (bounds the queries). */
export const MAX_CRITIQUE_KB_LOOKUPS = 20;

type KbFileRow = { path: string; title: unknown; content: unknown };

/**
 * KB files a critic critique names BY PATH (`logs/day-logs/2026-09-03.md`,
 * `projects/<slug>/README.md`, …) → evidence refs, same shape as the KB/day-log
 * passes. The critic verifies against a wider surface than the gathered ledger,
 * so a `needs_revision` often demands a citation the author has no `[K]` entry
 * for; the re-author appends these so the named source becomes citable. Tokens
 * ending in `.md` are taken in first-seen order and deduped (the critique is split
 * on non-path characters, so a comma- or paren-joined list still yields each path;
 * path-character runs over 300 chars are skipped, which keeps the match linear); the first
 * `MAX_CRITIQUE_KB_LOOKUPS` are looked up by EXACT `path = ?` and at most
 * `MAX_CRITIQUE_KB_PATHS` found refs are kept — model text is never a SQL
 * fragment or a LIKE/GLOB/FTS pattern, so an unknown or
 * metacharacter token simply finds nothing. Excerpt: title + the snippet around
 * the subject (same terms as the day-log pass) or the head of the content.
 * Non-string rows are skipped. Never throws: a missing table degrades to empty.
 */
export function retrieveKbPathsFromCritique(
  critique: string,
  options: RetrievalOptions = {},
): EvidenceRef[] {
  const paths = [
    ...new Set(
      critique
        .split(/[^\p{L}\p{N}_./-]+/u)
        .filter((t) => t.length <= 300)
        .flatMap(
          (t) => t.match(/[\p{L}\p{N}_./-]*\.md(?![\p{L}\p{N}_/-])/gu) ?? [],
        ),
    ),
  ].slice(0, MAX_CRITIQUE_KB_LOOKUPS);
  if (paths.length === 0) return [];
  const db = options.db ?? getDatabase();
  const retrievedAt = options.nowIso ?? new Date().toISOString();
  const needle = options.subject?.trim();

  try {
    const terms = needle ? subjectTerms(db, needle) : [];
    const stmt = db.prepare(
      `SELECT path, title, content FROM jarvis_files WHERE path = ?`,
    );
    const refs: EvidenceRef[] = [];
    for (const path of paths) {
      const r = stmt.get(path) as KbFileRow | undefined;
      if (!r || typeof r.title !== "string" || typeof r.content !== "string")
        continue;
      const snippet =
        snippetAround(r.content, terms) ?? r.content.slice(0, 160);
      refs.push({
        kind: "kb_entry" as const,
        id: r.path,
        // Ruling 3c (audit round 4 S2): scrubbed before the cut.
        excerpt: scrubSecrets(`${r.title} — …${snippet.trim()}…`).slice(0, 200),
        retrieved_at: retrievedAt,
      });
      if (refs.length === MAX_CRITIQUE_KB_PATHS) break;
    }
    return refs;
  } catch (e) {
    // jarvis_files absent (bare in-memory db) → skip, never throw.
    log.debug(
      { err: errMsg(e) },
      "decompose: critique KB-path retrieval unavailable (jarvis_files) — skipped",
    );
    return [];
  }
}

/**
 * Run every angle's retrieval and return the deduplicated evidence ledger.
 * Dedup key is `kind:id` — the same task surfaced by two angles is one ledger
 * entry (the FIRST retrieval wins, preserving its excerpt/timestamp).
 *
 * When `options.subject` is set, two supplemental `jarvis_files` passes are
 * appended so the ledger the author cites approaches the surface the critic
 * VERIFIES against (`recall_check` + day-log SQL): (1) a subject-keyed KB pass
 * for identity/grounding files (`projects/<subject>/` README/snapshot); (2) a
 * recent-day-log pass for live activity. Note this only NARROWS the asymmetry —
 * the critic still runs up to 5 arbitrary recall queries + SQL over 6 tables, so
 * a residual gap remains (see critic.ts).
 */
export function gatherEvidence(
  decomposition: Decomposition,
  options: RetrievalOptions = {},
): EvidenceRef[] {
  const seen = new Set<string>();
  const ledger: EvidenceRef[] = [];
  const push = (ref: EvidenceRef) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    ledger.push(ref);
  };
  for (const angle of decomposition.angles) {
    for (const ref of retrieveForAngle(angle, options)) push(ref);
  }
  if (options.subject) {
    for (const ref of retrieveKbForQuery(options.subject, options)) push(ref);
    for (const ref of retrieveRecentDayLogs(options.subject, options))
      push(ref);
  }
  return ledger;
}

// ── append-only ADR persistence ──────────────────────────────────────────────

/** Root for decision ADR dirs; override via env for non-default deployments. */
export const DECISIONS_DIR =
  process.env.MC_DECISIONS_DIR ?? resolve("decisions");

export interface SaveDecompositionOptions {
  /** Override the decisions root (tests inject a tmpdir). */
  baseDir?: string;
}

/**
 * A judgment id is safe to use as a single path segment: it must not be empty
 * and must not introduce separators or traversal. Judgment ids are app-
 * generated integers today, but the param is typed `string`, so guard the
 * filesystem boundary (poka-yoke — a `../` id would otherwise escape baseDir).
 */
const SAFE_JUDGMENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Append-only ADR write to `<baseDir>/decisions/<judgmentId>/decomposition.json`.
 * NEVER overwrites: if the canonical file already exists, the write lands on a
 * versioned sibling (`decomposition.v2.json`, `…v3.json`, …) so the decision
 * record is immutable history (`reference_adr_eventsourcing`). Returns the path
 * actually written.
 */
export function saveDecomposition(
  judgmentId: string,
  decomposition: Decomposition,
  options: SaveDecompositionOptions = {},
): string {
  if (!SAFE_JUDGMENT_ID.test(judgmentId)) {
    throw new Error(
      `saveDecomposition: unsafe judgmentId ${JSON.stringify(judgmentId)} — must match ${SAFE_JUDGMENT_ID}`,
    );
  }
  const root = options.baseDir ?? DECISIONS_DIR;
  const dir = join(root, judgmentId);
  mkdirSync(dir, { recursive: true });

  let target = join(dir, "decomposition.json");
  if (existsSync(target)) {
    let version = 2;
    while (existsSync(join(dir, `decomposition.v${version}.json`))) version++;
    target = join(dir, `decomposition.v${version}.json`);
  }

  writeFileSync(target, JSON.stringify(decomposition, null, 2), "utf8");
  return target;
}
