/**
 * V8.2 Phase 6 — §11 CRITIC verification (forced-tool, ground-truth).
 *
 * The CRITIC is V8.2's verification step: a SEPARATE LLM call with its OWN
 * system prompt (a skeptical verifier — deliberately NOT the Phase-5
 * strategic-voice block; this call is not Jarvis-the-counsel, it is the audit
 * gate) that checks a judgment's factual claims against ground truth using
 * read-only tools, then emits a tri-state verdict via a forced tool.
 *
 * It extends the S2 critic's forced-tool pattern (`src/audit/critic.ts`,
 * 2026-05-27 — [[forced_structured_output_via_mcp_tool]]): the verdict is the
 * ONLY legal emission (a one-shot `submit_critic_verdict` SDK tool whose Zod
 * schema IS the output), captured via a closure sink, NO free-text fallback
 * (re-introducing it re-introduces the `fail_returned_anyway` bug class).
 *
 * Ground-truth tools (read-only, §11):
 *   - `sql_check`   — ONE LLM-authored SELECT against whitelisted tables, run
 *                     on a READONLY connection (writes physically impossible) +
 *                     SELECT-only + single-statement + table-whitelist + caps.
 *   - `cost_check`  — parameterized aggregate over `cost_ledger` (no LLM SQL).
 *   - `recall_check`— lexical FTS5 (`jarvis_files_fts`) top-5. NOTE: lexical,
 *                     not semantic — `kb_entries` semantic recall lives in
 *                     pgvector and is DEFERRED; Phase 6 ships local recall.
 *   - `file_sha`    — path-guarded SHA-256 to verify "I checked file X" claims.
 *
 * `contradicted_claim_ids` (claims the tools PROVED false) → §12 wiring:
 * `markClaimsContradicted` flips those `attributed_claims` rows to
 * `resolver_status='contradicted'`, which §12 confidence later counts.
 *
 * POSTURE: additive + dormant. No producer calls the critic yet (the
 * judgment-assembly pass that emits prose+claims+ledger is a later phase); no
 * schema change; no restart. Tests mock the SDK + seed claims.
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import {
  queryClaudeSdk,
  SONNET_MODEL_ID,
  type InlineSdkTool,
} from "../../inference/claude-sdk.js";
import { getDatabase } from "../../db/index.js";
import { createLogger } from "../logger.js";
import { markClaimsContradicted, type ResolvedClaim } from "./cite.js";
import type { UnresolvedClaim } from "./cite.js";
import type { EvidenceRef } from "./types.js";
import { errMsg } from "../err-msg.js";

const log = createLogger("v8-2:critic");

// ── verdict + forced tool ─────────────────────────────────────────────────────

export const CRITIC_VERDICTS = [
  "approved",
  "needs_revision",
  "unfixable",
] as const;
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number];

/**
 * WHY a terminal verdict is `unfixable`. Only two of these are judgment-quality
 * defects the §17 gate must catch:
 *   - `contradicted` — a claim is contradicted by ground truth (the critic's own
 *     §11 definition; a direct critic verdict or the contradicted-claims branch).
 *   - `unsupported`  — a factual sentence survived with no resolvable citation.
 *   - `unverified`   — the critic INFRA-FAILED (no tool call / timeout) and never
 *     actually verified; escalated to `unfixable` conservatively so it can't
 *     auto-approve. This is a critic-reliability problem, NOT a bad judgment, so
 *     the §17 unfixable rate excludes it (see `v82-activation-gate.ts` check 4).
 */
export type UnfixableReason = "contradicted" | "unverified" | "unsupported";

/**
 * Machine-emitted marker appended to an escalated critique when the critic never
 * produced a verdict. Exported so the §17 gate can retro-classify trail rows
 * written before `unfixableReason` was persisted — it matches THIS module's own
 * constant, not free-form LLM text, and self-retires as old rows age out.
 */
export const CRITIC_UNVERIFIED_MARKER = "(critic could not verify)";

/** Single-source-of-truth tool name (a typo would silently drift the prompt). */
export const SUBMIT_CRITIC_VERDICT_TOOL_NAME = "submit_critic_verdict";

/** Read-only verification calls allowed before the verdict (§11). */
export const CRITIC_TOOL_BUDGET = 5;

