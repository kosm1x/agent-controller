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
import { buildGwsArgv } from "../tools/builtin/google-workspace-cli.js";
import { toolRegistry } from "../tools/registry.js";
import {
  highRiskScheduledTools,
  isToolSetCarrier,
} from "../tools/task-executor.js";
import { describeCron } from "../rituals/cron-next.js";
import { emitTraceEvent } from "../observability/task-trace.js";

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
  /** Task whose run showed the card (in memory only; the trace key at expiry). */
  taskId?: string;
}

/** Why an expiry ended the way it did (trace `confirmation.expired`). */
export type ExpiryReason =
  | "notified"
  | "already_decided"
  | "no_notifier"
  | "notify_failed";

export type ApprovalDecision = "confirmed" | "declined" | "expired" | "superseded";

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** In-memory store of pending confirmations, keyed by thread key. */
const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Timers for auto-expiry. */
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Who to tell when the thread's pending approval lapses (the asked chat). */
const expiryNotifiers = new Map<string, (notice: string) => void>();

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

/**
 * Fields named first in a confirmation line — who receives it, what it
 * touches — per tool; everything else goes in the JSON tail.
 */
const DEFAULT_KEY_FIELDS = [
  "to",
  "cc",
  "bcc",
  "subject",
  "path",
  "paths",
  "id",
  "ids",
];
const SUMMARY_KEY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  tweet_post: ["account", "reply_to_id", "text"],
  wp_raw_api: ["method", "path", "site"],
  run_schedule: ["schedule_id", "id"],
  delete_schedule: ["schedule_id", "id"],
  jarvis_dev: ["action", "type", "slug"],
  wp_publish: ["site", "status", "post_id", "slug"],
  wp_plugins: ["site", "action", "plugin"],
  calendar_create: ["event_id", "start", "end", "attendees", "status"],
  calendar_update: ["event_id", "start", "end", "attendees", "status"],
  gdrive_share: ["file_id", "email", "role"],
  schedule_task: ["name", "cron", "tools", "delivery", "email_to"],
};
const SUMMARY_VALUE_CAP = 120;
const SUMMARY_CAP = 400;

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * What a confirmation approves, rendered by the harness from the STORED args
 * the sha binds — never the model's wording (audit 2026-09-30 W1). Shown to
 * the operator under the reply and stored as `tool_approvals.summary`.
 * google_workspace_cli shows the exact gws argv it will run; other tools
 * show their key fields by name (each value capped, never dropped), then the
 * rest as compact JSON, shortest values first — the tail is what the line
 * cap clips, so free text goes before an identifier does (W-C, round 3). A
 * truncated array says how many items it holds. Nested values render as
 * JSON, never `[object Object]`. One line, no backtick, so the router can
 * show it as inline code (no chat markdown applies inside).
 */
