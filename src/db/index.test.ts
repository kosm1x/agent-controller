/**
 * Database index tests — writeWithRetry jitter behavior.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the database module to test writeWithRetry in isolation
const mockPragma = vi.fn();
vi.mock("better-sqlite3", () => ({
  default: vi.fn(() => ({
    pragma: mockPragma,
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
    close: vi.fn(),
  })),
}));

vi.mock("../tuning/schema.js", () => ({
  ensureTuningTables: vi.fn(),
}));

vi.mock("../tuning/activation.js", () => ({
  activateBestVariant: vi.fn(),
}));

import { initDatabase, writeWithRetry } from "./index.js";

// Initialize the mock database
initDatabase("/tmp/test-wal-jitter.db");

describe("writeWithRetry", () => {
  it("should return result on first success", () => {
    const result = writeWithRetry(() => 42);
    expect(result).toBe(42);
  });

  it("should retry on SQLITE_BUSY and eventually succeed", () => {
    let attempt = 0;
    const result = writeWithRetry(() => {
      attempt++;
      if (attempt < 3) throw new Error("SQLITE_BUSY");
      return "success";
    });
    expect(result).toBe("success");
    expect(attempt).toBe(3);
  });

  it("should retry on 'database is locked'", () => {
    let attempt = 0;
    const result = writeWithRetry(() => {
      attempt++;
      if (attempt < 2) throw new Error("database is locked");
      return "unlocked";
    });
    expect(result).toBe("unlocked");
    expect(attempt).toBe(2);
  });

  it("should throw non-BUSY errors immediately", () => {
    expect(() =>
      writeWithRetry(() => {
        throw new Error("UNIQUE constraint failed");
      }),
    ).toThrow("UNIQUE constraint failed");
  });

  it("should throw after max retries exhausted", () => {
    expect(() =>
      writeWithRetry(() => {
        throw new Error("SQLITE_BUSY");
      }),
    ).toThrow("SQLITE_BUSY");
  });

  it("should propagate return type correctly", () => {
    const obj = writeWithRetry(() => ({ key: "value", count: 5 }));
    expect(obj.key).toBe("value");
    expect(obj.count).toBe(5);
  });
});
