/**
 * memory_search over the real SQLite backend: with MEMORY_RECALL_FLOOR=on a
 * query made only of common words gets the honest empty text, not the rows
 * that happen to share those words. The tool's description is pinned whole, so
 * a sentence added beside it fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";

const backend = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../memory/index.js", () => ({ getMemoryService: () => backend.current }));
vi.mock("../../memory/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../memory/embeddings.js")>()),
  embed: async () => null,
}));
vi.mock("../../observability/task-trace.js", () => ({ emitTraceEvent: () => {} }));

import { SqliteMemoryBackend } from "../../memory/sqlite-backend.js";
import { memorySearchTool } from "./memory.js";

const prevMode = process.env.MEMORY_RECALL_FLOOR;

beforeEach(() => {
  initDatabase(":memory:");
  backend.current = new SqliteMemoryBackend(false);
  const ins = getDatabase().prepare(
    "INSERT INTO conversations (bank, tags, content, trust_tier, source) VALUES ('mc-jarvis', '[]', ?, 2, 'agent')",
  );
  for (let i = 0; i < 10; i++) ins.run(`Usuario: el proyecto de la semana ${i} sigue en curso`);
  ins.run("Usuario: el proyecto zafiro arranca el lunes");
  for (let i = 0; i < 20; i++) ins.run(`Usuario: reunion ${i} con el equipo de ventas`);
});

afterEach(() => {
  closeDatabase();
  if (prevMode === undefined) delete process.env.MEMORY_RECALL_FLOOR;
  else process.env.MEMORY_RECALL_FLOOR = prevMode;
  vi.restoreAllMocks();
});

describe("memory_search with the recall floor", () => {
  const search = (query: string) => memorySearchTool.execute({ query, bank: "jarvis" });

  it("off: common words still list the rows that share them", async () => {
    delete process.env.MEMORY_RECALL_FLOOR;
    const out = await search("como va el proyecto esta semana");
    expect(out).not.toBe("No relevant memories found.");
    expect(out).toMatch(/^1\. Usuario: el proyecto/);
  });

  it("on: a common-only query returns the honest empty text", async () => {
    process.env.MEMORY_RECALL_FLOOR = "on";
    expect(await search("como va el proyecto esta semana")).toBe("No relevant memories found.");
  });

  it("on: a nothing-matches query no longer lists the newest rows", async () => {
    process.env.MEMORY_RECALL_FLOOR = "on";
    expect(await search("factura pendiente del dentista")).toBe("No relevant memories found.");
  });

  it("on: a rare keyword lists only its row", async () => {
    process.env.MEMORY_RECALL_FLOOR = "on";
    const out = await search("que paso con el proyecto zafiro");
    expect(out).toMatch(/^1\. Usuario: el proyecto zafiro arranca el lunes \(relevance: \d\.\d\d\)$/);
  });
});

describe("memory_search description", () => {
  it("is exactly this text", () => {
    expect(memorySearchTool.definition.function.description).toBe(
      [
        'Search one long-term memory bank with a text query. Results are entries chosen for the query, best first; when nothing matches, the bank\'s newest entries may be listed instead, and "No relevant memories found." can also mean the search failed.',
        "",
        "USE WHEN:",
        "- You need context from previous task executions (planning patterns, tool failure workarounds)",
        "- You want to recall user preferences or conversation history (jarvis bank)",
        "",
        "DO NOT USE WHEN:",
        "- The information is available in the current task description or goal context",
        "- You need real-time data",
        "- You're looking for code or file contents (use file_read)",
        "",
        "BANKS:",
        '- "operational" — Task execution learnings, planning patterns, tool strategies',
        '- "jarvis" — User conversations, preferences, schedule, personal context',
        '- "system" — the system bank (nothing in the agent writes to it automatically; it may be empty)',
      ].join("\n"),
    );
  });

  it("each property carries exactly this text", () => {
    const props = (
      memorySearchTool.definition.function.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect({
      query: props.query?.description,
      bank: props.bank?.description,
      max_results: props.max_results?.description,
    }).toEqual({
      query: "Natural language search query. Be specific — 'API timeout handling' works better than 'errors'.",
      bank: "Which memory bank to search. Default: operational.",
      max_results: "Maximum memories to return (1-20). Default: 5.",
    });
    expect(Object.keys(props).sort()).toEqual(["bank", "max_results", "query"]);
  });
});
