/**
 * S6 ruling 5a audit R2 — operator-only scripts: cgroup allow-list + TTY.
 */

import { describe, expect, it } from "vitest";
import { operatorGateReason } from "./operator-gate.js";

const SESSION = "0::/user.slice/user-0.slice/session-29815.scope\n";

describe("operatorGateReason", () => {
  it("passes only an interactive login session scope WITH a terminal", () => {
    expect(operatorGateReason(SESSION, true)).toBeNull();
    expect(operatorGateReason("0::/user.slice/user-1000.slice/session-7.scope", true)).toBeNull();
  });

  it("a login session without a terminal (pty-less pipe) is refused for the TTY", () => {
    expect(operatorGateReason(SESSION, false)).toBe("operator terminal required");
  });

  it.each([
    ["mission-control service", "0::/system.slice/mission-control.service\n"],
    ["docker scope", "0::/system.slice/docker-2c226d58308889b8b7ac56f0c572f98fd629064696aca3b32f432f65665b22ff.scope\n"],
    ["unshare -C (cgroup root)", "0::/\n"],
    ["systemd-run unit", "0::/system.slice/run-u123.service\n"],
    ["cron", "0::/system.slice/cron.service\n"],
    ["user manager (not a session)", "0::/user.slice/user-0.slice/user@0.service/app.slice/x.service\n"],
    ["nested under a session scope", "0::/user.slice/user-0.slice/session-1.scope/child\n"],
    ["cgroup v1 line only", "12:pids:/user.slice/user-0.slice/session-1.scope\n"],
    ["unreadable", ""],
  ])("%s is not an operator login session, TTY or not", (_n, line) => {
    expect(operatorGateReason(line, true)).toBe("not an operator login session");
    expect(operatorGateReason(line, false)).toBe("not an operator login session");
  });
});
