/**
 * Tests for essential facts layer (v6.5 M2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "../db/index.js";

// Real schema through initDatabase(":memory:"): `conversation_embeddings`
// references `conversations` with ON DELETE CASCADE, so an embedding row
// needs its memory row. The clock is fixed and every row carries an explicit
// UTC `created_at`, so the age score and the cache window never read the host.
const NOW = Date.UTC(2001, 0, 15, 12, 0, 0);
let db: Database.Database;

// Ruling 3c: one synthetic stored value stands in for the secret store.
const SCRUB_SYN = vi.hoisted(() => "syn-" + "e".repeat(14));
const laterSaved = vi.hoisted(() => new Set<string>());
vi.mock("../lib/secret-refs.js", () => ({
  scrubSecrets: (t: string) => {
    let out = t.replaceAll(SCRUB_SYN, "[oculto]");
    for (const v of laterSaved) out = out.replaceAll(v, "[oculto]");
    return out;
  },
}));

import { getEssentialFacts, clearEssentialsCache } from "./essentials.js";

/** Inserts one memory dated `secondsAgo` before NOW; returns its id. */
function remember(
  bank: string,
  content: string,
  tier: number,
  secondsAgo = 60,
): number {
  const createdAt = new Date(NOW - secondsAgo * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  return Number(
    db
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(bank, content, tier, createdAt).lastInsertRowid,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearEssentialsCache();
  db = initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getEssentialFacts", () => {
  it("scrubs a stored credential value from a row stored in clear, before the per-entry cut (ruling 3c, audit R3 B1)", () => {
    remember("mc-jarvis", "x".repeat(140) + ` ${SCRUB_SYN} fin`, 1);
    const result = getEssentialFacts();
    expect(result).toContain("[Essential context");
    expect(result).not.toContain(SCRUB_SYN.slice(0, 6));
  });

  it("a value saved after the block was cached is scrubbed on the cache hit", () => {
    const later = "lt-" + "w".repeat(14);
    remember("mc-jarvis", `la nota ${later}`, 1);
    expect(getEssentialFacts()).toContain(later); // not a stored secret yet
    laterSaved.add(later);
    try {
      const cached = getEssentialFacts();
      expect(cached).toContain("la nota [oculto]");
      expect(cached).not.toContain(later);
    } finally {
      laterSaved.clear();
    }
  });

  it("returns empty string when no memories exist", () => {
    expect(getEssentialFacts()).toBe("");
  });

  it("returns essential facts block for tier 1-2 memories", () => {
    remember("mc-jarvis", "User prefers dark mode interfaces", 1);
    remember("mc-jarvis", "User is a senior engineer focused on AI agents", 2);

    const result = getEssentialFacts();
    expect(result).toContain("[Essential context");
    expect(result).toContain("dark mode");
    expect(result).toContain("senior engineer");
  });

  it("excludes tier 3-4 memories", () => {
    remember("mc-jarvis", "Tier 1 verified fact", 1);
    remember("mc-jarvis", "Tier 4 unverified observation", 4);

    const result = getEssentialFacts();
    expect(result).toContain("Tier 1");
    expect(result).not.toContain("Tier 4");
  });

  it("respects character budget", () => {
    for (let i = 0; i < 50; i++) {
      remember("mc-jarvis", `Important fact number ${i}: ${"x".repeat(100)}`, 1);
    }

    const result = getEssentialFacts();
    expect(result).toContain("Important fact number");
    // Should be well under 1500 chars total (1200 char budget + header)
    expect(result.length).toBeLessThan(1500);
  });

  it("caches result for subsequent calls", () => {
    remember("mc-jarvis", "Cached fact", 1);

    const first = getEssentialFacts();
    // Add more data — should still return cached version
    remember("mc-jarvis", "New uncached fact", 1);
    const second = getEssentialFacts();

    expect(first).toContain("Cached fact");
    expect(first).toBe(second);
  });

  it("rebuilds the block once the cache window has passed", () => {
    remember("mc-jarvis", "Fact before the window", 1);
    expect(getEssentialFacts()).not.toContain("Fact saved later");

    remember("mc-jarvis", "Fact saved later", 1);
    // Inside the five-minute window the cached block is served.
    vi.setSystemTime(NOW + 4 * 60_000);
    expect(getEssentialFacts()).not.toContain("Fact saved later");
    vi.setSystemTime(NOW + 5 * 60_000 + 1000);
    expect(getEssentialFacts()).toContain("Fact saved later");
  });

  it("reads tier 1 before tier 2 into its 100-row window, whatever their age", () => {
    // 100 newer tier-2 rows fill the window if age were the first sort key.
    for (let i = 0; i < 100; i++) {
      remember("mc-jarvis", `Newer inferred note ${i}`, 2, 60 + i);
    }
    remember("mc-jarvis", "Older verified fact", 1, 86_400);

    expect(getEssentialFacts()).toContain("Older verified fact");
  });

  it("refreshes after cache clear", () => {
    remember("mc-jarvis", "Original fact", 1);

    const first = getEssentialFacts();
    clearEssentialsCache();

    remember("mc-jarvis", "New fact after clear", 1);
    const second = getEssentialFacts();

    expect(second).toContain("New fact after clear");
    expect(first).not.toBe(second);
  });

  it("ranks a memory with a stored embedding above an equal, slightly newer one without", () => {
    remember("mc-jarvis", "Plain newer fact", 1, 60);
    const id = remember("mc-jarvis", "Embedded older fact", 1, 120);
    db.prepare(
      "INSERT INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)",
    ).run(id, Buffer.alloc(4));

    const result = getEssentialFacts();
    expect(result.indexOf("Embedded older fact")).toBeGreaterThan(-1);
    expect(result.indexOf("Embedded older fact")).toBeLessThan(
      result.indexOf("Plain newer fact"),
    );
  });

  it("filters by bank", () => {
    remember("mc-jarvis", "Jarvis memory", 1);
    remember("mc-operational", "Operational memory", 1);

    clearEssentialsCache();
    const jarvis = getEssentialFacts("mc-jarvis");
    expect(jarvis).toContain("Jarvis memory");
    expect(jarvis).not.toContain("Operational memory");
  });
});
