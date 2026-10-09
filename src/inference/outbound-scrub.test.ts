/**
 * Ruling 3c, audit round 4 — the STRUCTURAL closer: every request that leaves
 * the process for a model passes the outbound scrub. Each test asserts on the
 * request object handed to the mocked provider client (the SDK's `query()`
 * args, or the body given to a stubbed `fetch`) — never a real endpoint.
 *
 * A value already stored is replaced by its by-name placeholder everywhere in
 * the request; a value NOT yet stored (a credential pasted this turn) reaches
 * the model, so it can still save it.
 *
 * In-memory SQLite with the two stores; synthetic values assembled at runtime
 * (public repo — no key-shaped literal in source).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

let db: Database.Database;
vi.mock("../db/index.js", () => ({ getDatabase: () => db }));

// --- SDK client mock: captures what queryClaudeSdk hands the SDK ----------
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: unknown,
    extras?: Record<string, unknown>,
  ) => ({ name, description, inputSchema, handler, ...(extras ?? {}) }),
  createSdkMcpServer: (config: unknown) => ({ type: "sdk", config }),
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    sdk.calls.push(args);
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })();
  },
}));

const stopHook = vi.hoisted(() => ({ impl: null as unknown }));
vi.mock("../lib/v8-4/stop-hook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/v8-4/stop-hook.js")>()),
  makeGatesStopHook: () => stopHook.impl,
}));
const traceMock = vi.hoisted(() => ({ emitTraceEvent: vi.fn() }));
vi.mock("../observability/task-trace.js", () => traceMock);
vi.mock("../budget/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../budget/service.js")>()),
  recordCost: vi.fn(),
  getRemainingBudgetUsd: vi.fn(() => 10),
}));
vi.mock("../prometheus/context-compressor.js", () => ({
  shouldCompress: vi.fn(() => false),
  compress: vi.fn((msgs: unknown[]) => msgs),
  estimateTokens: vi.fn(() => 0),
}));

const cfg = vi.hoisted(() => ({
  inferencePrimaryProvider: "claude-sdk" as "claude-sdk" | "openai",
  inferencePrimaryUrl: "http://127.0.0.1:9/v1",
  inferencePrimaryKey: "test",
  inferencePrimaryModel: "test-model",
  inferenceFallbackUrl: "",
  inferenceFallbackKey: "",
  inferenceFallbackModel: "",
  inferenceTertiaryUrl: "",
  inferenceTertiaryKey: "",
  inferenceTertiaryModel: "",
  inferenceTimeoutMs: 5000,
  inferenceMaxTokens: 256,
  inferenceMaxRetries: 1,
  inferenceContextLimit: 128000,
  compressionThreshold: 0.85,
  heavyRunnerContainerized: false,
  budgetEnabled: false,
  budgetEnforce: false,
}));
vi.mock("../config.js", () => ({ getConfig: () => cfg }));

import {
  infer,
  inferWithTools,
  scrubOutboundMessages,
  providerMetrics,
  SecretScrubUnavailableError,
  type ChatMessage,
} from "./adapter.js";
import {
  queryClaudeSdk,
  queryClaudeSdkTiered,
  queryClaudeSdkComplexWithFallback,
  queryClaudeSdkAsInfer,
  queryClaudeSdkAsInferWithTools,
} from "./claude-sdk.js";
import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { toolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { circuitRegistry } from "../lib/circuit-breaker.js";
import {
  expireSecretRefsForTest,
  invalidateSecretRefs,
  resetSecretRefsForTest,
  secretPlaceholder,
} from "../lib/secret-refs.js";
import { describeImage } from "./vision.js";
import { generateEmbeddings } from "./embeddings.js";
import { askJev } from "../jev/client.js";
import { enterRunToolContext } from "../tools/rule-of-two.js";

// Synthetic values. STORED / PROJ are stored; PASTED is new this turn.
const STORED = "pw-" + "z".repeat(14);
const PROJ = "dp-" + "y".repeat(16);
const PASTED = "np-" + "q".repeat(16);
const PH = secretPlaceholder("SECRET_PROJECTS_ACME_FTP_PASSWORD");
const PH_PROJ = secretPlaceholder("SECRET_ACME_PORTAL_PASSWORD");

const STORE_DDL = (() => {
  const schema = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");
  const from = schema.indexOf("CREATE TABLE IF NOT EXISTS user_facts");
  const endMarker =
    "CREATE INDEX IF NOT EXISTS idx_project_log_project ON project_log(project_id);";
  return schema.slice(from, schema.indexOf(endMarker) + endMarker.length);
})();

function seed(): void {
  db = new Database(":memory:");
  db.exec(STORE_DDL);
  db.prepare(
    "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
  ).run("projects", "acme_ftp_password", STORED);
  db.prepare(
    "INSERT INTO projects (id, slug, name, urls, credentials, config) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "proj-acme-portal",
    "acme-portal",
    "acme-portal",
    "{}",
    JSON.stringify({ password: PROJ }),
    "{}",
  );
  resetSecretRefsForTest();
}

/** A request that carries the stored values in every role, plus a new paste. */
function leakyMessages(): ChatMessage[] {
  return [
    { role: "system", content: `essentials: ftp ${STORED}` },
    {
      role: "system",
      content: `variable: portal ${PROJ}`,
      cacheable: false,
    },
    { role: "user", content: `earlier turn mentioned ${STORED}` },
    {
      role: "assistant",
      content: `I used ${PROJ}`,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "http_fetch",
            arguments: JSON.stringify({ body: `p=${STORED}` }),
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: `{"echo":"${PROJ}"}` },
    {
      role: "user",
      content: [
        { type: "text", text: `save this new one: ${PASTED} (old ${STORED})` },
      ],
    },
  ];
}

