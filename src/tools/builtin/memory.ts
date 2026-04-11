/**
 * Memory tools — agent-accessible memory search, store, and reflect.
 *
 * 3 native builtin tools exposed to LLMs during goal execution.
 * Only registered when Hindsight is enabled (semantic memory available).
 *
 * Governance: Per-task store counter caps memory_store at MAX_STORES_PER_TASK
 * to prevent memory pollution from runaway tool loops.
 */

import type { Tool } from "../types.js";
import { getMemoryService } from "../../memory/index.js";
import type { MemoryBank } from "../../memory/types.js";
import {
  queryTriples,
  getEntityHistory,
  formatTriples,
} from "../../memory/knowledge-graph.js";

const BANK_MAP: Record<string, MemoryBank> = {
  operational: "mc-operational",
  jarvis: "mc-jarvis",
  system: "mc-system",
};

function resolveBank(bank: string): MemoryBank {
  return BANK_MAP[bank] ?? "mc-operational";
}

// ---------------------------------------------------------------------------
// Governance: per-task memory store rate limiting
// ---------------------------------------------------------------------------

const MAX_STORES_PER_TASK = 5;
const storeCountByTask = new Map<string, number>();
let _currentTaskId: string | null = null;

/**
 * Set the current task context for governance tracking.
 * Call with taskId before tool execution, null after completion.
 */
