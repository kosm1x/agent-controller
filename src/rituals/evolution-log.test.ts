import { describe, it, expect, vi } from "vitest";

// createEvolutionLogEntry() calls countTodayConversations() → getDatabase().
// Stub the DB so the ritual builder runs without a real SQLite handle.
vi.mock("../db/index.js", () => ({
  getDatabase: () => ({
    prepare: () => ({ all: () => [] }),
  }),
}));

import { createEvolutionLogEntry } from "./evolution-log.js";

describe("createEvolutionLogEntry — append-only / no-overwrite invariants (2026-06-17 fix)", () => {
  const sub = createEvolutionLogEntry("2026-06-17");

  it("does NOT grant file_write — the overwrite footgun is excluded by construction", () => {
    // 2026-06-17: file_write truncated the 45 KB log to a single entry when the
    // ritual called it as an "append". No overwrite-capable file tool in scope is
    // layer 1; shell.ts's append-only gate on RITUAL_WRITABLE_DOCS is layer 2.
    expect(sub.tools).not.toContain("file_write");
    expect(sub.tools).not.toContain("jarvis_file_write");
  });

  it("still grants the read + append toolset (file_read, shell_exec)", () => {
    expect(sub.tools).toContain("file_read");
    expect(sub.tools).toContain("shell_exec");
  });

  it("mandates the shell_exec heredoc append as the write method", () => {
    expect(sub.description).toContain(
      "cat >> /root/claude/mission-control/docs/EVOLUTION-LOG.md << 'ENTRY'",
    );
    // The append operator is named as the only safe method.
    expect(sub.description).toContain(">>");
  });

  it("explicitly forbids file_write / whole-file overwrite of the log", () => {
    expect(sub.description).toMatch(/NEVER use file_write/);
    expect(sub.description).toMatch(/OVERWRITE/);
    // The single-`>` prohibition is load-bearing prose — pin it so a future edit
    // can't silently drop it (the shell-guard blocks `>` too, but defense-in-depth).
    expect(sub.description).toMatch(/a single `>` redirect/);
  });

  it("carries the anti-git-recovery guard (no forensics, no restore, no commit)", () => {
    expect(sub.description).toMatch(/Do NOT run git recovery or commits/i);
    expect(sub.description).toMatch(/git diff HEAD/);
    expect(sub.description).toMatch(/is NOT data loss/);
    expect(sub.description).toMatch(/git add.*git commit/);
  });

  it("keeps the append-only contract (do not modify existing entries)", () => {
    expect(sub.description).toMatch(/Do NOT modify existing entries/);
  });

  it("runs on the fast runner", () => {
    expect(sub.agentType).toBe("fast");
  });
});
