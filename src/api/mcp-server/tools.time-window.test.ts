/**
 * Time windows of the jarvis_* MCP tools on the real schema.
 *
 * Database times come in two text formats: datetime('now') writes UTC without
 * a zone marker (`2026-01-02 03:04:05`), JavaScript writes ISO
 * (`2026-01-02T03:04:05.000Z`). Compared as strings, a zone-less value sorts
 * below every ISO value of the same calendar date, so each comparison must put
 * both sides in one format.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { PersistentEventBus } from "../../lib/events/bus.js";
import { logMcpCall } from "./audit.js";
import { registerJarvisTools } from "./tools.js";
import type { McpDeps } from "./types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
}>;

class ToolRegistry {
  handlers = new Map<string, ToolHandler>();
  registerTool(name: string, _config: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

let registry: ToolRegistry;
let bus: PersistentEventBus;

beforeEach(() => {
  const db = initDatabase(":memory:");
  // The events table belongs to the event bus; constructing it creates the table.
  bus = new PersistentEventBus({ db, cleanupIntervalMs: 0 });
  const memory: McpDeps["memory"] = {
    retain: vi.fn(async () => {}),
    recall: vi.fn(async () => []),
    reflect: vi.fn(async () => ""),
    isHealthy: vi.fn(async () => true),
    backend: "sqlite",
  };
  registry = new ToolRegistry();
  registerJarvisTools(
    registry as unknown as Parameters<typeof registerJarvisTools>[0],
    { db, memory, startedAt: Date.now() },
  );
});

afterEach(() => {
  bus.destroy();
  closeDatabase();
});

async function call(
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await registry.handlers.get(tool)!(args);
  const parsed = JSON.parse(r.content[0].text) as {
    ok: boolean;
    data: Record<string, unknown>;
  };
  expect(parsed.ok).toBe(true);
  return parsed.data;
}

describe("jarvis_recent_events — events.timestamp holds both formats", () => {
  function busEvent(id: string, timestamp: string) {
    return {
      id,
      type: "task.failed",
      category: "task",
      timestamp,
      workspace_id: "default",
      data: { task_id: id },
      correlation_id: "",
      sequence: 0,
    } as unknown as Parameters<PersistentEventBus["emitRaw"]>[0];
  }

  it("counts ISO and zone-less rows inside the window and drops both just outside", async () => {
    const hour = 3_600_000;
    const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();
    // ISO rows, as the event bus writes them.
    bus.emitRaw(busEvent("iso-inside", isoAgo(hour - 60_000)));
    bus.emitRaw(busEvent("iso-outside", isoAgo(hour + 1_000)));
    // Zone-less rows: one as the audit writer writes it, one just outside.
    logMcpCall(getDatabase(), { id: 1, clientName: "c", scope: "read_only" }, "request_received");
    getDatabase()
      .prepare(
        `INSERT INTO events (id, type, category, timestamp, workspace_id, data)
         VALUES ('plain-outside', 'task.failed', 'task', datetime('now', '-3601 seconds'), 'default', '{}')`,
      )
      .run();

    const stamps = getDatabase()
      .prepare("SELECT id, timestamp FROM events ORDER BY sequence")
      .all() as Array<{ id: string; timestamp: string }>;
    expect(stamps[0].timestamp).toMatch(/T.*Z$/);
    expect(stamps[2].timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const data = await call("jarvis_recent_events", { hours: 1 });
    const ids = (data.events as Array<{ type: string; data: string }>).map(
      (e) => (e.type === "task.failed" ? (JSON.parse(e.data) as { task_id: string }).task_id : e.type),
    );
    expect(ids.sort()).toEqual(["iso-inside", "request_received"]);
  });
});

describe("jarvis_task_list — `since` against zone-less tasks.created_at", () => {
  beforeEach(() => {
    const ins = getDatabase().prepare(
      "INSERT INTO tasks (task_id, title, description, status, created_at) VALUES (?, 't', 'd', 'completed', ?)",
    );
    ins.run("before", "2026-03-10 11:59:59");
    ins.run("at", "2026-03-10 12:00:00");
    ins.run("after", "2026-03-10 12:00:01");
  });

  async function since(value: string): Promise<string[]> {
    const data = await call("jarvis_task_list", { since: value });
    return (data.tasks as Array<{ task_id: string }>).map((t) => t.task_id).sort();
  }

  it("an ISO `since` compares by time", async () => {
    expect(await since("2026-03-10T12:00:00.000Z")).toEqual(["after", "at"]);
  });

  it("a zone-less `since` compares by time", async () => {
    expect(await since("2026-03-10 12:00:00")).toEqual(["after", "at"]);
  });

  it("a `since` with an offset is converted to UTC", async () => {
    expect(await since("2026-03-10T06:00:00-06:00")).toEqual(["after", "at"]);
  });

  it("a `since` with a colon-less offset is converted to UTC", async () => {
    expect(await since("2026-03-10T06:00:00-0600")).toEqual(["after", "at"]);
  });

  it("a `since` with a lowercase `z` compares like `Z`", async () => {
    expect(await since("2026-03-10T12:00:00z")).toEqual(["after", "at"]);
  });

  it("a date-only `since` starts at UTC midnight", async () => {
    expect(await since("2026-03-10")).toEqual(["after", "at", "before"]);
  });

  it("an unparseable `since` is bound as given (a plain text comparison)", async () => {
    expect(await since("yesterday")).toEqual([]);
    expect(await since("1")).toEqual(["after", "at", "before"]);
    expect(await since("3")).toEqual([]); // not read as a lenient date (2003)
    expect(await since("2026-13-45")).toEqual([]);
  });
});