/** Outer Self-Refine loop cap (§11). Two failed needs_revision → unfixable. */
export const CRITIC_MAX_LOOP = 2;

/** Hard cap on a single critic LLM call. */
const DEFAULT_TIMEOUT_MS = 45_000;

/** sql_check result caps (defense vs a huge read flooding the context). */
const SQL_CHECK_ROW_CAP = 50;
const SQL_CHECK_CHAR_CAP = 4_000;

/** file_sha read cap — source files the critic verifies are small; a multi-GB
 *  file is never a legitimate "I checked file X" target (qa-W4). */
const FILE_SHA_MAX_BYTES = 16 * 1024 * 1024;

/** Ground-truth tables `sql_check` may read. `kb_entries` (pgvector/semantic)
 *  maps to the local `jarvis_files` KB; `recall_check` covers its FTS. */
const SQL_CHECK_TABLES = new Set([
  "tasks",
  "jarvis_files",
  "general_events",
  "recurring_blockers",
  "northstar",
  "cost_ledger",
]);

export const CRITIC_SYSTEM_PROMPT_V1 = `You are the CRITIC — a skeptical verification gate for a strategic judgment produced by another agent. You do NOT rewrite the judgment and you do NOT defer to its confident tone. Your only job is to check whether its FACTUAL claims hold against ground truth, then return a verdict.

You have read-only verification tools (use up to ${CRITIC_TOOL_BUDGET} calls total — spend them on the load-bearing claims, not trivia):
- sql_check(query): run ONE read-only SELECT against ground-truth tables (tasks, jarvis_files, general_events, recurring_blockers, northstar, cost_ledger).
- cost_check(window_days, model?, agent_type?): aggregate cost_ledger to check a spend/token claim.
- recall_check(query): lexical top-5 over the local knowledge base (jarvis_files) — does stored knowledge support the claim?
- file_sha(path): SHA-256 of a repo file, to check an "I verified file X" claim.

Process: identify each factual claim (a number, date, named entity, or state claim about a task/metric/person); verify the ones the judgment leans on; then call \`${SUBMIT_CRITIC_VERDICT_TOOL_NAME}\` EXACTLY once. Emit no other text.

VERIFICATION DISCIPLINE — the two ways a verifier manufactures a FALSE contradiction (avoid both):
1. ENTITY IDENTITY. When a claim is about a NAMED project / person / entity, ONLY that exact entity is evidence. A different entity that merely shares a name-prefix or substring is NOT the same thing and never confirms or contradicts the claim — "Very Light CMS" (vlcms) is NOT "Very Light Media Player" (vlmp). Match the full canonical name or the exact slug, never a shared prefix. A search hit on a similarly-named sibling is a NON-match: discount it and keep looking, do not count it as presence.
2. A FUZZY HIT DOES NOT OUTRANK A DETERMINISTIC FIGURE. When a claim cites a value a deterministic check already produced ("absent N days per the stall detector", a count, a SQL aggregate), it came from exact matching. A looser LIKE / FTS keyword scan over-matches (a query for one project surfaces every name-prefix sibling), so its hit is weak evidence about the subject and does NOT by itself overturn the figure — this is a corollary of rule 1, not deference to the judgment's tone (a sibling hit simply is not evidence about the subject). A fuzzy hit contradicts the figure ONLY if it lands on the EXACT subject entity AND inside the claimed window — otherwise it says nothing about the subject. When you are unsure a hit is the right entity, treat the deterministic figure as standing: marking a TRUE claim contradicted is the costlier error.
3. YOUR OWN 0-ROW QUERY IS NOT PROOF OF ABSENCE. Every ref in the evidence ledger was retrieved DETERMINISTICALLY from the DB — it EXISTS by construction. If a sql_check you wrote returns 0 rows for a ledger ref, your QUERY is wrong (most often the KEY COLUMN — the "tasks" table keys on "task_id" (a TEXT UUID), NOT the integer "id"), NOT the evidence. NEVER conclude a cited task is missing/fake, and never mark a claim contradicted, on the strength of a 0-row result from SQL you authored — re-query with the right column, or let the ledger ref stand. (Judgment 32: the critic queried "tasks" by "id" for 10 real "task_id" UUIDs, got 0 rows each, and falsely called the whole ledger nonexistent.)

Verdict:
- approved — every load-bearing factual claim is grounded and nothing is contradicted by the tools.
- needs_revision — CORRECTABLE problems (a wrong source id, a stale row, a citation that points at the wrong evidence). Say exactly what to fix in 'critique'.
- unfixable — a claim is CONTRADICTED by ground truth and the judgment cannot be salvaged.

'contradicted_claim_ids' lists the claim_id values your tools proved FALSE (these rows get marked contradicted). Omit it when nothing was disproven. A confident argument is not evidence — only the tool results are.`;

