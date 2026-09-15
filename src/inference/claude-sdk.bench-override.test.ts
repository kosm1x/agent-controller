/**
 * Opus-tier benchmark override seam (scripts/benchmark-opus-tier.ts).
 * Production invariant: with the override UNSET, the tiered wrapper calls
 * OPUS_MODEL_ID first and retries Sonnet on failure — unchanged behavior.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  OPUS_MODEL_ID,
  SONNET_MODEL_ID,
  queryClaudeSdkTiered,
  setOpusTierBenchmarkOverride,
} from "./claude-sdk.js";

afterEach(() => setOpusTierBenchmarkOverride(undefined));

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
    setOpusTierBenchmarkOverride({ opusModel: "claude-opus-5", noFallback: true });
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
    setOpusTierBenchmarkOverride({ opusModel: "claude-opus-5", noFallback: true });
    const seen: string[] = [];
    await queryClaudeSdkTiered(false, async (model) => {
      seen.push(model);
      return "ok";
    });
    expect(seen).toEqual([SONNET_MODEL_ID]);
  });
});
