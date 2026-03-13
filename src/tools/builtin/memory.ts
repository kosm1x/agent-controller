/**
 * Memory tools — agent-accessible memory search, store, and reflect.
 *
 * 3 native builtin tools exposed to LLMs during goal execution.
 * Only registered when Hindsight is enabled (semantic memory available).
 */

import type { Tool } from "../types.js";
import { getMemoryService } from "../../memory/index.js";
import type { MemoryBank } from "../../memory/types.js";

const BANK_MAP: Record<string, MemoryBank> = {
  operational: "mc-operational",
  jarvis: "mc-jarvis",
  system: "mc-system",
};

function resolveBank(bank: string): MemoryBank {
  return BANK_MAP[bank] ?? "mc-operational";
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
      description: `Store an observation or learning in long-term memory for future recall.

USE WHEN:
- You discovered something important during task execution that future tasks should know
- A tool failed in a specific way and you found a workaround
- You learned a user preference or project detail worth remembering

DO NOT USE WHEN:
- The task reflector will capture this automatically (routine execution outcomes)
- The information is transient (temporary errors, one-time states)
- You're storing raw data that belongs in a database or file

TIPS:
- Be specific and actionable: "ShellExec fails with ENOENT for 'npm' — use full path /usr/bin/npm"
- Include context: what happened, why it matters, what to do differently`,
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
    const content = args.content as string;
    const bank = resolveBank((args.bank as string) ?? "operational");
    const tags = (args.tags as string[]) ?? [];

    await getMemoryService().retain(content, {
      bank,
      tags,
      async: true,
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
