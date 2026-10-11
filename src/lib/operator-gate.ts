/**
 * S6 ruling 5a (audit R2) + queue item 3c: operator-only scripts run from an
 * operator context, never from a task. An ALLOW-list on the process cgroup:
 * a login session lives in `user.slice/user-<uid>.slice/session-<n>.scope`;
 * the few systemd units that run operator scripts on a schedule are named in
 * OPERATOR_UNIT_RE (a task cannot author a unit: `systemctl`/`crontab` are
 * shell deny-verbs). mission-control (`system.slice/mission-control.service`,
 * where every task runs), docker / opensandbox scopes, `systemd-run` units
 * and `unshare -C` (`0::/`) are refused. A pty wrapper (`script`,
 * `pty.spawn`) fakes a TTY but not the cgroup. No env or flag override.
 * Bash twin: scripts/lib/operator-gate.sh (same regexes).
 */

import { readFileSync } from "node:fs";

/** cgroup v2 line of an interactive login session (observed: `0::/user.slice/user-0.slice/session-29815.scope`). */
const OPERATOR_SESSION_RE = /^0::\/user\.slice\/user-\d+\.slice\/session-\d+\.scope$/;
/**
 * Units that run operator scripts unattended, each from a fixed repo path. Not cron,
 * recall-checkpoint or post-reboot-verify: they run code a task can write (crontab, ops/ scripts).
 */
const OPERATOR_UNIT_RE = /^0::\/system\.slice\/(?:v81-gate-check|v82-shadow-verdict|kb-janitor)\.service$/;
const TASK_RE = /^0::\/system\.slice\/mission-control\.service$/;

/**
 * Pure: why this process may not run an operator-only script, or null.
 * The whole file must be ONE cgroup v2 line (a v1/hybrid multi-line file is
 * refused). `{ tty: true }`: login session + both TTYs (units do not count).
 * `{ tty: false }`: login session (pipes allowed) or an operator unit.
 */
export function operatorContextReason(
  cgroupText: string,
  isTTY: boolean,
  opts: { tty: boolean },
): string | null {
  const line = cgroupText.replace(/\n$/, "");
  if (TASK_RE.test(line)) return "running inside mission-control.service (a task)";
  if (OPERATOR_SESSION_RE.test(line)) {
    if (opts.tty && !isTTY) return "operator terminal required";
    return null;
  }
  if (opts.tty) return "not an operator login session";
  if (OPERATOR_UNIT_RE.test(line)) return null;
  return "not an operator login session or operator unit";
}

/** 5a name for the `{ tty: true }` case. */
export function operatorGateReason(cgroupText: string, isTTY: boolean): string | null {
  return operatorContextReason(cgroupText, isTTY, { tty: true });
}

/** Exit 2 with the reason unless this is an operator context. Call before main() and any db/KB side effect. */
export function requireOperatorContext(tag: string, opts: { tty: boolean }): void {
  let cgroup = "";
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf-8");
  } catch {
    // unreadable → no session line → refused
  }
  const reason = operatorContextReason(cgroup, !!(process.stdin.isTTY && process.stdout.isTTY), opts);
  if (reason) {
    console.error(`[${tag}] ${reason}; this script is not callable from a task`);
    process.exit(2);
  }
}

/** 5a name: operator login session WITH a terminal. */
export function requireOperatorTerminal(tag: string): void {
  requireOperatorContext(tag, { tty: true });
}
