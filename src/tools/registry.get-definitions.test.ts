/**
 * ToolRegistry.getDefinitions — which definitions a run's tool list selects.
 * No list: every registered tool, in registration order. A list: exactly the
 * listed tools that are registered, in the list's order; a name that is not
 * registered selects nothing. Synthetic tools on a private registry.
 */

import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

function makeTool(name: string): Tool {
  return {
    name,
    definition: {
      type: "function" as const,
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: "object", properties: { input: { type: "string" } } },
      },
    },
    execute: async () => "ok",
  };
}

// Registration order is deliberately not alphabetical.
const REGISTERED = ["tool_c", "tool_a", "tool_d", "tool_b"];

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of REGISTERED) reg.register(makeTool(name));
  return reg;
}

const names = (defs: ReturnType<ToolRegistry["getDefinitions"]>) =>
  defs.map((d) => d.function.name);

describe("ToolRegistry.getDefinitions — the tool list a run declares", () => {
  it("no list → every registered tool, in registration order", () => {
    expect(names(registry().getDefinitions())).toEqual(REGISTERED);
    expect(names(registry().getDefinitions(undefined))).toEqual(REGISTERED);
  });

  it("a list → exactly the listed registered tools, in the list's order; unregistered names select nothing", () => {
    // Listed against registration order (tool_b was registered after tool_c),
    // with unregistered names below, between and above the registered ones;
    // tool_a and tool_d are registered neighbours that must stay out. Names
    // match exactly: TOOL_A differs from a registered name only by case and
    // is unknown.
    expect(
      names(
        registry().getDefinitions(["tool_0", "tool_b", "TOOL_A", "tool_bb", "tool_c", "tool_z"]),
      ),
    ).toEqual(["tool_b", "tool_c"]);
    // A one-name list is a list, not "no list".
    expect(names(registry().getDefinitions(["tool_d"]))).toEqual(["tool_d"]);
  });

  it("a list of only unregistered names → no definitions", () => {
    expect(registry().getDefinitions(["tool_0", "tool_z"])).toEqual([]);
  });
});
