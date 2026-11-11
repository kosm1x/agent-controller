/**
 * Database index tests — writeWithRetry jitter behavior.
 */

import { describe, it, expect, vi , afterEach } from "vitest";

// Mock the database module to test writeWithRetry in isolation
const mockPragma = vi.fn();
const mockExec = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());
vi.mock("better-sqlite3", () => ({
  default: vi.fn(() => ({
    pragma: mockPragma,
    exec: mockExec,
    prepare: vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
    close: mockClose,
  })),
}));

vi.mock("../tuning/schema.js", () => ({
  ensureTuningTables: vi.fn(),
}));

vi.mock("../tuning/activation.js", () => ({
  activateBestVariant: vi.fn(),
}));

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  writeWithRetry,
} from "./index.js";

// Initialize the mock database
initDatabase("/tmp/test-wal-jitter.db");

describe("writeWithRetry", () => {
  afterEach(() => { vi.restoreAllMocks(); });
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

// A failed initialisation must not leave a half-built handle: getDatabase()
// would hand out a database with an incomplete schema and a second
// initDatabase() would return it instead of retrying.
describe("initDatabase when an initialisation step fails", () => {
  it("throws the original error, leaves no handle, and a later call initialises", () => {
    const dbPath = join(tmpdir(), "init-failure.db");
    closeDatabase();
    mockClose.mockClear();
    mockExec.mockImplementationOnce(() => {
      throw new Error("schema step failed");
    });
    // A close error during the cleanup must not hide the original error.
    mockClose.mockImplementationOnce(() => {
      throw new Error("close failed");
    });

    expect(() => initDatabase(dbPath)).toThrow("schema step failed");
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(() => getDatabase()).toThrow("Database not initialized");

    const db = initDatabase(dbPath);
    expect(getDatabase()).toBe(db);
  });
});
