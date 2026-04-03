import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockRun = vi.fn().mockReturnValue({ changes: 1 });
const mockGet = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockTransaction = vi.fn((fn: () => void) => fn);
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  }),
  transaction: mockTransaction,
};

vi.mock("./index.js", () => ({
  getDatabase: () => mockDb,
}));

import {
  insertProvenance,
  getProvenanceByTask,
  getProvenanceByGoal,
  getUnanchoredUrls,
  countByStatus,
} from "./provenance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.mockReturnValue({ changes: 1 });
  mockDb.prepare.mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  });
});

describe("insertProvenance", () => {
  it("inserts records in a transaction", () => {
    const records = [
      {
        task_id: "task-1",
        goal_id: "g-1",
        tool_name: "web_search",
        url: "https://example.com",
        query: "test query",
        status: "verified" as const,
        content_hash: "abc12345",
        snippet: "some snippet",
      },
      {
        task_id: "task-1",
        goal_id: "g-1",
        tool_name: "web_read",
        url: "https://example.com/page",
        query: null,
        status: "inferred" as const,
        content_hash: "def67890",
        snippet: "another snippet",
      },
    ];

    const result = insertProvenance(records);
    expect(result).toBe(2);
    expect(mockTransaction).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun).toHaveBeenCalledWith(
      "task-1",
      "g-1",
      "web_search",
      "https://example.com",
      "test query",
      "verified",
      "abc12345",
      "some snippet",
    );
  });

  it("returns 0 for empty array", () => {
    expect(insertProvenance([])).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("getProvenanceByTask", () => {
  it("queries by task_id", () => {
    const expected = [
      { id: 1, task_id: "task-1", goal_id: "g-1", tool_name: "web_search" },
    ];
    mockAll.mockReturnValueOnce(expected);

    const result = getProvenanceByTask("task-1");
    expect(result).toEqual(expected);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("task_id = ?"),
    );
  });
});

describe("getProvenanceByGoal", () => {
  it("queries by goal_id", () => {
    const expected = [
      { id: 1, task_id: "task-1", goal_id: "g-1", tool_name: "web_read" },
    ];
    mockAll.mockReturnValueOnce(expected);

    const result = getProvenanceByGoal("g-1");
    expect(result).toEqual(expected);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("goal_id = ?"),
    );
  });
});

describe("getUnanchoredUrls", () => {
  it("returns only unverified records", () => {
    const expected = [
      {
        id: 2,
        task_id: "task-1",
        goal_id: "g-1",
        status: "unverified",
        url: "https://made-up.com",
      },
    ];
    mockAll.mockReturnValueOnce(expected);

    const result = getUnanchoredUrls("task-1");
    expect(result).toEqual(expected);
    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining("status = 'unverified'"),
    );
  });
});

describe("countByStatus", () => {
  it("returns counts per status", () => {
    mockAll.mockReturnValueOnce([
      { status: "verified", cnt: 5 },
      { status: "inferred", cnt: 3 },
      { status: "unverified", cnt: 1 },
    ]);

    const result = countByStatus("task-1");
    expect(result).toEqual({ verified: 5, inferred: 3, unverified: 1 });
  });

  it("returns zeros when no records exist", () => {
    mockAll.mockReturnValueOnce([]);

    const result = countByStatus("task-2");
    expect(result).toEqual({ verified: 0, inferred: 0, unverified: 0 });
  });
});
