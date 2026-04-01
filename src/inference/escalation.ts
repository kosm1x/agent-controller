/**
 * Graduated escalation ladder — replaces binary guard-break→wrap-up
 * with a 4-level progressive response to guard triggers.
 *
 * Level 1: RETRY_DIFFERENT  — inject nudge, continue loop
 * Level 2: ESCALATE_MODEL   — switch to stronger model, continue loop
 * Level 3: FORCE_WRAPUP     — break loop, quality gate on wrap-up
 * Level 4: ABORT            — break loop, BLOCKED status, no wrap-up
 *
 * Also includes phantom action detection (claims action without tool call).
 */

export type EscalationLevel = 1 | 2 | 3 | 4;

export interface EscalationAction {
  level: EscalationLevel;
  action: "RETRY_DIFFERENT" | "ESCALATE_MODEL" | "FORCE_WRAPUP" | "ABORT";
  message: string;
}

export interface EscalationState {
  currentLevel: EscalationLevel;
  triggerCount: number;
}

export function createEscalationState(): EscalationState {
  return { currentLevel: 1, triggerCount: 0 };
}

/**
 * Advance the escalation ladder. Each guard trigger increments the level.
 * Level progression: 1 → 2 → 3 → 4 (never goes back down).
 */
export function escalate(state: EscalationState): EscalationAction {
  state.triggerCount++;

  // Map trigger count to escalation level
  if (state.triggerCount >= 4) {
    state.currentLevel = 4;
  } else if (state.triggerCount >= 3) {
    state.currentLevel = 3;
  } else if (state.triggerCount >= 2) {
    state.currentLevel = 2;
  } else {
    state.currentLevel = 1;
  }

  switch (state.currentLevel) {
    case 1:
      return {
        level: 1,
        action: "RETRY_DIFFERENT",
        message:
          "SYSTEM: Your approach is repeating or stuck. Try a completely different strategy — use different tools, rephrase your approach, or proceed with what you have.",
      };
    case 2:
      return {
        level: 2,
        action: "ESCALATE_MODEL",
        message:
          "SYSTEM: Multiple guard triggers detected. Switching to a stronger model for this task.",
      };
    case 3:
      return {
        level: 3,
        action: "FORCE_WRAPUP",
        message:
          "SYSTEM: Persistent guard triggers. Forcing wrap-up with quality verification.",
      };
    case 4:
      return {
        level: 4,
        action: "ABORT",
        message: "SYSTEM: Guard escalation exhausted. Aborting task.",
      };
  }
}

// ---------------------------------------------------------------------------
// Phantom action detection
// ---------------------------------------------------------------------------

/** Action verbs in Spanish and English that claim a mutation was performed. */
const ACTION_VERBS = [
  // Spanish past tense
  "envié",
  "mandé",
  "publiqué",
  "creé",
  "actualicé",
  "eliminé",
  "borré",
  "guardé",
  "subí",
  "programé",
  // English past tense
  "sent ",
  "posted ",
  "emailed ",
  "delivered ",
  "published ",
  "created ",
  "updated ",
  "deleted ",
  "uploaded ",
  "scheduled ",
];

/** Channels/targets that indicate external delivery. */
const CHANNEL_REFS = [
  "telegram",
  "whatsapp",
  "slack",
  "email",
  "gmail",
  "correo",
  "calendar",
  "calendario",
  "sheet",
  "hoja",
  "wordpress",
  "blog",
  "drive",
];

/** Tools that correspond to external delivery actions. */
const DELIVERY_TOOLS = new Set([
  "gmail_send",
  "wp_publish",
  "wp_media_upload",
  "wp_delete",
  "gdrive_create",
  "gdrive_share",
  "gsheets_write",
  "gdocs_write",
  "gslides_create",
  "calendar_create",
  "calendar_update",
  "gtasks_create",
  "schedule_task",
  "shell_exec",
]);

export interface PhantomAction {
  verb: string;
  channel: string;
}

/**
 * Detect claims of external actions without matching tool calls.
 * Returns detected phantoms (empty array = no phantoms).
 */
export function detectPhantomActions(
  llmText: string,
  toolCallNames: string[],
): PhantomAction[] {
  if (!llmText || llmText.length < 20) return [];

  const lower = llmText.toLowerCase();
  const calledSet = new Set(toolCallNames);

  // Check if any delivery tool was actually called
  const hasDeliveryCall = [...DELIVERY_TOOLS].some((t) => calledSet.has(t));
  if (hasDeliveryCall) return [];

  const phantoms: PhantomAction[] = [];
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb.toLowerCase())) {
      for (const channel of CHANNEL_REFS) {
        if (lower.includes(channel)) {
          phantoms.push({ verb: verb.trim(), channel });
          break; // one phantom per verb is enough
        }
      }
    }
  }
  return phantoms;
}
