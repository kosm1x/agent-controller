import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDefinition } from "../inference/adapter.js";
import { scopeToolsForMessage, CODE_SCOPE_PATTERNS } from "../messaging/scope.js";

// Pass-through spy: scopeCases must call the scoper exactly as the gate does.
vi.mock("../messaging/scope.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../messaging/scope.js")>();
  return {
    ...orig,
    scopeToolsForMessage: vi.fn(
      (...a: Parameters<typeof orig.scopeToolsForMessage>) => orig.scopeToolsForMessage(...a),
    ),
  };
});

import {
  BUILTIN_PRICES,
  CHAT_PROMPTS,
  GATE_COMPARABILITY,
  buildChatBody,
  callChat,
  catalogRows,
  fetchCatalog,
  filterCatalog,
  intersectCandidates,
  normalizeModelId,
  parseBenchArgs,
  parseCompletion,
  parseSkuPrice,
  pickServerlessMode,
  pool,
  priceFor,
  probeModel,
  rankModels,
  renderJson,
  renderMarkdown,
  runBenchmark,
  scopeCases,
  scoreCase,
  scoreModel,
  toModelPath,
  type BenchConfig,
  type CallRecord,
  type CatalogModel,
  type FetchLike,
  type ModelScore,
  type ScopedCase,
} from "./bench-fallback.js";

const FAKE_KEY = "fw_FAKE_KEY_0123456789abcdef";

const def = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const completion = (opts: {
  tools?: Array<{ name: string; args: string }>;
  content?: string | null;
  reasoning?: string;
  finish?: string;
}) => ({
  choices: [
    {
      finish_reason: opts.finish ?? (opts.tools ? "tool_calls" : "stop"),
      message: {
        role: "assistant",
        content: opts.content ?? null,
        ...(opts.reasoning !== undefined && { reasoning_content: opts.reasoning }),
        ...(opts.tools && {
          tool_calls: opts.tools.map((t, i) => ({
            id: `c${i}`,
            type: "function",
            function: { name: t.name, arguments: t.args },
          })),
        }),
      },
    },
  ],
  usage: { prompt_tokens: 1000, completion_tokens: 50 },
});

const record = (over: Partial<CallRecord>): CallRecord => ({
  model: "m",
  caseId: "c",
  kind: "tool",
  latencyMs: 100,
  httpStatus: 200,
  errorClass: null,
  error: null,
  promptTokens: 1000,
  completionTokens: 100,
  finishReason: "stop",
  toolCalls: [],
  argsParseOk: [],
  reasoningContent: false,
  thinkInContent: false,
  ...over,
});

const noSleep = async () => {};

const money = (units: string, nanos: number) => ({ currencyCode: "USD", units, nanos });

// GET /v1/accounts/fireworks/models/qwen3p8-max, captured 2026-10-23 18:31 UTC (ListModels row identical).
// serverlessModes empty, contextLength 0 are the API's values, not a fixture shortcut.
const LIVE_ROW_RAW = {
  name: "accounts/fireworks/models/qwen3p8-max",
  displayName: "Qwen 3.8 Max",
  state: "READY",
  kind: "HF_BASE_MODEL",
  public: true,
  contextLength: 0,
  trainingContextLength: 65536,
  supportsTools: true,
  supportsImageInput: true,
  supportsServerless: true,
  deprecationDate: null,
  serverlessModes: [],
};
const LIVE_CATALOG_ROW_QWEN3P8_MAX: CatalogModel = LIVE_ROW_RAW;

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseBenchArgs", () => {
  it("defaults to dry with nothing set", () => {
    expect(parseBenchArgs([])).toEqual({ ok: true, args: { run: false } });
  });

  it("parses --run, --models (normalised, deduped), --cases, --out, --reasoning-effort", () => {
    const r = parseBenchArgs([
      "--run",
      "--models=glm-5p3, accounts/fireworks/models/kimi-k3,glm-5p3",
      "--cases=5",
      "--out=docs/benchmarks/x.md",
      "--reasoning-effort=none",
    ]);
    expect(r).toEqual({
      ok: true,
      args: {
        run: true,
        models: ["glm-5p3", "kimi-k3"],
        cases: 5,
        out: "docs/benchmarks/x.md",
        reasoningEffort: "none",
      },
    });
  });

  it("refuses bad values and unknown flags", () => {
    for (const bad of [
      ["--cases=0"],
      ["--cases=abc"],
      ["--cases=2.5"],
      ["--models="],
      ["--out=report.txt"],
      ["--reasoning-effort=max"],
      ["--bogus"],
    ]) {
      expect(parseBenchArgs(bad).ok, bad[0]).toBe(false);
    }
  });
});

