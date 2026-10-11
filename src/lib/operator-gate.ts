/**
 * S6 ruling 5a (audit R2): operator-only scripts run from an interactive
 * operator login, never from a task. An ALLOW-list on the process cgroup:
 * a login session lives in `user.slice/user-<uid>.slice/session-<n>.scope`;
 * mission-control (`system.slice/mission-control.service`), docker /
 * opensandbox scopes, cron, `systemd-run` units and `unshare -C` (`0::/`)
 * do not. A pty wrapper (`script`, `pty.spawn`) fakes a TTY but not the
 * cgroup, so both conditions are required. No env or flag override.
 */

import { readFileSync } from "node:fs";

/** cgroup v2 line of an interactive login session (observed: `0::/user.slice/user-0.slice/session-29815.scope`). */
const OPERATOR_SESSION_RE = /^0::\/user\.slice\/user-\d+\.slice\/session-\d+\.scope$/m;

/** Pure: why this process may not run an operator-only script, or null. */
export function operatorGateReason(cgroupText: string, isTTY: boolean): string | null {
  if (!OPERATOR_SESSION_RE.test(cgroupText)) return "not an operator login session";
  if (!isTTY) return "operator terminal required";
  return null;
}

/** Exit 2 with the reason unless this is an operator terminal. Call before main(). */
export function requireOperatorTerminal(tag: string): void {
  let cgroup = "";
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf-8");
  } catch {
    // unreadable → no session line → refused
  }
  const reason = operatorGateReason(cgroup, !!(process.stdin.isTTY && process.stdout.isTTY));
  if (reason) {
    console.error(`[${tag}] ${reason}; this script is not callable from a task`);
    process.exit(2);
  }
}
