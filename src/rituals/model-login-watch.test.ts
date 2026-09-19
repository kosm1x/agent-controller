/**
 * Model-login expiry watch — 2026-09-19 outage: the claude.ai login ended,
 * every SDK call failed, and nothing had read the end date the file states.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../messaging/index.js", () => ({ getRouter: () => null }));

import {
  classifyLogin,
  formatLoginMessage,
  runModelLoginWatch,
  _resetLoginWatchState,
  readLoginFile,
} from "./model-login-watch.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 15, 30); // 2026-10-15 15:30 UTC
const creds = (refreshTokenExpiresAt: unknown, refreshToken = "rt-value") => ({
  claudeAiOauth: {
    accessToken: "at-value",
    refreshToken,
    refreshTokenExpiresAt,
  },
});

beforeEach(() => _resetLoginWatchState());

describe("classifyLogin", () => {
  it("ok outside the 72 h window, expiring inside it, dead at or past the end", () => {
    expect(classifyLogin(creds(NOW + 73 * HOUR), NOW).kind).toBe("ok");
    expect(classifyLogin(creds(NOW + 72 * HOUR), NOW).kind).toBe("expiring");
    expect(classifyLogin(creds(NOW), NOW).kind).toBe("dead");
  });

  it("a blanked refresh token is dead even with a future end date (the CLI's invalid_grant clear)", () => {
    expect(classifyLogin(creds(NOW + 500 * HOUR, ""), NOW).kind).toBe("dead");
  });

  it("a missing login file reads as {} (unknown), not a thrown ritual failure", async () => {
    const read = await readLoginFile("/nonexistent/model-login-watch/creds.json");
    expect(read).toEqual({});
    expect(classifyLogin(read, NOW).kind).toBe("unknown");
  });

  it("no claude.ai login, or no end date, is unknown — never a false alarm", () => {
    expect(classifyLogin({}, NOW).kind).toBe("unknown");
    expect(classifyLogin(null, NOW).kind).toBe("unknown");
    expect(classifyLogin(creds(undefined), NOW).kind).toBe("unknown");
  });
});

describe("runModelLoginWatch", () => {
  it("sends the expiry warning once per 24 h and never includes a token value", async () => {
    const send = vi.fn(async (_text: string) => {});
    const readCreds = async () => creds(NOW + 72 * HOUR);
    const first = await runModelLoginWatch({ readCreds, send, now: () => NOW });
    const second = await runModelLoginWatch({
      readCreds,
      send,
      now: () => NOW + 23 * HOUR,
    });
    const third = await runModelLoginWatch({
      readCreds,
      send,
      now: () => NOW + 24 * HOUR,
    });
    expect([first.sent, second.sent, third.sent]).toEqual([true, false, true]);
    expect(send.mock.calls[0][0]).toBe(
      "🟡 Model login expires in 72 h (2026-10-18 15:30 UTC). Run `claude /login` on the VPS before then — after it, every Jarvis model call fails.",
    );
    expect(send.mock.calls[1][0]).toContain("expires in 48 h");
    for (const [text] of send.mock.calls) expect(text).not.toMatch(/-value/);
  });

  it("a dead login is announced at once even if the expiry warning just went out", async () => {
    const send = vi.fn(async (_text: string) => {});
    await runModelLoginWatch({
      readCreds: async () => creds(NOW + HOUR),
      send,
      now: () => NOW,
    });
    const dead = await runModelLoginWatch({
      readCreds: async () => creds(NOW + HOUR, ""),
      send,
      now: () => NOW + HOUR,
    });
    expect(dead).toEqual({ state: "dead", sent: true });
    expect(send.mock.calls[1][0]).toContain("DEAD");
    expect(send.mock.calls[1][0]).toContain("claude /login");
  });

  it("a failed delivery does not stamp the throttle — the next tick retries", async () => {
    const readCreds = async () => creds(NOW + HOUR);
    await expect(
      runModelLoginWatch({
        readCreds,
        send: async () => {
          throw new Error("no channel");
        },
        now: () => NOW,
      }),
    ).rejects.toThrow("no channel");
    const send = vi.fn(async (_text: string) => {});
    const retry = await runModelLoginWatch({
      readCreds,
      send,
      now: () => NOW + HOUR / 2,
    });
    expect(retry.sent).toBe(true);
  });

  it("stays silent on ok, and a fresh /login re-arms the warning", async () => {
    const send = vi.fn(async (_text: string) => {});
    await runModelLoginWatch({
      readCreds: async () => creds(NOW + HOUR),
      send,
      now: () => NOW,
    });
    const ok = await runModelLoginWatch({
      readCreds: async () => creds(NOW + 700 * HOUR),
      send,
      now: () => NOW + HOUR,
    });
    expect(ok).toEqual({ state: "ok", sent: false });
    const again = await runModelLoginWatch({
      readCreds: async () => creds(NOW + 3 * HOUR),
      send,
      now: () => NOW + 2 * HOUR,
    });
    expect(again.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("the default send throws when no router is up (zero delivery is never silent)", async () => {
    await expect(
      runModelLoginWatch({
        readCreds: async () => creds(NOW + HOUR),
        now: () => NOW,
      }),
    ).rejects.toThrow("messaging router unavailable");
  });
});

describe("formatLoginMessage", () => {
  it("is empty for states that need no message", () => {
    expect(
      formatLoginMessage({ kind: "ok", expiresAt: NOW + 900 * HOUR }, NOW),
    ).toBe("");
    expect(formatLoginMessage({ kind: "unknown" }, NOW)).toBe("");
  });
});
