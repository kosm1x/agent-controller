/**
 * V8.4 — POST /api/tasks accepts optional `gates` (source "submission"),
 * validated at the edge: a malformed ledger is a 400, never a task that
 * silently runs ungated. `priority`, `tags` and `tools` are validated at the
 * same edge, and the dashboard's submit form may only offer accepted priorities.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
}));
vi.mock("../../dispatch/dispatcher.js", () => ({
  submitTask: mocks.submitTask,
  listTasks: vi.fn(() => []),
  getTaskWithRuns: vi.fn(() => null),
  cancelTask: vi.fn(),
}));
// The rate limiter is not under test; a pass-through keeps the number of
// requests this file may send independent of the wall clock.
vi.mock("../rate-limit.js", () => ({
  apiRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { tasks } from "./tasks.js";

const app = new Hono();
app.route("/api/tasks", tasks);

beforeEach(() => {
  mocks.submitTask.mockReset();
  mocks.submitTask.mockResolvedValue({
    taskId: "t-1",
    agentType: "fast",
    classification: { score: 1, reason: "", explicit: false },
  });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/tasks gates", () => {
  it("forwards validated gates to submitTask; omits the field when absent", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "gated",
        description: "do it",
        gates: [{ criterion: "typecheck", check: "npx tsc --noEmit" }],
      }),
    });
    expect(res.status).toBe(201);
    expect(mocks.submitTask).toHaveBeenCalledWith(
      expect.objectContaining({
        gates: [{ criterion: "typecheck", check: "npx tsc --noEmit" }],
      }),
    );
    const plain = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "plain", description: "no gates" }),
    });
    expect(plain.status).toBe(201);
    expect(mocks.submitTask.mock.calls[1]![0]).not.toHaveProperty("gates");
  });

  it("rejects a malformed gates payload with 400 and never submits", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "bad",
        description: "d",
        gates: [{ check: "orphan" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/gates: .*criterion/),
    });
    expect(mocks.submitTask).not.toHaveBeenCalled();
  });

  it("R6: forwards interactive:false only; absent or true leaves the default (interactive)", async () => {
    const post = (extra: Record<string, unknown>) =>
      app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", description: "d", ...extra }),
      });
    expect((await post({ interactive: false })).status).toBe(201);
    expect((await post({})).status).toBe(201);
    expect((await post({ interactive: true })).status).toBe(201);
    expect((await post({ interactive: "false" })).status).toBe(201);
    const calls = mocks.submitTask.mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({ interactive: false });
    expect(calls[1]).not.toHaveProperty("interactive");
    expect(calls[2]).not.toHaveProperty("interactive");
    expect(calls[3]).not.toHaveProperty("interactive");
  });
});

const post = (extra: Record<string, unknown>) =>
  app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "t", description: "d", ...extra }),
  });

// The four allowed priorities and near and far values outside them.
const PRIORITY_CANDIDATES = [
  "critical",
  "high",
  "medium",
  "low",
  "urgent",
  "normal",
  "Medium",
  " medium",
  "medium ",
  "0",
  "HIGH",
  "",
];

// A priority outside the four the tasks table allows is a 400 at the edge,
// never a submission the database then refuses as a server error.
describe("POST /api/tasks priority", () => {
  it("accepts exactly the four allowed priorities out of a wider candidate list, each passed unchanged", async () => {
    const accepted: string[] = [];
    for (const priority of PRIORITY_CANDIDATES) {
      const res = await post({ priority });
      if (res.status === 201) {
        accepted.push(priority);
      } else {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "priority must be one of critical, high, medium, low" });
      }
    }
    expect(accepted).toEqual(["critical", "high", "medium", "low"]);
    expect(mocks.submitTask.mock.calls.map((c) => c[0].priority)).toEqual(accepted);
  });

  // A null priority means absent: the submission sees `undefined`, so the
  // dispatcher's default applies on every path.
  it("an absent or null priority is accepted and submitted as undefined", async () => {
    expect((await post({})).status).toBe(201);
    expect((await post({ priority: null })).status).toBe(201);
    const calls = mocks.submitTask.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.priority).toBe(undefined);
  });

  it.each([[2], [{ level: "high" }], [["high"]], [true]])(
    "refuses priority %j with 400 and never submits",
    async (priority) => {
      const res = await post({ priority });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "priority must be one of critical, high, medium, low" });
      expect(mocks.submitTask).not.toHaveBeenCalled();
    },
  );
});

// The classifier and the runners treat tags and tools as lists of names; any
// other shape is a 400 at the edge, never a server error or a task.
describe.each([["tags"], ["tools"]])("POST /api/tasks %s", (field) => {
  // Null means absent: the submission sees `undefined`, never a null list that
  // one reader takes as empty and another as unrestricted.
  // An explicit empty list means "none" and reaches the submission as given;
  // only absent or null means "not given".
  it("an array of strings, empty included, is passed unchanged; absent or null is submitted as undefined", async () => {
    expect((await post({ [field]: ["name-a", "name-b"] })).status).toBe(201);
    expect((await post({ [field]: [] })).status).toBe(201);
    expect((await post({})).status).toBe(201);
    expect((await post({ [field]: null })).status).toBe(201);
    const calls = mocks.submitTask.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(4);
    expect(calls[0][field]).toEqual(["name-a", "name-b"]);
    expect(calls[1][field]).not.toBe(undefined);
    expect(calls[1][field]).toEqual([]);
    expect(calls[2][field]).toBe(undefined);
    expect(calls[3][field]).toBe(undefined);
  });

  it.each([["name-a"], [3], [{ a: "b" }], [["name-a", 2]]])(
    "refuses %j with 400 and never submits",
    async (value) => {
      const res = await post({ [field]: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `${field} must be an array of strings` });
      expect(mocks.submitTask).not.toHaveBeenCalled();
    },
  );
});

/**
 * The option values of the `#submit-priority` select in the form's markup and
 * how many options are marked selected. Throws when the select is missing or
 * an option has a shape the pattern does not read, so a markup change cannot
 * hide an option from the check.
 */
