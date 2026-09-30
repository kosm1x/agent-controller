/**
 * POST /api/jarvis-pull — runs the CRM request as a Jarvis chat task through
 * the task seam (read-only research tools, `external` flag), with a
 * single-call fallback on deadline or failure. Response contract unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

type Handler = (e: { data: Record<string, unknown> }) => void;

const mocks = vi.hoisted(() => {
  // Short real-time deadline + budget; read by constants.ts at import.
  process.env.JARVIS_PULL_DEADLINE_MS = "200";
  process.env.JARVIS_PULL_BUDGET_MS = "1000";
  process.env.JARVIS_PULL_MAX_INFLIGHT = "3";
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    emit(type: string, data: Record<string, unknown>) {
      for (const h of handlers.get(type) ?? []) h({ data });
    },
    submitTask: vi.fn(),
    cancelTask: vi.fn(),
    getRunToolCalls: vi.fn(() => ["web_search", "jarvis_file_read"]),
    infer: vi.fn(),
    kbRows: [] as Array<{ path: string; content: string; qualifier: string }>,
    readOnly: new Map<string, boolean>(),
    ledgerRow: { tokens: 4321, cost: 0.0123 } as
      | { tokens: number; cost: number }
      | undefined,
  };
});

vi.mock("../../dispatch/dispatcher.js", () => ({
  submitTask: mocks.submitTask,
  cancelTask: mocks.cancelTask,
  getRunToolCalls: mocks.getRunToolCalls,
}));
vi.mock("../../lib/event-bus.js", () => ({
  getEventBus: () => ({
    subscribe: (type: string, h: Handler) => {
      if (!mocks.handlers.has(type)) mocks.handlers.set(type, new Set());
      mocks.handlers.get(type)!.add(h);
      return { unsubscribe: () => mocks.handlers.get(type)!.delete(h) };
    },
  }),
}));
vi.mock("../../tools/registry.js", () => ({
  toolRegistry: {
    get: (name: string) =>
      mocks.readOnly.has(name)
        ? { name, readOnlyHint: mocks.readOnly.get(name) }
        : undefined,
  },
}));
vi.mock("../../messaging/router.js", () => ({
  buildExternalJarvisSystemPrompt: vi.fn(() => ({
    stable: "STABLE-PERSONA",
    variable: "VARIABLE-PERSONA",
  })),
  CACHE_BREAK_MARKER: "\n<!--CACHE_BREAK_v1-->\n",
}));
vi.mock("../../inference/adapter.js", () => ({ infer: mocks.infer }));
vi.mock("../../db/jarvis-fs.js", () => ({
  getFilesByQualifier: () => mocks.kbRows,
}));
vi.mock("../../db/index.js", () => ({
  getDatabase: () => ({
    prepare: () => ({ get: () => mocks.ledgerRow }),
  }),
}));

import { jarvisPull, JARVIS_PULL_TOOLS } from "./jarvis-pull.js";
import { buildExternalJarvisSystemPrompt } from "../../messaging/router.js";

const app = new Hono();
app.route("/api", jarvisPull);

const QUERY = "¿Qué anunciantes de retail están subiendo inversión digital?";

const post = (body: unknown) =>
  app.request("/api/jarvis-pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let taskSeq = 0;
/** submitTask that finishes the task the given way right after submitting. */
function submitThen(
  finish: ((taskId: string) => void) | null,
  opts: { sync?: boolean } = {},
) {
  mocks.submitTask.mockImplementation(async () => {
    const taskId = `task-${++taskSeq}-abcdef`;
    if (finish) {
      // sync: the terminal event fires BEFORE submitTask resolves (the race
      // the route must survive by subscribing first).
      if (opts.sync) finish(taskId);
      else setTimeout(() => finish(taskId), 0);
    }
    return {
      taskId,
      agentType: "fast",
      classification: { score: 1, reason: "explicit", explicit: true },
    };
  });
}
const completeWith = (result: unknown) => (taskId: string) =>
  mocks.emit("task.completed", {
    task_id: taskId,
    agent_id: "fast",
    result,
    duration_ms: 10,
  });

let logSpy: ReturnType<typeof vi.spyOn>;
const requestLogs = () =>
  logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("[jarvis-pull] role="));

