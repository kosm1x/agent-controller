/**
 * S6 ruling 5b — the SDK path's in-process tool server (`buildMcpServer`)
 * applies the same offer filter as `ToolRegistry.getDefinitions`: a run
 * attributed to a project whose record does not declare `crm_query` is not
 * given it. Real `:memory:` db and registry singleton; the SDK is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown, extras?: Record<string, unknown>) => ({
    name,
    desc,
    shape,
    handler,
    ...(extras ?? {}),
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: () => (async function* () {})(),
}));

import { buildMcpServer } from "./claude-sdk.js";
import { toolRegistry } from "../tools/registry.js";
import { crmQueryTool } from "../tools/builtin/crm-query.js";
import { enterRunToolContext } from "../tools/rule-of-two.js";
import { closeDatabase, getDatabase, initDatabase } from "../db/index.js";

const served = (names: string[]) =>
  (buildMcpServer(names) as unknown as { config: { tools: Array<{ name: string }> } }).config.tools.map(
    (t) => t.name,
  );

beforeEach(() => {
  toolRegistry.register(crmQueryTool);
  initDatabase(":memory:");
  const db = getDatabase();
  const p = db.prepare("INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, 'active', ?)");
  p.run("p1", "acme-crm", "CRM", JSON.stringify({ capabilities: { tools: ["crm_query"] } }));
  p.run("p2", "acme-other", "Other", "{}");
  const t = db.prepare("INSERT INTO tasks (task_id, title, description, project_slug) VALUES (?, 't', 'd', ?)");
  t.run("t-crm", "acme-crm");
  t.run("t-other", "acme-other");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
});

describe("buildMcpServer — record-gated tools", () => {
  it("a run of a project without the capability gets no crm_query; the owner's run does; outside a run unchanged", () => {
    expect(enterRunToolContext("t-other", () => served(["crm_query"]))).toEqual([]);
    expect(enterRunToolContext("t-crm", () => served(["crm_query"]))).toEqual(["crm_query"]);
    expect(served(["crm_query"])).toEqual(["crm_query"]);
  });
});
