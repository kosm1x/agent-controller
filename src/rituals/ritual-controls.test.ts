import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

const mem = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db/index.js", () => ({ getDatabase: () => mem.db }));

import {
  GLOBAL_MUTE_ID,
  activeMuteUntil,
  DEFERRED_BLOCK_MAX,
  consumeDeferralIds,
  deferredBlock,
  handlesIn,
  enqueueDeferral,
  getDeferral,
  isMorningSync,
  isRitualPaused,
  pendingDeferrals,
  setMutedUntil,
  setRitualPaused,
} from "./ritual-controls.js";

describe("ritual controls", () => {
  beforeEach(() => {
    mem.db = new Database(":memory:");
  });
  afterEach(() => {
    (mem.db as { close?: () => void }).close?.();
    vi.restoreAllMocks();
  });

  it("pause / resume round-trips; unknown rituals are not paused", () => {
    expect(isRitualPaused("signal-intelligence")).toBe(false);
    setRitualPaused("signal-intelligence", true);
    expect(isRitualPaused("signal-intelligence")).toBe(true);
    setRitualPaused("signal-intelligence", false);
    expect(isRitualPaused("signal-intelligence")).toBe(false);
  });

  it("isRitualPaused fails OPEN (not paused) on a broken DB", () => {
    mem.db = { exec: () => { throw new Error("disk I/O"); } };
    expect(isRitualPaused("signal-intelligence")).toBe(false);
  });

  it("global mute applies to every ritual; expired mutes do not", () => {
    const now = new Date("2026-08-24T18:00:00Z");
    expect(activeMuteUntil("pm-daily-rebalance", now)).toBeNull();
    setMutedUntil(GLOBAL_MUTE_ID, new Date("2026-08-24T21:00:00Z"));
    expect(activeMuteUntil("pm-daily-rebalance", now)).toBe("2026-08-24T21:00:00.000Z");
    // Past the stamp → not muted.
    expect(activeMuteUntil("pm-daily-rebalance", new Date("2026-08-24T21:00:01Z"))).toBeNull();
    setMutedUntil(GLOBAL_MUTE_ID, null);
    expect(activeMuteUntil("pm-daily-rebalance", now)).toBeNull();
  });

  it("per-ritual mute and the later of the two stamps wins", () => {
    const now = new Date("2026-08-24T18:00:00Z");
    setMutedUntil("signal-intelligence", new Date("2026-08-25T12:00:00Z"));
    setMutedUntil(GLOBAL_MUTE_ID, new Date("2026-08-24T20:00:00Z"));
    expect(activeMuteUntil("signal-intelligence", now)).toBe("2026-08-25T12:00:00.000Z");
    expect(activeMuteUntil("nightly-close", now)).toBe("2026-08-24T20:00:00.000Z");
  });

  it("deferrals: the block renders every pending row with its phone handle and caps text; consumption follows DELIVERY", () => {
    const id1 = enqueueDeferral("schedule:x", "t1", "Posthumanismo — 2026-08-24", "x".repeat(2000), "budget");
    const id2 = enqueueDeferral("market-eod-scan", "t2", "Market EOD scan", "SPY −1.2%", "muted");
    expect(pendingDeferrals()).toHaveLength(2);
    const { block, ids } = deferredBlock();
    expect(ids).toEqual([id1, id2]);
    expect(block).toContain("DIFERIDOS (2)");
    expect(block).toContain(`### Posthumanismo — 2026-08-24 (presupuesto de lectura) — completo: /rituales completo ${id1}`);
    expect(block).toContain(`### Market EOD scan (silenciado) — completo: /rituales completo ${id2}`);
    expect(block).toContain("x".repeat(1500) + "…");
    expect(block).not.toContain("x".repeat(1501));
    // Not consumed by rendering — a failed sync sees them again.
    expect(pendingDeferrals()).toHaveLength(2);
    // Consumption follows the handles the delivered text carries (R3 W2).
    expect(handlesIn(`Diferido de ayer:\n- Market EOD scan: SPY −1.2% → /rituales completo ${id2}\n`)).toEqual([id2]);
    expect(consumeDeferralIds([id2])).toBe(1);
    expect(pendingDeferrals().map((r) => r.id)).toEqual([id1]);
    expect(consumeDeferralIds([id1])).toBe(1);
    expect(deferredBlock().block).toBe("");
    // The full text stays reachable by id.
    expect(getDeferral(id1)?.text).toBe("x".repeat(2000));
  });

  it(`the block carries at most ${DEFERRED_BLOCK_MAX} rows (oldest first) and says how many wait (R3 W1)`, () => {
    for (let i = 0; i < DEFERRED_BLOCK_MAX + 3; i++) enqueueDeferral("x", null, `Row ${i}`, "t", "budget");
    const { block, ids } = deferredBlock();
    expect(ids).toHaveLength(DEFERRED_BLOCK_MAX);
    expect(block).toContain(`DIFERIDOS (${DEFERRED_BLOCK_MAX} de ${DEFERRED_BLOCK_MAX + 3})`);
    expect(block).toContain("Hay 3 más pendientes");
    expect(block).toContain("### Row 0 ");
    expect(block).not.toContain(`### Row ${DEFERRED_BLOCK_MAX} `);
    expect(block).toContain("FUENTE AUTORIZADA");
  });

  it("a 'capped' row is stored pre-consumed: reachable by id, never folded", () => {
    const id = enqueueDeferral("schedule:w", "t1", "Williams", "full post", "capped");
    expect(getDeferral(id)?.text).toBe("full post");
    expect(pendingDeferrals()).toEqual([]);
  });

  it("deferrals never expire (R1 C3): an old one is folded with its age, not dropped", () => {
    enqueueDeferral("schedule:x", "t1", "Old", "old text", "budget");
    (mem.db as Database.Database)
      .prepare("UPDATE ritual_deferrals SET created_at = datetime('now', '-50 hours')")
      .run();
    const { block } = deferredBlock();
    expect(block).toContain("### Old (presupuesto de lectura — de hace 2 días)");
    expect(block).toContain("FUERA del límite de longitud");
  });

  it("isMorningSync: schedule ID when V82_SYNC_SCHEDULE_ID is set, name otherwise", () => {
    delete process.env.V82_SYNC_SCHEDULE_ID;
    expect(isMorningSync({ schedule_id: "x", name: "Morning Sync — Piotr 8am" })).toBe(true);
    expect(isMorningSync({ schedule_id: "x", name: "Química" })).toBe(false);
    process.env.V82_SYNC_SCHEDULE_ID = "abc";
    expect(isMorningSync({ schedule_id: "abc", name: "Renamed" })).toBe(true);
    expect(isMorningSync({ schedule_id: "x", name: "Morning Sync — Piotr 8am" })).toBe(false);
    delete process.env.V82_SYNC_SCHEDULE_ID;
  });

});