beforeEach(() => {
  mocks.readOnly.clear();
  for (const t of JARVIS_PULL_TOOLS) mocks.readOnly.set(t, true);
  mocks.ledgerRow = { tokens: 4321, cost: 0.0123 };
  mocks.kbRows = [];
  mocks.infer.mockResolvedValue({
    content: "- Respuesta sin herramientas suficiente.\n📎 Fuentes: GDELT",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllMocks();
  logSpy.mockRestore();
  mocks.handlers.clear();
});

describe("POST /api/jarvis-pull — task path", () => {
  it("submits a fast chat task with the read-only allow-list, no interactive:false, no chat origin", async () => {
    submitThen(
      completeWith({
        text: "STATUS: DONE\n- Walmart y Liverpool suben 20 %.\n📎 Fuentes: projects/pulso/README.md, GDELT",
      }),
    );
    const res = await post({ query: QUERY, role: "gerente", context: "Cuenta: Liverpool" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["model", "response", "role", "tokens"]);
    expect(json).toMatchObject({ role: "gerente", model: "jarvis", tokens: 4321 });
    expect(json.response).toBe(
      "- Walmart y Liverpool suben 20 %.\n📎 Fuentes: projects/pulso/README.md, GDELT",
    );

    expect(mocks.submitTask).toHaveBeenCalledTimes(1);
    const sub = mocks.submitTask.mock.calls[0]![0];
    expect(sub).toMatchObject({
      agentType: "fast",
      tools: JARVIS_PULL_TOOLS,
      tags: ["jarvis-pull", "crm"],
      detectionText: QUERY,
      external: { maxRounds: expect.any(Number) },
    });
    expect(sub.tools).not.toContain("http_fetch");
    expect(sub.tools).not.toContain("memory_search");
    expect(sub.tools).not.toContain("task_history");
    expect(sub.interactive).not.toBe(false);
    expect(sub).not.toHaveProperty("interactive");
    expect(sub).not.toHaveProperty("threadId");
    expect(sub.tags).not.toContain("messaging");
    expect(sub.tags).not.toContain("a2a");
    expect(sub.abortController).toBeInstanceOf(AbortController);
    expect(sub.title).toBe(`CRM jarvis-pull: ${QUERY.slice(0, 50)}`);
    // System prompt = persona split on the cache marker + the CRM addendum.
    expect(sub.description).toContain("STABLE-PERSONA\n<!--CACHE_BREAK_v1-->\nVARIABLE-PERSONA");
    expect(sub.description).toContain("el operador no está en esta conversación");
    expect(sub.description).toContain("📎 Fuentes");
    expect(sub.description).toContain('jarvis_file_read({tags:["external"]})');
    expect(sub.description).toContain('"path not available" es definitiva');
    expect(sub.description).toContain("knowledge/domain/tv-, knowledge/domain/media-market-");
    expect(sub.description).not.toContain("denue-intel");
    expect(sub.description).not.toContain("projects/pulso-aura-upfront/");
    expect(sub.description).toContain("no tienes acceso al DENUE Analyzer");
    expect(sub.description).toContain("nunca cites cifras del DENUE de memoria");
    // User turn: time line + CRM context + query.
    expect(sub.conversationHistory).toHaveLength(1);
    const turn = sub.conversationHistory[0];
    expect(turn.role).toBe("user");
    expect(turn.content).toMatch(/^\[Hoy: .+ CDMX\]\n\nContexto del CRM: Cuenta: Liverpool\n\nConsulta: /);
    expect(mocks.infer).not.toHaveBeenCalled();
    expect(mocks.cancelTask).not.toHaveBeenCalled();
    // Listeners are released.
    for (const set of mocks.handlers.values()) expect(set.size).toBe(0);
  });

  it("survives a completion that fires before submitTask resolves", async () => {
    submitThen(completeWith({ text: "Respuesta rápida y útil para el AE." }), {
      sync: true,
    });
    const res = await post({ query: QUERY });
    const json = (await res.json()) as { response: string };
    expect(json.response).toBe(
      "Respuesta rápida y útil para el AE.\n\n📎 Fuentes: Análisis propio",
    );
  });

  it("appends 'Análisis propio' when the model wrote no Fuentes line", async () => {
    submitThen(completeWith("Respuesta sin línea de fuentes."));
    const json = (await (await post({ query: QUERY })).json()) as { response: string };
    expect(json.response.split("\n").at(-1)).toBe("📎 Fuentes: Análisis propio");
  });

  it("drops a registered write tool (readOnlyHint false) and an unregistered name", async () => {
    mocks.readOnly.set("web_read", false);
    mocks.readOnly.delete("intel_baseline");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    submitThen(completeWith("ok ok ok ok ok ok ok"));
    await post({ query: QUERY });
    const tools = mocks.submitTask.mock.calls[0]![0].tools as string[];
    expect(tools).not.toContain("web_read");
    expect(tools).not.toContain("intel_baseline");
    expect(tools).toEqual(
      JARVIS_PULL_TOOLS.filter((t) => t !== "web_read" && t !== "intel_baseline"),
    );
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "web_read,intel_baseline",
    );
    warn.mockRestore();
  });

  it("never submits an empty toolset (the runner reads [] as every tool)", async () => {
    mocks.readOnly.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ query: QUERY });
    expect(res.status).toBe(200);
    expect(mocks.submitTask).not.toHaveBeenCalled();
    expect(mocks.infer).toHaveBeenCalled();
  });
});

