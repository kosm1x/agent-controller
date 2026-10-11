/**
 * S6 ruling 5a audit R2 + queue item 3c — operator-only entry points:
 * cgroup allow-list (login session or operator unit) + TTY where required.
 * The bash twin (scripts/lib/operator-gate.sh) is held to the same matrix.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { operatorContextReason, operatorGateReason } from "./operator-gate.js";

const SESSION = "0::/user.slice/user-0.slice/session-29815.scope\n";
const MC = "0::/system.slice/mission-control.service\n";
const DOCKER = "0::/system.slice/docker-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope\n";
const V1_MULTI = "12:pids:/user.slice/user-0.slice/session-1.scope\n0::/user.slice/user-0.slice/session-1.scope\n";

describe("operatorGateReason (5a: { tty: true })", () => {
  it("passes only an interactive login session scope WITH a terminal", () => {
    expect(operatorGateReason(SESSION, true)).toBeNull();
    expect(operatorGateReason("0::/user.slice/user-1000.slice/session-7.scope", true)).toBeNull();
  });

  it("a login session without a terminal (pty-less pipe) is refused for the TTY", () => {
    expect(operatorGateReason(SESSION, false)).toBe("operator terminal required");
  });

  it("mission-control (every task) is named as such, TTY or not", () => {
    expect(operatorGateReason(MC, true)).toBe("running inside mission-control.service (a task)");
    expect(operatorGateReason(MC, false)).toBe("running inside mission-control.service (a task)");
  });

  it.each([
    ["docker scope", DOCKER],
    ["unshare -C (cgroup root)", "0::/\n"],
    ["systemd-run unit", "0::/system.slice/run-u123.service\n"],
    ["kb-janitor (an operator unit, but units never satisfy the terminal gate)", "0::/system.slice/kb-janitor.service\n"],
    ["user manager (not a session)", "0::/user.slice/user-0.slice/user@0.service/app.slice/x.service\n"],
    ["nested under a session scope", "0::/user.slice/user-0.slice/session-1.scope/child\n"],
    ["cgroup v1 line only", "12:pids:/user.slice/user-0.slice/session-1.scope\n"],
    ["v1/hybrid multi-line file", V1_MULTI],
    ["unreadable", ""],
  ])("%s is not an operator login session, TTY or not", (_n, line) => {
    expect(operatorGateReason(line, true)).toBe("not an operator login session");
    expect(operatorGateReason(line, false)).toBe("not an operator login session");
  });
});

// [name, cgroup text, isTTY, require TTY, expected reason]
const MATRIX: Array<[string, string, boolean, boolean, string | null]> = [
  ["session + TTY, tty mode", SESSION, true, true, null],
  ["session + TTY, context mode", SESSION, true, false, null],
  ["session no TTY, context mode (pipes allowed)", SESSION, false, false, null],
  ["session no TTY, tty mode", SESSION, false, true, "operator terminal required"],
  ["mission-control, context mode", MC, false, false, "running inside mission-control.service (a task)"],
  ["mission-control with a faked TTY", MC, true, false, "running inside mission-control.service (a task)"],
  ["cron.service (runs task-writable crontabs)", "0::/system.slice/cron.service\n", false, false, "not an operator login session or operator unit"],
  ["kb-janitor.service", "0::/system.slice/kb-janitor.service", false, false, null],
  ["v81-gate-check.service", "0::/system.slice/v81-gate-check.service\n", false, false, null],
  ["v82-shadow-verdict.service", "0::/system.slice/v82-shadow-verdict.service\n", false, false, null],
  ["recall-checkpoint.service (runs ops/ scripts)", "0::/system.slice/recall-checkpoint.service\n", false, false, "not an operator login session or operator unit"],
  ["post-reboot-verify.service (runs /root/*.sh)", "0::/system.slice/post-reboot-verify.service\n", false, false, "not an operator login session or operator unit"],
  ["kb-janitor.service in tty mode", "0::/system.slice/kb-janitor.service\n", true, true, "not an operator login session"],
  ["docker scope", DOCKER, false, false, "not an operator login session or operator unit"],
  ["cgroup root (unshare -C)", "0::/\n", false, false, "not an operator login session or operator unit"],
  ["child of an operator unit (anchored)", "0::/system.slice/kb-janitor.service/child\n", false, false, "not an operator login session or operator unit"],
  ["unit name prefix (anchored)", "0::/system.slice/xkb-janitor.service\n", false, false, "not an operator login session or operator unit"],
  ["other unit", "0::/system.slice/run-u123.service\n", false, false, "not an operator login session or operator unit"],
  ["v1/hybrid multi-line", V1_MULTI, true, false, "not an operator login session or operator unit"],
  ["unreadable", "", false, false, "not an operator login session or operator unit"],
];

describe("operatorContextReason (3c)", () => {
  it.each(MATRIX)("%s", (_n, text, tty, needTty, want) => {
    expect(operatorContextReason(text, tty, { tty: needTty })).toBe(want);
  });
});

describe("bash twin scripts/lib/operator-gate.sh", () => {
  const LIB = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/lib/operator-gate.sh");
  it.each(MATRIX)("%s", (_n, text, tty, needTty, want) => {
    const r = spawnSync(
      "bash",
      ["-c", 'source "$1"; _operator_context_reason "$2" "$3" "$4"', "_", LIB, text, tty ? "1" : "0", needTty ? "1" : "0"],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(want ?? "");
  });
});
