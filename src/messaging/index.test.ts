/**
 * initMessaging takes the router from its caller: the singleton the accessors
 * return is the very object handed in, and with no channel enabled the layer
 * is a no-op that returns null. A stand-in router is used so that the router
 * module (and the database and services it loads) is never loaded here; the
 * channel adapters fail closed if anything tries to load one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRouter } from "./router.js";

vi.mock("./channels/whatsapp.js", () => {
  throw new Error("channel adapter must not load in this test");
});
vi.mock("./channels/telegram.js", () => {
  throw new Error("channel adapter must not load in this test");
});
vi.mock("./channels/email.js", () => {
  throw new Error("channel adapter must not load in this test");
});

import { getRouter, initMessaging, shutdownMessaging } from "./index.js";

const FLAGS = ["WHATSAPP_ENABLED", "TELEGRAM_ENABLED", "EMAIL_ENABLED"];

function standIn(channelCount: number) {
  return {
    channelCount,
    startEventListeners: vi.fn(),
    rearmPendingApprovals: vi.fn(),
    stopAll: vi.fn(async () => {}),
  };
}

describe("initMessaging", () => {
  const saved: Record<string, string | undefined> = {};
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of FLAGS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await shutdownMessaging();
    for (const k of FLAGS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("keeps the router it is handed: the accessor returns that same object", async () => {
    const r = standIn(1);
    const result = await initMessaging(r as unknown as MessageRouter);
    expect(result).toBe(r);
    expect(getRouter()).toBe(r);
    expect(r.startEventListeners).toHaveBeenCalledTimes(1);
    expect(r.rearmPendingApprovals).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a second init replaces an earlier router: the accessor returns the latest one handed in", async () => {
    const a = standIn(1);
    const b = standIn(1);
    await initMessaging(a as unknown as MessageRouter);
    const result = await initMessaging(b as unknown as MessageRouter);
    expect(result).toBe(b);
    expect(getRouter()).toBe(b);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("with no channel enabled returns null and leaves no router behind", async () => {
    const r = standIn(0);
    const result = await initMessaging(r as unknown as MessageRouter);
    expect(result).toBeNull();
    expect(getRouter()).toBeNull();
    expect(r.startEventListeners).not.toHaveBeenCalled();
    expect(r.rearmPendingApprovals).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
