/**
 * Tests for ToolSourceManager.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolSourceManager } from "./source.js";
import type { ToolSource, ToolSourceHealth } from "./source.js";
import type { ToolRegistry } from "./registry.js";

function makeRegistry(): ToolRegistry {
  const tools = new Map<string, unknown>();
  return {
    register: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
    list: vi.fn(() => Array.from(tools.keys())),
  } as unknown as ToolRegistry;
}

function makeSource(
  name: string,
  opts: {
    initError?: string;
    tools?: string[];
    healthy?: boolean;
  } = {},
): ToolSource {
  const tools = opts.tools ?? [`${name}_tool`];
  return {
    manifest: { name, version: "1.0.0", description: `${name} source` },
    initialize: opts.initError
      ? vi.fn().mockRejectedValue(new Error(opts.initError))
      : vi.fn().mockResolvedValue(undefined),
    registerTools: vi.fn(async (registry: ToolRegistry) => {
      for (const t of tools) {
        registry.register({ name: t } as any);
      }
      return tools;
    }),
    healthCheck: vi.fn(
      async (): Promise<ToolSourceHealth> => ({
        healthy: opts.healthy ?? true,
        checkedAt: new Date().toISOString(),
      }),
    ),
    teardown: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ToolSourceManager", () => {
  let manager: ToolSourceManager;
  let registry: ToolRegistry;

  beforeEach(() => {
    manager = new ToolSourceManager();
    registry = makeRegistry();
  });

  describe("initAll", () => {
    it("initializes all sources and registers tools", async () => {
      const src1 = makeSource("a", { tools: ["tool_a1", "tool_a2"] });
      const src2 = makeSource("b", { tools: ["tool_b1"] });

      manager.addSource(src1);
      manager.addSource(src2);

      const result = await manager.initAll(registry);

      expect(result.initialized).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.totalTools).toBe(3);
      expect(src1.initialize).toHaveBeenCalled();
      expect(src2.initialize).toHaveBeenCalled();
      expect(src1.registerTools).toHaveBeenCalledWith(registry);
      expect(src2.registerTools).toHaveBeenCalledWith(registry);
    });

    it("does not block healthy sources when one fails", async () => {
      const good = makeSource("good", { tools: ["g1"] });
      const bad = makeSource("bad", { initError: "OAuth expired" });

      manager.addSource(good);
      manager.addSource(bad);

      const result = await manager.initAll(registry);

      expect(result.initialized).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.totalTools).toBe(1);
      // Bad source's registerTools should not be called
      expect(bad.registerTools).not.toHaveBeenCalled();
    });
  });

  describe("healthCheckAll", () => {
    it("returns per-source health results", async () => {
      const healthy = makeSource("ok", { healthy: true });
      const sick = makeSource("sick", { healthy: false });

      manager.addSource(healthy);
      manager.addSource(sick);
      await manager.initAll(registry);

      const results = await manager.healthCheckAll();

      expect(results.ok.healthy).toBe(true);
      expect(results.sick.healthy).toBe(false);
    });

    it("handles health check errors gracefully", async () => {
      const exploding: ToolSource = {
        ...makeSource("boom"),
        healthCheck: vi.fn().mockRejectedValue(new Error("connection lost")),
      };

      manager.addSource(exploding);
      await manager.initAll(registry);

      const results = await manager.healthCheckAll();

      expect(results.boom.healthy).toBe(false);
      expect(results.boom.message).toContain("connection lost");
    });
  });

  describe("teardownAll", () => {
    it("calls teardown on all sources", async () => {
      const src1 = makeSource("a");
      const src2 = makeSource("b");

      manager.addSource(src1);
      manager.addSource(src2);
      await manager.initAll(registry);

      await manager.teardownAll();

      expect(src1.teardown).toHaveBeenCalled();
      expect(src2.teardown).toHaveBeenCalled();
    });

    it("continues teardown even if one source throws", async () => {
      const errSrc: ToolSource = {
        ...makeSource("err"),
        teardown: vi.fn().mockRejectedValue(new Error("cleanup failed")),
      };
      const okSrc = makeSource("ok");

      manager.addSource(errSrc);
      manager.addSource(okSrc);
      await manager.initAll(registry);

      // Should not throw
      await manager.teardownAll();

      expect(okSrc.teardown).toHaveBeenCalled();
    });
  });

  describe("getSources", () => {
    it("returns source metadata with tool counts", async () => {
      const src = makeSource("test", { tools: ["t1", "t2", "t3"] });

      manager.addSource(src);
      await manager.initAll(registry);

      const sources = manager.getSources();

      expect(sources).toHaveLength(1);
      expect(sources[0].name).toBe("test");
      expect(sources[0].toolCount).toBe(3);
      expect(sources[0].tools).toEqual(["t1", "t2", "t3"]);
    });

    it("shows 0 tools for failed sources", async () => {
      const bad = makeSource("bad", { initError: "fail" });

      manager.addSource(bad);
      await manager.initAll(registry);

      const sources = manager.getSources();
      expect(sources[0].toolCount).toBe(0);
      expect(sources[0].tools).toEqual([]);
    });
  });
});