export function renderConfirmationSummary(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const oneLine = (s: string): string =>
    s.replace(/`/g, "\\u0060").replace(/[\r\n]+/g, " ");
  // A value with a control character or backtick renders as JSON (escaped).
  const text = (v: unknown): string =>
    typeof v === "string" && !/[\u0000-\u001f`]/.test(v)
      ? v
      : (JSON.stringify(v) ?? String(v));
  if (toolName === "google_workspace_cli") {
    const argv = buildGwsArgv(args).map(text).join(" ");
    return oneLine(clip(`${toolName}(gws ${argv})`, SUMMARY_CAP));
  }
  const keyValue = (v: unknown): string => {
    const full = text(v);
    if (!Array.isArray(v) || full.length <= SUMMARY_VALUE_CAP) {
      return clip(full, SUMMARY_VALUE_CAP);
    }
    const items: string[] = [];
    for (const item of v) {
      const next = JSON.stringify(item) ?? "null";
      if ([...items, next].join(",").length > SUMMARY_VALUE_CAP) break;
      items.push(next);
    }
    const shown =
      items.length > 0 ? items.join(",") : clip(full, SUMMARY_VALUE_CAP);
    return `[${shown},…] (${v.length} total)`;
  };
  const keys = SUMMARY_KEY_FIELDS[toolName] ?? DEFAULT_KEY_FIELDS;
  const parts = keys
    .filter((k) => args[k] !== undefined)
    .map((k) => `${k}: ${keyValue(args[k])}`);
  const size = (v: unknown): number => (JSON.stringify(v) ?? "").length;
  const rest = Object.fromEntries(
    Object.entries(args)
      .filter(([k]) => !keys.includes(k))
      .sort(([, a], [, b]) => size(a) - size(b)),
  );
  if (Object.keys(rest).length > 0) {
    const head = `${toolName}(${parts.join(", ")}${parts.length > 0 ? ", " : ""}`;
    const room = SUMMARY_CAP - head.length - 2; // "…" + ")"
    const tail = JSON.stringify(rest);
    parts.push(room > 0 ? clip(tail, room) : "…");
  }
  const line = oneLine(`${toolName}(${parts.join(", ")})`);
  // Ruling 2026-10-01: a schedule's yes is asked once, so the line names the
  // high-risk tools its runs will use unattended and how often, outside the
  // capped key values (a long tools array is truncated above).
  if (toolName !== "schedule_task") return line;
  const risky = highRiskScheduledTools(toolRegistry, args);
  if (risky.length === 0) return line;
  const cadence = typeof args.cron === "string" ? describeCron(args.cron) : "?";
  return oneLine(
    `${line} · usará sin pedir confirmación: ${renderRiskyToolList(risky)} (cadencia: ${cadence})`,
  );
}

/** At most this many risky tool names on a schedule card; the rest are counted. */
export const CARD_RISKY_TOOLS_MAX = 5;

/**
 * Re-audit should-fix (2026-10-03): a tool-set carrier (`batch_decompose`,
 * `schedule_task`, a name the registry does not know) is marked "(puede usar
 * cualquier herramienta)" — its tier says nothing about what its runs reach —
 * and the list is capped so a long tools array cannot flood the card.
 */
function renderRiskyToolList(risky: string[]): string {
  const shown = risky
    .slice(0, CARD_RISKY_TOOLS_MAX)
    .map((t) =>
      isToolSetCarrier(toolRegistry, t)
        ? `${t} (puede usar cualquier herramienta)`
        : t,
    );
  const more = risky.length - shown.length;
  return more > 0 ? `${shown.join(", ")} y ${more} más` : shown.join(", ");
}

/**
 * Ruling 2026-10-01: the ONE line sent to the asked chat when an approval
 * lapses unanswered — the same harness summary the card showed, never
 * raw args or model text. Not a question: nothing is pending after it.
 */
