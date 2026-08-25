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

  // Layer D — read-only mount + host-DB guard (2026-08-20 AMN PDF ingestion
  // incident). The agent burned its 10-turn cap diagnosing file permissions when
  // the wall was the READ-ONLY mount. Must fire on BOTH branches so the guard is
  // always present regardless of whether a writable workspace exists.
  it.each([["/workspace"], [null]] as const)(
    "includes the READ-ONLY MOUNT guard naming data/mc.db and host-side tools (workspace=%s)",
    (ws) => {
      const note = buildEnvironmentNote(ws);
      expect(note).toContain("READ-ONLY MOUNT");
      expect(note).toContain("data/mc.db");
      expect(note).toMatch(/gemini_upload/i);
      expect(note).toMatch(/jarvis_file_write/i);
      // Must explicitly say the mount wins — not file permissions
      expect(note).toMatch(/mount.*wins|MOUNT.*always wins/i);
      // Must tell the agent NOT to spend turns diagnosing permissions
      expect(note).toMatch(/do NOT spend turns|stop immediately/i);
    },
  );

  // Mutation-verify: removing the roMountGuard from buildEnvironmentNote breaks
  // the test above (this assertion is the wiring check — if the guard text is
  // absent, the .toContain("READ-ONLY MOUNT") assertion fails first).
  it("roMountGuard text is actually included in both branches", () => {
    for (const ws of ["/workspace", null] as const) {
      const note = buildEnvironmentNote(ws);
      // Both strings are unique to the roMountGuard block — not in base/scope/evasion.
      expect(note).toContain("attempt to write a readonly database");
      expect(note).toContain("dead end");
    }
  });
});
