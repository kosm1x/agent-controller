import { describe, it, expect, vi } from "vitest";
import {
  runXProbeTick,
  type XProbeLog,
  type AccountProbe,
} from "./probe-cron.js";

const SILENT: XProbeLog = { info: () => {}, warn: () => {} };

function acct(
  account: string,
  backend: string,
  ok: boolean,
  authExpired = !ok,
): AccountProbe {
  return {
    account,
    probe: {
      healthy: ok,
      unconfigured: false,
      results: [{ backend, ok, detail: ok ? "200" : "401", authExpired }],
    },
  };
}

function tick(
  accounts: AccountProbe[],
  state: Map<string, boolean>,
  notify = vi.fn(async (_text: string) => {}),
) {
  const record = vi.fn();
  return {
    notify,
    record,
    run: () =>
      runXProbeTick({
        probeAll: async () => accounts,
        record,
        notify,
        state,
        log: SILENT,
      }),
  };
}

describe("runXProbeTick (multi-account)", () => {
  it("records health for each account+backend every tick", async () => {
    const t = tick(
      [
        acct("lookin4ward", "cookie", true),
        acct("mexiconecesario", "cookie", true),
      ],
      new Map(),
    );
    await t.run();
    expect(t.record).toHaveBeenCalledWith("lookin4ward", "cookie", true);
    expect(t.record).toHaveBeenCalledWith("mexiconecesario", "cookie", true);
  });

  it("does NOT notify on first sight (no prior state)", async () => {
    const t = tick([acct("lookin4ward", "cookie", false)], new Map());
    await t.run();
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("notifies on healthy→unhealthy with the per-account refresh hint", async () => {
    const state = new Map([["lookin4ward|cookie", true]]);
    const t = tick([acct("lookin4ward", "cookie", false, true)], state);
    await t.run();
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][0]).toMatch(/UNHEALTHY/);
    expect(t.notify.mock.calls[0][0]).toMatch(/X_AUTH_TOKEN__lookin4ward/);
  });

  it("notifies on unhealthy→healthy recovery", async () => {
    const state = new Map([["mexiconecesario|cookie", false]]);
    const t = tick([acct("mexiconecesario", "cookie", true)], state);
    await t.run();
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][0]).toMatch(/recovered/i);
  });

  it("is edge-triggered per account+backend: no notify when unchanged", async () => {
    const state = new Map([["lookin4ward|cookie", false]]);
    const t = tick([acct("lookin4ward", "cookie", false)], state);
    await t.run();
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("only flips the account that changed, not its sibling", async () => {
    const state = new Map([
      ["lookin4ward|cookie", true],
      ["mexiconecesario|cookie", true],
    ]);
    const t = tick(
      [
        acct("lookin4ward", "cookie", true),
        acct("mexiconecesario", "cookie", false, true),
      ],
      state,
    );
    await t.run();
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][0]).toMatch(/mexiconecesario/);
  });

  it("skips entirely when no account is configured", async () => {
    const t = tick([], new Map());
    await t.run();
    expect(t.record).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("never throws when notify rejects (non-fatal)", async () => {
    const state = new Map([["lookin4ward|cookie", true]]);
    const failing = vi.fn(async (_text: string) => {
      throw new Error("router down");
    });
    const t = tick([acct("lookin4ward", "cookie", false)], state, failing);
    await expect(t.run()).resolves.toBeUndefined();
  });
});
