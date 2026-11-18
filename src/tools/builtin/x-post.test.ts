/**
 * tweet_post execute — a failure always carries a non-empty `error`: the
 * confirmation card reads a result as failed only by a truthy `error`, so an
 * empty one would show a failed post as done. The posting module is replaced
 * whole: no backend, cookie, credential or network is reachable, and every
 * stand-in a case does not set throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const xp = vi.hoisted(() => {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    post: vi.fn(),
    getXRouter: vi.fn(),
    anyXAccountConfigured: vi.fn(),
    resolveAccount: vi.fn(),
    unexpected,
  };
});

vi.mock("../../lib/x-poster/index.js", () => ({
  getXRouter: xp.getXRouter,
  anyXAccountConfigured: xp.anyXAccountConfigured,
  resolveAccount: xp.resolveAccount,
  probeAllAccounts: xp.unexpected("probeAllAccounts"),
  listXAccounts: xp.unexpected("listXAccounts"),
  currentXAccountScope: xp.unexpected("currentXAccountScope"),
  readMentions: xp.unexpected("readMentions"),
}));

import { tweetPostTool } from "./x-post.js";

describe("tweet_post execute: the thrown-error path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xp.anyXAccountConfigured.mockReturnValue(true);
    xp.getXRouter.mockReturnValue({ post: xp.post });
    xp.resolveAccount.mockReturnValue("acmenews");
  });

  const run = async () =>
    JSON.parse(
      (await tweetPostTool.execute({ text: "hello" })) as string,
    ) as Record<string, unknown>;

  it("an exception with a message → that message", async () => {
    xp.post.mockRejectedValue(new Error("socket hang up"));
    expect(await run()).toEqual({ error: "socket hang up" });
    expect(xp.post).toHaveBeenCalledWith("hello", undefined);
  });

  it("an exception without a message → its class name", async () => {
    xp.post.mockRejectedValue(new TypeError(""));
    expect(await run()).toEqual({ error: "TypeError" });
  });

  it("a thrown empty string → a fixed non-empty text", async () => {
    xp.post.mockRejectedValue("");
    const { error } = await run();
    expect(typeof error).toBe("string");
    expect((error as string).length).toBeGreaterThan(0);
  });
});
