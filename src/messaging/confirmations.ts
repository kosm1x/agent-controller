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

/** Patterns that indicate user confirms the pending operation.
 * Uses (\s|$|[.,!?]) instead of \b — word boundary breaks on accented chars (sí, envía). */
const CONFIRM_PATTERNS =
  /^(s[ií]|dale|hazlo|procede|adelante|ok|okey|va|confirmo|env[ií]a(lo)?|m[aá]ndalo|ejecuta|claro|por\s*favor|yes|go|confirm|send\s*it|do\s*it|approved?)(\s|$|[.,!?])/i;

/** Patterns that indicate user declines. */
const DECLINE_PATTERNS =
  /^(no|cancela(do)?|para|detente|stop|nope|nel|mejor\s*no|olv[ií]da(lo)?|don.?t|never\s*mind)(\s|$|[.,!?])/i;

/**
 * Detect if a user message is a confirmation or decline of a pending operation.
 * Only checks short messages (< 60 chars) to avoid false positives.
 * Returns null for ambiguous or unrelated messages.
 */
export function detectConfirmationResponse(
  text: string,
): "confirm" | "decline" | null {
  const stripped = text.replace(/^\[Grupo:.*?\]\n?/i, "").trim();
  // Only short messages are treated as confirmation/decline
  if (stripped.length > 60) return null;

  if (CONFIRM_PATTERNS.test(stripped)) return "confirm";
  if (DECLINE_PATTERNS.test(stripped)) return "decline";
  return null;
}
