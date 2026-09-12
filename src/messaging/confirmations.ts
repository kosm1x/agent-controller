/**
 * Pending tool confirmation — stores high-risk tool operations awaiting user approval.
 *
 * Adapted from Executor's pause/resume pattern (RhysSullivan/executor).
 * Simplified for messaging: task completes, pending op stored, next message
 * either confirms (direct execution) or declines (clear + "Cancelado").
 *
 * Flow:
 * 1. task-executor returns CONFIRMATION_REQUIRED for high-risk tool
 * 2. LLM asks user "¿Lo envío?" → task completes
 * 3. fast-runner includes pendingConfirmation in output metadata
 * 4. router stores it here, keyed by thread
 * 5. User says "sí" → router executes tool directly → sends result
 *
 * Durability (2026-09-12, agents-best-practices gap 3): every pending op is
 * also written to `tool_approvals` (mc.db) with a sha256 of its args. The
 * in-memory map is the fast path; a miss falls back to the newest pending
 * row for the thread, so a restart between "¿Lo envío?" and "sí" no longer
 * drops the approval. Resolving records who decided and when, and refuses
 * when the stored args no longer hash to the recorded value — the yes is
 * bound to the exact action the user saw. DB writes are best-effort: the
 * map keeps working when the DB is unavailable (tests, early boot).
 */

import { createHash } from "crypto";
import { getDatabase } from "../db/index.js";

/** Pending confirmation waiting for user approval. */
export interface PendingConfirmation {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
  /** Human-readable summary for logging. */
  summary: string;
  /** sha256 over sorted-key JSON of `args` — the identity the approval binds to. */
  argsSha256: string;
  /** Row id in `tool_approvals`, when the durable write succeeded. */
  approvalId?: number;
}

export type ApprovalDecision = "confirmed" | "declined" | "expired" | "superseded";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** In-memory store of pending confirmations, keyed by thread key. */
const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Timers for auto-expiry. */
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Exact-action identity: sha256 over sorted-key JSON (order-insensitive, lossless). */
export function argsSha256(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

/** Best-effort durable write; never throws (DB may be absent in tests / early boot). */
function dbWrite<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    // Fail open on purpose (the map keeps working) but never silently: a
    // missing approval record must be visible in the journal (qa-audit W-3).
    console.warn(
      `[confirmations] approval record not written: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function markThreadRows(threadKey: string, decision: ApprovalDecision): void {
  dbWrite(() =>
    getDatabase()
      .prepare(
        `UPDATE tool_approvals SET decision = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE thread_key = ? AND decision = 'pending'`,
      )
      .run(decision, threadKey),
  );
}

/**
 * Store a pending confirmation for a thread.
 * Overwrites any existing pending for the same thread (durable row → superseded).
 * Auto-expires after 5 minutes.
 */
export function storePendingConfirmation(
  threadKey: string,
  toolName: string,
  args: Record<string, unknown>,
  summary: string,
): void {
  // Clear existing timer if any
  const existing = expiryTimers.get(threadKey);
  if (existing) clearTimeout(existing);
  markThreadRows(threadKey, "superseded");

  const sha = argsSha256(args);
  const approvalId = dbWrite(
    () =>
      getDatabase()
        .prepare(
          `INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(threadKey, toolName, sha, JSON.stringify(args), summary.slice(0, 500))
        .lastInsertRowid as number,
  );

  pendingConfirmations.set(threadKey, {
    toolName,
    args,
    timestamp: Date.now(),
    summary,
    argsSha256: sha,
    ...(approvalId !== undefined && { approvalId }),
  });

  // Auto-expire
  expiryTimers.set(
    threadKey,
    setTimeout(() => {
      pendingConfirmations.delete(threadKey);
      expiryTimers.delete(threadKey);
      markThreadRows(threadKey, "expired");
    }, CONFIRMATION_TTL_MS),
  );
}

interface ApprovalRow {
  id: number;
  tool: string;
  args_sha256: string;
  args_json: string;
  summary: string | null;
  requested_at: string;
}

