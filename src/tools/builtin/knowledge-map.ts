/**
 * Knowledge Map tools — structured domain overviews for Prometheus.
 *
 * Two tools:
 * - knowledge_map: Generate or retrieve a cached concept map for a topic
 * - knowledge_map_expand: Drill deeper into a specific node
 */

import { infer } from "../../inference/adapter.js";
import {
  slugify,
  isStale,
  getMap,
  upsertMap,
  deleteMap,
  getNodes,
  getNode,
  getChildNodes,
  countNodes,
  insertNodes,
  updateMapStats,
  nextNodeSeq,
  MAX_NODES_PER_MAP,
  MAX_DEPTH,
} from "../../db/knowledge-maps.js";
import type { Tool } from "../types.js";

// ---------------------------------------------------------------------------
// LLM prompts
// ---------------------------------------------------------------------------

const GENERATE_SYSTEM = `You are a domain mapping specialist. Given a topic, produce a structured knowledge map as JSON.

Respond ONLY with a JSON object:
{
  "nodes": [
    {
      "id": "n-1",
      "label": "short label",
      "type": "concept|pattern|gotcha",
      "summary": "one paragraph. Use [[label_of_related_node]] inline to explain connections with semantic justification."
    }
  ]
}

Rules:
- Produce 8-12 nodes.
- Use 3 types: "concept" (core domain ideas), "pattern" (recurring approaches/methods), "gotcha" (common pitfalls/misconceptions).
- Include at least 1 gotcha.
- Summaries should use [[wikilinks]] to reference other nodes in this map. Each wikilink must include a brief justification of WHY it's relevant in the surrounding sentence.
- IDs must be sequential: n-1, n-2, n-3, etc.
- Emit ONLY valid JSON. No markdown, no commentary.`;

const EXPAND_SYSTEM = `You are expanding a node in a knowledge map. Given the parent node and its map context, produce child nodes that provide deeper detail.

Respond ONLY with a JSON object:
{
  "nodes": [
    {
      "id": "placeholder",
      "label": "short label",
      "type": "concept|pattern|gotcha",
      "summary": "one paragraph with [[wikilinks]] to sibling or parent nodes."
    }
  ]
}

Rules:
- Produce 3-6 child nodes.
- Children should elaborate on specific aspects of the parent, not repeat it.
- Include at least 1 gotcha if the parent is a complex concept.
- IDs will be reassigned by the system — use any placeholder.
- Emit ONLY valid JSON. No markdown, no commentary.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LLMNode {
  id: string;
  label: string;
  type: string;
  summary: string;
}

function parseLLMNodes(content: string): LLMNode[] {
  // Strip markdown fences if present
  const cleaned = content
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const parsed = JSON.parse(cleaned);
  const nodes: LLMNode[] = parsed.nodes ?? parsed;

  if (!Array.isArray(nodes)) throw new Error("Expected nodes array");

  return nodes.filter(
    (n) =>
      n &&
      typeof n.label === "string" &&
      typeof n.summary === "string" &&
      ["concept", "pattern", "gotcha"].includes(n.type),
  );
}

function formatMapResponse(
  mapId: string,
  topic: string,
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    summary: string;
    depth: number;
    parent_id: string | null;
  }>,
): string {
  const concepts = nodes.filter((n) => n.type === "concept");
  const patterns = nodes.filter((n) => n.type === "pattern");
  const gotchas = nodes.filter((n) => n.type === "gotcha");

  return JSON.stringify({
    map_id: mapId,
    topic,
    total_nodes: nodes.length,
    concepts: concepts.map((n) => ({
      id: n.id,
      label: n.label,
      summary: n.summary,
    })),
    patterns: patterns.map((n) => ({
      id: n.id,
      label: n.label,
      summary: n.summary,
    })),
    gotchas: gotchas.map((n) => ({
      id: n.id,
      label: n.label,
      summary: n.summary,
    })),
  });
}

// ---------------------------------------------------------------------------
// Tool: knowledge_map
// ---------------------------------------------------------------------------

export const knowledgeMapTool: Tool = {
  name: "knowledge_map",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "knowledge_map",
      description: `Generate or retrieve a structured knowledge map for a domain/topic.

USE WHEN:
- You need to understand an unfamiliar domain before planning or executing
- A task involves a specialized field (regulation, finance, science, industry)
- You want a breadth-first overview before diving into specifics

BEHAVIOR:
- If a fresh map exists (< 7 days old), returns it immediately (no LLM call)
- If no map exists or it's stale, generates one with 8-12 concept nodes
- Each node has a type: "concept" (core idea), "pattern" (recurring approach), "gotcha" (common pitfall)
- Node summaries contain [[wikilinks]] to related nodes with semantic justification

RETURNS: The complete knowledge map with all nodes. Use knowledge_map_expand to drill deeper into specific nodes.

