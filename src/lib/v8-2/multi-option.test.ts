/**
 * V8.2 Phase 3 — RAPID-D multi-option tests (spec §8).
 *
 * `queryClaudeSdk` is mocked with DISPATCH-BY-SHAPE (not call-order): a call
 * carrying `extraTools` is the forced-tool Synthesizer (we invoke its
 * `submit_options` handler with scripted options); any other call is a
 * free-text perspective, routed to a canned answer by the role marker in its
 * USER prompt (Phase 5 moved the role text from systemPrompt → user turn so the
 * systemPrompt is the shared strategic-voice cache prefix). This is robust to
 * the parallel perspective fan-out. The
 * embedder is injected via `embedFn` so the diversity gate is deterministic
 * without real embeddings.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClaudeSdk } from "../../inference/claude-sdk.js";
import {
  computeMaxPairwiseSimilarity,
  isDiverseEnough,
  renderEvidenceDigest,
  resolveDiversityTheta,
  runMultiOption,
  validateOptions,
  DEFAULT_DIVERSITY_THETA,
  RAPID_D_PROMPT_VERSION,
  SynthesisError,
  type PerspectiveRole,
  type RapidDInput,
} from "./multi-option.js";
import type { EvidenceRef } from "./types.js";
import { strategicVoiceSystemPrompt } from "./strategic-voice.js";

vi.mock("../../inference/claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../inference/claude-sdk.js")
  >("../../inference/claude-sdk.js");
  return { ...actual, queryClaudeSdk: vi.fn() };
});

const mockQuery = vi.mocked(queryClaudeSdk);

const SDK_RESULT = {
  text: "",
  toolCalls: [] as string[],
  numTurns: 1,
  usage: {
    promptTokens: 100,
    completionTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  costUsd: 0.002,
  costAuthoritative: true,
  durationMs: 50,
  model: "claude-sonnet-4-6",
};

type RawOpt = {
  label: "A" | "B" | "C";
  summary: string;
  tradeoffs: string[];
  rank: 1 | 2 | 3;
};

/** Build a raw option whose summary encodes the embedding bucket `v<idx>:`. */
function opt(label: "A" | "B" | "C", rank: 1 | 2 | 3, vecIdx: number): RawOpt {
  return {
    label,
    summary: `v${vecIdx}: choose ${label}`,
    tradeoffs: ["t"],
    rank,
  };
}

/** Three valid A/B/C options that all map to the SAME embedding bucket → cosine 1. */
function similarSet(): RawOpt[] {
  return [opt("A", 1, 0), opt("B", 2, 0), opt("C", 3, 0)];
}

/** Three valid A/B/C options on orthogonal embedding buckets → cosine 0. */
function diverseSet(): RawOpt[] {
  return [opt("A", 1, 0), opt("B", 2, 1), opt("C", 3, 2)];
}

/** Embedder that one-hots on the `v<idx>:` prefix; distinct idx ⇒ orthogonal. */
function controlledEmbed(s: string): Promise<Float32Array | null> {
  const dim = 32;
  const v = new Float32Array(dim);
  const m = s.match(/^v(\d+):/);
  v[m ? Number(m[1]) % dim : 0] = 1;
  return Promise.resolve(v);
}
const nullEmbed = (): Promise<Float32Array | null> => Promise.resolve(null);

type SynthStep = RawOpt[] | "no_tool" | "throw";

function detectRole(userPrompt: string): PerspectiveRole {
  if (userPrompt.includes("DEVIL")) return "devils_advocate";
  if (userPrompt.includes("SEEKER")) return "seeker";
  return "analyst";
}

