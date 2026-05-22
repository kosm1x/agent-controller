/**
 * Tests for the pure classification logic of cleanup-jarvis-kb.ts — the
 * functions that decide what gets deleted from / moved within production.
 */
import { describe, it, expect } from "vitest";
import { deleteReason, moveTarget } from "./cleanup-jarvis-kb.js";

describe("cleanup-jarvis-kb — deleteReason", () => {
  it("flags a workspace [AUTO-PERSIST] dump by content marker", () => {
    expect(
      deleteReason({
        path: "workspace/procede-plan-2026-05-02.md",
        content: "[AUTO-PERSIST task=abc]\nUser: ...",
      }),
    ).toBe("workspace auto-persist dump");
  });

  it("KEEPS a real workspace note that has a date in its name but no marker", () => {
    // The exact pre-existing bug a filename-date heuristic would have caused.
    expect(
      deleteReason({
        path: "workspace/claude-code-panorama-2026-04-23.md",
        content: "# Panorama\nReal content.",
      }),
    ).toBeNull();
  });

  it("flags an execution-patterns tuning-hash file", () => {
    expect(
      deleteReason({
        path: "knowledge/execution-patterns/2026-04-25-66cfe010.md",
        content: "# Pattern",
      }),
    ).toBe("execution-patterns tuning hash");
  });

  it("KEEPS a named file inside execution-patterns (algebra-progress.md)", () => {
    expect(
      deleteReason({
        path: "knowledge/execution-patterns/algebra-progress.md",
        content: "# Álgebra",
      }),
    ).toBeNull();
  });

  it("does NOT match an uppercase-hex name — regex is lowercase-only (safe direction)", () => {
    expect(
      deleteReason({
        path: "knowledge/execution-patterns/2026-04-25-ABCDEF.md",
        content: "x",
      }),
    ).toBeNull();
  });

  it("flags dead session logs and compaction snapshots", () => {
    expect(
      deleteReason({ path: "logs/sessions/2026-04-02-x.md", content: "x" }),
    ).toBe("dead session log");
    expect(
      deleteReason({ path: "compaction/2026-04-09T05-06.md", content: "x" }),
    ).toBe("machine compaction snapshot");
  });

  it("NEVER flags protected namespaces, even with a noise-shaped payload", () => {
    expect(
      deleteReason({ path: "NorthStar/goal.md", content: "[AUTO-PERSIST]" }),
    ).toBeNull();
    expect(
      deleteReason({ path: "directives/rule.md", content: "[AUTO-PERSIST]" }),
    ).toBeNull();
  });

  it("keeps an ordinary knowledge file", () => {
    expect(
      deleteReason({
        path: "knowledge/people/fede-reference.md",
        content: "x",
      }),
    ).toBeNull();
  });
});

describe("cleanup-jarvis-kb — moveTarget", () => {
  it("relocates knowledge-base/ into knowledge/", () => {
    expect(moveTarget("knowledge-base/denue-intel/foo.md")).toBe(
      "knowledge/denue-intel/foo.md",
    );
  });

  it("relocates mexiconecesario/ and data-intelligence/", () => {
    expect(moveTarget("mexiconecesario/plan.md")).toBe(
      "projects/mexico-necesario-ac/docs/plan.md",
    );
    expect(moveTarget("data-intelligence/Fase_1.md")).toBe(
      "projects/data-intelligence/Fase_1.md",
    );
  });

  it("rescues algebra-progress.md out of execution-patterns", () => {
    expect(moveTarget("knowledge/execution-patterns/algebra-progress.md")).toBe(
      "knowledge/learning/algebra-progress.md",
    );
  });

  it("returns null for a row that is not misplaced", () => {
    expect(moveTarget("knowledge/people/fede-reference.md")).toBeNull();
    expect(moveTarget("workspace/farmacia-score-query.md")).toBeNull();
  });

  it("never moves protected namespaces", () => {
    expect(moveTarget("NorthStar/x.md")).toBeNull();
    expect(moveTarget("directives/x.md")).toBeNull();
  });
});
