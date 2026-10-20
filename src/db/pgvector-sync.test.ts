/**
 * settlePgvectorSyncs (2026-10-20): operator scripts drain the fire-and-forget
 * pgvector writes before closeDatabase. pgvector + embeddings are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pg = vi.hoisted(() => ({
  upsert: vi.fn(),
  del: vi.fn(),
}));
vi.mock("./pgvector.js", () => ({
  pgUpsert: pg.upsert,
  pgDelete: pg.del,
  pgFindByHash: vi.fn(async () => null),
  pgReinforce: vi.fn(async () => {}),
  isPgvectorEnabled: () => true,
  contentHash: (c: string) => `h-${c.length}`,
  coerceKbQualifier: (q: string) => q,
}));
vi.mock("../inference/embeddings.js", () => ({ generateEmbedding: vi.fn(async () => null) }));

import { settlePgvectorSyncs, syncDeleteToPgvector, syncToPgvector } from "./pgvector-sync.js";

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("settlePgvectorSyncs", () => {
  beforeEach(() => {
    pg.upsert.mockReset();
    pg.del.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves at once when nothing is in flight", async () => {
    await expect(settlePgvectorSyncs()).resolves.toBeUndefined();
  });

  it("waits for an in-flight upsert, and for one started while waiting", async () => {
    const release: Array<() => void> = [];
    pg.upsert.mockImplementation(() => new Promise<void>((r) => release.push(r)));
    syncToPgvector("knowledge/a.md", "A", "body");
    let settled = false;
    const done = settlePgvectorSyncs().then(() => (settled = true));
    await vi.waitFor(() => expect(release).toHaveLength(1));
    syncToPgvector("knowledge/b.md", "B", "body");
    release[0]!();
    await vi.waitFor(() => expect(release).toHaveLength(2));
    await ticks(20);
    expect(settled).toBe(false);
    release[1]!();
    await done;
    expect(pg.upsert).toHaveBeenCalledTimes(2);
  });

  it("a failed upsert or delete still settles (never rejects)", async () => {
    pg.upsert.mockRejectedValue(new Error("boom"));
    pg.del.mockRejectedValue(new Error("boom"));
    syncToPgvector("knowledge/a.md", "A", "body");
    syncDeleteToPgvector("knowledge/a.md");
    await expect(settlePgvectorSyncs()).resolves.toBeUndefined();
    expect(pg.del).toHaveBeenCalledOnce();
  });
});
