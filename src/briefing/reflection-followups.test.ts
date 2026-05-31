/**
 * reflection_followups sweep — V8.2 Phase 0 (spec §5 item 2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";
import {
  insertReflectionFollowup,
  getDueReflectionFollowups,
  markReflectionFollowupFired,
  sweepDueReflectionFollowups,
  registerFollowupHandler,
  resetFollowupHandlersForTests,
  contextRefPrefix,
} from "./reflection-followups.js";

const T0 = "2026-05-31T00:00:00.000Z";
const T1 = "2026-05-31T12:00:00.000Z"; // > T0
const FUTURE = "2026-12-31T00:00:00.000Z";

beforeEach(() => {
  initDatabase(":memory:");
  resetFollowupHandlersForTests();
});
afterEach(() => {
  resetFollowupHandlersForTests();
  closeDatabase();
});

describe("insert + due query", () => {
  it("returns rows whose fire_after has passed, oldest-first", () => {
    const db = getDatabase();
    insertReflectionFollowup(
      {
        fireAfter: "2026-05-30T00:00:00.000Z",
        checkpointKind: "verify_resolution",
        contextRef: "judgment:1",
      },
      db,
    );
    insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "decision:2",
      },
      db,
    );
    insertReflectionFollowup(
      {
        fireAfter: FUTURE,
        checkpointKind: "verify_prediction",
        contextRef: "judgment:3",
      },
      db,
    );
    const due = getDueReflectionFollowups(T1, db);
    expect(due.map((r) => r.context_ref)).toEqual(["judgment:1", "decision:2"]);
  });

  it("excludes a row whose fire_after is still in the future", () => {
    const db = getDatabase();
    insertReflectionFollowup(
      {
        fireAfter: FUTURE,
        checkpointKind: "verify_resolution",
        contextRef: "judgment:9",
      },
      db,
    );
    expect(getDueReflectionFollowups(T1, db)).toHaveLength(0);
  });
});

describe("markFired is idempotent", () => {
  it("a fired row is never returned as due again", () => {
    const db = getDatabase();
    const id = insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "judgment:1",
      },
      db,
    );
    expect(getDueReflectionFollowups(T1, db)).toHaveLength(1);
    markReflectionFollowupFired(id, T1, db);
    expect(getDueReflectionFollowups(T1, db)).toHaveLength(0);
    // second mark is a no-op (already fired)
    markReflectionFollowupFired(id, "2026-06-01T00:00:00.000Z", db);
    const row = db
      .prepare("SELECT fired_at FROM reflection_followups WHERE id = ?")
      .get(id) as { fired_at: string };
    expect(row.fired_at).toBe(T1);
  });
});

describe("sweep is empty-handler-safe (Phase 0 production state)", () => {
  it("with no handlers, every due row is skipped and left unfired", async () => {
    const db = getDatabase();
    insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "judgment:1",
      },
      db,
    );
    const result = await sweepDueReflectionFollowups(T1, db);
    expect(result).toEqual({ due: 1, fired: 0, skipped: 1, failed: 0 });
    // still due — a consumer added later still receives it
    expect(getDueReflectionFollowups(T1, db)).toHaveLength(1);
  });
});

describe("sweep dispatches by context_ref prefix", () => {
  it("fires only rows whose prefix has a registered handler; idempotent across sweeps", async () => {
    const db = getDatabase();
    const seen: string[] = [];
    registerFollowupHandler("judgment", (row) => {
      seen.push(row.context_ref);
    });
    insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "judgment:1",
      },
      db,
    );
    insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "decision:2",
      },
      db,
    );

    const first = await sweepDueReflectionFollowups(T1, db);
    expect(first.fired).toBe(1); // judgment:1
    expect(first.skipped).toBe(1); // decision:2 — no handler
    expect(seen).toEqual(["judgment:1"]);

    // second sweep: judgment:1 already fired, decision:2 still has no handler
    const second = await sweepDueReflectionFollowups(T1, db);
    expect(second.fired).toBe(0);
    expect(second.due).toBe(1); // only decision:2 remains due
    expect(seen).toEqual(["judgment:1"]); // handler not called again
  });

  it("a throwing handler leaves the row unfired for retry", async () => {
    const db = getDatabase();
    const handler = vi
      .fn<(row: { context_ref: string }) => void>()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => {});
    registerFollowupHandler("judgment", handler as never);
    insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "judgment:1",
      },
      db,
    );

    const first = await sweepDueReflectionFollowups(T1, db);
    expect(first).toEqual({ due: 1, fired: 0, skipped: 0, failed: 1 });
    expect(getDueReflectionFollowups(T1, db)).toHaveLength(1); // unfired

    const second = await sweepDueReflectionFollowups(T1, db);
    expect(second.fired).toBe(1); // retry succeeded
    expect(getDueReflectionFollowups(T1, db)).toHaveLength(0);
  });

  it("supports async handlers", async () => {
    const db = getDatabase();
    registerFollowupHandler("decision", async () => {
      await Promise.resolve();
    });
    insertReflectionFollowup(
      {
        fireAfter: T0,
        checkpointKind: "verify_resolution",
        contextRef: "decision:7",
      },
      db,
    );
    const result = await sweepDueReflectionFollowups(T1, db);
    expect(result.fired).toBe(1);
  });
});

describe("contextRefPrefix", () => {
  it("splits on the first colon", () => {
    expect(contextRefPrefix("judgment:123")).toBe("judgment");
    expect(contextRefPrefix("decision:42")).toBe("decision");
  });
  it("returns the whole string when there is no colon", () => {
    expect(contextRefPrefix("bare")).toBe("bare");
  });
});