const submitCriticVerdictSchema = {
  verdict: z
    .enum(CRITIC_VERDICTS)
    .describe(
      "approved = all load-bearing claims grounded; needs_revision = correctable (wrong source id / stale row / mis-citation); unfixable = a claim is contradicted by ground truth and unsalvageable.",
    ),
  critique: z
    .string()
    .describe(
      "Concise justification. For needs_revision, state EXACTLY what to fix so the re-author can act on it.",
    ),
  contradicted_claim_ids: z
    .array(z.number().int())
    .optional()
    .describe(
      "claim_id values your tool checks PROVED false against ground truth. These attributed_claims rows are marked resolver_status='contradicted'. Omit or leave empty if nothing was disproven.",
    ),
};

interface CriticVerdictCapture {
  verdict: CriticVerdict;
  critique: string;
  contradicted_claim_ids: number[];
}

/**
 * Forced `submit_critic_verdict` tool. The Zod parse runs at the SDK boundary
 * (verdict ∈ enum, critique present), so the handler only sinks the validated
 * args. Double-call guard mirrors the S2 critic (W2): the FIRST verdict wins;
 * a second call is ignored rather than clobbering it.
 */
function buildSubmitCriticVerdictTool(sink: {
  captured: CriticVerdictCapture | null;
}): InlineSdkTool {
  return sdkTool(
    SUBMIT_CRITIC_VERDICT_TOOL_NAME,
    "Submit your verification verdict. Call exactly once. The schema IS your output.",
    submitCriticVerdictSchema,
    async (args: {
      verdict: CriticVerdict;
      critique: string;
      contradicted_claim_ids?: number[];
    }) => {
      if (sink.captured) {
        return {
          content: [
            { type: "text" as const, text: "Verdict already recorded." },
          ],
        };
      }
      sink.captured = {
        verdict: args.verdict,
        critique: args.critique,
        contradicted_claim_ids: [
          ...new Set(args.contradicted_claim_ids ?? []),
        ].filter((n) => Number.isInteger(n)),
      };
      return {
        content: [{ type: "text" as const, text: "Verdict recorded." }],
      };
    },
  ) as unknown as InlineSdkTool;
}

// ── read-only verification tools ──────────────────────────────────────────────

/** Extract table names following FROM/JOIN, INCLUDING comma-join lists
 *  (`FROM a, b` — qa-W1: the first-table-only regex let `FROM tasks,
 *  conversations` smuggle a non-whitelisted table past the check). Subqueries
 *  in parens evade this, but the readonly connection caps the worst case to
 *  "read a local table" (no write/exfil), and WITH/CTE is rejected up front. */
function referencedTables(sql: string): string[] {
  const out: string[] = [];
  // FROM/JOIN <name> then an optional comma-list of further <name>s.
  const re =
    /\b(?:from|join)\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    for (const t of m[1].split(",")) out.push(t.trim().toLowerCase());
  }
  return out;
}

/** Run a single read-only SELECT with layered guards. Returns a text summary or
 *  a rejection/error string (never throws — the model reads the message). */
