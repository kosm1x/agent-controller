/**
 * Reflection runner tests (V8.1 Phase 4 B3) — harness wiring + role-reframe.
 * fastRunner is mocked: tests never invoke real inference.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import type { RunnerOutput } from "../runners/types.js";

const executeMock = vi.fn();
vi.mock("../runners/fast-runner.js", () => ({
  fastRunner: { type: "fast", execute: (...a: unknown[]) => executeMock(...a) },
}));

import { readCursor } from "./cursors.js";
import { buildReflectionScope } from "./scope.js";
import {
  runReflection,
  buildReflectionMessage,
  ROLE_REFRAME,
  REFLECTION_TOOLS,
} from "./runner.js";

const ok: RunnerOutput = { success: true, output: "summary", durationMs: 1 };
const fail: RunnerOutput = { success: false, error: "boom", durationMs: 1 };

beforeEach(() => {
  initDatabase(":memory:");
  executeMock.mockReset();
});

afterEach(() => {
  closeDatabase();
});

function insertTasks(n: number): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      db.prepare(
        "INSERT INTO tasks (task_id, title, description, status) VALUES (?, ?, ?, 'completed')",
      ).run(`t-${crypto.randomUUID()}`, `task ${i}`, "desc");
    }
  });
  tx();
}

describe("buildReflectionMessage", () => {
  it("injects the role-reframe inside a <system-reminder> block", () => {
    const scope = (() => {
      insertTasks(2);
      return buildReflectionScope("morning_brief", "n-turn");
    })();
    const msg = buildReflectionMessage(scope);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("</system-reminder>");
    expect(msg).toContain(ROLE_REFRAME);
    // The reframe must precede the delta — identity framing comes first.
    expect(msg.indexOf(ROLE_REFRAME)).toBeLessThan(msg.indexOf("Bounded diff"));
  });

  it("renders every delta event", () => {
    insertTasks(3);
    const scope = buildReflectionScope("morning_brief", "n-turn");
    const msg = buildReflectionMessage(scope);
    for (const e of scope.deltaEvents) {
      expect(msg).toContain(`event ${e.eventId}`);
    }
  });
});

describe("runReflection", () => {
  it("is a no-op on an empty delta — no inference, cursor unmoved", async () => {
    const res = await runReflection({
      cursorName: "morning_brief",
      trigger: "n-turn",
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("empty-delta");
    expect(executeMock).not.toHaveBeenCalled();
    expect(readCursor("morning_brief").lastEventId).toBe(0);
  });

  it("invokes fastRunner with the read-only allowlist and advances the cursor on success", async () => {
    insertTasks(4);
    executeMock.mockResolvedValue(ok);
    const res = await runReflection({
      cursorName: "morning_brief",
      trigger: "n-turn",
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const input = executeMock.mock.calls[0]![0] as {
      tools: string[];
      conversationHistory: { role: string; content: string }[];
      interactive: boolean;
    };
    expect(input.tools).toEqual([...REFLECTION_TOOLS]);
    expect(input.interactive).toBe(false);
    expect(input.conversationHistory[0]!.content).toContain(ROLE_REFRAME);

    expect(res.ran).toBe(true);
    expect(res.cursorAdvancedTo).toBe(4);
    expect(readCursor("morning_brief").lastEventId).toBe(4);
  });

  it("does NOT advance the cursor when the runner fails", async () => {
    insertTasks(4);
    executeMock.mockResolvedValue(fail);
    const res = await runReflection({
      cursorName: "morning_brief",
      trigger: "n-turn",
    });
    expect(res.ran).toBe(true);
    expect(res.reason).toBe("runner-failed");
    // Cursor stays at 0 so the next pass retries the same delta.
    expect(readCursor("morning_brief").lastEventId).toBe(0);
  });

  it("maps a thrown fastRunner error to a failed pass — cursor unmoved (W1)", async () => {
    insertTasks(4);
    executeMock.mockRejectedValue(new Error("registry boom"));
    const res = await runReflection({
      cursorName: "morning_brief",
      trigger: "n-turn",
    });
    expect(res.ran).toBe(true);
    expect(res.reason).toBe("runner-failed");
    expect(res.output?.success).toBe(false);
    expect(readCursor("morning_brief").lastEventId).toBe(0);
  });

  it("allowlist is read-only — no write/proposed tools (Phase 6 adds those)", () => {
    expect(REFLECTION_TOOLS).not.toContain("proposed_briefings");
    expect(
      REFLECTION_TOOLS.some((t) => /write|create|update|delete|send/.test(t)),
    ).toBe(false);
  });
});
