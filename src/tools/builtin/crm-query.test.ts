/**
 * S6 ruling 5b — `crm_query` is `pulso-aura-upfront`'s capability: a run is
 * offered it only when its attributed project's record declares
 * `capabilities.tools: ["crm_query"]`; while no record declares it, today's
 * env-keyed behaviour holds behind one trace line per task. Real `:memory:`
 * db, synthetic slugs, fetch stubbed (no live call).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../db/index.js";
import { enterRunToolContext } from "../rule-of-two.js";
import { ToolRegistry } from "../registry.js";
import type { Tool } from "../types.js";
import { crmQueryTool } from "./crm-query.js";
import { recordGatedToolScope } from "../../projects/capabilities.js";
import { parseProjectRecord, ProjectRecordError } from "../../projects/record.js";

const TOKEN = "crm-token-value-0123456789";

const dummy: Tool = {
  name: "dummy_read",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  definition: {
    type: "function",
    function: { name: "dummy_read", description: "d", parameters: { type: "object", properties: {} } },
  },
  execute: async () => "{}",
};

function seed(pulsoConfig: Record<string, unknown>): void {
  initDatabase(":memory:");
  const db = getDatabase();
  const p = db.prepare("INSERT INTO projects (id, slug, name, status, config) VALUES (?, ?, ?, 'active', ?)");
  p.run("p1", "acme-crm", "CRM", JSON.stringify(pulsoConfig));
  p.run("p2", "acme-other", "Other", "{}");
  const t = db.prepare("INSERT INTO tasks (task_id, title, description, project_slug) VALUES (?, 't', 'd', ?)");
  t.run("t-crm", "acme-crm");
  t.run("t-other", "acme-other");
  t.run("t-null", null);
}

const inRun = <T>(taskId: string, fn: () => T): T => enterRunToolContext(taskId, fn);

let logSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.CRM_API_TOKEN = TOKEN;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  closeDatabase();
  delete process.env.CRM_API_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const lines = () => logSpy.mock.calls.map((c) => c.map(String).join(" "));

describe("record declares crm_query", () => {
  beforeEach(() => seed({ capabilities: { tools: ["crm_query"] } }));

  it("offered only to the declaring project's runs; outside a run unchanged", () => {
    expect(inRun("t-crm", () => recordGatedToolScope("crm_query"))).toEqual({
      mode: "record",
      offered: true,
      slug: "acme-crm",
    });
    expect(inRun("t-other", () => recordGatedToolScope("crm_query")).offered).toBe(false);
    expect(inRun("t-null", () => recordGatedToolScope("crm_query")).offered).toBe(false);
    expect(recordGatedToolScope("crm_query")).toEqual({ mode: "outside-run", offered: true });
  });

  it("the registry does not offer it to another project's run", () => {
    const reg = new ToolRegistry();
    reg.register(crmQueryTool);
    reg.register(dummy);
    const names = (defs: ReturnType<ToolRegistry["getDefinitions"]>) => defs.map((d) => d.function.name);
    expect(inRun("t-other", () => names(reg.getDefinitions(["crm_query", "dummy_read"])))).toEqual(["dummy_read"]);
    expect(inRun("t-other", () => names(reg.getDefinitions()))).toEqual(["dummy_read"]);
    expect(inRun("t-crm", () => names(reg.getDefinitions(["crm_query", "dummy_read"])))).toEqual([
      "crm_query",
      "dummy_read",
    ]);
  });

  it("the deferred catalog leaves it out for another project's run", () => {
    const reg = new ToolRegistry();
    reg.register({ ...crmQueryTool, deferred: true });
    expect(inRun("t-other", () => reg.getDeferredCatalog(["crm_query"]))).toBeNull();
    expect(inRun("t-crm", () => reg.getDeferredCatalog(["crm_query"]))).toContain("crm_query");
  });

  it("execute refuses another project's run before any HTTP call; the owner's run reaches the API", async () => {
    const refused = JSON.parse(await inRun("t-other", () => crmQueryTool.execute({ endpoint: "pipeline" })));
    expect(refused.error).toContain("not a capability of this task's project (acme-other)");
    expect(fetchSpy).not.toHaveBeenCalled();
    const ok = JSON.parse(await inRun("t-crm", () => crmQueryTool.execute({ endpoint: "pipeline" })));
    expect(ok).toEqual({ ok: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lines().filter((l) => l.includes("env-keyed fallback"))).toEqual([]);
  });
});

describe("no record declares crm_query (today): env-keyed fallback", () => {
  beforeEach(() => seed({ aliases: ["crm"] }));

  it("offered to every run, ONE trace line per task, never a value", async () => {
    const reg = new ToolRegistry();
    reg.register(crmQueryTool);
    expect(inRun("t-other", () => reg.getDefinitions(["crm_query"])).length).toBe(1);
    const ok = JSON.parse(await inRun("t-other", () => crmQueryTool.execute({ endpoint: "pipeline" })));
    expect(ok).toEqual({ ok: 1 });
    inRun("t-null", () => recordGatedToolScope("crm_query"));
    const fallback = lines().filter((l) => l.includes("env-keyed fallback"));
    expect(fallback).toEqual([
      "[crm_query] no record-declared capability for project acme-other; env-keyed fallback",
      "[crm_query] no record-declared capability for project none; env-keyed fallback",
    ]);
    for (const l of lines()) expect(l).not.toContain(TOKEN);
  });
});

it("a db error inside a run fails closed", () => {
  seed({});
  closeDatabase();
  expect(inRun("t-crm", () => recordGatedToolScope("crm_query")).offered).toBe(false);
});

describe("record schema: capabilities.tools", () => {
  const rec = (tools: unknown) =>
    "```json\n" +
    JSON.stringify({ slug: "acme-crm", name: "CRM", status: "active", capabilities: { tools } }) +
    "\n```\n";

  it("accepts crm_query and projects it", () => {
    const { contract } = parseProjectRecord(rec(["crm_query"]), { folderSlug: "acme-crm" });
    expect(contract.capabilities?.tools).toEqual(["crm_query"]);
  });

  it("refuses a tool that is not record-gated, and a duplicate", () => {
    expect(() => parseProjectRecord(rec(["shell_exec"]), { folderSlug: "acme-crm" })).toThrow(ProjectRecordError);
    expect(() => parseProjectRecord(rec(["crm_query", "crm_query"]), { folderSlug: "acme-crm" })).toThrow(
      ProjectRecordError,
    );
  });
});
