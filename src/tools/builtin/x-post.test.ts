/**
 * tweet_post execute — a failure always carries a non-empty `error`: the
 * confirmation card reads a result as failed only by a truthy `error`, so an
 * empty one would show a failed post as done. The posting module is replaced
 * whole: no backend, cookie, credential or network is reachable, and every
 * stand-in a case does not set throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const xp = vi.hoisted(() => {
  const unexpected =
    (name: string) =>
    (..._args: unknown[]): unknown => {
      throw new Error(`unexpected call: ${name}`);
    };
  return {
    post: vi.fn(unexpected("post")),
    probe: vi.fn(unexpected("probe")),
    getXRouter: vi.fn(unexpected("getXRouter")),
    anyXAccountConfigured: vi.fn(unexpected("anyXAccountConfigured")),
    resolveAccount: vi.fn(unexpected("resolveAccount")),
    listXAccounts: vi.fn(unexpected("listXAccounts")),
    currentXAccountScope: vi.fn(unexpected("currentXAccountScope")),
    unexpected,
  };
});

vi.mock("../../lib/x-poster/index.js", () => ({
  getXRouter: xp.getXRouter,
  anyXAccountConfigured: xp.anyXAccountConfigured,
  resolveAccount: xp.resolveAccount,
  probeAllAccounts: xp.unexpected("probeAllAccounts"),
  listXAccounts: xp.listXAccounts,
  currentXAccountScope: xp.currentXAccountScope,
  readMentions: xp.unexpected("readMentions"),
}));

import { tweetPostTool, tweetProbeTool } from "./x-post.js";

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

// A probe that could not run leads with `error`; a probe that ran and found
// an account unhealthy is an answer and has no error key.
describe("tweet_probe execute: could not run vs. an answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xp.anyXAccountConfigured.mockReturnValue(true);
  });

  const call = async (args: Record<string, unknown>) =>
    (await tweetProbeTool.execute(args)) as string;

  function expectFailure(raw: string, error: string) {
    expect(raw.startsWith('{"error":"')).toBe(true);
    const r = JSON.parse(raw);
    expect(Object.keys(r)).toEqual(["error", "healthy"]);
    expect(r).toEqual({ error, healthy: false });
  }

  it("no account configured at all → error first", async () => {
    xp.anyXAccountConfigured.mockReturnValue(false);
    xp.currentXAccountScope.mockReturnValueOnce({ mode: "service" });
    expectFailure(
      await call({}),
      "X posting not configured. Set X_AUTH_TOKEN__<handle> + X_CT0__<handle> (session cookies from a logged-in x.com browser) and X_DEFAULT_ACCOUNT in the environment.",
    );
    expect(xp.getXRouter).not.toHaveBeenCalled();
  });

  it("an account that cannot be resolved → error first", async () => {
    xp.getXRouter.mockReturnValueOnce(undefined);
    xp.listXAccounts.mockReturnValueOnce(["acct-a", "acct-b"]);
    expectFailure(
      await call({ account: "acct-z" }),
      'Unknown X account "acct-z". Configured: acct-a, acct-b. Use one of these EXACT labels (do not re-spell).',
    );
    expect(xp.getXRouter).toHaveBeenCalledWith("acct-z");
    expect(xp.probe).not.toHaveBeenCalled();
  });

  it("the probe throws → error first, with its message", async () => {
    xp.getXRouter.mockReturnValueOnce({ probe: xp.probe });
    xp.probe.mockRejectedValueOnce(new Error("socket hang up"));
    expectFailure(await call({ account: "acct-a" }), "socket hang up");
    expect(xp.probe).toHaveBeenCalledTimes(1);
  });

  it("the probe throws an error with no message → a non-empty error", async () => {
    xp.getXRouter.mockReturnValueOnce({ probe: xp.probe });
    xp.probe.mockRejectedValueOnce(new TypeError(""));
    expectFailure(await call({ account: "acct-a" }), "TypeError");
    xp.getXRouter.mockReturnValueOnce({ probe: xp.probe });
    xp.probe.mockRejectedValueOnce("");
    expectFailure(await call({ account: "acct-a" }), "probe failed (no error message)");
  });

  it("an unhealthy answer is unchanged: no error key, account first", async () => {
    xp.getXRouter.mockReturnValueOnce({ probe: xp.probe });
    xp.resolveAccount.mockReturnValueOnce("acct-a");
    xp.probe.mockResolvedValueOnce({
      healthy: false,
      results: [{ backend: "cookie", ok: false, detail: "401", authExpired: true }],
    });
    const raw = await call({ account: "acct-a" });
    expect(raw).toBe(
      JSON.stringify({
        account: "acct-a",
        healthy: false,
        backends: [{ backend: "cookie", ok: false, detail: "401", auth_expired: true }],
      }),
    );
  });
});