/** Restart recovery: newest pending row for the thread, if still inside the TTL. */
function rehydrateFromDb(threadKey: string): PendingConfirmation | null {
  const row = dbWrite(
    () =>
      getDatabase()
        .prepare(
          `SELECT id, tool, args_sha256, args_json, summary, requested_at
           FROM tool_approvals WHERE thread_key = ? AND decision = 'pending'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(threadKey) as ApprovalRow | undefined,
  );
  if (!row) return null;
  const requestedAt = Date.parse(row.requested_at);
  if (!Number.isFinite(requestedAt) || Date.now() - requestedAt > CONFIRMATION_TTL_MS) {
    markThreadRows(threadKey, "expired");
    return null;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.args_json) as Record<string, unknown>;
  } catch {
    markThreadRows(threadKey, "superseded");
    return null;
  }
  if (argsSha256(args) !== row.args_sha256) {
    markThreadRows(threadKey, "superseded");
    return null;
  }
  const pending: PendingConfirmation = {
    toolName: row.tool,
    args,
    timestamp: requestedAt,
    summary: row.summary ?? row.tool,
    argsSha256: row.args_sha256,
    approvalId: row.id,
  };
  pendingConfirmations.set(threadKey, pending);
  // Re-arm expiry for the remaining TTL so a silent thread still closes the row.
  expiryTimers.set(
    threadKey,
    setTimeout(() => {
      pendingConfirmations.delete(threadKey);
      expiryTimers.delete(threadKey);
      markThreadRows(threadKey, "expired");
    }, Math.max(0, CONFIRMATION_TTL_MS - (Date.now() - requestedAt))),
  );
  return pending;
}

/**
 * Get a pending confirmation for a thread. Returns null if none or expired.
 * Falls back to the durable row when the process restarted in between.
 */
export function getPendingConfirmation(
  threadKey: string,
): PendingConfirmation | null {
  const pending = pendingConfirmations.get(threadKey) ?? rehydrateFromDb(threadKey);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > CONFIRMATION_TTL_MS) {
    clearPendingConfirmation(threadKey, "expired");
    return null;
  }
  return pending;
}

/**
 * Resolve the pending confirmation: record WHO decided WHAT, verify the
 * args still hash to the approved identity, and clear it. Returns the
 * approved operation on `confirmed`, or null when nothing valid is pending
 * (the caller must not execute anything in that case).
 */
export function resolvePendingConfirmation(
  threadKey: string,
  decision: "confirmed" | "declined",
  approver: string,
): PendingConfirmation | null {
  const pending = getPendingConfirmation(threadKey);
  if (!pending) return null;
  if (argsSha256(pending.args) !== pending.argsSha256) {
    console.warn(
      `[confirmations] args hash mismatch for ${pending.toolName} on ${threadKey} — refusing to execute`,
    );
    clearPendingConfirmation(threadKey, "superseded");
    return null;
  }
  // Pin the decision to the ONE row the user saw (qa-audit W-2: a thread
  // predicate stamped every pending row, including one the user never saw
  // when an earlier supersede write was lost). Thread fallback only when the
  // durable insert itself failed and there is no id.
  dbWrite(() =>
    pending.approvalId !== undefined
      ? getDatabase()
          .prepare(
            `UPDATE tool_approvals SET decision = ?, approver = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ? AND decision = 'pending'`,
          )
          .run(decision, approver.slice(0, 200), pending.approvalId)
      : getDatabase()
          .prepare(
            `UPDATE tool_approvals SET decision = ?, approver = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE thread_key = ? AND decision = 'pending'`,
          )
          .run(decision, approver.slice(0, 200), threadKey),
  );
  clearInMemory(threadKey);
  return decision === "confirmed" ? pending : null;
}

function clearInMemory(threadKey: string): void {
  pendingConfirmations.delete(threadKey);
  const timer = expiryTimers.get(threadKey);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(threadKey);
  }
}

/**
 * Clear a pending confirmation for a thread. The durable row is closed with
 * `decision` (default `superseded`: the user moved on without deciding).
 */
export function clearPendingConfirmation(
  threadKey: string,
  decision: ApprovalDecision = "superseded",
): void {
  clearInMemory(threadKey);
  markThreadRows(threadKey, decision);
}

/** Test seam: drop the in-memory map so rehydration from the DB can be exercised. */
export function _resetPendingConfirmationsForTests(): void {
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
  pendingConfirmations.clear();
}

// ---------------------------------------------------------------------------
// Confirmation / decline detection
// ---------------------------------------------------------------------------

import { buildConfirmRegex, buildDeclineRegex } from "./confirmation-verbs.js";

/** Lax matcher — full vocabulary (generic + action + clitic + EN). */
const CONFIRM_PATTERNS = buildConfirmRegex("lax");
/** Strict matcher — generic affirmations + destructive-aligned clitic stems
 * only (bórralo, elimínalo, etc.). Used when the pending op has
 * destructiveHint: true. Excludes broad action verbs (dale/hazlo/procede)
 * and non-destructive clitics (súbelo/créalo) so an action verb in incidental
 * text or a verb/op-type mismatch can't accidentally confirm an irreversible
 * operation. See `confirmation-verbs.ts:DESTRUCTIVE_CLITIC_CONFIRM_SRC`. */
const CONFIRM_PATTERNS_STRICT = buildConfirmRegex("strict");
const DECLINE_PATTERNS = buildDeclineRegex();

/** Caller-supplied options. `strict: true` narrows the matcher. */
export interface DetectOptions {
  /** Use the strict matcher — required for destructive-hint tools. */
  strict?: boolean;
}

/**
 * Detect if a user message is a confirmation or decline of a pending operation.
 * Only checks short messages (< 60 chars lax / < 30 chars strict) to avoid
 * false positives. Returns null for ambiguous or unrelated messages.
 */
export function detectConfirmationResponse(
  text: string,
  options: DetectOptions = {},
): "confirm" | "decline" | null {
  const stripped = text.replace(/^\[Grupo:.*?\]\n?/i, "").trim();
  const maxLen = options.strict ? 30 : 60;
  if (stripped.length > maxLen) return null;

  const confirmRe = options.strict ? CONFIRM_PATTERNS_STRICT : CONFIRM_PATTERNS;
  if (confirmRe.test(stripped)) return "confirm";
  if (DECLINE_PATTERNS.test(stripped)) return "decline";
  return null;
}
