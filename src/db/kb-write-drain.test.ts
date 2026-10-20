/**
 * drainKbWrites (2026-10-20, qa R1 W1): operator scripts drain upsertFile's
 * syncs and regenerate INDEX.md before closeDatabase. Real in-memory db + the
 * real upsertFile with pgvector and Drive both off; scratch KB mirror.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Both syncs off: no pgvector key, no Drive folder (and :memory: is not the live db).
  delete process.env.COMMIT_DB_KEY;
  delete process.env.DRIVE_KB_FOLDER_ID;
});

import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { getFile, upsertFile } from "./jarvis-fs.js";
import { cancelPendingRegeneration } from "./jarvis-index.js";
import { drainKbWrites, type KbWriteDrainDeps } from "./kb-write-drain.js";

describe("drainKbWrites — real upsertFile, both syncs off", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    initDatabase(":memory:");
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50)); // let any late dynamic-import mark land
    cancelPendingRegeneration();
    closeDatabase();
    vi.restoreAllMocks();
  });

  it("INDEX.md lists a new project before closeDatabase, with no wait for the mark", async () => {
    // Settle initDatabase's own writes, then make INDEX.md stale on purpose.
    await drainKbWrites();
    expect(getFile("INDEX.md")?.content ?? "").not.toContain("zeta-syn");
    upsertFile("projects/zeta-syn/a.md", "A", "synthetic\n", [], "reference", 50, null, []);
    await drainKbWrites();
    expect(getFile("INDEX.md")?.content).toContain("[[projects/zeta-syn/|zeta-syn]]");
  });

  it("is safe to call twice and when nothing was written (INDEX.md is idempotent)", async () => {
    await drainKbWrites();
    const first = getFile("INDEX.md")?.content;
    await drainKbWrites();
    expect(getFile("INDEX.md")?.content).toBe(first);
    expect(getDatabase().prepare("SELECT count(*) AS n FROM jarvis_files WHERE path = 'INDEX.md'").get()).toEqual({ n: 1 });
  });
});

describe("drainKbWrites — order", () => {
  const orderDeps = (order: string[]): KbWriteDrainDeps & Record<string, ReturnType<typeof vi.fn>> => ({
    settlePgvectorSyncs: vi.fn(async (): Promise<void> => void order.push("settle-pg")),
    settleDriveSyncs: vi.fn(async (): Promise<void> => void order.push("settle-drive")),
    regenerateIndex: vi.fn(() => void order.push("regen")),
    cancelPendingRegeneration: vi.fn(() => void order.push("cancel")),
  });

  it("settles, regenerates INDEX.md unconditionally, settles INDEX.md's own syncs, cancels any late mark", async () => {
    const order: string[] = [];
    await drainKbWrites(orderDeps(order));
    expect(order).toEqual([
      "settle-pg",
      "settle-drive",
      "cancel",
      "regen",
      "settle-pg",
      "settle-drive",
      "cancel",
    ]);
  });

  it("does not regenerate while a sync is still in flight", async () => {
    const order: string[] = [];
    const deps = orderDeps(order);
    let release!: () => void;
    deps.settleDriveSyncs.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const run = drainKbWrites(deps);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(deps.regenerateIndex).not.toHaveBeenCalled();
    release();
    await run;
    expect(deps.regenerateIndex).toHaveBeenCalledOnce();
  });
});
