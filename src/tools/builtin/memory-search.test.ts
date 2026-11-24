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
import {
  memoryKgQueryTool,
  memoryReflectTool,
  memorySearchTool,
  memoryStoreTool,
} from "./memory.js";

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
        "- You're looking for code or file contents (use file_read when it is among your tools)",
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

// Description pins: each tool's whole description text as registered.
describe("tool description texts", () => {
  it("memory_search carries exactly this description", () => {
    expect(memorySearchTool.definition.function.description).toBe(
      [
        "Search one long-term memory bank with a text query. Results are entries chosen for the query, best first; when nothing matches, the bank's newest entries may be listed instead, and \"No relevant memories found.\" can also mean the search failed.",
        "",
        "USE WHEN:",
        "- You need context from previous task executions (planning patterns, tool failure workarounds)",
        "- You want to recall user preferences or conversation history (jarvis bank)",
        "",
        "DO NOT USE WHEN:",
        "- The information is available in the current task description or goal context",
        "- You need real-time data",
        "- You're looking for code or file contents (use file_read when it is among your tools)",
        "",
        "BANKS:",
        "- \"operational\" — Task execution learnings, planning patterns, tool strategies",
        "- \"jarvis\" — User conversations, preferences, schedule, personal context",
        "- \"system\" — the system bank (nothing in the agent writes to it automatically; it may be empty)",
      ].join("\n"),
    );
  });

  it("memory_store carries exactly this description", () => {
    expect(memoryStoreTool.definition.function.description).toBe(
      [
        "Store a durable learning in long-term memory. Use sparingly — only for knowledge that should survive across sessions.",
        "",
        "MEMORY TYPES:",
        "- FACT: Durable knowledge — IPs, hostnames, API endpoints, credentials paths, architecture decisions. Survives decay long-term. Use for things that don't change.",
        "- OBSERVATION: Ephemeral context — what the user discussed, preferences expressed. Decays faster. Use for \"the user mentioned X\" moments.",
        "- CORRECTION: \"When I say X, I mean Y\" — user corrected a mistake. Persists for intent learning.",
        "",
        "USE WHEN:",
        "- You discovered a NEW fact worth remembering across sessions (tool workaround, user preference, project detail)",
        "- The user explicitly asked you to remember something",
        "- You found a non-obvious gotcha (data format, API quirk, timezone issue)",
        "",
        "DO NOT USE WHEN:",
        "- Greeting noise (\"user said hi\", \"session started\") — not worth storing",
        "- Content is trivially short — be specific and actionable",
        "- The information is transient (temporary errors, one-time states)",
        "- You're storing raw data that belongs in a file (use jarvis_file_write when it is among your tools)",
        "",
        "TIPS:",
        "- Be specific: \"ShellExec fails with ENOENT for npm — use /usr/bin/npm\" > \"npm doesn't work\"",
        "- One fact per call. Don't bundle multiple learnings into one entry",
      ].join("\n"),
    );
  });

  it("memory_reflect carries exactly this description", () => {
    expect(memoryReflectTool.definition.function.description).toBe(
      [
        "Synthesize a reflection from stored memories about a topic. Returns a coherent summary rather than individual memories.",
        "",
        "USE WHEN:",
        "- You need a high-level understanding of past experiences with a topic",
        "- You want to understand patterns across multiple related memories",
        "- You need strategic context (e.g., \"What has worked well for deployment tasks?\")",
        "",
        "DO NOT USE WHEN:",
        "- You need specific, individual memories (use memory_search when it is among your tools)",
        "- You need current/real-time information",
      ].join("\n"),
    );
  });

  it("memory_kg_query carries exactly this description", () => {
    expect(memoryKgQueryTool.definition.function.description).toBe(
      [
        "Query the temporal knowledge graph for entity facts and relationships. Tracks what is/was true about people, projects, and concepts over time. Use to check current entity state or historical state at a specific date. Example: subject='acme website' to see current facts about that project.",
        "",
        "DO NOT USE WHEN:",
        "- You know only part of a name or a keyword: this tool does no partial or keyword match on subject, and a miss returns a plain \"No knowledge graph entries found\" line.",
        "- You combine include_history with predicate or as_of: with include_history both are ignored, and up to 50 facts, current and superseded, come back.",
        "- You want a stored note, a file or a user profile fact: this tool reads only the knowledge-graph facts.",
      ].join("\n"),
    );
  });
});
