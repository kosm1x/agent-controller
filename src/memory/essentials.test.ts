/**
 * Tests for essential facts layer (v6.5 M2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

let mockDb: Database.Database;

vi.mock("../db/index.js", () => ({
  getDatabase: () => mockDb,
}));

import { getEssentialFacts, clearEssentialsCache } from "./essentials.js";

beforeEach(() => {
  clearEssentialsCache();
  mockDb = new Database(":memory:");
  mockDb.exec(`CREATE TABLE conversations (
    id         INTEGER PRIMARY KEY,
    bank       TEXT NOT NULL DEFAULT 'mc-jarvis',
    tags       TEXT DEFAULT '[]',
    content    TEXT NOT NULL,
    trust_tier INTEGER NOT NULL DEFAULT 3,
    source     TEXT DEFAULT 'agent',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  mockDb.exec(`CREATE TABLE conversation_embeddings (
    conversation_id INTEGER PRIMARY KEY,
    embedding       BLOB NOT NULL
  )`);
});

afterEach(() => {
  mockDb.close();
  vi.restoreAllMocks();
});

describe("getEssentialFacts", () => {
  it("returns empty string when no memories exist", () => {
    expect(getEssentialFacts()).toBe("");
  });

  it("returns essential facts block for tier 1-2 memories", () => {
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "User prefers dark mode interfaces", 1);
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "User is a senior engineer focused on AI agents", 2);

    const result = getEssentialFacts();
    expect(result).toContain("[Essential context");
    expect(result).toContain("dark mode");
    expect(result).toContain("senior engineer");
  });

  it("excludes tier 3-4 memories", () => {
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "Tier 1 verified fact", 1);
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "Tier 4 unverified observation", 4);

    const result = getEssentialFacts();
    expect(result).toContain("Tier 1");
    expect(result).not.toContain("Tier 4");
  });

  it("respects character budget", () => {
    for (let i = 0; i < 50; i++) {
      mockDb
        .prepare(
          "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
        )
        .run("mc-jarvis", `Important fact number ${i}: ${"x".repeat(100)}`, 1);
    }

    const result = getEssentialFacts();
    // Should be well under 1500 chars total (1200 char budget + header)
    expect(result.length).toBeLessThan(1500);
  });

  it("caches result for subsequent calls", () => {
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "Cached fact", 1);

    const first = getEssentialFacts();
    // Add more data — should still return cached version
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "New uncached fact", 1);
    const second = getEssentialFacts();

    expect(first).toBe(second);
  });

  it("refreshes after cache clear", () => {
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "Original fact", 1);

    const first = getEssentialFacts();
    clearEssentialsCache();

    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "New fact after clear", 1);
    const second = getEssentialFacts();

    expect(second).toContain("New fact after clear");
    expect(first).not.toBe(second);
  });

  it("filters by bank", () => {
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-jarvis", "Jarvis memory", 1);
    mockDb
      .prepare(
        "INSERT INTO conversations (bank, content, trust_tier) VALUES (?, ?, ?)",
      )
      .run("mc-operational", "Operational memory", 1);

    clearEssentialsCache();
    const jarvis = getEssentialFacts("mc-jarvis");
    expect(jarvis).toContain("Jarvis memory");
    expect(jarvis).not.toContain("Operational memory");
  });
});
