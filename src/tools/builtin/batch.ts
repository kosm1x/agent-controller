/**
 * Batch decomposition tool (v6.4 SK1).
 *
 * Decomposes large tasks into chunks of max 5 items each,
 * submitting them as sequential subtasks. Prevents the LLM from
 * exhausting 35 rounds on a single massive task.
 */

import type { Tool } from "../types.js";
import { submitTask } from "../../dispatch/dispatcher.js";

export const batchDecomposeTool: Tool = {
  name: "batch_decompose",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "batch_decompose",
      description: `Decompose a large batch task into smaller chunks that Jarvis can execute sequentially.

USE WHEN:
- A task involves MORE THAN 5 files, items, or records to process
- The user says "migra todo", "procesa todos", "actualiza todas las tareas"
- The prompt enhancer suggested splitting a large task

HOW IT WORKS:
1. You provide the items to process and the action to perform on each
2. The tool chunks them into groups of max 5
3. Each chunk is submitted as a subtask
4. Results are collected and returned

DO NOT USE WHEN:
- Task involves ≤5 items (just do it directly)
- The task is a single complex operation (not a batch of similar operations)

EXAMPLE:
  items: ["file1.md", "file2.md", ..., "file20.md"]
  action: "Read each file and update its status to completed"
  tools: ["jarvis_file_read", "jarvis_file_write"]`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "The action to perform on each batch of items. Be specific — this becomes the subtask description.",
          },
          items: {
            type: "array",
            items: { type: "string" },
            description:
              "List of items to process (file paths, task names, record IDs, etc.)",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              'Tool names each subtask needs (e.g., ["jarvis_file_read", "jarvis_file_write"])',
          },
          chunk_size: {
            type: "number",
            description: "Items per chunk (default: 5, max: 10)",
          },
        },
        required: ["action", "items", "tools"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const items = args.items as string[];
    const tools = args.tools as string[];
    const chunkSize = Math.min(
      Math.max((args.chunk_size as number) ?? 5, 1),
      10,
    );

    // Safety cap: prevent unbounded subtask creation (audit #5)
    const MAX_ITEMS = 100;
    if (items.length > MAX_ITEMS) {
      return JSON.stringify({
        error: `Too many items (${items.length}). Maximum is ${MAX_ITEMS}. Narrow the scope or split manually.`,
      });
    }

    if (items.length <= chunkSize) {
      return JSON.stringify({
        message: `Only ${items.length} items — no decomposition needed. Process them directly.`,
        items,
      });
    }

    // Chunk items
    const chunks: string[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    const results: Array<{ chunk: number; taskId: string; items: string[] }> =
      [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const description = `Batch ${i + 1}/${chunks.length}: ${action}\n\nItems in this batch:\n${chunk.map((item, j) => `${j + 1}. ${item}`).join("\n")}\n\nProcess ALL items in this batch. Report results for each.`;

      try {
        const result = await submitTask({
          title: `[Batch ${i + 1}/${chunks.length}] ${action.slice(0, 60)}`,
          description,
          agentType: "fast",
          tools,
          tags: ["batch", `chunk:${i + 1}/${chunks.length}`],
        });
        results.push({
          chunk: i + 1,
          taskId: result.taskId,
          items: chunk,
        });
      } catch (err) {
        return JSON.stringify({
          error: `Failed to submit batch ${i + 1}: ${err instanceof Error ? err.message : err}`,
          submitted: results,
        });
      }
    }

    return JSON.stringify({
      decomposed: true,
      total_items: items.length,
      chunks: chunks.length,
      chunk_size: chunkSize,
      tasks: results,
      message: `Decomposed ${items.length} items into ${chunks.length} batches of ${chunkSize}. All subtasks submitted.`,
    });
  },
};
