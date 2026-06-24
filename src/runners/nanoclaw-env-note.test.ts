import { describe, it, expect } from "vitest";
import {
  buildEnvironmentNote,
  RO_REPO,
  TARGET_NOT_IN_SANDBOX,
  emittedTargetNotInSandbox,
} from "./nanoclaw-env-note.js";

describe("buildEnvironmentNote — nanoclaw sandbox guards", () => {
  it("workspace branch carries the workspace path + delivery mechanics", () => {
    const note = buildEnvironmentNote("/workspace");
    expect(note).toContain("/workspace");
    expect(note).toContain("git push -u origin");
    expect(note).toContain(RO_REPO);
  });

  it("read-only branch states it cannot commit", () => {
    const note = buildEnvironmentNote(null);
    expect(note).toContain("READ-ONLY");
    expect(note).toContain("cannot commit");
  });

  // Layer B — sandbox-scope guard (the EurekaMS-Landing misroute fix). Must fire
  // on BOTH branches: the agent should never edit mc's own source as a substitute
  // for an absent target, and must emit the structured TARGET_NOT_IN_SANDBOX stop.
  it.each([["/workspace"], [null]] as const)(
    "includes the SANDBOX SCOPE guard (workspace=%s)",
    (ws) => {
      const note = buildEnvironmentNote(ws);
      expect(note).toContain("SANDBOX SCOPE");
      expect(note).toContain("ONLY the mission-control repository");
      expect(note).toContain("TARGET_NOT_IN_SANDBOX");
      expect(note).toMatch(/CRITICAL error/i);
    },
  );

  // Layer C — no-evasion guard. The 2026-06-24 agent base64-decoded "commit" and
  // wrote a wrapper script to dodge the shell-guard; forbid that explicitly.
  it.each([["/workspace"], [null]] as const)(
    "includes the NO-EVASION guard (workspace=%s)",
    (ws) => {
      const note = buildEnvironmentNote(ws);
      expect(note).toContain("GUARD POLICY");
      expect(note).toContain("HARD STOP");
      expect(note).toMatch(/base64/i);
      expect(note).toMatch(/wrapper scripts/i);
    },
  );

  // The structural backstop (qa W2): the prompt tells the agent to emit the
  // sentinel, and the worker turns it into a hard failure. These two must use the
  // SAME literal or the backstop silently breaks — assert they stay in sync.
  it("the env-note prompt actually contains the sentinel the worker checks for", () => {
    expect(buildEnvironmentNote("/workspace")).toContain(TARGET_NOT_IN_SANDBOX);
    expect(buildEnvironmentNote(null)).toContain(TARGET_NOT_IN_SANDBOX);
  });

  it("emittedTargetNotInSandbox detects the sentinel in an agent summary", () => {
    expect(
      emittedTargetNotInSandbox(
        `${TARGET_NOT_IN_SANDBOX}: this task targets EurekaMS-Landing, not here.`,
      ),
    ).toBe(true);
    expect(
      emittedTargetNotInSandbox("Fixed the regex and pushed branch fix/foo."),
    ).toBe(false);
    expect(emittedTargetNotInSandbox("")).toBe(false);
  });
});