function sdkText(): string {
  const last = sdk.calls.at(-1)!;
  return `${String(last.options.systemPrompt)}\n${String(last.prompt)}`;
}

function expectScrubbed(text: string): void {
  expect(text).not.toContain(STORED);
  expect(text).not.toContain(PROJ);
  expect(text).toContain(PH);
  expect(text).toContain(PH_PROJ);
}

beforeEach(() => {
  seed();
  sdk.calls = [];
  stopHook.impl = null;
  cfg.inferencePrimaryProvider = "claude-sdk";
  cfg.inferencePrimaryModel = "test-model";
  circuitRegistry.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Claude Agent SDK path — queryClaudeSdk is the one choke point
// ---------------------------------------------------------------------------

describe("SDK path: every entry point reaches query() scrubbed", () => {
  it("infer() (claude-sdk routing): system prompt and every message scrubbed; a new paste passes", async () => {
    await infer({ messages: leakyMessages() });
    const text = sdkText();
    expectScrubbed(text);
    expect(text).toContain(PASTED);
  });

  it("inferWithTools() (claude-sdk routing)", async () => {
    await inferWithTools(leakyMessages(), [], async () => "");
    const text = sdkText();
    expectScrubbed(text);
    expect(text).toContain(PASTED);
  });

  it("queryClaudeSdkAsInfer / AsInferWithTools direct", async () => {
    await queryClaudeSdkAsInfer(leakyMessages());
    expectScrubbed(sdkText());
    await queryClaudeSdkAsInferWithTools(leakyMessages(), [], async () => "");
    expectScrubbed(sdkText());
  });

  it("queryClaudeSdk direct, tiered and Opus→Sonnet fallback wrappers", async () => {
    const call = (model: string) =>
      queryClaudeSdk({
        prompt: `user ${STORED} new ${PASTED}`,
        systemPrompt: `sys ${PROJ}`,
        toolNames: [],
        model,
      });
    await call("claude-sonnet-x");
    expectScrubbed(sdkText());
    await queryClaudeSdkTiered(false, call);
    expectScrubbed(sdkText());
    await queryClaudeSdkTiered(true, call);
    expectScrubbed(sdkText());
    await queryClaudeSdkComplexWithFallback(call);
    expectScrubbed(sdkText());
    expect(sdkText()).toContain(PASTED);
    expect(sdk.calls).toHaveLength(4);
  });

  it("vision prompt stream (images present): the text block is scrubbed", async () => {
    await queryClaudeSdk({
      prompt: `look ${STORED}`,
      systemPrompt: "sys",
      toolNames: [],
      images: [{ mediaType: "image/png", data: "AAAA" }],
    });
    const stream = sdk.calls.at(-1)!.prompt as AsyncIterable<{
      message: { content: Array<{ type: string; text?: string }> };
    }>;
    for await (const m of stream) {
      const text = m.message.content.find((c) => c.type === "text")!.text!;
      expect(text).toBe(`look ${PH}`);
    }
  });

  it("an index change between calls is picked up (a value stored mid-turn is scrubbed from the next request)", async () => {
    await queryClaudeSdk({ prompt: `x ${PASTED}`, systemPrompt: "s", toolNames: [] });
    expect(sdkText()).toContain(PASTED);
    db.prepare(
      "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
    ).run("projects", "acme_new_token", PASTED);
    invalidateSecretRefs();
    await queryClaudeSdk({ prompt: `x ${PASTED}`, systemPrompt: "s", toolNames: [] });
    expect(sdkText()).not.toContain(PASTED);
    expect(sdkText()).toContain(secretPlaceholder("SECRET_PROJECTS_ACME_NEW_TOKEN"));
  });
});

describe("SDK path: in-turn text the model receives", () => {
  type Handler = (a: unknown, e?: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
  const serverTools = (): Array<{ name: string; handler: Handler }> => {
    const opts = sdk.calls.at(-1)!.options as {
      mcpServers: { jarvis: { config: { tools: Array<{ name: string; handler: Handler }> } } };
    };
    return opts.mcpServers.jarvis.config.tools;
  };

  it("inline (extraTools) results bypass the registry, so they are scrubbed at the server", async () => {
    const recall = sdkTool(
      "recall_check_probe",
      "probe",
      {},
      async () => ({ content: [{ type: "text" as const, text: `kb: ${STORED}` }] }),
    );
    await queryClaudeSdk({
      prompt: "p",
      systemPrompt: "s",
      toolNames: [],
      extraTools: [recall],
    });
    const t = serverTools().find((x) => x.name === "recall_check_probe")!;
    const out = await t.handler({});
    expect(out.content[0].text).toBe(`kb: ${PH}`);
  });

  it("a registry tool's result is scrubbed again at the SDK tool boundary", async () => {
    const tool: Tool = {
      name: "outbound_probe_tool",
      definition: {
        type: "function",
        function: {
          name: "outbound_probe_tool",
          description: "probe",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => "unused",
    };
    toolRegistry.register(tool);
    // Simulates any path that hands back text the registry did not scrub.
    vi.spyOn(toolRegistry, "execute").mockResolvedValue(`out ${PROJ}`);
    await queryClaudeSdk({
      prompt: "p",
      systemPrompt: "s",
      toolNames: ["outbound_probe_tool"],
    });
    const t = serverTools().find((x) => x.name === "outbound_probe_tool")!;
    const out = await t.handler({});
    expect(out.content[0].text).not.toContain(PROJ);
    expect(out.content[0].text).toContain(PH_PROJ);
  });

  it("the Stop-hook block reason (gate evidence) is scrubbed", async () => {
    stopHook.impl = async () => ({
      decision: "block",
      reason: `gate g1 failed [evidence: ${STORED}]`,
    });
    await queryClaudeSdk({
      prompt: "p",
      systemPrompt: "s",
      toolNames: [],
      trace: { taskId: "t-1" },
    });
    const opts = sdk.calls.at(-1)!.options as {
      hooks: { Stop: Array<{ hooks: Array<(...a: unknown[]) => Promise<{ reason: string }>> }> };
    };
    const out = await opts.hooks.Stop[0].hooks[0]({}, undefined, {});
    expect(out.reason).toBe(`gate g1 failed [evidence: ${PH}]`);
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compat path — callProvider is the one choke point
// ---------------------------------------------------------------------------

describe("OpenAI-compat path: the body handed to fetch is scrubbed", () => {
  function stubOpenAi() {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "done" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 },
        );
      }),
    );
    return bodies;
  }

  it("infer() (openai routing): every role, text parts and tool-call arguments", async () => {
    cfg.inferencePrimaryProvider = "openai";
    const bodies = stubOpenAi();
    const messages = leakyMessages();
    const before = JSON.stringify(messages);
    await infer({ messages });
    expect(bodies).toHaveLength(1);
    expectScrubbed(bodies[0]);
    expect(bodies[0]).toContain(PASTED);
    // The caller's messages are not mutated.
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("audit R5: a NUMBER in tool-call arguments equal to a stored value becomes the placeholder string, and the arguments stay valid JSON", async () => {
    cfg.inferencePrimaryProvider = "openai";
    const NUM = "73519046";
    db.prepare(
      "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
    ).run("projects", "bank_nip_long", NUM);
    invalidateSecretRefs();
    const bodies = stubOpenAi();
    await infer({
      messages: [
        { role: "user", content: "pay" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c9",
              type: "function",
              function: {
                name: "http_fetch",
                arguments: JSON.stringify({ pin: Number(NUM), note: `p ${STORED}`, n: 7 }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "c9", content: "ok" },
      ],
    });
    expect(bodies[0]).not.toContain(NUM);
    const sent = JSON.parse(bodies[0]) as {
      messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    };
    const args = JSON.parse(
      sent.messages.find((m) => m.tool_calls)!.tool_calls![0]!.function.arguments,
    );
    expect(args).toEqual({
      pin: secretPlaceholder("SECRET_PROJECTS_BANK_NIP_LONG"),
      note: `p ${PH}`,
      n: 7,
    });
  });

  it("inferWithTools() (openai routing)", async () => {
    cfg.inferencePrimaryProvider = "openai";
    const bodies = stubOpenAi();
    await inferWithTools(leakyMessages(), [], async () => "", { maxRounds: 1 });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).not.toContain(STORED);
      expect(b).not.toContain(PROJ);
    }
    expect(bodies[0]).toContain(PASTED);
  });

  it("Anthropic Messages provider (claude-* model on the openai path)", async () => {
    cfg.inferencePrimaryProvider = "openai";
    cfg.inferencePrimaryModel = "claude-test";
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return new Response(
          JSON.stringify({
            id: "m",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }),
    );
    await infer({ messages: leakyMessages() });
    expect(bodies).toHaveLength(1);
    expectScrubbed(bodies[0]);
    expect(bodies[0]).toContain(PASTED);
  });
});

// ---------------------------------------------------------------------------
// Other model-bound paths outside the adapter
// ---------------------------------------------------------------------------

describe("other model-bound requests", () => {
  function captureFetch(response: unknown) {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return new Response(JSON.stringify(response), { status: 200 });
      }),
    );
    return bodies;
  }

  it("vision describeImage: the prompt text", async () => {
    const bodies = captureFetch({ choices: [{ message: { content: "img" } }] });
    await describeImage("data:image/png;base64,AAAA", `describe ${STORED}`);
    expect(bodies[0]).not.toContain(STORED);
    expect(bodies[0]).toContain(PH);
  });

  it("embeddings: every input text (scrubbed before the cut)", async () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.EMBEDDING_URL = "http://127.0.0.1:9/v1";
    process.env.EMBEDDING_KEY = "test";
    try {
      const bodies = captureFetch({ data: [{ embedding: [0.1], index: 0 }] });
      await generateEmbeddings([`note ${PROJ}`]);
      expect(bodies[0]).not.toContain(PROJ);
      expect(bodies[0]).toContain(PH_PROJ);
    } finally {
      delete process.env.EMBEDDING_PROVIDER;
      delete process.env.EMBEDDING_URL;
      delete process.env.EMBEDDING_KEY;
    }
  });

  it("Jev askJev: the JSON body", async () => {
    const bodies = captureFetch({ answers: { q: { noul: 0.5 } } });
    await askJev(
      { message: `hola ${STORED}` },
      { q: { question: "x" } as never },
      1000,
    );
    expect(bodies[0]).not.toContain(STORED);
    expect(JSON.parse(bodies[0]).state.message).toBe(`hola ${PH}`);
  });
});

// ---------------------------------------------------------------------------
// Failure policy at the seam, and cost
// ---------------------------------------------------------------------------

describe("failure policy and performance", () => {
  it("a DB error with a current last-good index scrubs with it; after a write, or with none, the call fails closed (nothing sent)", async () => {
    await queryClaudeSdk({ prompt: `a ${STORED}`, systemPrompt: "s", toolNames: [] });
    db.close();
    expireSecretRefsForTest(); // TTL expired, no write since the last good build
    await queryClaudeSdk({ prompt: `b ${STORED}`, systemPrompt: "s", toolNames: [] });
    expect(String(sdk.calls.at(-1)!.prompt)).toBe(`b ${PH}`);

    const n = sdk.calls.length;
    invalidateSecretRefs(); // a store write: the last good index is stale (S5)
    await expect(
      queryClaudeSdk({ prompt: `c ${STORED}`, systemPrompt: "s", toolNames: [] }),
    ).rejects.toThrow(SecretScrubUnavailableError);

    resetSecretRefsForTest();
    await expect(
      queryClaudeSdk({ prompt: `c ${STORED}`, systemPrompt: "s", toolNames: [] }),
    ).rejects.toThrow(/not open/);
    expect(sdk.calls).toHaveLength(n);
  });

  it("audit R5: a scrub throw in queryClaudeSdk happens before the 15-minute timer and the abort listener are armed", async () => {
    db.close();
    resetSecretRefsForTest();
    const ac = new AbortController();
    const addListener = vi.spyOn(ac.signal, "addEventListener");
    const timers = vi.spyOn(globalThis, "setTimeout");
    await expect(
      queryClaudeSdk({
        prompt: `c ${STORED}`,
        systemPrompt: "s",
        toolNames: [],
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow(SecretScrubUnavailableError);
    expect(addListener).not.toHaveBeenCalled();
    expect(timers.mock.calls.filter((c) => c[1] === 15 * 60_000)).toHaveLength(0);
    expect(sdk.calls).toHaveLength(0);
  });

  it("audit R5: a scrub throw in callProvider is not a provider failure (no breaker failure, no provider metric, nothing sent)", async () => {
    cfg.inferencePrimaryProvider = "openai";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const record = vi.spyOn(providerMetrics, "record");
    db.close();
    resetSecretRefsForTest();
    await expect(
      infer({ messages: [{ role: "user", content: `x ${STORED}` }] }),
    ).rejects.toBeInstanceOf(SecretScrubUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    const statuses = Object.values(circuitRegistry.getAllStatus());
    expect(statuses.length).toBeGreaterThan(0);
    for (const st of statuses) expect(st.failures).toBe(0);
  });

  // A scrub throw while holding the single HALF_OPEN probe must hand it back,
  // or the breaker stays HALF_OPEN with no probe in flight.
  it("a scrub throw holding the HALF_OPEN probe releases it — at both choke points", async () => {
    const sdkBreaker = circuitRegistry.get("claude-sdk", {
      failureThreshold: 1,
      cooldownMs: 0,
    });
    sdkBreaker.recordFailure();
    db.close();
    resetSecretRefsForTest();
    await expect(
      queryClaudeSdk({ prompt: `c ${STORED}`, systemPrompt: "s", toolNames: [] }),
    ).rejects.toThrow(SecretScrubUnavailableError);
    expect(sdkBreaker.getStatus().state).toBe("OPEN");
    expect(sdkBreaker.allowRequest()).toBe(true);

    cfg.inferencePrimaryProvider = "openai";
    vi.stubGlobal("fetch", vi.fn());
    const oaiBreaker = circuitRegistry.get("primary", {
      failureThreshold: 1,
      cooldownMs: 0,
    });
    oaiBreaker.recordFailure();
    await expect(
      infer({ messages: [{ role: "user", content: `x ${STORED}` }] }),
    ).rejects.toBeInstanceOf(SecretScrubUnavailableError);
    expect(oaiBreaker.getStatus().state).toBe("OPEN");
    expect(oaiBreaker.allowRequest()).toBe(true);
  });

  // Combined audit 2026-10-03 (should-fix 2): the not-sent decision is on
  // the run's trace timeline, at both choke points.
  it("a scrub failure at either choke point emits inference.scrub_unavailable on the run", async () => {
    db.close();
    resetSecretRefsForTest();
    traceMock.emitTraceEvent.mockClear();
    await expect(
      enterRunToolContext("task-sdk", () =>
        queryClaudeSdk({ prompt: `c ${STORED}`, systemPrompt: "s", toolNames: [] }),
      ),
    ).rejects.toThrow(SecretScrubUnavailableError);
    expect(traceMock.emitTraceEvent).toHaveBeenCalledWith({
      taskId: "task-sdk",
      name: "inference.scrub_unavailable",
      attrs: { where: "claude_sdk" },
    });

    cfg.inferencePrimaryProvider = "openai";
    vi.stubGlobal("fetch", vi.fn());
    traceMock.emitTraceEvent.mockClear();
    await expect(
      enterRunToolContext("task-oai", () =>
        infer({ messages: [{ role: "user", content: `x ${STORED}` }] }),
      ),
    ).rejects.toBeInstanceOf(SecretScrubUnavailableError);
    expect(traceMock.emitTraceEvent).toHaveBeenCalledWith({
      taskId: "task-oai",
      name: "inference.scrub_unavailable",
      attrs: { where: "openai" },
    });
  });

  it("a realistic 70 KB request with 40 secrets is scrubbed cheaply", () => {
    for (let i = 0; i < 38; i++) {
      db.prepare(
        "INSERT INTO user_facts (category, key, value) VALUES (?, ?, ?)",
      ).run("projects", `bulk_token_${i}`, `bt${i}-` + "q".repeat(20));
    }
    invalidateSecretRefs();
    const filler = "lorem ipsum dolor sit amet, consectetur adipiscing ".repeat(20);
    let system = "";
    while (system.length < 50_000) system += filler;
    system += ` ${STORED} `;
    const messages: ChatMessage[] = [{ role: "system", content: system }];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: i % 2 ? "assistant" : "user",
        content: filler + (i === 7 ? PROJ : ""),
      });
    }
    const size = messages.reduce((n, m) => n + String(m.content).length, 0);
    expect(size).toBeGreaterThan(65_000);
    scrubOutboundMessages(messages); // warm-up (index build)
    const runs = 50;
    const t0 = performance.now();
    let out: ChatMessage[] = [];
    for (let i = 0; i < runs; i++) out = scrubOutboundMessages(messages);
    const ms = (performance.now() - t0) / runs;
    expectScrubbed(JSON.stringify(out));
    console.info(
      `[outbound-scrub perf] ${Math.round(size / 1024)} KB / 40 secrets: ${ms.toFixed(2)} ms per request`,
    );
    expect(ms).toBeLessThan(25);
  });
});
