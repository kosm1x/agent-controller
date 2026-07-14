/**
 * Task-trace store tests — V8.5 Phase 6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  _resetTraceWarnThrottle,
  emitTraceEvent,
  getTrace,
  pruneTraceEvents,
} from "./task-trace.js";

beforeEach(() => {
  initDatabase(":memory:");
  // Emit-failure specs assert on console.warn; the 60s throttle is module
  // state, so reset it here to keep those specs order-independent.
  _resetTraceWarnThrottle();
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("emitTraceEvent / getTrace", () => {
  it("round-trips a full lifecycle in insertion order", () => {
    emitTraceEvent({
      taskId: "t-1",
      runId: "r-1",
      name: "task.started",
      attrs: { agent_type: "fast", title: "hola" },
    });
    emitTraceEvent({
      taskId: "t-1",
      runId: "r-1",
      name: "tool.called",
      round: 1,
      tool: "web_search",
    });
    emitTraceEvent({
      taskId: "t-1",
      runId: "r-1",
      name: "turn.completed",
      round: 1,
      tokensIn: 12000,
      tokensOut: 300,
      latencyMs: 2100,
    });
    emitTraceEvent({
      taskId: "t-1",
      runId: "r-1",
      name: "task.completed",
      tokensIn: 12000,
      tokensOut: 300,
      costUsd: 0.0123,
      latencyMs: 4200,
    });
    // Another task's events must not bleed in.
    emitTraceEvent({ taskId: "t-2", name: "task.started" });

    const trace = getTrace("t-1");
    expect(trace.map((e) => e.name)).toEqual([
      "task.started",
      "tool.called",
      "turn.completed",
      "task.completed",
    ]);
    expect(trace[0].run_id).toBe("r-1");
    expect(JSON.parse(trace[0].attrs!)).toEqual({
      agent_type: "fast",
      title: "hola",
    });
    expect(trace[1].tool).toBe("web_search");
    expect(trace[1].round).toBe(1);
    expect(trace[2].tokens_in).toBe(12000);
    expect(trace[3].cost_usd).toBeCloseTo(0.0123);
    // ts carries milliseconds (strftime %f) so latency is readable.
    expect(trace[0].ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(getTrace("t-2")).toHaveLength(1);
    expect(getTrace("ghost")).toEqual([]);
  });

  it("caps oversized attrs instead of storing them whole", () => {
    emitTraceEvent({
      taskId: "t-big",
      name: "task.failed",
      attrs: { error: "x".repeat(10_000) },
    });
    const [row] = getTrace("t-big");
    expect(row.attrs!.length).toBeLessThan(2200);
    expect(JSON.parse(row.attrs!)).toHaveProperty("truncated");
  });

  it("never throws when the insert fails (best-effort contract)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getDatabase().exec("DROP TABLE task_trace_events");
    expect(() =>
      emitTraceEvent({ taskId: "t-x", name: "task.started" }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("pruneTraceEvents", () => {
  it("deletes only rows older than the window", () => {
    const db = getDatabase();
    emitTraceEvent({ taskId: "t-new", name: "task.started" });
    db.prepare(
      `INSERT INTO task_trace_events (task_id, name, ts)
       VALUES ('t-old', 'task.started',
               strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days'))`,
    ).run();

    const removed = pruneTraceEvents(30);
    expect(removed).toBe(1);
    expect(getTrace("t-old")).toEqual([]);
    expect(getTrace("t-new")).toHaveLength(1);
  });

  it("returns 0 (never throws) when the table is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getDatabase().exec("DROP TABLE task_trace_events");
    expect(pruneTraceEvents()).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});
