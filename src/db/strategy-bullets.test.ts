/**
 * Strategy bullets CRUD tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRun = vi.fn();
const mockGet = vi.fn();
const mockAll = vi.fn();
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  }),
  transaction: <T>(fn: () => T) => fn,
};

vi.mock("./index.js", () => ({
  getDatabase: () => mockDb,
}));

import {
  insertBullet,
  updateBulletCounts,
  getTopBullets,
  getProblematicBullets,
  deactivateBullet,
  getBulletStats,
} from "./strategy-bullets.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  });
});

describe("insertBullet", () => {
  it("should generate first bullet_id for section", () => {
    mockGet.mockReturnValueOnce(undefined); // no existing bullets
    mockRun.mockReturnValueOnce(undefined);

    const id = insertBullet("strategies", "Always verify inputs");
    expect(id).toBe("str-00001");
    expect(mockRun).toHaveBeenCalledWith(
      "str-00001",
      "strategies",
      "Always verify inputs",
      "reflector",
    );
  });

  it("should increment from highest existing bullet_id", () => {
    mockGet.mockReturnValueOnce({ bullet_id: "str-00005" });
    mockRun.mockReturnValueOnce(undefined);

    const id = insertBullet("strategies", "New strategy");
    expect(id).toBe("str-00006");
  });

  it("should use custom source", () => {
    mockGet.mockReturnValueOnce(undefined);
    mockRun.mockReturnValueOnce(undefined);

    insertBullet("mistakes", "Don't use any", "evolution");
    expect(mockRun).toHaveBeenCalledWith(
      "mis-00001",
      "mistakes",
      "Don't use any",
      "evolution",
    );
  });

  it("should generate slug for unknown section", () => {
    mockGet.mockReturnValueOnce(undefined);
    mockRun.mockReturnValueOnce(undefined);

    const id = insertBullet("debugging", "Check logs first");
    expect(id).toBe("deb-00001");
  });
});

describe("updateBulletCounts", () => {
  it("should increment helpful_count", () => {
    updateBulletCounts("str-00001", "helpful");
    const sql = mockDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("helpful_count = helpful_count + 1");
    expect(mockRun).toHaveBeenCalledWith("str-00001");
  });

  it("should increment harmful_count", () => {
    updateBulletCounts("str-00001", "harmful");
    const sql = mockDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("harmful_count = harmful_count + 1");
    expect(mockRun).toHaveBeenCalledWith("str-00001");
  });
});

describe("getTopBullets", () => {
  it("should query active bullets sorted by net score", () => {
    mockAll.mockReturnValueOnce([
      { bullet_id: "str-00001", helpful_count: 10, harmful_count: 1 },
    ]);

    const result = getTopBullets(5, 2);
    expect(result).toHaveLength(1);
    expect(mockAll).toHaveBeenCalledWith(2, 5);
  });
});

describe("getProblematicBullets", () => {
  it("should return bullets where harmful >= helpful", () => {
    mockAll.mockReturnValueOnce([
      { bullet_id: "str-00002", helpful_count: 1, harmful_count: 5 },
    ]);

    const result = getProblematicBullets(2);
    expect(result).toHaveLength(1);
    expect(mockAll).toHaveBeenCalledWith(2);
  });
});

describe("deactivateBullet", () => {
  it("should set active = 0", () => {
    deactivateBullet("str-00001");
    const sql = mockDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("active = 0");
    expect(mockRun).toHaveBeenCalledWith("str-00001");
  });
});

describe("getBulletStats", () => {
  it("should return aggregate stats", () => {
    // First prepare call: totals
    mockGet.mockReturnValueOnce({
      total: 10,
      active: 8,
      high_performing: 3,
      problematic: 2,
      unused: 1,
    });
    // Second prepare call: sections
    mockAll.mockReturnValueOnce([
      { section: "strategies", count: 5 },
      { section: "mistakes", count: 3 },
    ]);

    // Need two separate prepare results
    let callCount = 0;
    mockDb.prepare.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          get: () => ({
            total: 10,
            active: 8,
            high_performing: 3,
            problematic: 2,
            unused: 1,
          }),
        };
      }
      return {
        all: () => [
          { section: "strategies", count: 5 },
          { section: "mistakes", count: 3 },
        ],
      };
    });

    const stats = getBulletStats();
    expect(stats.total).toBe(10);
    expect(stats.active).toBe(8);
    expect(stats.highPerforming).toBe(3);
    expect(stats.problematic).toBe(2);
    expect(stats.bySection).toEqual({ strategies: 5, mistakes: 3 });
  });
});
