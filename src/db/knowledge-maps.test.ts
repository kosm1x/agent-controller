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
  slugify,
  isStale,
  getMap,
  getMapByTopic,
  searchMaps,
  upsertMap,
  updateMapStats,
  deleteMap,
  getNodes,
  getNode,
  getChildNodes,
  countNodes,
  getMaxDepth,
  insertNodes,
  nextNodeSeq,
  MAP_TTL_DAYS,
} from "./knowledge-maps.js";
import type { KnowledgeMap } from "./knowledge-maps.js";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll,
  });
});

describe("slugify", () => {
  it("converts spaces to hyphens and lowercases", () => {
    expect(slugify("Mexican Telecom Regulation")).toBe(
      "mexican-telecom-regulation",
    );
  });

  it("strips accents", () => {
    expect(slugify("Regulación Energética")).toBe("regulacion-energetica");
  });

  it("strips special characters", () => {
    expect(slugify("CRISPR: Gene Editing!")).toBe("crispr-gene-editing");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("a  --  b")).toBe("a-b");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("isStale", () => {
  it("returns false for fresh maps", () => {
    const map: KnowledgeMap = {
      id: "test",
      topic: "test",
      node_count: 0,
      max_depth: 0,
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    };
    expect(isStale(map)).toBe(false);
  });

  it("returns true for maps older than TTL", () => {
    const old = new Date(Date.now() - (MAP_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const map: KnowledgeMap = {
      id: "test",
      topic: "test",
      node_count: 0,
      max_depth: 0,
      created_at: old.toISOString().replace("T", " ").slice(0, 19),
      updated_at: old.toISOString().replace("T", " ").slice(0, 19),
    };
    expect(isStale(map)).toBe(true);
  });
});

describe("getMap", () => {
  it("returns null when not found", () => {
    mockGet.mockReturnValueOnce(undefined);
    expect(getMap("nonexistent")).toBeNull();
  });

  it("returns map when found", () => {
    const map = { id: "test", topic: "Test Topic" };
    mockGet.mockReturnValueOnce(map);
    expect(getMap("test")).toEqual(map);
  });
});

describe("getMapByTopic", () => {
  it("slugifies and delegates to getMap", () => {
    mockGet.mockReturnValueOnce(undefined);
    getMapByTopic("Mexican Telecom");
    expect(mockDb.prepare).toHaveBeenCalledWith(
      "SELECT * FROM knowledge_maps WHERE id = ?",
    );
  });
});

describe("searchMaps", () => {
  it("returns empty for short keywords", () => {
    expect(searchMaps("a b c")).toEqual([]);
  });

  it("queries with LIKE for keywords longer than 3 chars", () => {
    mockAll.mockReturnValueOnce([]);
    searchMaps("telecom regulation");
    const sql = mockDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("LIKE");
    expect(sql).toContain("AND");
  });
});

describe("upsertMap", () => {
  it("calls INSERT OR CONFLICT with correct params", () => {
    upsertMap("test-id", "Test Topic");
    expect(mockRun).toHaveBeenCalledWith("test-id", "Test Topic");
  });
});

describe("updateMapStats", () => {
  it("reads count and max depth then updates", () => {
    mockGet.mockReturnValueOnce({ cnt: 10, maxd: 3 });
    updateMapStats("test-id");
    expect(mockRun).toHaveBeenCalledWith(10, 3, "test-id");
  });
});

describe("deleteMap", () => {
  it("returns true when map existed", () => {
    mockRun
      .mockReturnValueOnce({ changes: 5 }) // delete nodes
      .mockReturnValueOnce({ changes: 1 }); // delete map
    expect(deleteMap("test-id")).toBe(true);
  });

  it("returns false when map did not exist", () => {
    mockRun
      .mockReturnValueOnce({ changes: 0 })
      .mockReturnValueOnce({ changes: 0 });
    expect(deleteMap("test-id")).toBe(false);
  });
});

describe("node operations", () => {
  it("getNodes returns ordered results", () => {
    const nodes = [{ id: "n-1" }, { id: "n-2" }];
    mockAll.mockReturnValueOnce(nodes);
    expect(getNodes("map-1")).toEqual(nodes);
  });

  it("getNode returns null when not found", () => {
    mockGet.mockReturnValueOnce(undefined);
    expect(getNode("nonexistent")).toBeNull();
  });

  it("getChildNodes filters by parent", () => {
    mockAll.mockReturnValueOnce([]);
    getChildNodes("n-1");
    const sql = mockDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("parent_id");
  });

  it("countNodes returns count", () => {
    mockGet.mockReturnValueOnce({ cnt: 12 });
    expect(countNodes("map-1")).toBe(12);
  });

  it("getMaxDepth returns max depth", () => {
    mockGet.mockReturnValueOnce({ maxd: 3 });
    expect(getMaxDepth("map-1")).toBe(3);
  });

  it("nextNodeSeq returns max ID + 1", () => {
    mockGet.mockReturnValueOnce({ maxseq: 8 });
    expect(nextNodeSeq("map-1")).toBe(9);
  });
});

describe("insertNodes", () => {
  it("inserts nodes in a transaction", () => {
    // Ensure mockRun returns { changes } for the insert stmt
    mockRun.mockReturnValue({ changes: 1 });
    const nodes = [
      {
        id: "map-1/n-1",
        map_id: "map-1",
        label: "Test",
        type: "concept" as const,
        summary: "A test node",
        depth: 0,
        parent_id: null,
      },
    ];
    const count = insertNodes(nodes);
    expect(mockTransaction).toHaveBeenCalled();
    expect(count).toBe(1);
    expect(mockRun).toHaveBeenCalledWith(
      "map-1/n-1",
      "map-1",
      "Test",
      "concept",
      "A test node",
      0,
      null,
    );
  });
});