/** Install the dispatch-by-shape mock. */
function installSdk(cfg: {
  perspectives?: Partial<Record<PerspectiveRole, string | null>>;
  synth?: SynthStep[];
}) {
  let synthAttempt = 0;
  mockQuery.mockImplementation(async (o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = o as any;
    const isSynth = (opts.extraTools?.length ?? 0) > 0;
    if (isSynth) {
      const seq = cfg.synth ?? [];
      const step = seq[Math.min(synthAttempt, seq.length - 1)];
      synthAttempt++;
      if (step === "throw") throw new Error("api down");
      if (step === "no_tool") return { ...SDK_RESULT, toolCalls: [] };
      await opts.extraTools[0].handler({ options: step }, {});
      return { ...SDK_RESULT, toolCalls: ["submit_options"] };
    }
    const role = detectRole(opts.prompt);
    const override = cfg.perspectives?.[role];
    if (override === null) throw new Error(`perspective ${role} failed`);
    return { ...SDK_RESULT, text: override ?? `${role} perspective text` };
  });
}

const EVIDENCE: EvidenceRef[] = [
  { kind: "task", id: "t-1", excerpt: "[blocked] ship", retrieved_at: "now" },
];
const INPUT: RapidDInput = {
  question: "should we ship the pilot?",
  contextSummary: "pilot has 1 blocked task",
  evidence: EVIDENCE,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("runMultiOption — happy path", () => {
  it("returns 3 ranked options on the first attempt when diverse enough", async () => {
    installSdk({ synth: [diverseSet()] });
    const r = await runMultiOption(INPUT, { embedFn: controlledEmbed });
    expect(r.options).toHaveLength(3);
    expect(r.degraded).toBe(false);
    expect(r.degradedReason).toBeNull();
    expect(r.attempts).toBe(1);
    expect(r.maxSimilarity).toBe(0);
    expect(r.promptVersion).toBe(RAPID_D_PROMPT_VERSION);
    expect(r.perspectives).toHaveLength(3);
    // every option carries the deterministically-stamped synthesizer role
    expect(r.options.every((o) => o.generated_by_role === "synthesizer")).toBe(
      true,
    );
    // §8 invariant: proposed_options length ∈ {0,3}
    expect([0, 3]).toContain(r.options.length);
  });
});

describe("runMultiOption — strategic-voice cache prefix (§10)", () => {
  it("passes the byte-identical strategic-voice block as systemPrompt for EVERY call, with role text in the user prompt", async () => {
    const seen: { system: string; prompt: string }[] = [];
    mockQuery.mockImplementation(async (o) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = o as any;
      seen.push({ system: opts.systemPrompt, prompt: opts.prompt });
      if ((opts.extraTools?.length ?? 0) > 0) {
        await opts.extraTools[0].handler({ options: diverseSet() }, {});
        return { ...SDK_RESULT, toolCalls: ["submit_options"] };
      }
      return { ...SDK_RESULT, text: "perspective" };
    });

    await runMultiOption(INPUT, { embedFn: controlledEmbed });

    const sv = strategicVoiceSystemPrompt();
    // 3 perspectives + 1 synthesizer = ≥4 calls; all share ONE cache prefix.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const c of seen) expect(c.system).toBe(sv);
    // The systemPrompt is the identity block, never the role text.
    expect(sv).toContain("Strategic-voice principles");
    for (const c of seen) {
      expect(c.system).not.toContain("ANALYST");
      expect(c.system).not.toContain("SYNTHESIZER");
    }
    // Role/task instructions still reach the model — now leading the user turn.
    const prompts = seen.map((c) => c.prompt).join("\n");
    expect(prompts).toContain("ANALYST");
    expect(prompts).toContain("SEEKER");
    expect(prompts).toContain("DEVIL");
    expect(prompts).toContain("SYNTHESIZER");
  });
});