describe("candidate normalisation", () => {
  it("bare id ↔ full Fireworks path", () => {
    expect(normalizeModelId("accounts/fireworks/models/glm-5p3")).toBe("glm-5p3");
    expect(normalizeModelId("glm-5p3")).toBe("glm-5p3");
    expect(toModelPath("glm-5p3")).toBe("accounts/fireworks/models/glm-5p3");
    expect(toModelPath(normalizeModelId("accounts/fireworks/models/x"))).toBe(
      "accounts/fireworks/models/x",
    );
    // another account keeps its full path both ways
    expect(normalizeModelId("accounts/acme/models/y")).toBe("accounts/acme/models/y");
    expect(toModelPath("accounts/acme/models/y")).toBe("accounts/acme/models/y");
  });

  it("intersects with the catalog by full path and reports the dropped ids", () => {
    const catalog: CatalogModel[] = [{ name: "accounts/fireworks/models/a" }];
    const r = intersectCandidates(["a", "b"], catalog);
    expect(r.kept).toEqual(["a"]);
    expect(r.dropped.map((d) => [d.model, d.stage])).toEqual([["b", "catalog"]]);
    // catalog not loaded → as-is
    expect(intersectCandidates(["a", "b"], null)).toEqual({ kept: ["a", "b"], dropped: [] });
  });
});

describe("filterCatalog", () => {
  const base = { supportsServerless: true, supportsTools: true };
  it("keeps serverless + tools models with no past deprecation", () => {
    const models: CatalogModel[] = [
      { name: "keep", ...base },
      { name: "future-dep", ...base, deprecationDate: "2027-01-01" },
      { name: "obj-future", ...base, deprecationDate: { year: 2027, month: 2, day: 1 } },
      { name: "past-dep", ...base, deprecationDate: "2026-01-01T00:00:00Z" },
      { name: "today-dep", ...base, deprecationDate: "2026-10-23" },
      { name: "obj-past", ...base, deprecationDate: { year: 2025, month: 12, day: 31 } },
      { name: "no-serverless", supportsServerless: false, supportsTools: true },
      { name: "no-tools", supportsServerless: true, supportsTools: false },
      { name: "missing-flags" },
    ];
    expect(filterCatalog(models, "2026-10-23").map((m) => m.name)).toEqual([
      "keep",
      "future-dep",
      "obj-future",
    ]);
  });
});

