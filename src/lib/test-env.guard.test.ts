import { describe, it, expect } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { isPgvectorEnabled } from "../db/pgvector.js";
import {
  OUTSIDE_CALL_ENV,
  dropOutsideCallEnv,
} from "../test-utils/outside-call-env.js";

// Rule: no test reaches the live vector store, whatever the shell that starts
// the run exports. The store's client switches itself on when its key variable
// is merely present, and every in-memory database seeds directives that it
// syncs, so an inherited key would send real writes from ordinary tests. The
// per-worker setup file (vitest.setup-env.ts) deletes the key before any test
// file loads; a test that needs the client on sets its own dummy key.
describe("test worker environment", () => {
  it("carries no vector-store key, so the store client stays off", () => {
    expect(process.env.COMMIT_DB_KEY).toBeUndefined();
    expect(isPgvectorEnabled()).toBe(false);
  });

  // Rule: a test supplies the outside-service keys it needs itself; none is
  // inherited from the shell that starts the run. The shared list is pinned to
  // a literal copy so a name dropped from it fails here, the drop itself is
  // checked on a synthetic object (the shell running a check may carry none of
  // the names), and the setup's marker shows the drop ran in this worker.
  describe("outside-service names", () => {
    it("the shared list is exactly the pinned names", () => {
      expect(OUTSIDE_CALL_ENV).toEqual([
        "INFERENCE_PRIMARY_URL",
        "INFERENCE_PRIMARY_KEY",
        "INFERENCE_FALLBACK_URL",
        "INFERENCE_FALLBACK_KEY",
        "INFERENCE_TERTIARY_URL",
        "INFERENCE_TERTIARY_KEY",
        "INFERENCE_VISION_URL",
        "INFERENCE_VISION_KEY",
        "GEMINI_API_KEY",
        "EMBEDDING_KEY",
        "WHISPER_API_KEY",
        "HUGGINGFACE_TOKEN",
        "PEXELS_API_KEY",
        "JINA_API_KEY",
        "BRAVE_SEARCH_API_KEY",
        "EXA_API_KEY",
        "EXPAND_API_KEY",
        "TYPESAFE_API_KEY",
        "HINDSIGHT_ENABLED",
      ]);
    });

    it("the drop removes every listed name and nothing else", () => {
      const env: Record<string, string | undefined> = { BYSTANDER_SETTING: "keep" };
      for (const name of OUTSIDE_CALL_ENV) env[name] = "synthetic";
      expect(dropOutsideCallEnv(env)).toBe(OUTSIDE_CALL_ENV.length);
      expect(env).toEqual({ BYSTANDER_SETTING: "keep" });
    });

    it("the setup ran the drop in this worker and no name is present", () => {
      expect(
        (globalThis as typeof globalThis & { __outsideCallEnvDropped?: number })
          .__outsideCallEnvDropped,
      ).toBeTypeOf("number");
      expect(OUTSIDE_CALL_ENV.filter((n) => process.env[n] !== undefined)).toEqual([]);
    });
  });

  // Rule: no test reaches a real model. The setup file replaces the agent
  // SDK's `query` for every test file with one that throws and records the
  // call; its afterEach fails any test that left a record. This case wants the
  // throw, so it empties the record itself.
  it("blocks the agent SDK's query and records the call", () => {
    const hits = (
      globalThis as typeof globalThis & { __modelCallGuardHits?: string[] }
    ).__modelCallGuardHits;
    expect(hits).toEqual([]);
    // Checked before the call: if the stub were not in place, calling the real
    // export would start a real model session.
    expect(query.name).toBe("blockedModelQuery");
    expect(() => query({ prompt: "guard probe" })).toThrow(
      /query\(\) is blocked under vitest/,
    );
    expect(hits).toHaveLength(1);
    hits!.splice(0);
  });
});