export function renderExpiryNotice(summary: string): string {
  return `⏱ La aprobación para \`${summary}\` venció sin respuesta. Si aún lo quieres, pídemelo de nuevo.`;
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
 * The TTL passed with no answer (ruling 2026-10-01). Re-reads the row at
 * fire time: the one notice goes out only when THIS approval was still
 * pending (a confirmed/declined/superseded row changes nothing), and only
 * when the router registered the chat it asked in. The notice stores
 * nothing, so a late "sí" finds no pending op and runs nothing. Every call
 * emits `confirmation.expired` with the outcome. Never throws — it runs
 * from a timer.
 */
function lapsePendingConfirmation(
  threadKey: string,
  pending: PendingConfirmation,
): ExpiryReason {
  let reason: ExpiryReason = "no_notifier";
  try {
    const notify = expiryNotifiers.get(threadKey);
    const current = pendingConfirmations.get(threadKey);
    clearInMemory(threadKey);
    const closed =
      pending.approvalId === undefined
        ? undefined
        : dbWrite(
            () =>
              getDatabase()
                .prepare(
                  `UPDATE tool_approvals SET decision = 'expired', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                   WHERE id = ? AND decision = 'pending'`,
                )
                .run(pending.approvalId).changes === 1,
          );
    markThreadRows(threadKey, "expired");
    // No durable row (or the DB is down): fall back to the in-memory identity.
    const lapsed = closed ?? current === pending;
    reason = !lapsed ? "already_decided" : notify ? "notified" : "no_notifier";
    if (reason === "notified") {
      try {
        notify!(renderExpiryNotice(pending.summary));
      } catch (err) {
        reason = "notify_failed";
        throw err;
      }
    }
  } catch (err) {
    console.warn(
      `[confirmations] expiry notice failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  traceExpiry(threadKey, pending, reason);
  return reason;
}

/** Trace the expiry decision (dashboard timeline); best-effort like every emit. */
function traceExpiry(
  threadKey: string,
  pending: PendingConfirmation,
  reason: ExpiryReason,
): void {
  emitTraceEvent({
    // A card rehydrated after a restart has no task id in memory: the
    // approval row (or the thread) keys its timeline instead.
    taskId:
      pending.taskId ??
      (pending.approvalId !== undefined
        ? `approval:${pending.approvalId}`
        : `approval:${threadKey}`),
    name: "confirmation.expired",
    tool: pending.toolName,
    attrs: {
      tool: pending.toolName,
      notified: reason === "notified",
      reason,
      ...(pending.approvalId !== undefined && {
        approval_id: pending.approvalId,
      }),
    },
  });
}

/**
 * Store a pending confirmation for a thread.
 * Overwrites any existing pending for the same thread (durable row → superseded).
 * Auto-expires after 5 minutes; `onExpire` (the router's send to the chat
 * that showed the card) then gets the one expiry notice. The timer lives in
 * memory; after a restart `rearmPendingConfirmationsAtBoot` re-arms it from
 * the row. `taskId` (the run that showed the card) keys the expiry trace.
 */
export function storePendingConfirmation(
  threadKey: string,
  toolName: string,
  args: Record<string, unknown>,
  summary: string,
  onExpire?: (notice: string) => void,
  taskId?: string,
): void {
  // Clear existing timer if any
  const existing = expiryTimers.get(threadKey);
  if (existing) clearTimeout(existing);
  expiryNotifiers.delete(threadKey);
  markThreadRows(threadKey, "superseded");

  const sha = argsSha256(args);
  const approvalId = dbWrite(
    () =>
      getDatabase()
        .prepare(
          `INSERT INTO tool_approvals (thread_key, tool, args_sha256, args_json, summary)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          threadKey,
          toolName,
          sha,
          JSON.stringify(args),
          summary.slice(0, 2000),
        ).lastInsertRowid as number,
  );

  const pending: PendingConfirmation = {
    toolName,
    args,
    timestamp: Date.now(),
    summary,
    argsSha256: sha,
    ...(approvalId !== undefined && { approvalId }),
    ...(taskId !== undefined && { taskId }),
  };
  pendingConfirmations.set(threadKey, pending);
  if (onExpire) expiryNotifiers.set(threadKey, onExpire);
  armExpiryTimer(threadKey, pending, CONFIRMATION_TTL_MS);
}

/**
 * The one expiry timer per thread, always through `lapsePendingConfirmation`
 * (unref'd: a pending approval never holds the process open).
 */
function armExpiryTimer(
  threadKey: string,
  pending: PendingConfirmation,
  delayMs: number,
): void {
  const existing = expiryTimers.get(threadKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => lapsePendingConfirmation(threadKey, pending),
    Math.max(0, delayMs),
  );
  timer.unref?.();
  expiryTimers.set(threadKey, timer);
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
  // Re-arm expiry for the remaining TTL so a silent thread still closes the
  // row — through the one lapse path (trace, and the notice when the boot
  // sweep's resolver knows the chat).
  const notify = resolveBootNotifier(threadKey, row.id);
  if (notify) expiryNotifiers.set(threadKey, notify);
  armExpiryTimer(
    threadKey,
    pending,
    CONFIRMATION_TTL_MS - (Date.now() - requestedAt),
  );
  return pending;
}

type ExpiryNotifier = (notice: string) => void;

/** The router's thread-key → chat resolver, set by the boot sweep. */
let bootNotifierResolver:
  | ((threadKey: string) => ExpiryNotifier | null)
  | null = null;

function resolveBootNotifier(
  threadKey: string,
  approvalId: number,
): ExpiryNotifier | null {
  if (!bootNotifierResolver) return null;
  try {
    const notify = bootNotifierResolver(threadKey);
    if (!notify) {
      console.warn(
        `[confirmations] approval ${approvalId}: chat not resolvable after restart — it lapses without a notice`,
      );
    }
    return notify;
  } catch (err) {
    console.warn(
      `[confirmations] approval ${approvalId}: notifier resolve failed (${err instanceof Error ? err.message : String(err)}) — it lapses without a notice`,
    );
    return null;
  }
}

/** Rows one boot sweep handles at most (newest first); older ones lapse on read. */
export const BOOT_SWEEP_MAX_ROWS = 50;

interface SweepRow extends ApprovalRow {
  thread_key: string;
}

/**
 * Re-audit should-fix (2026-10-03): the expiry timer lives in memory, so a
 * restart inside the 5-minute window would drop the notice. ONE pass at
 * boot (bounded by `maxRows`, newest first, one row per thread) re-arms
 * every still-pending approval: past its TTL it lapses at once, otherwise a
 * timer runs for the remainder — both through `lapsePendingConfirmation`.
 * `resolveNotifier` maps a thread key to the chat that showed the card;
 * when it cannot (unknown key shape, channel not up), the row lapses
 * silently (trace reason `no_notifier`) — never a guessed recipient. Never
 * throws. Not a cron: a single bounded pass.
 */
export function rearmPendingConfirmationsAtBoot(
  resolveNotifier: (threadKey: string) => ExpiryNotifier | null,
  maxRows: number = BOOT_SWEEP_MAX_ROWS,
): { armed: number; lapsed: number } {
  const tally = { armed: 0, lapsed: 0 };
  bootNotifierResolver = resolveNotifier;
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT id, thread_key, tool, args_sha256, args_json, summary, requested_at
         FROM tool_approvals WHERE decision = 'pending'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(0, Math.floor(maxRows))) as SweepRow[];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.thread_key)) continue; // older row of the same chat
      seen.add(row.thread_key);
      if (pendingConfirmations.has(row.thread_key)) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(row.args_json) as Record<string, unknown>;
      } catch {
        markThreadRows(row.thread_key, "superseded");
        continue;
      }
      if (argsSha256(args) !== row.args_sha256) {
        markThreadRows(row.thread_key, "superseded");
        continue;
      }
      const requestedAt = Date.parse(row.requested_at);
      const pending: PendingConfirmation = {
        toolName: row.tool,
        args,
        timestamp: Number.isFinite(requestedAt) ? requestedAt : 0,
        summary: row.summary ?? row.tool,
        argsSha256: row.args_sha256,
        approvalId: row.id,
      };
      pendingConfirmations.set(row.thread_key, pending);
      const notify = resolveBootNotifier(row.thread_key, row.id);
      if (notify) expiryNotifiers.set(row.thread_key, notify);
      const remaining = CONFIRMATION_TTL_MS - (Date.now() - pending.timestamp);
      if (remaining <= 0) {
        lapsePendingConfirmation(row.thread_key, pending);
        tally.lapsed++;
      } else {
        armExpiryTimer(row.thread_key, pending, remaining);
        tally.armed++;
      }
    }
    if (rows.length > 0) {
      console.log(
        `[confirmations] boot sweep: ${tally.armed} re-armed, ${tally.lapsed} lapsed (of ${rows.length} pending row(s), cap ${maxRows})`,
      );
    }
  } catch (err) {
    console.warn(
      `[confirmations] boot sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return tally;
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
    // Read before a late timer fired: the same one-notice expiry path.
    lapsePendingConfirmation(threadKey, pending);
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
  expiryNotifiers.delete(threadKey);
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
  expiryNotifiers.clear();
  pendingConfirmations.clear();
  bootNotifierResolver = null;
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
