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
 */

/** Pending confirmation waiting for user approval. */
export interface PendingConfirmation {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
  /** Human-readable summary for logging. */
  summary: string;
}

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** In-memory store of pending confirmations, keyed by thread key. */
const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Timers for auto-expiry. */
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Store a pending confirmation for a thread.
 * Overwrites any existing pending for the same thread.
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

  pendingConfirmations.set(threadKey, {
    toolName,
    args,
    timestamp: Date.now(),
    summary,
  });

  // Auto-expire
  expiryTimers.set(
    threadKey,
    setTimeout(() => {
      pendingConfirmations.delete(threadKey);
      expiryTimers.delete(threadKey);
    }, CONFIRMATION_TTL_MS),
  );
}

/**
 * Get a pending confirmation for a thread. Returns null if none or expired.
 */
export function getPendingConfirmation(
  threadKey: string,
): PendingConfirmation | null {
  const pending = pendingConfirmations.get(threadKey);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > CONFIRMATION_TTL_MS) {
    clearPendingConfirmation(threadKey);
    return null;
  }
  return pending;
}

/**
 * Clear a pending confirmation for a thread.
 */
export function clearPendingConfirmation(threadKey: string): void {
  pendingConfirmations.delete(threadKey);
  const timer = expiryTimers.get(threadKey);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(threadKey);
  }
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
