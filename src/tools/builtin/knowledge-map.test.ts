import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Mocks ---

const mockInfer = vi.fn();
vi.mock("../../inference/adapter.js", () => ({
  infer: (...args: unknown[]) => mockInfer(...args),
}));

const mocks = vi.hoisted(() => ({
  slugify: vi.fn((t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-"),
  ),
  isStale: vi.fn(() => false),
  getMap: vi.fn(),
  deleteMap: vi.fn(() => true),
  upsertMap: vi.fn(),
  getNodes: vi.fn((): unknown[] => []),
  getNode: vi.fn(),
  getChildNodes: vi.fn((): unknown[] => []),
  countNodes: vi.fn(() => 0),
  insertNodes: vi.fn(() => 0),
  updateMapStats: vi.fn(),
  nextNodeSeq: vi.fn(() => 1),
  MAX_NODES_PER_MAP: 60,
  MAX_DEPTH: 5,
}));

vi.mock("../../db/knowledge-maps.js", () => mocks);

import { knowledgeMapTool, knowledgeMapExpandTool } from "./knowledge-map.js";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset defaults
  mocks.getMap.mockReturnValue(null);
  mocks.getNodes.mockReturnValue([]);
  mocks.getNode.mockReturnValue(null);
  mocks.getChildNodes.mockReturnValue([]);
  mocks.countNodes.mockReturnValue(0);
  mocks.isStale.mockReturnValue(false);
  mocks.nextNodeSeq.mockReturnValue(1);
});

// ---------------------------------------------------------------------------
// knowledge_map
// ---------------------------------------------------------------------------