describe("pricing", () => {
  it("parses typeMoney {units, nanos} amounts per-1M and per-token", () => {
    const perMillion = parseSkuPrice({
      name: "x",
      serverlessModes: [
        {
          skuInfos: [
            { sku: "serverless-input-tokens", amount: money("0", 900_000_000), unit: "1M tokens" },
            { sku: "serverless-output-tokens", amount: money("2", 500_000_000), unit: "1M tokens" },
          ],
        },
      ],
    });
    expect(perMillion?.in).toBeCloseTo(0.9);
    expect(perMillion?.out).toBeCloseTo(2.5);
    const perToken = parseSkuPrice({
      name: "x",
      serverlessModes: [
        {
          skuInfos: [
            { sku: "prompt", amount: money("0", 200), unit: "token" },
            { sku: "completion", amount: { currencyCode: "USD", nanos: 800 }, unit: "token" },
          ],
        },
      ],
    });
    expect(perToken?.in).toBeCloseTo(0.2);
    expect(perToken?.out).toBeCloseTo(0.8);
  });

  it("returns null when unparseable or half-priced; a nonsense amount falls back to the builtin table", () => {
    expect(parseSkuPrice({ name: "x" })).toBeNull();
    const nonsense: CatalogModel = {
      name: "accounts/fireworks/models/glm-5p3",
      serverlessModes: [
        {
          skuInfos: [
            { sku: "input", amount: { price: "cheap" }, unit: "1M tokens" },
            { sku: "output", amount: money("1.5", 0), unit: "1M tokens" },
          ],
        },
      ],
    };
    expect(parseSkuPrice(nonsense)).toBeNull();
    const rows = catalogRows([nonsense]);
    expect(rows[0].price).toBeNull();
    expect(priceFor("glm-5p3", new Map(rows.map((r) => [r.id, r.price])))).toEqual({
      price: BUILTIN_PRICES["glm-5p3"],
      source: "builtin",
    });
    expect(
      parseSkuPrice({
        name: "x",
        serverlessModes: [{ skuInfos: [{ sku: "input", amount: "1", unit: "1M tokens" }] }],
      }),
    ).toBeNull();
    expect(
      parseSkuPrice({
        name: "x",
        serverlessModes: [
          {
            skuInfos: [
              { sku: "input", amount: money("1", 0), unit: "1M tokens" },
              { sku: "output", amount: money("2", 0), unit: "GPU hour" },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects negative amounts and |nanos| >= 1e9 (builtin fallback)", () => {
    const priced = (input: unknown, output: unknown): CatalogModel => ({
      name: "accounts/fireworks/models/glm-5p3",
      serverlessModes: [
        {
          skuInfos: [
            { sku: "input", amount: input, unit: "1M tokens" },
            { sku: "output", amount: output, unit: "1M tokens" },
          ],
        },
      ],
    });
    for (const bad of [
      money("-1", -500_000_000),
      money("0", -1),
      -1.5,
      money("0", 1_000_000_000),
      money("1", -1_000_000_000),
    ]) {
      const m = priced(bad, money("1", 0));
      expect(parseSkuPrice(m), JSON.stringify(bad)).toBeNull();
      const rows = catalogRows([m]);
      expect(priceFor("glm-5p3", new Map(rows.map((r) => [r.id, r.price]))).source).toBe("builtin");
    }
    // nanos just under the bound is still a valid price
    expect(parseSkuPrice(priced(money("0", 999_999_999), money("1", 0)))?.in).toBeCloseTo(1);
  });

  it("reads price AND usageIdentifier from ONE mode, standard tier over priority", () => {
    const tier = (serviceTier: string, id: string, price: string) => ({
      serviceTier,
      usageIdentifier: id,
      skuInfos: [
        { sku: "input", amount: money(price, 0), unit: "1M tokens" },
        { sku: "output", amount: money(price, 0), unit: "1M tokens" },
      ],
    });
    const twoTier: CatalogModel = {
      name: "accounts/fireworks/models/m",
      serverlessModes: [
        tier("priority", "accounts/fireworks/models/m-priority", "9"),
        tier("standard", "accounts/fireworks/models/m-standard", "1"),
      ],
    };
    expect(parseSkuPrice(twoTier)).toEqual({ in: 1, out: 1 });
    expect(catalogRows([twoTier])[0].usageIdentifier).toBe("accounts/fireworks/models/m-standard");
    // the mode whose identifier IS the name path wins over tier labels
    const named: CatalogModel = {
      name: "accounts/fireworks/models/m",
      serverlessModes: [
        tier("standard", "accounts/fireworks/models/m-standard", "1"),
        tier("fast", "accounts/fireworks/models/m", "3"),
      ],
    };
    expect(parseSkuPrice(named)).toEqual({ in: 3, out: 3 });
    // an empty tier counts as standard; with no standard tier, the first mode
    expect(
      pickServerlessMode({
        name: "x",
        serverlessModes: [{ serviceTier: "fast" }, { serviceTier: "" , usageIdentifier: "s" }],
      })?.usageIdentifier,
    ).toBe("s");
    expect(
      pickServerlessMode({ name: "x", serverlessModes: [{ serviceTier: "priority", usageIdentifier: "p" }, { serviceTier: "fast" }] })
        ?.usageIdentifier,
    ).toBe("p");
    expect(pickServerlessMode({ name: "x" })).toBeNull();
  });

  it("serviceTier compare is case-insensitive (STANDARD beats a listed-first priority tier)", () => {
    expect(
      pickServerlessMode({
        name: "accounts/fireworks/models/m",
        serverlessModes: [
          { serviceTier: "priority", usageIdentifier: "accounts/fireworks/models/m-priority" },
          { serviceTier: "STANDARD", usageIdentifier: "accounts/fireworks/models/m-standard" },
        ],
      })?.usageIdentifier,
    ).toBe("accounts/fireworks/models/m-standard");
  });

  it("prefers catalog, falls back to builtin, else n/a", () => {
    const cat = new Map([["glm-5p3", { in: 9, out: 9 }]]);
    expect(priceFor("glm-5p3", cat)).toEqual({ price: { in: 9, out: 9 }, source: "catalog" });
    expect(priceFor("kimi-k3", cat)).toEqual({ price: BUILTIN_PRICES["kimi-k3"], source: "builtin" });
    expect(priceFor("ember-1", new Map([["ember-1", null]])).source).toBe("builtin");
    expect(priceFor("mystery", cat)).toEqual({ price: null, source: "n/a" });
  });

  it("live qwen3p8-max row (empty serverlessModes, contextLength 0) → nulls, builtin price", () => {
    const rows = catalogRows([LIVE_CATALOG_ROW_QWEN3P8_MAX]);
    expect(rows).toEqual([
      { id: "qwen3p8-max", contextLength: null, deprecation: null, price: null, usageIdentifier: null },
    ]);
    expect(priceFor("qwen3p8-max", new Map(rows.map((r) => [r.id, r.price])))).toEqual({
      price: BUILTIN_PRICES["qwen3p8-max"],
      source: "builtin",
    });
  });

  it("a non-positive or non-integer contextLength is unknown (null); a positive one is kept", () => {
    const ctx = (contextLength: number) =>
      catalogRows([{ name: "accounts/fireworks/models/m", contextLength }])[0].contextLength;
    expect(ctx(0)).toBeNull();
    expect(ctx(-1)).toBeNull();
    expect(ctx(1.5)).toBeNull();
    expect(ctx(262144)).toBe(262144);
  });
});

describe("leak detection + completion parsing", () => {
  it("flags reasoning_content and <think> in content", () => {
    const a = parseCompletion(completion({ content: "<think>plan</think>Hola", reasoning: "r" }));
    expect(a.reasoningContent).toBe(true);
    expect(a.thinkInContent).toBe(true);
    const b = parseCompletion(completion({ content: "Hola", reasoning: "" }));
    expect(b.reasoningContent).toBe(false);
    expect(b.thinkInContent).toBe(false);
    expect(b.finishReason).toBe("stop");
    expect(b.promptTokens).toBe(1000);
  });

  it("records tool call names and whether each args string parses", () => {
    const r = parseCompletion(
      completion({ tools: [{ name: "web_search", args: '{"q":"x"}' }, { name: "gmail_send", args: "{bad" }] }),
    );
    expect(r.toolCalls).toEqual(["web_search", "gmail_send"]);
    expect(r.argsParseOk).toEqual([true, false]);
    expect(r.finishReason).toBe("tool_calls");
  });
});

describe("request shaping", () => {
  it("tool case: history + user, tools with tool_choice auto, no system message", () => {
    const body = buildChatBody(
      "glm-5p3",
      { message: "hola", conversationHistory: [{ role: "user", content: "antes" }] },
      [def("web_search")],
      "none",
    );
    expect(body).toEqual({
      model: "accounts/fireworks/models/glm-5p3",
      messages: [
        { role: "user", content: "antes" },
        { role: "user", content: "hola" },
      ],
      tools: [def("web_search")],
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 1024,
      stream: false,
      reasoning_effort: "none",
    });
  });

  it("chat prompt: no tools, no tool_choice, no reasoning_effort by default", () => {
    const body = buildChatBody("x", { message: CHAT_PROMPTS[0].input }, []);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(CHAT_PROMPTS).toHaveLength(5);
  });
});

describe("callChat", () => {
  const deps = (fetch: FetchLike) => ({ fetch, apiKey: FAKE_KEY, now: () => 0, sleep: noSleep });
  const body = buildChatBody("m", { message: "x" }, []);
  const meta = { model: "m", caseId: "c", kind: "chat" as const };

  it("retries once on 429 then succeeds", async () => {
    let calls = 0;
    const rec = await callChat(
      deps(async () => (++calls === 1 ? json(429, "slow down") : json(200, completion({ content: "ok" })))),
      body,
      meta,
    );
    expect(calls).toBe(2);
    expect(rec.errorClass).toBeNull();
    expect(rec.httpStatus).toBe(200);
  });

  it("does not retry a 400, records it with a ≤200-char redacted body", async () => {
    let calls = 0;
    const rec = await callChat(
      deps(async () => {
        calls++;
        return json(400, `bad reasoning_effort for key ${FAKE_KEY} ${"x".repeat(500)}`);
      }),
      body,
      meta,
    );
    expect(calls).toBe(1);
    expect(rec.errorClass).toBe("http_400");
    expect(rec.error?.length).toBeLessThanOrEqual(200);
    expect(rec.error).not.toContain(FAKE_KEY);
  });

  it("records err.cause.code behind undici's 'fetch failed'", async () => {
    const rec = await callChat(
      deps(async () => {
        throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }),
      body,
      meta,
    );
    expect(rec.error).toBe("fetch failed (ECONNREFUSED)");
  });

  it("wraps a thrown fetch error without echoing the key", async () => {
    const rec = await callChat(
      deps(async () => {
        throw new Error(`connect failed Authorization: Bearer ${FAKE_KEY}`);
      }),
      body,
      meta,
    );
    expect(rec.errorClass).toBe("network");
    expect(rec.error).not.toContain(FAKE_KEY);
  });
});

describe("probeModel", () => {
  it("retries once on 429/5xx after RETRY_DELAY_MS, never on 404", async () => {
    const sleeps: number[] = [];
    const statuses = [503, 200];
    let calls = 0;
    const p = await probeModel(
      { fetch: async () => json(statuses[calls++], "x"), apiKey: FAKE_KEY, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } },
      "m",
    );
    expect(p.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);

    let calls404 = 0;
    const q = await probeModel(
      { fetch: async () => { calls404++; return json(404, "gone"); }, apiKey: FAKE_KEY, now: () => 0, sleep: noSleep },
      "m",
    );
    expect(q.status).toBe(404);
    expect(calls404).toBe(1);

    let calls429 = 0;
    const r = await probeModel(
      { fetch: async () => { calls429++; return json(429, "slow"); }, apiKey: FAKE_KEY, now: () => 0, sleep: noSleep },
      "m",
    );
    expect(r.status).toBe(429);
    expect(calls429).toBe(2);
  });
});

describe("fetchCatalog", () => {
  it("follows nextPageToken across pages", async () => {
    const urls: string[] = [];
    const models = await fetchCatalog({
      fetch: async (url) => {
        urls.push(url);
        return url.includes("pageToken=")
          ? json(200, { models: [{ name: "accounts/fireworks/models/b" }] })
          : json(200, { models: [{ name: "accounts/fireworks/models/a" }], nextPageToken: "t2" });
      },
      apiKey: FAKE_KEY,
      now: () => 0,
      sleep: noSleep,
    });
    expect(models.map((m) => m.name)).toEqual([
      "accounts/fireworks/models/a",
      "accounts/fireworks/models/b",
    ]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("pageToken=t2");
  });

  it("records the serverless usageIdentifier per model", () => {
    expect(
      catalogRows([
        { name: "accounts/fireworks/models/a", serverlessModes: [{ usageIdentifier: "accounts/fireworks/models/a-sl" }] },
        { name: "accounts/fireworks/models/b" },
      ]).map((r) => r.usageIdentifier),
    ).toEqual(["accounts/fireworks/models/a-sl", null]);
  });
});

describe("pool", () => {
  const tracked = (limit: number) => {
    let inFlight = 0;
    let max = 0;
    const order: number[] = [];
    const run = pool([1, 2, 3, 4, 5], limit, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      order.push(n);
      inFlight--;
      return n * 10;
    });
    return { run, max: () => max, order };
  };

  it("bounds in-flight calls at the limit and keeps result order", async () => {
    const t = tracked(2);
    expect(await t.run).toEqual([10, 20, 30, 40, 50]);
    expect(t.max()).toBe(2);
  });

  it("a limit of 1 serialises", async () => {
    const t = tracked(1);
    await t.run;
    expect(t.max()).toBe(1);
    expect(t.order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("scoring", () => {
  const c: ScopedCase = {
    caseId: "t1",
    input: { message: "x" },
    expected: { tools: ["web_search", "web_read"], not_tools: ["gmail_send"] },
    tools: [def("web_search"), def("web_read"), def("gmail_send")],
  };

  it("hit = any expected tool called; a forbidden call zeroes the case; an error scores 0", () => {
    expect(scoreCase(c, record({ toolCalls: ["web_read"] }))).toBe(1);
    expect(scoreCase(c, record({ toolCalls: ["calendar_list"] }))).toBe(0);
    expect(scoreCase(c, record({ toolCalls: ["web_search", "gmail_send"] }))).toBe(0);
    expect(scoreCase(c, record({ toolCalls: ["web_search"], errorClass: "timeout" }))).toBe(0);
  });

  it("scopeCases excludes a case whose expected tools are not offered (gate rule)", () => {
    const registry = { getDefinitions: (names?: string[]) => (names ?? []).filter((n) => n === "web_search").map(def) };
    const { cases, unreachable } = scopeCases(
      [
        { case_id: "reach", category: "tool_selection", input: { message: "Busca el clima en Madrid" }, expected: { tools: ["web_search"] } },
        { case_id: "unreach", category: "tool_selection", input: { message: "Busca el clima en Madrid" }, expected: { tools: ["not_registered_tool"] } },
        { case_id: "other", category: "classification", input: { message: "x" }, expected: { agent_type: "fast" } },
      ],
      registry,
    );
    expect(cases.map((x) => x.caseId)).toEqual(["reach"]);
    expect(unreachable).toEqual(["unreach"]);
    // first-N subsample is deterministic
    expect(scopeCases([{ case_id: "a", category: "tool_selection", input: { message: "Busca x" }, expected: { tools: ["web_search"] } }, { case_id: "b", category: "tool_selection", input: { message: "Busca y" }, expected: { tools: ["web_search"] } }], registry, 1).cases.map((x) => x.caseId)).toEqual(["a"]);
  });

  it("scopeCases calls scopeToolsForMessage with exactly the eval gate's args", () => {
    const registry = { getDefinitions: (names?: string[]) => (names ?? []).map(def) };
    scopeCases(
      [
        {
          case_id: "h",
          category: "tool_selection",
          input: {
            message: "Busca el clima",
            conversationHistory: [
              { role: "user", content: "antes" },
              { role: "assistant", content: "ok" },
            ],
          },
          expected: { tools: ["web_search"] },
        },
      ],
      registry,
    );
    const calls = vi.mocked(scopeToolsForMessage).mock.calls;
    expect(calls).toHaveLength(1);
    const [message, recent, patterns, flags, pre] = calls[0];
    expect(message).toBe("Busca el clima");
    expect(recent).toEqual(["antes"]);
    expect(patterns).toEqual([...CODE_SCOPE_PATTERNS]);
    expect(pre).toBeUndefined();
    // The flags literal eval-runner.ts passes, read from its source.
    const src = readFileSync(resolve(__dirname, "eval-runner.ts"), "utf-8");
    const call = src.slice(src.indexOf("scopeToolsForMessage(\n"));
    const literal = call.slice(call.indexOf("{"), call.indexOf("}") + 1);
    const gateFlags = Object.fromEntries(
      [...literal.matchAll(/(has\w+):\s*(true|false)/g)].map((m) => [m[1], m[2] === "true"]),
    );
    expect(Object.keys(gateFlags)).toHaveLength(4);
    expect(flags).toEqual(gateFlags);
  });

  it("errored tool call: counted in the accuracy denominator, excluded from latency percentiles", () => {
    const s = scoreModel(
      "m",
      [
        record({ score: 1, latencyMs: 100 }),
        record({ score: 1, latencyMs: 200 }),
        record({ score: 0, latencyMs: 90_000, errorClass: "timeout", httpStatus: null }),
      ],
      { price: null, source: "n/a" },
    );
    expect(s.accuracy).toBeCloseTo(2 / 3);
    expect(s.scoredCases).toBe(3);
    expect(s.p50ToolMs).toBe(100);
    expect(s.p95ToolMs).toBe(200);
    expect(s.errors).toBe(1);
  });

  it("scoreModel: accuracy, validity, leaks, errors, cost", () => {
    const s = scoreModel(
      "m",
      [
        record({ score: 1, toolCalls: ["a"], argsParseOk: [true], latencyMs: 100 }),
        record({ score: 0, toolCalls: ["b"], argsParseOk: [false], latencyMs: 300 }),
        record({ kind: "chat", latencyMs: 50, thinkInContent: true, reasoningContent: true }),
      ],
      { price: { in: 1, out: 2 }, source: "builtin" },
    );
    expect(s.accuracy).toBe(0.5);
    expect(s.scoredCases).toBe(2);
    expect(s.toolCallValidity).toBe(0.5);
    expect(s.p50ToolMs).toBe(100);
    expect(s.p95ToolMs).toBe(300);
    expect(s.p50ChatMs).toBe(50);
    expect(s.thinkingLeaks).toBe(1);
    expect(s.reasoningContentCalls).toBe(1);
    expect(s.errors).toBe(0);
    expect(s.costUsd).toBeCloseTo((3000 * 1 + 300 * 2) / 1e6);
    expect(s.unrankedReason).toBeNull();
    expect(s.routedVia).toBeNull();
    expect(scoreModel("n", [record({ score: 1 })], { price: null, source: "n/a" }).costUsd).toBeNull();
  });
});

describe("rankModels", () => {
  const ms = (over: Partial<ModelScore>): ModelScore => ({
    model: "m",
    scoredCases: 10,
    accuracy: 0.5,
    toolCallValidity: 1,
    p50ToolMs: 1000,
    p95ToolMs: 2000,
    p50ChatMs: 500,
    p95ChatMs: 900,
    thinkingLeaks: 0,
    reasoningContentCalls: 0,
    errors: 0,
    calls: 10,
    http404or401: false,
    price: null,
    priceSource: "n/a",
    costUsd: null,
    unrankedReason: null,
    routedVia: null,
    ...over,
  });

  it("accuracy desc → p50 tool latency asc → cost asc (unknown cost last)", () => {
    expect(
      rankModels([
        ms({ model: "slow", accuracy: 0.9, p50ToolMs: 3000 }),
        ms({ model: "best", accuracy: 0.95 }),
        ms({ model: "fast", accuracy: 0.9, p50ToolMs: 1000, costUsd: 0.5 }),
        ms({ model: "fast-cheap", accuracy: 0.9, p50ToolMs: 1000, costUsd: 0.1 }),
        ms({ model: "fast-unpriced", accuracy: 0.9, p50ToolMs: 1000, costUsd: null }),
      ]),
    ).toEqual(["best", "fast-cheap", "fast", "fast-unpriced", "slow"]);
  });

  it("404/401 or > 20% errors are unranked", () => {
    const r404 = scoreModel("a", [record({ score: 1 }), record({ httpStatus: 404, errorClass: "http_404", score: 0 })], { price: null, source: "n/a" });
    expect(r404.unrankedReason).toMatch(/404/);
    const errs = scoreModel(
      "b",
      [record({ score: 1 }), record({ score: 1 }), record({ score: 1 }), record({ score: 1 }), record({ errorClass: "timeout", httpStatus: null, score: 0 })],
      { price: null, source: "n/a" },
    );
    expect(errs.unrankedReason).toBeNull(); // exactly 20% → still ranked
    const errs2 = scoreModel(
      "c",
      [record({ score: 1 }), record({ errorClass: "timeout", httpStatus: null, score: 0 })],
      { price: null, source: "n/a" },
    );
    expect(errs2.unrankedReason).toMatch(/errors 1\/2/);
    expect(rankModels([r404, errs, errs2])).toEqual(["b"]);
  });
});

describe("runBenchmark (injected fetch, no network)", () => {
  const cases: ScopedCase[] = [
    { caseId: "t1", input: { message: "busca" }, expected: { tools: ["web_search"] }, tools: [def("web_search")] },
  ];
  const config = (models: string[]): BenchConfig => ({
    apiKey: FAKE_KEY,
    models,
    date: "2026-10-23",
    toolCount: 1,
    toolSources: { registered: ["builtin"], skipped: [] },
  });
  const catalogBody = {
    models: [
      { name: "accounts/fireworks/models/good", supportsServerless: true, supportsTools: true },
      { name: "accounts/fireworks/models/gone", supportsServerless: true, supportsTools: true },
    ],
  };

  const fakeFetch = (opts: { catalogStatus?: number; probe401?: boolean }): FetchLike =>
    async (url, init) => {
      expect(init.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
      if (url.includes("/v1/accounts/fireworks/models")) {
        return opts.catalogStatus
          ? json(opts.catalogStatus, `denied for ${FAKE_KEY}`)
          : json(200, catalogBody);
      }
      const body = JSON.parse(init.body ?? "{}") as { model: string; max_tokens: number; tools?: unknown[] };
      if (opts.probe401) return json(401, "unauthorized");
      if (body.model.endsWith("/gone")) return json(404, "model not found");
      if (body.max_tokens === 1) return json(200, completion({ content: "p" }));
      if (body.tools) return json(200, completion({ tools: [{ name: "web_search", args: "{}" }] }));
      throw new Error(`socket hang up near Bearer ${FAKE_KEY}`);
    };

  it("drops catalog misses and 404 probes, scores the rest, never leaks the key", async () => {
    const out = await runBenchmark({
      config: config(["good", "gone", "absent"]),
      cases,
      unreachable: ["u1"],
      deps: { fetch: fakeFetch({}), now: () => 0, sleep: noSleep },
    });
    expect(out.kind).toBe("complete");
    if (out.kind === "bad_key") throw new Error("unexpected");
    const r = out.result;
    expect(r.dropped.map((d) => `${d.model}:${d.stage}`)).toEqual(["absent:catalog", "gone:probe"]);
    expect(r.dropped[1].reason).toMatch(/retired\/undeployed/);
    expect(r.scores).toHaveLength(1);
    expect(r.scores[0].accuracy).toBe(1);
    // the chat prompts all threw an error that carries the key
    expect(r.scores[0].errors).toBe(CHAT_PROMPTS.length);
    expect(r.recommended).toBeNull(); // 5/6 errors → unranked
    const md = renderMarkdown(r, FAKE_KEY);
    const js = renderJson(r, FAKE_KEY);
    expect(md).toContain("RECOMMENDED: none");
    expect(md).toContain("network");
    for (const text of [md, js]) expect(text).not.toContain(FAKE_KEY);
    expect(JSON.parse(js).config).not.toHaveProperty("apiKey");
    expect(JSON.parse(js).config.caseCount).toBe(1);
    // W4: the run config says how it differs from the gate
    expect(md).toContain(`vs the eval gate: ${GATE_COMPARABILITY}`);
    expect(JSON.parse(js).config.gateComparability).toBe(GATE_COMPARABILITY);
  });

  it("chat calls: ≤ 2 in flight per model, each with an AbortSignal", async () => {
    let inFlight = 0;
    let max = 0;
    const signals: boolean[] = [];
    const many: ScopedCase[] = Array.from({ length: 6 }, (_, i) => ({ ...cases[0], caseId: `t${i}` }));
    const fetch: FetchLike = async (url, init) => {
      if (url.includes("/v1/accounts/fireworks/models")) return json(200, catalogBody);
      const body = JSON.parse(init.body ?? "{}") as { max_tokens: number };
      if (body.max_tokens === 1) return json(200, completion({ content: "p" }));
      signals.push(init.signal instanceof AbortSignal);
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return json(200, completion({ tools: [{ name: "web_search", args: "{}" }] }));
    };
    const out = await runBenchmark({
      config: config(["good"]),
      cases: many,
      unreachable: [],
      deps: { fetch, now: () => 0, sleep: noSleep },
    });
    expect(out.kind).toBe("complete");
    expect(max).toBe(2);
    expect(signals).toHaveLength(many.length + CHAT_PROMPTS.length);
    expect(signals.every(Boolean)).toBe(true);
  });

  it("usageIdentifier equal to the name path: one probe, plain 404 reason, no via-note", async () => {
    const probes: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (url.includes("/v1/accounts/fireworks/models")) {
        return json(200, {
          models: [
            {
              name: "accounts/fireworks/models/good",
              supportsServerless: true,
              supportsTools: true,
              serverlessModes: [{ usageIdentifier: "good" }],
            },
          ],
        });
      }
      probes.push((JSON.parse(init.body ?? "{}") as { model: string }).model);
      return json(404, "not found");
    };
    const out = await runBenchmark({
      config: config(["good"]),
      cases,
      unreachable: [],
      deps: { fetch, now: () => 0, sleep: noSleep },
    });
    expect(out.kind).toBe("all_dropped");
    if (out.kind === "bad_key") throw new Error("unexpected");
    expect(probes).toEqual(["accounts/fireworks/models/good"]);
    expect(out.result.dropped).toEqual([
      { model: "good", stage: "probe", reason: "retired/undeployed (HTTP 404)" },
    ]);
    expect(renderMarkdown(out.result, FAKE_KEY)).not.toContain("via usageIdentifier");
  });

  it("a throw outside callChat becomes an errored record; the batch and the model still score", async () => {
    const broken: ScopedCase = {
      caseId: "broken",
      input: { message: "busca" },
      // tools must be an array: scoreToolSelection throws on this shape
      expected: { tools: "web_search" } as unknown as ScopedCase["expected"],
      tools: [def("web_search")],
    };
    const out = await runBenchmark({
      config: config(["good"]),
      cases: [cases[0], broken],
      unreachable: [],
      deps: {
        fetch: async (url, init) => {
          if (url.includes("/v1/accounts/fireworks/models")) return json(200, catalogBody);
          return json(200, completion({ tools: [{ name: "web_search", args: "{}" }] }));
        },
        now: () => 0,
        sleep: noSleep,
      },
    });
    expect(out.kind).toBe("complete");
    if (out.kind === "bad_key") throw new Error("unexpected");
    const rec = out.result.records.find((r) => r.caseId === "broken");
    expect(rec?.errorClass).toBe("harness_error");
    expect(rec?.error).toBeTruthy();
    expect(rec?.score).toBe(0);
    const s = out.result.scores[0];
    expect(s.scoredCases).toBe(2);
    expect(s.accuracy).toBe(0.5);
    expect(s.errors).toBe(1);
    expect(s.calls).toBe(2 + CHAT_PROMPTS.length);
  });

  it("name path 404 → probe retried once with the catalog usageIdentifier, which the run then uses", async () => {
    const usage = "accounts/fireworks/models/good-serverless";
    const sentModels: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (url.includes("/v1/accounts/fireworks/models")) {
        return json(200, {
          models: [
            {
              name: "accounts/fireworks/models/good",
              supportsServerless: true,
              supportsTools: true,
              serverlessModes: [{ usageIdentifier: usage }],
            },
          ],
        });
      }
      const body = JSON.parse(init.body ?? "{}") as { model: string; max_tokens: number };
      if (body.model !== usage) return json(404, "not found");
      if (body.max_tokens !== 1) sentModels.push(body.model);
      return json(200, completion({ tools: [{ name: "web_search", args: "{}" }] }));
    };
    const out = await runBenchmark({
      config: config(["good"]),
      cases,
      unreachable: [],
      deps: { fetch, now: () => 0, sleep: noSleep },
    });
    if (out.kind === "bad_key") throw new Error("unexpected");
    expect(out.kind).toBe("complete");
    expect(out.result.dropped).toEqual([]);
    expect(out.result.scores[0].model).toBe("good");
    expect(out.result.scores[0].routedVia).toBe(usage);
    expect(sentModels).toHaveLength(cases.length + CHAT_PROMPTS.length);
    expect(new Set(sentModels)).toEqual(new Set([usage]));
    expect(renderMarkdown(out.result, FAKE_KEY)).toContain(`via usageIdentifier ${usage}`);
  });

  it("catalog failure warns and continues with the candidates as-is (key redacted)", async () => {
    const out = await runBenchmark({
      config: config(["good"]),
      cases,
      unreachable: [],
      deps: { fetch: fakeFetch({ catalogStatus: 500 }), now: () => 0, sleep: noSleep },
    });
    if (out.kind === "bad_key") throw new Error("unexpected");
    expect(out.result.catalog.loaded).toBe(false);
    expect(out.result.catalog.warning).toMatch(/HTTP 500/);
    expect(renderMarkdown(out.result, FAKE_KEY)).not.toContain(FAKE_KEY);
    expect(renderJson(out.result, "")).not.toContain(FAKE_KEY); // redacted at record time too
  });

  const NO_SKU_NOTE =
    "catalog rows had no parseable `skuInfos` (Fireworks fills serverless prices on its serverless-models list, not on ListModels/GetModel); the `price source` column says which of them fell back to the builtin table";
  const renderWithCatalog = async (models: CatalogModel[]): Promise<string> => {
    const out = await runBenchmark({
      config: config(["good"]),
      cases,
      unreachable: [],
      deps: { fetch: fakeFetch({}), now: () => 0, sleep: noSleep },
    });
    if (out.kind === "bad_key") throw new Error("unexpected");
    return renderMarkdown(
      { ...out.result, catalog: { loaded: true, warning: null, rows: catalogRows(models) } },
      FAKE_KEY,
    );
  };

  it("catalog table prints the price source and a note when rows carried no skuInfos", async () => {
    const live = await renderWithCatalog([LIVE_CATALOG_ROW_QWEN3P8_MAX]);
    const b = BUILTIN_PRICES["qwen3p8-max"];
    expect(live).toContain("| id | context | deprecation | $/1M in/out | price source |");
    expect(live).toContain(
      `| qwen3p8-max | n/a | — | ${b.in.toFixed(2)} / ${b.out.toFixed(2)} | builtin |`,
    );
    expect(live).toContain(`\`1/1\` ${NO_SKU_NOTE}`);
    const priced = await renderWithCatalog([
      {
        name: "accounts/fireworks/models/glm-5p3",
        contextLength: 262144,
        serverlessModes: [
          {
            skuInfos: [
              { sku: "input", amount: money("1", 0), unit: "1M tokens" },
              { sku: "output", amount: money("3", 0), unit: "1M tokens" },
            ],
          },
        ],
      },
    ]);
    expect(priced).toContain("| glm-5p3 | 262144 | — | 1.00 / 3.00 | catalog |");
    expect(priced).not.toContain(NO_SKU_NOTE);
  });

  it("a row with no catalog and no builtin price renders n/a source; the note counts it", async () => {
    const md = await renderWithCatalog([
      LIVE_CATALOG_ROW_QWEN3P8_MAX,
      { name: "accounts/fireworks/models/mystery" },
    ]);
    const b = BUILTIN_PRICES["qwen3p8-max"];
    expect(md).toContain("| mystery | n/a | — | n/a | n/a |");
    expect(md).toContain(
      `| qwen3p8-max | n/a | — | ${b.in.toFixed(2)} / ${b.out.toFixed(2)} | builtin |`,
    );
    expect(md).toContain(`\`2/2\` ${NO_SKU_NOTE}`);
  });

  it("a 401 aborts the whole run as bad_key", async () => {
    const out = await runBenchmark({
      config: config(["good"]),
      cases,
      unreachable: [],
      deps: { fetch: fakeFetch({ probe401: true }), now: () => 0, sleep: noSleep },
    });
    expect(out.kind).toBe("bad_key");
    const cat = await runBenchmark({
      config: config(["good"]),
      cases,
      unreachable: [],
      deps: { fetch: fakeFetch({ catalogStatus: 401 }), now: () => 0, sleep: noSleep },
    });
    expect(cat.kind).toBe("bad_key");
  });

  it("every candidate dropped → all_dropped", async () => {
    const out = await runBenchmark({
      config: config(["gone"]),
      cases,
      unreachable: [],
      deps: { fetch: fakeFetch({}), now: () => 0, sleep: noSleep },
    });
    expect(out.kind).toBe("all_dropped");
  });
});
