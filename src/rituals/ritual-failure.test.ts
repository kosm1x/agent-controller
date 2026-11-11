/**
 * recordRitualFailure — one schedule.run_failed event per failure, and a bus
 * that throws never turns a recorded failure into a second one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const { mockEmit, mockGetEventBus } = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockGetEventBus = vi.fn(() => ({ emitEvent: mockEmit }));
  return { mockEmit, mockGetEventBus };
});
vi.mock("../lib/event-bus.js", () => ({
  getEventBus: () => mockGetEventBus(),
}));

import { recordRitualFailure } from "./ritual-failure.js";

describe("recordRitualFailure", () => {
  beforeEach(() => {
    mockEmit.mockReset();
    mockGetEventBus.mockReset();
    mockGetEventBus.mockImplementation(() => ({ emitEvent: mockEmit }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits exactly one schedule.run_failed event with ritual_id, error and phase", () => {
    recordRitualFailure("kb-backup", new Error("disk full"), "execute");
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith("schedule.run_failed", {
      ritual_id: "kb-backup",
      error: "disk full",
      phase: "execute",
    });
  });

  it("passes the submit phase through", () => {
    recordRitualFailure("morning-briefing", "boom", "submit");
    expect(mockEmit.mock.calls[0]![1]).toMatchObject({ phase: "submit" });
  });

  it("truncates the error message to 1000 characters", () => {
    recordRitualFailure("diff-digest", new Error("x".repeat(1500)), "execute");
    const payload = mockEmit.mock.calls[0]![1] as { error: string };
    expect(payload.error).toBe("x".repeat(1000));
  });

  it("does not throw when the event bus throws, and logs both errors", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetEventBus.mockImplementation(() => {
      throw new Error("Event bus not initialized");
    });
    expect(() =>
      recordRitualFailure("canary", new Error("db locked"), "execute"),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0]![0]);
    expect(line).toContain("Event bus not initialized");
    expect(line).toContain("db locked");
  });

  it("does not throw when emitEvent itself throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockEmit.mockImplementation(() => {
      throw new Error("SQLITE_MISUSE");
    });
    expect(() =>
      recordRitualFailure("kb-reindex", "x", "execute"),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain("SQLITE_MISUSE");
  });
});

const readSource = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STATIC_SCHEDULER_IMPORT = /from\s*["'][^"']*scheduler\.js["']/;
const RECORDER_FROM_LEAF =
  /import\s*\{[^}]*\brecordRitualFailure\b[^}]*\}\s*from\s*["'][^"']*ritual-failure\.js["']/;

describe("ritual-failure module boundary", () => {
  it("imports only the event bus accessor and the error-message helper", () => {
    const src = readSource("./ritual-failure.ts");
    expect(src.match(/^import\b/gm) ?? []).toHaveLength(2);
    const specifiers = [
      ...src.matchAll(/^import\b[^;]*?from\s*["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    expect(specifiers.sort()).toEqual([
      "../lib/err-msg.js",
      "../lib/event-bus.js",
    ]);
  });

  it.each(["./canary.ts", "../finance/weekly-refresh-cron.ts"])(
    "%s imports the recorder from the leaf module, never from the scheduler",
    (rel) => {
      const src = readSource(rel);
      expect(src).not.toMatch(STATIC_SCHEDULER_IMPORT);
      expect(src).toMatch(RECORDER_FROM_LEAF);
    },
  );

  it("scheduler re-exports the recorder from ./ritual-failure.js for its call-time importers", () => {
    expect(readSource("./scheduler.ts")).toMatch(
      /export\s*\{[^}]*\brecordRitualFailure\b[^}]*\}\s*from\s*["']\.\/ritual-failure\.js["']/,
    );
  });
});
