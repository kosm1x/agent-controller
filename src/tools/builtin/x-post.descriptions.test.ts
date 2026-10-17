/**
 * S6 ruling 5b / WS3b R1 W2 — the X tool definitions are read by every task,
 * so no configured handle may appear in any description or parameter
 * description. The env is seeded with two synthetic handles BEFORE the module
 * loads (descriptions are built at module evaluation).
 */

import { afterAll, describe, expect, it, vi } from "vitest";

const HANDLES = vi.hoisted(() => {
  const handles = ["acmenews", "acmebrand"];
  for (const h of handles) {
    process.env[`X_AUTH_TOKEN__${h}`] = "synthetic-token";
    process.env[`X_CT0__${h}`] = "synthetic-ct0";
  }
  process.env.X_DEFAULT_ACCOUNT = "acmenews";
  return handles;
});

afterAll(() => {
  for (const h of HANDLES) {
    delete process.env[`X_AUTH_TOKEN__${h}`];
    delete process.env[`X_CT0__${h}`];
  }
  delete process.env.X_DEFAULT_ACCOUNT;
});

/** Every description string of a tool definition (the tool's and each parameter's). */
function descriptions(def: { function: { description?: string; parameters?: unknown } }): string[] {
  const out = [def.function.description ?? ""];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else walk(v);
    }
  };
  walk(def.function.parameters);
  return out;
}

describe("X tool definitions name no account", () => {
  it("tweet_post, tweet_probe and tweet_mentions carry no configured handle in any description", async () => {
    const { tweetPostTool, tweetProbeTool, tweetMentionsTool } = await import("./x-post.js");
    const tools = [tweetPostTool, tweetProbeTool, tweetMentionsTool];
    expect(tools.map((t) => t.name)).toEqual(["tweet_post", "tweet_probe", "tweet_mentions"]);
    for (const t of tools) {
      const texts = descriptions(t.definition as never);
      expect(texts.length).toBeGreaterThan(1);
      for (const text of texts) for (const h of HANDLES) expect(text.toLowerCase(), `${t.name}`).not.toContain(h);
    }
  });
});
