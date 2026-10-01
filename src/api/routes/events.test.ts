/**
 * SSE /events/stream — an export sink. Live events reach it as the raw
 * in-memory object (only the DB copy is redacted at persist), so the route
 * redacts credential shapes at its own send seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { PersistentEventBus } from "../../lib/events/bus.js";

let bus: PersistentEventBus;
vi.mock("../../lib/event-bus.js", () => ({ getEventBus: () => bus }));

import { events } from "./events.js";

// Built at runtime — no key-shaped literal in the (public) repo.
const SECRET = "sk-" + "a".repeat(24);

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("GET /events/stream redaction", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    bus = new PersistentEventBus({ db, cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    bus.destroy();
    db.close();
  });

  it("live and replayed events are sent without the raw key", async () => {
    // One persisted event before connecting → served via ?since= replay.
    bus.emitEvent("task.failed", {
      task_id: "t-old",
      agent_id: "fast",
      error: `old ${SECRET}`,
      recoverable: false,
      attempts: 1,
    });

    const res = await events.request("/stream?since=0");
    const reader = res.body!.getReader();
    const replayed = await readUntil(reader, ": connected");

    const live = {
      task_id: "t-new",
      agent_id: "fast",
      error: `new ${SECRET}`,
      recoverable: false,
      attempts: 1,
    };
    bus.emitEvent("task.failed", live);
    const streamed = await readUntil(reader, "t-new");
    await reader.cancel();

    expect(replayed).toContain("old [REDACTED_KEY]");
    expect(streamed).toContain("new [REDACTED_KEY]");
    expect(replayed + streamed).not.toContain(SECRET);
    // The in-memory object other subscribers see is untouched.
    expect(live.error).toBe(`new ${SECRET}`);
  });
});