export function setMemoryTaskContext(taskId: string | null): void {
  _currentTaskId = taskId;
  if (!taskId) storeCountByTask.clear();
}

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export const memorySearchTool: Tool = {
  name: "memory_search",
  definition: {
    type: "function",
    function: {
      name: "memory_search",
      description: `Search the long-term memory system for relevant past experiences, learnings, and context.

USE WHEN:
- You need context from previous task executions (planning patterns, tool failure workarounds)
- You want to recall user preferences or conversation history (jarvis bank)
- You need infrastructure or ritual outcome history (system bank)

DO NOT USE WHEN:
- The information is available in the current task description or goal context
- You need real-time data (use tools like shell_exec or http instead)
- You're looking for code or file contents (use file_read)

BANKS:
- "operational" — Task execution learnings, planning patterns, tool strategies
- "jarvis" — User conversations, preferences, schedule, personal context
- "system" — Infrastructure events, ritual outcomes, agent performance`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language search query. Be specific — 'API timeout handling' works better than 'errors'.",
          },
          bank: {
            type: "string",
            enum: ["operational", "jarvis", "system"],
            description: "Which memory bank to search. Default: operational.",
          },
          max_results: {
            type: "number",
            description: "Maximum memories to return (1-20). Default: 5.",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const bank = resolveBank((args.bank as string) ?? "operational");
    const maxResults = Math.min(
      Math.max((args.max_results as number) ?? 5, 1),
      20,
    );

    const memories = await getMemoryService().recall(query, {
      bank,
      maxResults,
    });

    if (memories.length === 0) {
      return "No relevant memories found.";
    }

    return memories
      .map((m, i) => {
        const relevance = m.relevance
          ? ` (relevance: ${m.relevance.toFixed(2)})`
          : "";
        return `${i + 1}. ${m.content}${relevance}`;
      })
      .join("\n");
  },
};

// ---------------------------------------------------------------------------
// memory_store
// ---------------------------------------------------------------------------

export const memoryStoreTool: Tool = {
  name: "memory_store",
  definition: {
    type: "function",
    function: {
      name: "memory_store",
      description: `Store a durable learning in long-term memory. Use sparingly — only for knowledge that should survive across sessions.

MEMORY TYPES (choose carefully):
- FACT: Durable knowledge — IPs, hostnames, API endpoints, credentials paths, architecture decisions. Survives decay long-term. Use for things that don't change.
- OBSERVATION: Ephemeral context — what the user discussed, preferences expressed. Decays faster. Use for "Fede mentioned X" moments.
- CORRECTION: "When I say X, I mean Y" — user corrected a mistake. Persists for intent learning.

USE WHEN:
- You discovered a NEW fact worth remembering across sessions (tool workaround, user preference, project detail)
- The user explicitly asked you to remember something
- You found a non-obvious gotcha (data format, API quirk, timezone issue)

DO NOT USE WHEN:
- Greeting noise ("user said hi", "session started") — not worth storing
- Content is trivially short — be specific and actionable
- The information is transient (temporary errors, one-time states)
- Background extraction will capture this automatically (tasks with ≥3 tools auto-extract)
- You're storing raw data that belongs in a file (use jarvis_file_write instead)

TIPS:
- Be specific: "ShellExec fails with ENOENT for npm — use /usr/bin/npm" > "npm doesn't work"
- One fact per call. Don't bundle multiple learnings into one entry`,
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The observation or learning to store. Should be specific, actionable, and self-contained.",
          },
          bank: {
            type: "string",
            enum: ["operational", "jarvis", "system"],
            description: "Which memory bank to store in. Default: operational.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              'Optional tags for categorization. Examples: ["tool-error", "planning"], ["telegram", "preference"].',
          },
        },
        required: ["content"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    // Governance: enforce per-task store limit
    if (_currentTaskId) {
      const count = storeCountByTask.get(_currentTaskId) ?? 0;
      if (count >= MAX_STORES_PER_TASK) {
        return JSON.stringify({
          warning: `Memory store limit reached (${MAX_STORES_PER_TASK}/task). Prioritize quality over quantity — store only the most valuable observation.`,
        });
      }
      storeCountByTask.set(_currentTaskId, count + 1);
    }

    const content = args.content as string;
    const bank = resolveBank((args.bank as string) ?? "operational");
    const tags = (args.tags as string[]) ?? [];

    await getMemoryService().retain(content, {
      bank,
      tags,
      async: true,
      trustTier: 3, // provisional — LLM-originated during task execution
      source: "agent",
    });

    return `Memory stored in ${bank} bank.`;
  },
};

// ---------------------------------------------------------------------------
// memory_reflect
// ---------------------------------------------------------------------------

export const memoryReflectTool: Tool = {
  name: "memory_reflect",
  definition: {
    type: "function",
    function: {
      name: "memory_reflect",
      description: `Synthesize a reflection from stored memories about a topic. Returns a coherent summary rather than individual memories.

USE WHEN:
- You need a high-level understanding of past experiences with a topic
- You want to understand patterns across multiple related memories
- You need strategic context (e.g., "What has worked well for deployment tasks?")

DO NOT USE WHEN:
- You need specific, individual memories (use memory_search instead)
- You need current/real-time information`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Topic or question to reflect on. Be specific for better synthesis.",
          },
          bank: {
            type: "string",
            enum: ["operational", "jarvis", "system"],
            description:
              "Which memory bank to reflect on. Default: operational.",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const bank = resolveBank((args.bank as string) ?? "operational");

    const reflection = await getMemoryService().reflect(query, { bank });

    if (!reflection) {
      return "No memories available for reflection on this topic.";
    }

    return reflection;
  },
};

// ---------------------------------------------------------------------------
// memory_kg_query — Temporal knowledge graph lookup (v6.5 M1)
// ---------------------------------------------------------------------------

export const memoryKgQueryTool: Tool = {
  name: "memory_kg_query",
  definition: {
    type: "function",
    function: {
      name: "memory_kg_query",
      description:
        "Query the temporal knowledge graph for entity facts and relationships. " +
        "Tracks what is/was true about people, projects, and concepts over time. " +
        "Use to check current entity state or historical state at a specific date. " +
        "Example: subject='cuatro flor' to see all known facts about that project.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description:
              "Entity name to query (person, project, concept). Case-insensitive.",
          },
          predicate: {
            type: "string",
            description:
              "Optional relationship type filter (e.g., 'status_is', 'uses', 'blocked_by').",
          },
          as_of: {
            type: "string",
            description:
              "Optional ISO date to query historical state ('what was true on this date?'). Omit for current state.",
          },
          include_history: {
            type: "boolean",
            description:
              "If true, include invalidated (superseded) facts. Default: false.",
          },
        },
        required: ["subject"],
      },
    },
  },
  deferred: true,

  async execute(args: Record<string, unknown>): Promise<string> {
    const subject = args.subject as string;
    const predicate = args.predicate as string | undefined;
    const asOf = args.as_of as string | undefined;
    const includeHistory = args.include_history === true;

    const triples = includeHistory
      ? getEntityHistory(subject)
      : queryTriples({ subject, predicate, asOf });

    if (triples.length === 0) {
      return `No knowledge graph entries found for "${subject}".`;
    }

    return `Knowledge graph for "${subject}" (${triples.length} facts):\n${formatTriples(triples)}`;
  },
};