describe("POST /api/jarvis-pull — fallback", () => {
  it("deadline → abort + cancelTask + single-call answer with the deadline Fuentes line", async () => {
    submitThen(null); // never finishes
    const res = await post({ query: QUERY, role: "ae" });
    expect(res.status).toBe(200);
    const sub = mocks.submitTask.mock.calls[0]![0];
    expect((sub.abortController as AbortController).signal.aborted).toBe(true);
    expect(mocks.cancelTask).toHaveBeenCalledWith(expect.stringMatching(/^task-/));
    expect(mocks.infer).toHaveBeenCalledTimes(1);
    const json = (await res.json()) as { response: string; tokens: number };
    // The model's own Fuentes claim is replaced: no tool ran on this path.
    expect(json.response).toBe(
      "- Respuesta sin herramientas suficiente.\n\n📎 Fuentes: Análisis propio (sin herramientas: se agotó el tiempo de investigación)",
    );
    expect(json.tokens).toBe(150);
    expect(requestLogs()).toHaveLength(1);
    expect(requestLogs()[0]).toContain("mode=fallback-deadline");
    // The task was cancelled mid-run: its ledger cost is partial.
    expect(requestLogs()[0]).toContain("cost=$0.0123(partial)");
    for (const set of mocks.handlers.values()) expect(set.size).toBe(0);
  });

  it("task.failed → single-call fallback, error reason", async () => {
    submitThen((taskId) =>
      mocks.emit("task.failed", { task_id: taskId, error: "boom" }),
    );
    const res = await post({ query: QUERY });
    const json = (await res.json()) as { response: string };
    expect(json.response).toMatch(/📎 Fuentes: Análisis propio \(sin herramientas: falló la investigación\)$/);
    expect(mocks.cancelTask).not.toHaveBeenCalled();
    expect(requestLogs()[0]).toContain("mode=fallback-error");
  });

  it("empty completion and a submitTask throw both fall back", async () => {
    submitThen(completeWith({ text: "   " }));
    const a = (await (await post({ query: QUERY })).json()) as { response: string };
    expect(a.response).toContain("falló la investigación");

    mocks.submitTask.mockRejectedValueOnce(new Error("db locked"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = await post({ query: QUERY });
    expect(b.status).toBe(200);
    expect(((await b.json()) as { response: string }).response).toContain(
      "falló la investigación",
    );
    expect(requestLogs().at(-1)).toContain("task=- mode=fallback-error");
  });

  it("the single call carries only the external-allowed enforce row", async () => {
    mocks.kbRows = [
      { path: "directives/repo-authorization.md", content: "REPO-RULE", qualifier: "enforce" },
      { path: "directives/exposing-services-externally.md", content: "EXPOSE-RULE", qualifier: "enforce" },
      { path: "directives/user-data-sources.md", content: "DATA-RULE", qualifier: "enforce" },
    ];
    submitThen((taskId) =>
      mocks.emit("task.failed", { task_id: taskId, error: "boom" }),
    );
    await post({ query: QUERY });
    const system = String(mocks.infer.mock.calls[0]![0].messages[0].content);
    expect(system).toContain("REPO-RULE");
    expect(system).not.toContain("EXPOSE-RULE");
    expect(system).not.toContain("DATA-RULE");
  });

  it("503 when the task fails AND the single call throws", async () => {
    submitThen((taskId) =>
      mocks.emit("task.failed", { task_id: taskId, error: "boom" }),
    );
    mocks.infer.mockRejectedValue(new Error("provider down"));
    const res = await post({ query: QUERY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Jarvis inference failed: provider down",
    });
  });
});

describe("POST /api/jarvis-pull — budget, in-flight cap, prompt errors", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("budget spent: answers 200 before the budget with the out-of-time line — never a hang", async () => {
    vi.useFakeTimers();
    submitThen(null); // task never finishes
    let signal: AbortSignal | undefined;
    mocks.infer.mockImplementation(
      (_req: unknown, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise(() => {}); // fallback call never answers
      },
    );
    let settled = false;
    const pending = post({ query: QUERY }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(990);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20); // past the 1000 ms budget
    expect(settled).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { response: string };
    expect(json.response).toBe(
      "Jarvis no alcanzó a responder a tiempo.\n\n📎 Fuentes: ninguna (sin respuesta a tiempo)",
    );
    expect(signal?.aborted).toBe(true);
    expect(requestLogs()[0]).toContain("mode=budget-exhausted");
  });

  it("budget spent after a failed task: returns the task's partial text", async () => {
    vi.useFakeTimers();
    submitThen((taskId) =>
      mocks.emit("task.failed", {
        task_id: taskId,
        error: "boom",
        result: { text: "Walmart sube 20 % en digital (parcial).\n\n¿Sigo?" },
      }),
    );
    mocks.infer.mockImplementation(() => new Promise(() => {}));
    const pending = post({ query: QUERY });
    await vi.advanceTimersByTimeAsync(1010);
    const json = (await (await pending).json()) as { response: string };
    expect(json.response).toBe(
      "Walmart sube 20 % en digital (parcial).\n\n📎 Fuentes: Análisis propio",
    );
  });

  it("a thrown fallback call after a partial answer returns the partial, not a 503", async () => {
    submitThen((taskId) =>
      mocks.emit("task.failed", {
        task_id: taskId,
        error: "boom",
        result: "Avance útil.\n📎 Fuentes: GDELT",
      }),
    );
    mocks.infer.mockRejectedValue(new Error("provider down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ query: QUERY });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { response: string }).response).toBe(
      "Avance útil.\n📎 Fuentes: GDELT",
    );
  });

  it("skips the near-empty retry when less than 15 s of budget remain", async () => {
    submitThen((taskId) =>
      mocks.emit("task.failed", { task_id: taskId, error: "boom" }),
    );
    mocks.infer.mockResolvedValue({
      content: "ok",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await post({ query: QUERY });
    expect(mocks.infer).toHaveBeenCalledTimes(1);
  });

  it("in-flight cap: a 4th concurrent request answers on the single call without a task", async () => {
    submitThen(null); // the first three hold their slot until the deadline
    const held = [post({ query: QUERY }), post({ query: QUERY }), post({ query: QUERY })];
    await vi.waitFor(() => expect(mocks.submitTask).toHaveBeenCalledTimes(3));

    const busy = await post({ query: QUERY });
    expect(busy.status).toBe(200);
    expect(mocks.submitTask).toHaveBeenCalledTimes(3);
    expect(((await busy.json()) as { response: string }).response).toBe(
      "- Respuesta sin herramientas suficiente.\n\n📎 Fuentes: Análisis propio (sin herramientas: Jarvis atiende otras consultas)",
    );
    expect(requestLogs().some((l) => /task=- mode=fallback-busy/.test(l))).toBe(true);

    await Promise.all(held);
    // Slots are released in finally: the next request runs a task again.
    submitThen(completeWith({ text: "Respuesta con datos suficientes." }));
    await post({ query: QUERY });
    expect(mocks.submitTask).toHaveBeenCalledTimes(4);
  });

  it("a prompt-assembly throw falls back with a log line (no task, no 500)", async () => {
    vi.mocked(buildExternalJarvisSystemPrompt).mockImplementationOnce(() => {
      throw new Error("section blew up");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ query: QUERY });
    expect(res.status).toBe(200);
    expect(mocks.submitTask).not.toHaveBeenCalled();
    expect(((await res.json()) as { response: string }).response).toContain(
      "falló la investigación",
    );
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "task path failed: section blew up",
    );
    expect(requestLogs()[0]).toContain("mode=fallback-error");
  });

  it("strips a trailing ¿Sigo? from a completed answer", async () => {
    submitThen(completeWith({ text: "Respuesta útil y completa.\n\n¿Sigo?" }));
    const json = (await (await post({ query: QUERY })).json()) as { response: string };
    expect(json.response).toBe(
      "Respuesta útil y completa.\n\n📎 Fuentes: Análisis propio",
    );
  });
});

describe("POST /api/jarvis-pull — validation + log", () => {
  it("400s unchanged: bad JSON, missing query, invalid role", async () => {
    const bad = await app.request("/api/jarvis-pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Invalid JSON body" });

    const noQuery = await post({ role: "ae" });
    expect(noQuery.status).toBe(400);
    expect(await noQuery.json()).toEqual({
      error: "Missing required field: query",
    });

    const badRole = await post({ query: QUERY, role: "ceo" });
    expect(badRole.status).toBe(400);
    expect(await badRole.json()).toEqual({
      error: "Invalid role: ceo. Valid: ae, gerente, director, vp",
    });
    expect(mocks.submitTask).not.toHaveBeenCalled();
  });

  it("one request log line: hashed query, short task id, mode, tools, cost, tokens — never the query text", async () => {
    submitThen(completeWith({ text: "Respuesta con datos.\n📎 Fuentes: GDELT" }));
    await post({ query: QUERY, role: "director", context: "Cuenta secreta" });
    const lines = requestLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[jarvis-pull\] role=director q=[0-9a-f]{12} task=task-\S{3} mode=tools ms=\d+ tools=2 cost=\$0\.0123 tokens=4321$/,
    );
    const all = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain("anunciantes");
    expect(all).not.toContain("Cuenta secreta");
  });
});