export function runReadOnlySelect(db: Database.Database, sql: string): string {
  const trimmed = sql.trim();
  // SELECT-only: no WITH (could front a writing CTE), no write/DDL/PRAGMA/ATTACH.
  if (!/^select\b/i.test(trimmed)) {
    return "sql_check rejected: only a single read-only SELECT is allowed (no WITH / INSERT / UPDATE / DELETE / PRAGMA / ATTACH).";
  }
  const bad = referencedTables(trimmed).filter((t) => !SQL_CHECK_TABLES.has(t));
  if (bad.length > 0) {
    return `sql_check rejected: table(s) outside the ground-truth whitelist: ${bad.join(", ")}. Allowed: ${[...SQL_CHECK_TABLES].join(", ")}.`;
  }
  try {
    // better-sqlite3 .prepare() throws on multiple statements; a readonly
    // connection throws on any write. Both are backstops to the regex guard.
    // qa-W3: .iterate() with an early break bounds memory to the cap — a
    // `SELECT *` over a large table no longer materializes every row first.
    const stmt = db.prepare(trimmed);
    const rows: unknown[] = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= SQL_CHECK_ROW_CAP) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    let json = JSON.stringify(rows);
    if (json.length > SQL_CHECK_CHAR_CAP) {
      json = `${json.slice(0, SQL_CHECK_CHAR_CAP)}…(truncated)`;
    }
    const more = truncated
      ? ` (capped at ${SQL_CHECK_ROW_CAP}; more rows exist)`
      : "";
    return `${rows.length} row(s)${more}: ${json}`;
  } catch (e) {
    return `sql_check error: ${errMsg(e)}`;
  }
}

/** `sql_check` tool description (exported so the ACI schema guidance is testable —
 *  tool descriptions are prompts). The SCHEMA NOTE closes the judgment-32 trap:
 *  the LLM defaults to `WHERE id = '<uuid>'`, but `tasks.id` is an integer rowid,
 *  so a UUID filter on it silently returns 0 rows (false "task missing"). */
export const SQL_CHECK_TOOL_DESCRIPTION = `Run ONE read-only SELECT against ground-truth tables (${[...SQL_CHECK_TABLES].join(", ")}) and return up to ${SQL_CHECK_ROW_CAP} rows as JSON. Read-only: writes/DDL/PRAGMA/ATTACH and non-whitelisted tables are rejected. Use it to verify a factual claim against live data. SCHEMA NOTE — an evidence ref keys on its table's BUSINESS key, not the row's \`id\`: a \`task <uuid>\` ref keys on \`tasks.task_id\` (a TEXT UUID) — filter \`WHERE task_id = '<uuid>'\`, NOT \`WHERE id = '<uuid>'\` (\`tasks.id\` is an unrelated INTEGER rowid, so an id=uuid filter silently returns 0 rows and would look like the task is missing when it is not); a \`kb_entry <path>\` ref keys on \`jarvis_files.path\` — filter \`WHERE path = '<path>'\` (or just use recall_check for KB).`;

function buildSqlCheckTool(db: Database.Database): InlineSdkTool {
  return sdkTool(
    "sql_check",
    SQL_CHECK_TOOL_DESCRIPTION,
    { query: z.string().describe("a single read-only SELECT statement") },
    async (args: { query: string }) => ({
      content: [
        { type: "text" as const, text: runReadOnlySelect(db, args.query) },
      ],
    }),
  ) as unknown as InlineSdkTool;
}