function prioritySelect(markup: string): { values: string[]; selected: number } {
  const select = markup.match(/<select id="submit-priority">([\s\S]*?)<\/select>/);
  if (!select) throw new Error("no #submit-priority select in the markup");
  const options = [...select[1].matchAll(/<option value="([^"]*)"( selected)?>/g)];
  const tags = select[1].match(/<option\b/g) ?? [];
  if (options.length === 0 || options.length !== tags.length) {
    throw new Error("an option of #submit-priority has a shape the check does not read");
  }
  return { values: options.map((o) => o[1]), selected: options.filter((o) => o[2]).length };
}

async function routeAcceptsAll(priorities: string[]): Promise<boolean> {
  for (const priority of priorities) {
    if ((await post({ priority })).status !== 201) return false;
  }
  return true;
}

// The dashboard's submit form must offer only priorities the route accepts,
// with one default, so the form's default submission is never refused.
describe("dashboard submit form priority options", () => {
  const FORM = readFileSync(
    fileURLToPath(new URL("../../../public/dashboard/components.js", import.meta.url)),
    "utf8",
  );

  it("every option is accepted by the route; exactly one is selected", async () => {
    const { values, selected } = prioritySelect(FORM);
    expect(await routeAcceptsAll(values)).toBe(true);
    expect(selected).toBe(1);
  });

  it("the check sees a refused option and a second selected one", async () => {
    const markup = [
      '<select id="submit-priority">',
      '  <option value="normal" selected>Normal</option>',
      '  <option value="low" selected>Low</option>',
      "</select>",
    ].join("\n");
    const { values, selected } = prioritySelect(markup);
    expect(values).toEqual(["normal", "low"]);
    expect(await routeAcceptsAll(values)).toBe(false);
    expect(selected).toBe(2);
  });

  it("an option the pattern cannot read fails loudly", () => {
    expect(() =>
      prioritySelect('<select id="submit-priority"><option selected value="low">Low</option></select>'),
    ).toThrow(/shape the check does not read/);
  });

  // Every priority a task can carry gets its own badge colour, and the colour
  // map names no priority the route refuses.
  it("the badge colour map has exactly the priorities the route accepts", async () => {
    const keys = priorityBadgeKeys(FORM);
    expect(await routeAcceptsAll(keys)).toBe(true);
    const accepted: string[] = [];
    for (const priority of PRIORITY_CANDIDATES) {
      if ((await post({ priority })).status === 201) accepted.push(priority);
    }
    expect([...keys].sort()).toEqual([...accepted].sort());
  });

  it("the badge check sees a colour keyed by a refused priority", async () => {
    const source = [
      "function priorityBadge(priority) {",
      "  const colors = {",
      '    critical: "#ef4444",',
      '    high: "#f59e0b",',
      '    normal: "#3b82f6",',
      '    low: "#6b7280",',
      "  };",
    ].join("\n");
    const keys = priorityBadgeKeys(source);
    expect(keys).toEqual(["critical", "high", "normal", "low"]);
    expect(await routeAcceptsAll(keys)).toBe(false);
  });

  it("a badge colour entry the pattern cannot read fails loudly", () => {
    const source = 'function priorityBadge(priority) {\n  const colors = {\n    "medium": "#3b82f6",\n  };';
    expect(() => priorityBadgeKeys(source)).toThrow(/shape the check does not read/);
  });
});

/**
 * The keys of the colour map in `priorityBadge`. Throws when the function, its
 * map or an entry has a shape the pattern does not read.
 */
function priorityBadgeKeys(source: string): string[] {
  const map = source.match(/function priorityBadge\(priority\) \{\s*const colors = \{([^}]*)\}/);
  if (!map) throw new Error("no colour map in priorityBadge");
  return map[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const key = entry.match(/^([a-z]+): "#[0-9a-f]{6}"$/);
      if (!key) throw new Error(`a priorityBadge colour entry has a shape the check does not read: ${entry}`);
      return key[1];
    });
}
