/**
 * Opus-tier benchmark override seam (scripts/benchmark-opus-tier.ts).
 * Production invariant: with the override UNSET, the tiered wrapper calls
 * OPUS_MODEL_ID first and retries Sonnet on failure — unchanged behavior.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

// SDK `query` mock (same shape as claude-sdk.test.ts) so the defaultModel
// case can read the options the builder hands the SDK.
const lastQueryOptions = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, desc: string, shape: unknown, handler: unknown) => ({
    name,
    desc,
    shape,
    handler,
  }),
  createSdkMcpServer: (config: unknown) => ({ type: "mcp", config }),
  query: (args: { prompt: unknown; options: unknown }) => {
    lastQueryOptions.value = args.options;
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        num_turns: 1,
        usage: { input_tokens: 5, output_tokens: 2 },
      };
    })();
  },
}));
vi.mock("../tools/registry.js", () => ({
  toolRegistry: { get: () => undefined, execute: async () => "" },
}));
vi.mock("../observability/task-trace.js", () => ({ emitTraceEvent: vi.fn() }));
vi.mock("../config.js", () => ({
  getConfig: () => ({ budgetEnabled: false, budgetEnforce: false }),
}));

import {
  HAIKU_MODEL_ID,
  OPUS_MODEL_ID,
  SONNET_MODEL_ID,
  queryClaudeSdk,
  queryClaudeSdkTiered,
  setOpusTierBenchmarkOverride,
} from "./claude-sdk.js";

afterEach(() => {
  setOpusTierBenchmarkOverride(undefined);
  vi.unstubAllEnvs();
});

describe("setOpusTierBenchmarkOverride", () => {
  it("unset: Opus first, Sonnet retry on failure (production default)", async () => {
    const seen: string[] = [];
    const out = await queryClaudeSdkTiered(true, async (model) => {
      seen.push(model);
      if (model === OPUS_MODEL_ID) throw new Error("403 plan denied");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(seen).toEqual([OPUS_MODEL_ID, SONNET_MODEL_ID]);
  });

  it("opusModel: the tier calls the candidate model instead", async () => {
    setOpusTierBenchmarkOverride({ opusModel: "claude-opus-5" });
    const seen: string[] = [];
    await queryClaudeSdkTiered(true, async (model) => {
      seen.push(model);
      return "ok";
    });
    expect(seen).toEqual(["claude-opus-5"]);
  });

  it("noFallback: an Opus failure surfaces instead of masking with Sonnet", async () => {
    setOpusTierBenchmarkOverride({
      opusModel: "claude-opus-5",
      noFallback: true,
    });
    const seen: string[] = [];
    await expect(
      queryClaudeSdkTiered(true, async (model) => {
        seen.push(model);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen).toEqual(["claude-opus-5"]);
  });

  it("does not touch the Sonnet tier", async () => {
    setOpusTierBenchmarkOverride({
      opusModel: "claude-opus-5",
      noFallback: true,
    });
    const seen: string[] = [];
    await queryClaudeSdkTiered(false, async (model) => {
      seen.push(model);
      return "ok";
    });
    expect(seen).toEqual([SONNET_MODEL_ID]);
  });
});

describe("defaultModel (Sonnet-tier benchmark seam)", () => {
  const call = (model?: string) =>
    queryClaudeSdk({
      prompt: "hola",
      systemPrompt: "sys",
      toolNames: [],
      costLedger: false,
      ...(model && { model }),
    });
  const sentModel = () => (lastQueryOptions.value as { model: string }).model;

  it("set + no opts.model: the SDK query carries defaultModel", async () => {
    const taps: string[] = [];
    setOpusTierBenchmarkOverride({
      defaultModel: "claude-sonnet-5-5",
      tap: (r) => taps.push(r.model),
    });
    const r = await call();
    expect(sentModel()).toBe("claude-sonnet-5-5");
    // No modelUsage in the fixture → attribution falls back to the effective
    // model, not the hard-coded Sonnet id.
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(taps).toEqual(["claude-sonnet-5-5"]);
  });

  it("set + explicit opts.model: the explicit model wins", async () => {
    setOpusTierBenchmarkOverride({ defaultModel: "claude-sonnet-5-5" });
    await call(OPUS_MODEL_ID);
    expect(sentModel()).toBe(OPUS_MODEL_ID);
  });

  it("unset (production): SONNET_MODEL_ID", async () => {
    const r = await call();
    expect(sentModel()).toBe(SONNET_MODEL_ID);
    expect(r.model).toBe(SONNET_MODEL_ID);
  });
});

// 2026-09-29: Sonnet 5.5 fast-path evaluation — model, thinking and effort
// env-driven on the production path; unset env ⇒ today's request shape.
describe("SONNET_MODEL_ID / SONNET_EFFORT env (production path)", () => {
  const call = (extra: Record<string, unknown> = {}) =>
    queryClaudeSdk({
      prompt: "hola",
      systemPrompt: "sys",
      toolNames: [],
      costLedger: false,
      ...extra,
    });
  const sent = () =>
    lastQueryOptions.value as {
      model: string;
      thinking: unknown;
      effort?: string;
    };
  const freshModelId = async () => {
    vi.resetModules();
    return (await import("./claude-sdk.js")).SONNET_MODEL_ID;
  };

  it("unset env: claude-sonnet-4-6, thinking disabled, no effort key", async () => {
    expect(SONNET_MODEL_ID).toBe("claude-sonnet-4-6");
    await call();
    expect(sent().model).toBe("claude-sonnet-4-6");
    expect(sent().thinking).toEqual({ type: "disabled" });
    expect("effort" in sent()).toBe(false);
  });

  it("valid SONNET_MODEL_ID is honoured at module load (trimmed, logged once)", async () => {
    vi.stubEnv("SONNET_MODEL_ID", "  claude-sonnet-5-5 ");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await freshModelId()).toBe("claude-sonnet-5-5");
    const lines = log.mock.calls.filter((c) =>
      String(c[0]).includes("SONNET_MODEL_ID override"),
    );
    log.mockRestore();
    expect(lines).toHaveLength(1);
  });

  it("invalid SONNET_MODEL_ID falls back to claude-sonnet-4-6", async () => {
    for (const bad of ["claude-opus-5", "sonnet-5-5", "claude-sonnet-x", ""]) {
      vi.stubEnv("SONNET_MODEL_ID", bad);
      expect(await freshModelId()).toBe("claude-sonnet-4-6");
    }
  });

  it("5.x effective model gets adaptive thinking; 4.x and Haiku keep disabled", async () => {
    await call({ model: "claude-sonnet-5-5" });
    expect(sent().thinking).toEqual({ type: "adaptive" });
    await call({ model: "claude-opus-5" });
    expect(sent().thinking).toEqual({ type: "adaptive" });
    await call({ model: "claude-sonnet-4-6" });
    expect(sent().thinking).toEqual({ type: "disabled" });
    await call({ model: OPUS_MODEL_ID });
    expect(sent().thinking).toEqual({ type: "disabled" });
    await call({ model: HAIKU_MODEL_ID });
    expect(sent().thinking).toEqual({ type: "disabled" });
  });

  it("benchmarkOverride.thinking still wins over the model default", async () => {
    setOpusTierBenchmarkOverride({ thinking: { type: "disabled" } });
    await call({ model: "claude-sonnet-5-5" });
    expect(sent().thinking).toEqual({ type: "disabled" });
  });

  it("SONNET_EFFORT=low reaches the Sonnet leg only (not Haiku, not Opus)", async () => {
    vi.stubEnv("SONNET_EFFORT", "low");
    await call();
    expect(sent().effort).toBe("low");
    await call({ model: SONNET_MODEL_ID });
    expect(sent().effort).toBe("low");
    await call({ model: HAIKU_MODEL_ID });
    expect("effort" in sent()).toBe(false);
    await call({ model: OPUS_MODEL_ID });
    expect("effort" in sent()).toBe(false);
  });

  it("invalid SONNET_EFFORT is ignored", async () => {
    vi.stubEnv("SONNET_EFFORT", "turbo");
    await call();
    expect("effort" in sent()).toBe(false);
  });

  it("opts.effort and benchmarkOverride.effort win over SONNET_EFFORT", async () => {
    vi.stubEnv("SONNET_EFFORT", "low");
    setOpusTierBenchmarkOverride({ effort: "high" });
    await call();
    expect(sent().effort).toBe("high");
    await call({ effort: "medium" });
    expect(sent().effort).toBe("medium");
  });
});