NOT FOR: Answering specific factual questions (use web_search). This builds domain understanding, not point lookups.`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              'Domain or topic to map (e.g. "Mexican telecom regulation", "CRISPR gene editing applications")',
          },
          force_refresh: {
            type: "boolean",
            description:
              "Force regeneration even if a cached map exists. Default: false",
          },
        },
        required: ["topic"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const topic = String(args.topic ?? "").trim();
    if (!topic) return JSON.stringify({ error: "topic is required" });

    const forceRefresh = args.force_refresh === true;
    const mapId = slugify(topic);
    if (!mapId)
      return JSON.stringify({ error: "Could not generate map ID from topic" });

    // Check cache
    if (!forceRefresh) {
      const existing = getMap(mapId);
      if (existing && !isStale(existing)) {
        const nodes = getNodes(mapId);
        if (nodes.length > 0) {
          return formatMapResponse(mapId, existing.topic, nodes);
        }
      }
    }

    // Generate via LLM
    try {
      const response = await infer({
        messages: [
          { role: "system", content: GENERATE_SYSTEM },
          {
            role: "user",
            content: `Generate a knowledge map for: ${topic}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 2000,
      });

      const llmNodes = parseLLMNodes(response.content ?? "");
      if (llmNodes.length === 0) {
        return JSON.stringify({
          error: "LLM generated no valid nodes",
        });
      }

      // Clear stale nodes before inserting fresh ones
      deleteMap(mapId);
      upsertMap(mapId, topic);
      const dbNodes = llmNodes.map((n, i) => ({
        id: `${mapId}/n-${i + 1}`,
        map_id: mapId,
        label: n.label,
        type: n.type as "concept" | "pattern" | "gotcha",
        summary: n.summary,
        depth: 0,
        parent_id: null,
      }));
      insertNodes(dbNodes);
      updateMapStats(mapId);

      return formatMapResponse(mapId, topic, dbNodes);
    } catch (err) {
      return JSON.stringify({
        error: `Failed to generate map: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: knowledge_map_expand
// ---------------------------------------------------------------------------

export const knowledgeMapExpandTool: Tool = {
  name: "knowledge_map_expand",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "knowledge_map_expand",
      description: `Drill deeper into a specific node of an existing knowledge map.

USE WHEN:
- You identified a knowledge gap during execution
- A specific concept needs more detail to complete a goal
- The reflector flagged a concept that wasn't adequately addressed

BEHAVIOR:
- Generates 3-6 child nodes under the specified parent node
- Respects limits: max 60 nodes per map, max depth 5
- If the node already has children, returns them without regenerating

REQUIRES: An existing knowledge map. Call knowledge_map first to generate one.`,
      parameters: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description:
              'Full ID of the node to expand (e.g. "mexican-telecom-regulation/n-3")',
          },
        },
        required: ["node_id"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const nodeId = String(args.node_id ?? "").trim();
    if (!nodeId) return JSON.stringify({ error: "node_id is required" });

    // Validate node exists
    const node = getNode(nodeId);
    if (!node) return JSON.stringify({ error: `Node not found: ${nodeId}` });

    // Check if already expanded
    const existingChildren = getChildNodes(nodeId);
    if (existingChildren.length > 0) {
      return JSON.stringify({
        node_id: nodeId,
        label: node.label,
        children: existingChildren.map((c) => ({
          id: c.id,
          label: c.label,
          type: c.type,
          summary: c.summary,
        })),
        cached: true,
      });
    }

    // Check limits
    const nodeCount = countNodes(node.map_id);
    if (nodeCount >= MAX_NODES_PER_MAP) {
      return JSON.stringify({
        error: `Map node limit reached (${MAX_NODES_PER_MAP}). Cannot expand further.`,
      });
    }
    if (node.depth >= MAX_DEPTH - 1) {
      return JSON.stringify({
        error: `Max depth reached (${MAX_DEPTH}). Cannot expand node at depth ${node.depth}.`,
      });
    }

    // Build context from sibling nodes
    const siblings = getNodes(node.map_id)
      .filter((n) => n.depth === node.depth)
      .map((n) => `- ${n.label} (${n.type}): ${n.summary.slice(0, 100)}`)
      .join("\n");

    // Generate via LLM
    try {
      const response = await infer({
        messages: [
          { role: "system", content: EXPAND_SYSTEM },
          {
            role: "user",
            content:
              `Expand this knowledge map node:\n\n` +
              `**${node.label}** (${node.type})\n${node.summary}\n\n` +
              `Map context (sibling nodes):\n${siblings}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 1500,
      });

      const llmNodes = parseLLMNodes(response.content ?? "");
      if (llmNodes.length === 0) {
        return JSON.stringify({ error: "LLM generated no valid child nodes" });
      }

      // Assign real IDs
      let seq = nextNodeSeq(node.map_id);
      const childDepth = node.depth + 1;
      const dbNodes = llmNodes.map((n) => ({
        id: `${node.map_id}/n-${seq++}`,
        map_id: node.map_id,
        label: n.label,
        type: n.type as "concept" | "pattern" | "gotcha",
        summary: n.summary,
        depth: childDepth,
        parent_id: nodeId,
      }));
      insertNodes(dbNodes);
      updateMapStats(node.map_id);

      return JSON.stringify({
        node_id: nodeId,
        label: node.label,
        children: dbNodes.map((c) => ({
          id: c.id,
          label: c.label,
          type: c.type,
          summary: c.summary,
        })),
        cached: false,
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to expand node: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
};
