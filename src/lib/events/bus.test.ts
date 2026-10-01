/**
 * PersistentEventBus — persisted-copy credential redaction.
 *
 * events.data is a durable sink (served by /api/events/stream replay and
 * jarvis_recent_events, shipped in nightly backups), so the row written to
 * SQLite is credential-redacted. The in-memory event delivered to
 * subscribers is NOT: the router delivers task results from it.
 *
 * The fake key is assembled at runtime so no key-shaped literal is committed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { PersistentEventBus } from "./bus.js";
import type { Event } from "./types.js";

const SECRET = "sk-" + "a".repeat(24);

describe("PersistentEventBus persisted-copy redaction", () => {
  let db: Database.Database;
  let bus: PersistentEventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    bus = new PersistentEventBus({ db, cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    bus.destroy();
    db.close();
    vi.restoreAllMocks();
  });

  function storedData(id: string): string {
    return (
      db.prepare("SELECT data FROM events WHERE id = ?").get(id) as {
        data: string;
      }
    ).data;
  }

  function failedPayload() {
    return {
      task_id: "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b",
      agent_id: "fast",
      error: `provider 401: invalid key ${SECRET}`,
      recoverable: false,
      attempts: 1,
      result: { finalAnswer: "partial", nested: [{ echo: `key=${SECRET}` }] },
    };
  }

  it("task.failed: the events row is redacted, the subscriber gets the raw object", () => {
    const data = failedPayload();
    const snapshot = structuredClone(data);
    const received: Event[] = [];
    bus.subscribe("task.failed", (e) => {
      received.push(e);
    });

    const event = bus.emitEvent("task.failed", data);

    const row = storedData(event.id);
    expect(row).not.toContain(SECRET);
    expect(row).toContain("[REDACTED_KEY]");
    expect(JSON.parse(row)).toMatchObject({
      task_id: data.task_id,
      error: "provider 401: invalid key [REDACTED_KEY]",
    });

    // Subscriber: same reference the caller passed, contents untouched.
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toBe(data);
    expect(received[0]!.data).toEqual(snapshot);
    expect(data).toEqual(snapshot);
  });

  it("the EventEmitter path (live SSE subscribers) also gets the raw object", () => {
    const data = failedPayload();
    const seen: unknown[] = [];
    bus.on("*", (e: Event) => seen.push(e.data));
    bus.emitEvent("task.failed", data);
    expect(seen[0]).toBe(data);
  });

  it("replay from the DB (getUndelivered) returns the redacted copy", () => {
    bus.emitEvent("task.failed", failedPayload());
    const [replayed] = bus.getUndelivered("t", 0);
    expect(JSON.stringify(replayed!.data)).not.toContain(SECRET);
  });

  it("a non-secret payload is stored byte-identical to JSON.stringify", () => {
    const data = {
      task_id: "3f2b8c1e-9d4a-4e6b-8f1a-2c3d4e5f6a7b",
      agent_id: "fast",
      result: {
        sha: "cd3c8204f1e2d3c4b5a69784f1e2d3c4b5a6978a",
        url: "https://example.com/search?q=hello+world&page=2",
      },
      duration_ms: 12,
    };
    const event = bus.emitEvent("task.completed", data);
    expect(storedData(event.id)).toBe(JSON.stringify(data));
  });

  it("a throwing redactor still writes the row (raw) and still delivers", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = failedPayload();
    const received: Event[] = [];
    bus.subscribe("task.failed", (e) => {
      received.push(e);
    });
    vi.spyOn(String.prototype, "replace").mockImplementation(() => {
      throw new Error("redactor bug");
    });
    const event = bus.emitEvent("task.failed", data);
    vi.mocked(String.prototype.replace).mockRestore();

    expect(storedData(event.id)).toBe(JSON.stringify(data));
    expect(received[0]!.data).toBe(data);
  });
});