export function runCostCheck(
  db: Database.Database,
  args: { window_days?: number; model?: string; agent_type?: string },
): string {
  const days = Math.min(Math.max(Math.trunc(args.window_days ?? 7), 1), 365);
  const conds = ["created_at >= datetime('now', ?)"];
  const params: unknown[] = [`-${days} days`];
  if (args.model) {
    conds.push("model = ?");
    params.push(args.model);
  }
  if (args.agent_type) {
    conds.push("agent_type = ?");
    params.push(args.agent_type);
  }
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS row_count,
                COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
                COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens
           FROM cost_ledger WHERE ${conds.join(" AND ")}`,
      )
      .get(...params);
    return JSON.stringify({ window_days: days, ...(row as object) });
  } catch (e) {
    return `cost_check error: ${errMsg(e)}`;
  }
}

function buildCostCheckTool(db: Database.Database): InlineSdkTool {
  return sdkTool(
    "cost_check",
    "Aggregate cost_ledger over a recent window to verify a spend/token claim. Read-only. Returns total cost, token sums and row count.",
    {
      window_days: z
        .number()
        .int()
        .optional()
        .describe("lookback window in days (default 7, clamped 1-365)"),
      model: z.string().optional().describe("filter to one model id"),
      agent_type: z.string().optional().describe("filter to one agent_type"),
    },
    async (args: {
      window_days?: number;
      model?: string;
      agent_type?: string;
    }) => ({
      content: [{ type: "text" as const, text: runCostCheck(db, args) }],
    }),
  ) as unknown as InlineSdkTool;
}

/** FTS5 MATCH needs sanitization — bare reserved operators raise syntax errors
 *  (sqlite-backend.ts:94). Quote each alnum token and OR them for recall breadth. */
export function sanitizeFtsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function runRecallCheck(db: Database.Database, q: string): string {
  const match = sanitizeFtsQuery(q);
  if (!match) return "recall_check: empty query after sanitization.";
  try {
    // jarvis_files_fts columns are (title, content, path) — snippet col idx 1.
    const rows = db
      .prepare(
        `SELECT path, title,
                snippet(jarvis_files_fts, 1, '[', ']', '…', 12) AS snippet,
                bm25(jarvis_files_fts) AS score
           FROM jarvis_files_fts WHERE jarvis_files_fts MATCH ?
           ORDER BY score LIMIT 5`,
      )
      .all(match) as unknown[];
    if (rows.length === 0) {
      return `recall_check: no KB matches for "${q}" (lexical).`;
    }
    return `top ${rows.length} (lexical bm25, lower=closer): ${JSON.stringify(rows)}`;
  } catch (e) {
    return `recall_check unavailable (lexical jarvis_files_fts): ${errMsg(e)}`;
  }
}

function buildRecallCheckTool(db: Database.Database): InlineSdkTool {
  return sdkTool(
    "recall_check",
    "Lexical top-5 search over the local knowledge base (jarvis_files) to check whether stored knowledge supports a claim. NOTE: lexical (FTS5), NOT semantic — semantic recall (pgvector kb_entries) is deferred.",
    { query: z.string().describe("keywords / phrase to look up in the KB") },
    async (args: { query: string }) => ({
      content: [
        { type: "text" as const, text: runRecallCheck(db, args.query) },
      ],
    }),
  ) as unknown as InlineSdkTool;
}

/** SHA-256 a repo file to verify an "I checked file X" claim. Path-guarded
 *  against traversal outside `repoRoot`. Never throws. */
export function runFileSha(repoRoot: string, p: string): string {
  let abs: string;
  try {
    abs = isAbsolute(p) ? resolve(p) : resolve(repoRoot, p);
  } catch {
    return "file_sha: invalid path.";
  }
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return "file_sha rejected: path escapes the repo root.";
  }
  if (!existsSync(abs)) return JSON.stringify({ exists: false, path: rel });
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return `file_sha: "${rel}" is a directory.`;
    // qa-W4: bound the read — readFileSync buffers the whole file. Source files
    // the critic verifies are small; a multi-GB file is not a legitimate target.
    if (st.size > FILE_SHA_MAX_BYTES) {
      return `file_sha: "${rel}" is ${st.size} bytes (> ${FILE_SHA_MAX_BYTES}-byte cap) — not hashed.`;
    }
    const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    return JSON.stringify({
      exists: true,
      path: rel,
      sha256: sha,
      bytes: st.size,
    });
  } catch (e) {
    return `file_sha error: ${errMsg(e)}`;
  }
}

function buildFileShaTool(repoRoot: string): InlineSdkTool {
  return sdkTool(
    "file_sha",
    "Compute the SHA-256 of a file under the repo to verify an 'I checked file X' claim. The path must resolve inside the repo (traversal is rejected).",
    {
      path: z
        .string()
        .describe("repo-relative (or absolute-within-repo) file path"),
    },
    async (args: { path: string }) => ({
      content: [
        { type: "text" as const, text: runFileSha(repoRoot, args.path) },
      ],
    }),
  ) as unknown as InlineSdkTool;
}

// ── critic input / result ─────────────────────────────────────────────────────

export interface CriticInput {
  /** When set (+ a write db), a captured verdict's `contradicted_claim_ids`
   *  flip those rows to `contradicted`. Omit for a dry verify (no DB write). */
  judgmentId?: number;
  /** The judgment prose under audit (carries `[K]` markers). */
  prose: string;
  /** Resolved claims (claim_id + text + evidence refs) — the citable facts. */
  claims: ResolvedClaim[];
  /** The evidence ledger the prose's `[K]` markers index into. */
  ledger: EvidenceRef[];
  /** Optional §9 handoff: factual sentences cite.ts could NOT resolve. The
   *  critic scrutinizes these as unsupported claims (they have no claim_id, so
   *  they can't be `contradicted_claim_ids` — a disproven one forces
   *  needs_revision/unfixable instead). */
  unresolved?: UnresolvedClaim[];
}

export interface CriticOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
  /** Injected read-only query db (tests). Production opens a READONLY
   *  connection to the live mc.db file. */
  queryDb?: Database.Database;
  /** Write db for `markClaimsContradicted` (tests inject `:memory:`). Defaults
   *  to the `getDatabase()` singleton. Only used when `input.judgmentId` is set. */
  writeDb?: Database.Database;
  /** Repo root for `file_sha` path-guarding (default `process.cwd()`). */
  repoRoot?: string;
}

export interface CriticResult {
  verdict: CriticVerdict;
  critique: string;
  contradictedClaimIds: number[];
  latencyMs: number;
  costUsd?: number;
  /** true on infra failure (timeout, no tool call) — verdict is the
   *  conservative `needs_revision` so the loop retries then escalates. */
  error: boolean;
  /** Set ONLY when `verdict==='unfixable'`: why it is unfixable, so the §17 gate
   *  can separate a real judgment defect from a critic that never verified. */
  unfixableReason?: UnfixableReason;
}

function renderCriticPrompt(input: CriticInput): string {
  const claims = input.claims
    .map((c) => {
      const ev = c.evidence_refs
        .map((r) => `(${r.kind} ${r.id}) "${r.excerpt}"`)
        .join("; ");
      return `[claim_id ${c.claim_id}] "${c.claim_text}" — evidence: ${ev}`;
    })
    .join("\n");
  const ledger = input.ledger
    .map((r, i) => `[${i + 1}] (${r.kind} ${r.id}) ${r.excerpt}`)
    .join("\n");
  const unresolved =
    input.unresolved && input.unresolved.length > 0
      ? `\n\nUNSUPPORTED factual sentences (no valid citation — scrutinize; a disproven one is needs_revision/unfixable, NOT contradicted_claim_ids):\n${input.unresolved
          .map((u) => `- "${u.claim_text}" (${u.reason})`)
          .join("\n")}`
      : "";
  return `Judgment prose to verify:\n${input.prose}\n\nResolved claims (contradicted_claim_ids refers to these claim_id values):\n${claims || "(none)"}\n\nEvidence ledger:\n${ledger || "(none)"}${unresolved}`;
}

// ── single critic pass ────────────────────────────────────────────────────────

/**
 * One forced-tool verification pass. Mirrors the S2 `runCritic`: closure sink,
 * abort-during-handler tolerance, NO free-text fallback. On a captured verdict
 * with `contradicted_claim_ids` + `input.judgmentId`, marks those claims
 * contradicted (§11 → §12 wiring). On infra failure returns a conservative
 * `needs_revision` (error=true) — "couldn't verify → don't trust → retry, then
 * the loop escalates to unfixable".
 */
export async function runCritic(
  input: CriticInput,
  options: CriticOptions = {},
): Promise<CriticResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();

  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    const msg =
      reason instanceof Error ? reason.message : String(reason ?? "aborted");
    return {
      verdict: "needs_revision",
      critique: `critic skipped: caller signal already aborted (${msg})`,
      contradictedClaimIds: [],
      latencyMs: 0,
      error: true,
    };
  }

  // Read-only query connection: injected (tests) or a fresh readonly conn to
  // the live mc.db. An in-memory main db can't be reopened readonly, so fall
  // back to the singleton (the SQL guards still hold) rather than spawn an
  // empty database.
  let queryDb = options.queryDb;
  let ownConn = false;
  if (!queryDb) {
    const main = getDatabase();
    const path = main.name;
    if (path && path !== ":memory:") {
      queryDb = new Database(path, { readonly: true });
      ownConn = true;
    } else {
      queryDb = main;
    }
  }
  const repoRoot = options.repoRoot ?? process.cwd();

  const ac = new AbortController();
  const timeoutHandle = setTimeout(
    () => ac.abort(new Error("critic timeout")),
    timeoutMs,
  );
  const onAbort = () => ac.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const sink: { captured: CriticVerdictCapture | null } = { captured: null };

  try {
    const result = await queryClaudeSdk({
      prompt: renderCriticPrompt(input),
      systemPrompt: CRITIC_SYSTEM_PROMPT_V1,
      toolNames: [],
      extraTools: [
        buildSqlCheckTool(queryDb),
        buildCostCheckTool(queryDb),
        buildRecallCheckTool(queryDb),
        buildFileShaTool(repoRoot),
        buildSubmitCriticVerdictTool(sink),
      ],
      // Tool budget (5 verification calls) + room for the verdict turn.
      maxTurns: CRITIC_TOOL_BUDGET + 2,
      model: options.model ?? SONNET_MODEL_ID,
      abortSignal: ac.signal,
    });

    const latencyMs = Date.now() - t0;
    const costUsd = result.costAuthoritative ? result.costUsd : undefined;

    if (sink.captured) {
      return finalize(input, options, sink.captured, latencyMs, costUsd, false);
    }
    // No free-text fallback (S2 audit-C1): a missing verdict is an audit
    // failure → conservative needs_revision so the loop can retry/escalate.
    return {
      verdict: "needs_revision",
      critique:
        "critic did not call submit_critic_verdict — model output was free text without a tool call",
      contradictedClaimIds: [],
      latencyMs,
      costUsd,
      error: true,
    };
  } catch (e) {
    // Abort may fire DURING the verdict handler; honor a captured verdict.
    if (sink.captured) {
      return finalize(
        input,
        options,
        sink.captured,
        Date.now() - t0,
        undefined,
        false,
      );
    }
    return {
      verdict: "needs_revision",
      critique: `critic call failed: ${errMsg(e)}`,
      contradictedClaimIds: [],
      latencyMs: Date.now() - t0,
      error: true,
    };
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onAbort);
    if (ownConn) {
      try {
        queryDb.close();
      } catch {
        /* connection already closed — ignore */
      }
    }
  }
}

/** Apply the contradiction write (§12 wiring) and shape the result. */
function finalize(
  input: CriticInput,
  options: CriticOptions,
  captured: CriticVerdictCapture,
  latencyMs: number,
  costUsd: number | undefined,
  error: boolean,
): CriticResult {
  const ids = captured.contradicted_claim_ids;
  if (input.judgmentId != null && ids.length > 0) {
    try {
      const n = markClaimsContradicted(
        input.judgmentId,
        ids,
        options.writeDb ?? getDatabase(),
      );
      log.info(
        { judgmentId: input.judgmentId, claims: ids, rows: n },
        "critic: marked claims contradicted",
      );
    } catch (e) {
      // A write failure must not erase the verdict — surface it, keep going.
      log.warn(
        { err: errMsg(e), ids },
        "critic: markClaimsContradicted failed",
      );
    }
  }
  return {
    verdict: captured.verdict,
    critique: captured.critique,
    contradictedClaimIds: ids,
    latencyMs,
    costUsd,
    error,
  };
}

// ── 2-loop (Self-Refine) ──────────────────────────────────────────────────────

export interface ReAuthorResult {
  prose: string;
  claims: ResolvedClaim[];
  /** New ledger if re-retrieval changed it; falls back to the prior ledger. */
  ledger?: EvidenceRef[];
  unresolved?: UnresolvedClaim[];
}

/** Re-author the judgment with the critique injected, returning revised
 *  prose+claims (and optionally a new ledger). Provided by the judgment-pass
 *  producer (a later phase); mocked in tests. */
export type ReAuthorFn = (
  input: CriticInput,
  critique: string,
) => Promise<ReAuthorResult>;

export interface CriticLoopResult extends CriticResult {
  iterations: number;
}

/**
 * §11 terminal disposition when a SECOND `needs_revision` ends the loop.
 * `unfixable` (per the critic's own §11 definition) is reserved for a claim
 * CONTRADICTED by ground truth — plus two conservative cases that must never
 * auto-approve:
 *   1. infra error (no tool call / timeout) — the critic never actually verified;
 *   2. a surviving UNSUPPORTED sentence (`unresolvedCount > 0`). cite.ts couldn't
 *      resolve it, so it has no claim_id and can NEVER be a contradicted_claim_id —
 *      the discriminator below is structurally blind to it (qa-W1). "Unsupported"
 *      is NOT "mis-cited", so we do not let it ride in dressed as green: any
 *      unresolved sentence still present after the re-author keeps the judgment
 *      `unfixable`. The re-author recomputes `unresolved` each pass, so removing
 *      the flagged sentence (the intended fix, per author.ts) clears this gate.
 *
 * ONLY a pass that VERIFIED, contradicted nothing, AND left no unsupported
 * sentence is `approved` — that residual is a CORRECTABLE citation/sourcing nit on
 * RESOLVED claims that the re-author couldn't fully fix, usually because the right
 * source isn't in the frozen task-only ledger (the critic verifies against task +
 * KB recall, so it can demand a marker the author has no ledger entry for). That
 * judgment is substantively sound, so `approved` beats mislabeling it "contradicted
 * by ground truth" (which also structurally caps the §17 unfixable rate). The
 * residual critique is preserved in the critic trail — visible in the AUDIT trail
 * (`mc-ctl judgments <id>`), NOT rendered in the operator's brief. Phase 2 widens
 * the gather ledger so these citations become fixable at the source.
 */
export function escalationDisposition(
  last: CriticResult,
  unresolvedCount: number,
): {
  verdict: CriticVerdict;
  critique: string;
  unfixableReason?: UnfixableReason;
} {
  const tail = `after ${CRITIC_MAX_LOOP} needs_revision iterations — last critique: ${last.critique}`;
  if (last.error) {
    return {
      verdict: "unfixable",
      critique: `escalated to unfixable ${tail} ${CRITIC_UNVERIFIED_MARKER}`,
      unfixableReason: "unverified",
    };
  }
  if (last.contradictedClaimIds.length > 0) {
    return {
      verdict: "unfixable",
      critique: `escalated to unfixable ${tail}`,
      unfixableReason: "contradicted",
    };
  }
  if (unresolvedCount > 0) {
    return {
      verdict: "unfixable",
      critique: `escalated to unfixable ${tail} (unsupported sentence still unresolved)`,
      unfixableReason: "unsupported",
    };
  }
  return {
    verdict: "approved",
    critique: `approved with residual citation/sourcing caveat ${tail}`,
  };
}

/**
 * The §11 2-loop. `approved`/`unfixable` are terminal. `needs_revision`
 * re-authors (critique injected) and re-critics; a SECOND `needs_revision` ends
 * the loop via `escalationDisposition` — `unfixable` only when a claim was
 * contradicted or the critic couldn't verify, else `approved`-with-caveat (a
 * substantively-sound judgment whose residual defect is an uncorrectable
 * citation, not a ground-truth contradiction). The contradiction write happens
 * inside each `runCritic` pass.
 */
export async function runCriticLoop(
  input: CriticInput,
  deps: { reAuthor: ReAuthorFn },
  options: CriticOptions = {},
): Promise<CriticLoopResult> {
  let current = input;
  let last: CriticResult | null = null;

  for (let i = 1; i <= CRITIC_MAX_LOOP; i++) {
    last = await runCritic(current, options);

    if (last.verdict === "approved" || last.verdict === "unfixable") {
      // A DIRECT critic `unfixable` means the model verified and found a
      // ground-truth contradiction (an infra failure returns needs_revision, not
      // unfixable), so it is a real judgment defect — reason `contradicted`.
      const unfixableReason =
        last.verdict === "unfixable"
          ? ("contradicted" as UnfixableReason)
          : undefined;
      return { ...last, unfixableReason, iterations: i };
    }
    // needs_revision
    if (i === CRITIC_MAX_LOOP) {
      const unresolvedCount = current.unresolved?.length ?? 0;
      return {
        ...last,
        ...escalationDisposition(last, unresolvedCount),
        iterations: i,
      };
    }
    const revised = await deps.reAuthor(current, last.critique);
    current = {
      judgmentId: current.judgmentId,
      prose: revised.prose,
      claims: revised.claims,
      ledger: revised.ledger ?? current.ledger,
      unresolved: revised.unresolved ?? current.unresolved,
    };
  }

  // Unreachable (the loop always returns), but TS needs a terminal value.
  return { ...(last as CriticResult), iterations: CRITIC_MAX_LOOP };
}
