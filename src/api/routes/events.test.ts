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
import {
  PASSWORD_WITHHELD_PLACEHOLDER,
  passwordFingerprint,
} from "../../lib/v8-4/password-gate.js";
import {
  _resetStoreWithhold,
  setStoreSeenCheck,
} from "../../lib/v8-4/store-withhold.js";

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

  // Ruled reader behaviour: the dashboard stream is a view over a record and
  // shows the placeholder; subscribers that deliver (the router) get the
  // in-memory object unchanged.
  it("mailbox-password store rule: the stream frame and the stored event hold the placeholder; the in-memory object keeps the value", async () => {
    const pw = "FakeTestPassWordXYZ2345";
    const fp = passwordFingerprint(pw);
    setStoreSeenCheck({ size: () => 1, has: (f) => f === fp });
    try {
      const res = await events.request("/stream");
      const reader = res.body!.getReader();
      await readUntil(reader, ": connected");
      const live = {
        task_id: "t-pw",
        agent_id: "fast",
        result: `contraseña: ${pw}`,
        duration_ms: 3,
      };
      bus.emitEvent("task.completed", live);
      const streamed = await readUntil(reader, "t-pw");
      await reader.cancel();
      expect(streamed).toContain(`contraseña: ${PASSWORD_WITHHELD_PLACEHOLDER}`);
      expect(streamed).not.toContain(pw);
      expect(live.result).toBe(`contraseña: ${pw}`);
      const stored = db.prepare("SELECT data FROM events").all();
      expect(JSON.stringify(stored)).not.toContain(pw);
    } finally {
      _resetStoreWithhold();
    }
  });
});
