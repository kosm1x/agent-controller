import { describe, it, expect, beforeEach, vi } from "vitest";
import { runSkillCritic, SKILL_CRITIC_SYSTEM_PROMPT } from "./critic.js";
import { infer } from "../inference/adapter.js";
import type { ParsedSkillFile } from "./frontmatter.js";

vi.mock("../inference/adapter.js", () => ({
  infer: vi.fn(),
}));

const mockInfer = vi.mocked(infer);

const FIXTURE: ParsedSkillFile = {
  frontmatter: {
    name: "echo-skill",
    description:
      "When asked to echo a string, return the same string verbatim. Used by Phase 2 test harness.",
    version: "1.0.0",
    output_type: "text",
    trigger_examples: [
      "Echo the message hello",
      "Repeat the input back to me",
      "Send the same string verbatim",
    ],
    tools_used: [],
    inputs_json: '[{"name":"msg","type":"string","required":true}]',
    tests_json:
      '[{"name":"happy","input":{"msg":"x"},"expect":{"output_match":{"echoed":"x"}}}]',
  },
  body: "# Steps\n1. Take the input msg.\n2. Return it as `echoed`.",
};

beforeEach(() => {
  mockInfer.mockReset();
});

describe("runSkillCritic — pass path", () => {
  it("returns pass verdict on a clean LLM response", async () => {
    mockInfer.mockResolvedValueOnce({
      content: '{"verdict": "pass", "critique": ""}',
      usage: { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.001 },
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillCritic(FIXTURE);
    expect(result.verdict).toBe("pass");
    expect(result.critique).toBe("");
    expect(result.error).toBe(false);
    expect(result.costUsd).toBe(0.001);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("strips a markdown code fence around the JSON", async () => {
    mockInfer.mockResolvedValueOnce({
      content: '```json\n{"verdict": "pass", "critique": ""}\n```',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillCritic(FIXTURE);
    expect(result.verdict).toBe("pass");
    expect(result.error).toBe(false);
  });
});

describe("runSkillCritic — fail path", () => {
  it("returns fail verdict with critique on a content failure", async () => {
    mockInfer.mockResolvedValueOnce({
      content:
        '{"verdict": "fail", "critique": "Description is vague (\\"helper for X\\"); does not state when to invoke."}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillCritic(FIXTURE);
    expect(result.verdict).toBe("fail");
    expect(result.critique).toContain("vague");
    expect(result.error).toBe(false);
  });
});

describe("runSkillCritic — infrastructure failures (error=true)", () => {
  it("empty response → error=true with descriptive critique", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "",
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillCritic(FIXTURE);
    expect(result.verdict).toBe("fail");
    expect(result.error).toBe(true);
    expect(result.critique).toContain("empty");
  });

  it("non-JSON response → error=true", async () => {
    mockInfer.mockResolvedValueOnce({
      content: "This skill looks great, no notes!",
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const result = await runSkillCritic(FIXTURE);
    expect(result.error).toBe(true);
    expect(result.critique).toMatch(/non-JSON/i);
  });

  it("infer throws → error=true with caught message", async () => {
    mockInfer.mockRejectedValueOnce(new Error("network reset"));

    const result = await runSkillCritic(FIXTURE);
    expect(result.error).toBe(true);
    expect(result.critique).toContain("network reset");
  });

  it("pre-aborted signal short-circuits without spending an infer call", async () => {
    const ac = new AbortController();
    ac.abort(new Error("budget exhausted"));

    const result = await runSkillCritic(FIXTURE, { signal: ac.signal });
    expect(result.error).toBe(true);
    expect(result.critique).toContain("aborted");
    expect(mockInfer).not.toHaveBeenCalled();
  });
});

describe("runSkillCritic — prompt + payload shape", () => {
  it("invokes the frozen system prompt and includes frontmatter + body excerpt in the user message", async () => {
    mockInfer.mockResolvedValueOnce({
      content: '{"verdict": "pass", "critique": ""}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    await runSkillCritic(FIXTURE);
    const call = mockInfer.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    if (!call) return;
    const messages = (
      call as { messages: Array<{ role: string; content: string }> }
    ).messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(SKILL_CRITIC_SYSTEM_PROMPT);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("echo-skill");
    expect(messages[1].content).toContain("Return it as `echoed`");
  });

  it("caps the body excerpt at 8000 chars to bound critic cost", async () => {
    mockInfer.mockResolvedValueOnce({
      content: '{"verdict": "pass", "critique": ""}',
      usage: {},
    } as Awaited<ReturnType<typeof infer>>);

    const huge = "x".repeat(20_000);
    await runSkillCritic({ ...FIXTURE, body: huge });
    const messages = (
      mockInfer.mock.calls[0]?.[0] as {
        messages: Array<{ content: string }>;
      }
    ).messages;
    // The user message contains a JSON-stringified payload; the body_excerpt
    // field inside is capped. The full message is larger because of the
    // JSON envelope + frontmatter, but the body string itself is capped.
    const userContent = messages[1].content;
    // Should contain 8000 x's at most (look for the cap behavior — a 20000-x
    // run cannot appear; any contiguous x-run is ≤8000).
    const longestXRun = userContent.match(/x+/g)?.[0]?.length ?? 0;
    expect(longestXRun).toBeLessThanOrEqual(8000);
  });
});