describe("knowledge_map", () => {
  it("returns cached map when fresh", async () => {
    mocks.getMap.mockReturnValueOnce({
      id: "test-topic",
      topic: "Test Topic",
      node_count: 1,
      max_depth: 0,
      created_at: "2026-04-03 00:00:00",
      updated_at: "2026-04-03 00:00:00",
    });
    mocks.getNodes.mockReturnValueOnce([
      {
        id: "test-topic/n-1",
        map_id: "test-topic",
        label: "Concept A",
        type: "concept",
        summary: "A core concept",
        depth: 0,
        parent_id: null,
      },
    ]);

    const result = await knowledgeMapTool.execute({ topic: "Test Topic" });
    const parsed = JSON.parse(result);

    expect(parsed.map_id).toBe("test-topic");
    expect(parsed.total_nodes).toBe(1);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("generates new map when none exists", async () => {
    mocks.getMap.mockReturnValueOnce(null);

    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        nodes: [
          {
            id: "n-1",
            label: "Core Idea",
            type: "concept",
            summary: "The main concept.",
          },
          {
            id: "n-2",
            label: "Common Trap",
            type: "gotcha",
            summary: "A frequent pitfall.",
          },
        ],
      }),
      usage: { prompt_tokens: 100, completion_tokens: 200 },
    });

    const result = await knowledgeMapTool.execute({ topic: "New Domain" });
    const parsed = JSON.parse(result);

    expect(mockInfer).toHaveBeenCalledOnce();
    expect(parsed.total_nodes).toBe(2);
    expect(parsed.concepts).toHaveLength(1);
    expect(parsed.gotchas).toHaveLength(1);
    expect(mocks.deleteMap).toHaveBeenCalledWith("new-domain");
    expect(mocks.upsertMap).toHaveBeenCalledWith("new-domain", "New Domain");
    expect(mocks.insertNodes).toHaveBeenCalledOnce();
    expect(mocks.updateMapStats).toHaveBeenCalledWith("new-domain");
  });

  it("regenerates stale map", async () => {
    mocks.getMap.mockReturnValueOnce({
      id: "stale-topic",
      topic: "Stale Topic",
      node_count: 5,
      max_depth: 0,
      created_at: "2026-03-01 00:00:00",
      updated_at: "2026-03-01 00:00:00",
    });
    mocks.isStale.mockReturnValueOnce(true);

    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        nodes: [
          { id: "n-1", label: "Fresh", type: "concept", summary: "Refreshed." },
        ],
      }),
      usage: { prompt_tokens: 50, completion_tokens: 100 },
    });

    const result = await knowledgeMapTool.execute({ topic: "Stale Topic" });
    const parsed = JSON.parse(result);

    expect(mockInfer).toHaveBeenCalledOnce();
    expect(parsed.total_nodes).toBe(1);
  });

  it("force_refresh bypasses cache", async () => {
    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        nodes: [
          { id: "n-1", label: "New", type: "pattern", summary: "A pattern." },
        ],
      }),
      usage: { prompt_tokens: 50, completion_tokens: 100 },
    });

    await knowledgeMapTool.execute({ topic: "Test", force_refresh: true });
    expect(mockInfer).toHaveBeenCalledOnce();
    expect(mocks.getMap).not.toHaveBeenCalled();
  });

  it("returns error for empty topic", async () => {
    const result = await knowledgeMapTool.execute({ topic: "" });
    expect(JSON.parse(result).error).toContain("required");
  });

  it("handles invalid LLM response gracefully", async () => {
    mocks.getMap.mockReturnValueOnce(null);
    mockInfer.mockResolvedValueOnce({
      content: "not json at all",
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const result = await knowledgeMapTool.execute({ topic: "Bad Response" });
    expect(JSON.parse(result).error).toBeDefined();
  });

  it("strips markdown fences from LLM response", async () => {
    mocks.getMap.mockReturnValueOnce(null);
    mockInfer.mockResolvedValueOnce({
      content:
        '```json\n{"nodes":[{"id":"n-1","label":"Test","type":"concept","summary":"Works."}]}\n```',
      usage: { prompt_tokens: 50, completion_tokens: 50 },
    });

    const result = await knowledgeMapTool.execute({ topic: "Fenced" });
    const parsed = JSON.parse(result);
    expect(parsed.total_nodes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// knowledge_map_expand
// ---------------------------------------------------------------------------

describe("knowledge_map_expand", () => {
  it("returns error for nonexistent node", async () => {
    mocks.getNode.mockReturnValueOnce(null);
    const result = await knowledgeMapExpandTool.execute({ node_id: "bad/n-1" });
    expect(JSON.parse(result).error).toContain("not found");
  });

  it("returns cached children if already expanded", async () => {
    mocks.getNode.mockReturnValueOnce({
      id: "map/n-1",
      map_id: "map",
      label: "Parent",
      type: "concept",
      summary: "A concept",
      depth: 0,
      parent_id: null,
    });
    mocks.getChildNodes.mockReturnValueOnce([
      {
        id: "map/n-5",
        label: "Child",
        type: "pattern",
        summary: "A pattern",
        depth: 1,
        parent_id: "map/n-1",
      },
    ]);

    const result = await knowledgeMapExpandTool.execute({ node_id: "map/n-1" });
    const parsed = JSON.parse(result);

    expect(parsed.cached).toBe(true);
    expect(parsed.children).toHaveLength(1);
    expect(mockInfer).not.toHaveBeenCalled();
  });

  it("returns error at node count limit", async () => {
    mocks.getNode.mockReturnValueOnce({
      id: "map/n-1",
      map_id: "map",
      label: "Full",
      type: "concept",
      summary: "Full",
      depth: 0,
      parent_id: null,
    });
    mocks.getChildNodes.mockReturnValueOnce([]);
    mocks.countNodes.mockReturnValueOnce(60);

    const result = await knowledgeMapExpandTool.execute({ node_id: "map/n-1" });
    expect(JSON.parse(result).error).toContain("limit");
  });

  it("returns error at max depth", async () => {
    mocks.getNode.mockReturnValueOnce({
      id: "map/n-1",
      map_id: "map",
      label: "Deep",
      type: "concept",
      summary: "Deep",
      depth: 4,
      parent_id: null,
    });
    mocks.getChildNodes.mockReturnValueOnce([]);
    mocks.countNodes.mockReturnValueOnce(10);

    const result = await knowledgeMapExpandTool.execute({ node_id: "map/n-1" });
    expect(JSON.parse(result).error).toContain("depth");
  });

  it("generates child nodes via LLM", async () => {
    mocks.getNode.mockReturnValueOnce({
      id: "map/n-1",
      map_id: "map",
      label: "Parent",
      type: "concept",
      summary: "Expand me",
      depth: 0,
      parent_id: null,
    });
    mocks.getChildNodes.mockReturnValueOnce([]);
    mocks.countNodes.mockReturnValueOnce(5);
    mocks.getNodes.mockReturnValueOnce([]); // siblings for context
    mocks.nextNodeSeq.mockReturnValueOnce(6);

    mockInfer.mockResolvedValueOnce({
      content: JSON.stringify({
        nodes: [
          {
            id: "x-1",
            label: "Detail A",
            type: "concept",
            summary: "Deeper detail.",
          },
          { id: "x-2", label: "Trap B", type: "gotcha", summary: "Watch out." },
        ],
      }),
      usage: { prompt_tokens: 80, completion_tokens: 150 },
    });

    const result = await knowledgeMapExpandTool.execute({ node_id: "map/n-1" });
    const parsed = JSON.parse(result);

    expect(parsed.cached).toBe(false);
    expect(parsed.children).toHaveLength(2);
    expect(parsed.children[0].id).toBe("map/n-6");
    expect(parsed.children[1].id).toBe("map/n-7");
    expect(mockInfer).toHaveBeenCalledOnce();
    expect(mocks.insertNodes).toHaveBeenCalledOnce();
    expect(mocks.updateMapStats).toHaveBeenCalledWith("map");
  });

  it("returns error for empty node_id", async () => {
    const result = await knowledgeMapExpandTool.execute({ node_id: "" });
    expect(JSON.parse(result).error).toContain("required");
  });
});
