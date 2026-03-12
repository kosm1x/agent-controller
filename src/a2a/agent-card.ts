/**
 * A2A Agent Card builder.
 *
 * Generates the discovery document served at /.well-known/agent.json.
 * The card describes MC's capabilities, skills, and supported modes.
 */

import { getConfig } from "../config.js";
import { toolRegistry } from "../tools/registry.js";
import type { A2AAgentCard, A2ASkill } from "./types.js";

/**
 * Build the A2A agent card dynamically from config and registered tools.
 */
export function buildAgentCard(): A2AAgentCard {
  const config = getConfig();
  const baseUrl = config.a2aUrl ?? `http://localhost:${config.port}`;

  const skills: A2ASkill[] = [
    {
      id: "fast-execution",
      name: "Fast Execution",
      description:
        "Single-step tasks with tool access. In-process LLM + tool loop.",
      tags: ["fast", "simple", "tools"],
    },
    {
      id: "heavy-planning",
      name: "Heavy Planning",
      description:
        "Multi-step tasks using Plan-Execute-Reflect (Prometheus) orchestration.",
      tags: ["heavy", "planning", "multi-step"],
    },
    {
      id: "swarm-parallel",
      name: "Swarm Parallel",
      description:
        "Large-scope tasks decomposed and executed in parallel sub-tasks.",
      tags: ["swarm", "parallel", "decomposition"],
    },
    {
      id: "nanoclaw-isolated",
      name: "NanoClaw Isolated",
      description:
        "Tasks requiring Docker container isolation with extended tool access.",
      tags: ["nanoclaw", "container", "isolated"],
    },
  ];

  // Add MCP tools summary as a skill if any are registered
  const allTools = toolRegistry.list();
  const mcpTools = allTools.filter((t) => t.includes("__"));
  if (mcpTools.length > 0) {
    skills.push({
      id: "mcp-tools",
      name: "MCP Tool Servers",
      description: `Access to ${mcpTools.length} external tools via MCP protocol.`,
      tags: ["mcp", "tools", "external"],
    });
  }

  return {
    name: config.a2aName ?? "Mission Control",
    description:
      "Unified AI agent orchestrator with automatic task classification and multi-runner execution.",
    url: baseUrl,
    version: "2.0.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills,
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
  };
}