describe("runMultiOption — diversity gate (advisory)", () => {
  it("retries the synthesizer when options are too similar, then succeeds", async () => {
    installSdk({ synth: [similarSet(), diverseSet()] });
    const r = await runMultiOption(INPUT, { embedFn: controlledEmbed });
    expect(r.options).toHaveLength(3);
    expect(r.degraded).toBe(false);
    expect(r.attempts).toBe(2); // one diversity retry
    expect(r.maxSimilarity).toBe(0);
  });

  it("gracefully degrades to options=[] after exhausting the retry budget", async () => {
    installSdk({ synth: [similarSet(), similarSet(), similarSet()] });
    const r = await runMultiOption(INPUT, { embedFn: controlledEmbed });
    expect(r.options).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("no_diversity");
    expect(r.attempts).toBe(3); // 1 + DIVERSITY_RETRY_BUDGET(2)
    expect(r.maxSimilarity).toBe(1); // identical summaries
    expect([0, 3]).toContain(r.options.length);
  });

  it("accepts options when embeddings are unavailable (gate degrades to logging-only)", async () => {
    installSdk({ synth: [similarSet()] }); // similar, but gate can't run
    const r = await runMultiOption(INPUT, { embedFn: nullEmbed });
    expect(r.options).toHaveLength(3);
    expect(r.degraded).toBe(false);
    expect(r.maxSimilarity).toBeNull();
    expect(r.attempts).toBe(1); // no retry — the gate never fired
  });

  it("respects a custom θ that flags otherwise-orthogonal options", async () => {
    installSdk({ synth: [diverseSet(), diverseSet(), diverseSet()] });
    // θ = -1 makes nothing pass (cosine ≥ -1 always) → forces degrade
    const r = await runMultiOption(INPUT, {
      embedFn: controlledEmbed,
      theta: -1,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("no_diversity");
  });
});

describe("runMultiOption — degrade conditions", () => {
  it("degrades 'no_perspectives' when fewer than 2 roles produce text", async () => {
    installSdk({
      perspectives: { analyst: null, seeker: null }, // only devils_advocate succeeds
      synth: [diverseSet()],
    });
    const r = await runMultiOption(INPUT, { embedFn: controlledEmbed });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("no_perspectives");
    expect(r.options).toEqual([]);
    expect(r.attempts).toBe(0); // never reached synthesis
    expect(mockQuery).toHaveBeenCalledTimes(3); // 3 perspective calls, no synth
  });

  it("proceeds with exactly 2 perspectives (MIN_PERSPECTIVES)", async () => {
    installSdk({
      perspectives: { analyst: null }, // seeker + devils succeed → 2
      synth: [diverseSet()],
    });
    const r = await runMultiOption(INPUT, { embedFn: controlledEmbed });
    expect(r.degraded).toBe(false);
    expect(r.options).toHaveLength(3);
    expect(r.perspectives).toHaveLength(2);
  });

  it("degrades 'synthesizer_failed' when the synthesizer emits no tool call", async () => {
    installSdk({ synth: ["no_tool"] });
    const r = await runMultiOption(INPUT, {
      embedFn: controlledEmbed,
      retryBudget: 0,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("synthesizer_failed");
    expect(r.options).toEqual([]);
  });

  it("degrades 'synthesizer_failed' when every attempt returns a malformed (2-option) set", async () => {
    const twoOpts: RawOpt[] = [opt("A", 1, 0), opt("B", 2, 1)];
    installSdk({ synth: [twoOpts, twoOpts] });
    const r = await runMultiOption(INPUT, {
      embedFn: controlledEmbed,
      retryBudget: 1,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("synthesizer_failed");
    expect(r.attempts).toBe(2); // 1 + retryBudget(1)
  });

  it("degrades 'synthesizer_failed' when the SDK call throws with nothing captured", async () => {
    installSdk({ synth: ["throw"] });
    const r = await runMultiOption(INPUT, {
      embedFn: controlledEmbed,
      retryBudget: 0,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("synthesizer_failed");
  });

  it("degrades immediately with no LLM calls when the caller signal is already aborted", async () => {
    installSdk({ synth: [diverseSet()] });
    const ac = new AbortController();
    ac.abort();
    const r = await runMultiOption(INPUT, {
      embedFn: controlledEmbed,
      signal: ac.signal,
    });
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe("no_perspectives");
    expect(r.attempts).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled(); // not even the perspective fan-out
  });
});

describe("validateOptions", () => {
  it("accepts a valid A/B/C permutation and stamps generated_by_role", () => {
    const out = validateOptions(diverseSet());
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.label).sort()).toEqual(["A", "B", "C"]);
    expect(out.map((o) => o.rank).sort()).toEqual([1, 2, 3]);
    expect(out.every((o) => o.generated_by_role === "synthesizer")).toBe(true);
  });

  it("rejects a wrong option count", () => {
    expect(() => validateOptions([opt("A", 1, 0)])).toThrow(SynthesisError);
  });

  it("rejects duplicate labels", () => {
    expect(() =>
      validateOptions([opt("A", 1, 0), opt("A", 2, 1), opt("C", 3, 2)]),
    ).toThrow(/exactly A, B, C/);
  });

  it("rejects a non-permutation rank set", () => {
    const bad: RawOpt[] = [opt("A", 1, 0), opt("B", 1, 1), opt("C", 2, 2)];
    expect(() => validateOptions(bad)).toThrow(/permutation/);
  });

  it("surfaces a ProposedOptionSchema field violation as SynthesisError (qa-W2)", () => {
    // The structural checks (count/labels/ranks) pass, but an empty summary
    // fails ProposedOptionSchema.parse — the path the dispatch-by-shape mock
    // bypasses by invoking the tool handler directly. validateOptions must wrap
    // the ZodError as a SynthesisError, not leak it.
    const emptySummary: RawOpt[] = [
      { label: "A", summary: "", tradeoffs: ["t"], rank: 1 },
      opt("B", 2, 1),
      opt("C", 3, 2),
    ];
    expect(() => validateOptions(emptySummary)).toThrow(SynthesisError);
    expect(() => validateOptions(emptySummary)).toThrow(
      /ProposedOption validation/,
    );
  });
});

describe("computeMaxPairwiseSimilarity + isDiverseEnough", () => {
  it("returns null for fewer than two summaries (gate inert)", async () => {
    expect(
      await computeMaxPairwiseSimilarity(["only one"], controlledEmbed),
    ).toBeNull();
  });

  it("returns null when any embedding is unavailable", async () => {
    const partial = (s: string) =>
      s.startsWith("v1") ? Promise.resolve(null) : controlledEmbed(s);
    expect(
      await computeMaxPairwiseSimilarity(["v0:a", "v1:b"], partial),
    ).toBeNull();
  });

  it("computes 1 for identical vectors and 0 for orthogonal ones", async () => {
    expect(
      await computeMaxPairwiseSimilarity(["v0:a", "v0:b"], controlledEmbed),
    ).toBeCloseTo(1, 5);
    expect(
      await computeMaxPairwiseSimilarity(["v0:a", "v1:b"], controlledEmbed),
    ).toBeCloseTo(0, 5);
  });

  it("isDiverseEnough is a ≤ θ test at the boundary", () => {
    expect(isDiverseEnough(0.93, 0.93)).toBe(true);
    expect(isDiverseEnough(0.9300001, 0.93)).toBe(false);
  });
});

describe("resolveDiversityTheta", () => {
  const KEY = "MC_RAPID_D_DIVERSITY_THETA";
  const orig = process.env[KEY];
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it("defaults when unset", () => {
    delete process.env[KEY];
    expect(resolveDiversityTheta()).toBe(DEFAULT_DIVERSITY_THETA);
  });

  it("parses a valid (0,1] override", () => {
    process.env[KEY] = "0.8";
    expect(resolveDiversityTheta()).toBe(0.8);
  });

  it("falls back to default on an out-of-range or non-numeric value", () => {
    for (const bad of ["0", "-0.1", "1.5", "abc", ""]) {
      process.env[KEY] = bad;
      expect(resolveDiversityTheta()).toBe(DEFAULT_DIVERSITY_THETA);
    }
  });
});

describe("renderEvidenceDigest", () => {
  it("renders a placeholder for empty evidence", () => {
    expect(renderEvidenceDigest([])).toMatch(/no structured evidence/);
  });

  it("numbers entries and caps at 20", () => {
    const many: EvidenceRef[] = Array.from({ length: 25 }, (_, i) => ({
      kind: "task" as const,
      id: `t-${i}`,
      excerpt: `task ${i}`,
      retrieved_at: "now",
    }));
    const out = renderEvidenceDigest(many);
    expect(out).toMatch(/^\[1\] \(task\) task 0$/m);
    expect(out).toMatch(/\[20\]/);
    expect(out).not.toMatch(/\[21\]/);
  });
});
