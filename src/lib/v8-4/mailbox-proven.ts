/**
 * Proven (per task, memory only): fingerprints the mailbox tool printed in
 * this run (mailbox-passwords.ts registers them),
 * plus the candidates of this turn's user message. Freed with the run's
 * evidence (numbers.ts `takeToolEvidence`); a task id once freed never takes
 * proof again, so a late record cannot outlive it.
 *
 * A leaf on purpose: numbers.ts imports it, so it imports only the pure gate
 * (no database, no registry).
 */

import { candidateFingerprints } from "./password-gate.js";

/** Freed task ids remembered, so a late proof record is refused. */
const MAX_CLOSED_TASKS = 1024;

const provenByTask = new Map<string, Set<string>>();
const closedTasks = new Set<string>();

export function recordProvenPasswords(
  taskId: string,
  fingerprints: readonly string[],
): void {
  if (!taskId || fingerprints.length === 0 || closedTasks.has(taskId)) return;
  let set = provenByTask.get(taskId);
  if (!set) {
    set = new Set();
    provenByTask.set(taskId, set);
  }
  for (const fp of fingerprints) set.add(fp);
}

/** This turn's user message: its candidates are proof for the task. */
export function recordUserPasswordProof(taskId: string, message: string): void {
  if (!taskId || !message) return;
  recordProvenPasswords(taskId, candidateFingerprints(message));
}

export function provenPasswords(
  taskId: string | undefined,
): ReadonlySet<string> {
  return (taskId && provenByTask.get(taskId)) || new Set<string>();
}

/** Frees the task's proven set; the task id takes no proof afterwards. */
export function forgetProvenPasswords(taskId: string): void {
  if (!taskId) return;
  provenByTask.delete(taskId);
  closedTasks.add(taskId);
  if (closedTasks.size > MAX_CLOSED_TASKS) {
    closedTasks.delete(closedTasks.values().next().value!);
  }
}

/** @internal test hook */
export function _resetMailboxProven(): void {
  provenByTask.clear();
  closedTasks.clear();
}
