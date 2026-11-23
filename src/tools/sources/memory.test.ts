import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry.js";
import { MemoryToolSource } from "./memory.js";

describe("MemoryToolSource modes (2026-09-12)", () => {
  it("'all' registers the five memory tools (Hindsight backend)", async () => {
    const reg = new ToolRegistry();
    const names = await new MemoryToolSource().registerTools(reg);
    expect(names.sort()).toEqual(
      ["memory_forget", "memory_kg_query", "memory_reflect", "memory_search", "memory_store"],
    );
  });

  it("'backend_independent' registers search, kg_query and forget, and not store or reflect", async () => {
    const reg = new ToolRegistry();
    const names = await new MemoryToolSource("backend_independent").registerTools(reg);
    expect(names.sort()).toEqual(["memory_forget", "memory_kg_query", "memory_search"]);
    expect(reg.get("memory_forget")).toBeDefined();
    expect(reg.get("memory_search")).toBeDefined();
    expect(reg.get("memory_store")).toBeUndefined();
    expect(reg.get("memory_reflect")).toBeUndefined();
  });
});
