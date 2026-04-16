/**
 * Tests for fingerprint injection helper.
 *
 * Mocks fingerprint-injector and playwright — no real browser launches.
 * Verifies correct options are passed and fallback works on failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockNewInjectedContext = vi.hoisted(() => vi.fn());
const mockNewContext = vi.hoisted(() => vi.fn());

vi.mock("fingerprint-injector", () => ({
  newInjectedContext: mockNewInjectedContext,
}));

const mockBrowser = {
  newContext: mockNewContext,
} as unknown as import("playwright").Browser;

beforeEach(() => {
  mockNewInjectedContext.mockResolvedValue({ _type: "injected-context" });
  mockNewContext.mockResolvedValue({ _type: "static-context" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFingerprintedContext", () => {
  it("returns injected context when fingerprint-injector is available", async () => {
    const { createFingerprintedContext } = await import("./fingerprint.js");

    const ctx = await createFingerprintedContext(mockBrowser);

    expect(ctx).toEqual({ _type: "injected-context" });
    expect(mockNewInjectedContext).toHaveBeenCalledOnce();
    expect(mockNewContext).not.toHaveBeenCalled();
  });

  it("passes correct fingerprint constraints", async () => {
    const { createFingerprintedContext } = await import("./fingerprint.js");

    await createFingerprintedContext(mockBrowser);

    const call = mockNewInjectedContext.mock.calls[0];
    const [browser, options] = call;
    expect(browser).toBe(mockBrowser);
    expect(options.fingerprintOptions).toEqual({
      devices: ["desktop"],
      operatingSystems: ["linux", "windows", "macos"],
      browsers: [{ name: "chrome", minVersion: 120 }],
    });
  });

  it("merges caller contextOptions into newContextOptions", async () => {
    const { createFingerprintedContext } = await import("./fingerprint.js");

    await createFingerprintedContext(mockBrowser, {
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    });

    const options = mockNewInjectedContext.mock.calls[0][1];
    expect(options.newContextOptions.viewport).toEqual({
      width: 800,
      height: 600,
    });
    expect(options.newContextOptions.deviceScaleFactor).toBe(1);
    // Base options still present
    expect(options.newContextOptions.ignoreHTTPSErrors).toBe(true);
  });

  it("falls back to static context when fingerprint-injector throws", async () => {
    mockNewInjectedContext.mockRejectedValueOnce(new Error("injection failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createFingerprintedContext } = await import("./fingerprint.js");
    const ctx = await createFingerprintedContext(mockBrowser);

    expect(ctx).toEqual({ _type: "static-context" });
    expect(mockNewContext).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Fingerprint injection unavailable"),
      expect.any(String),
    );
  });

  it("fallback merges contextOptions into static defaults", async () => {
    mockNewInjectedContext.mockRejectedValueOnce(new Error("fail"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createFingerprintedContext } = await import("./fingerprint.js");
    await createFingerprintedContext(mockBrowser, {
      viewport: { width: 400, height: 300 },
    });

    const opts = mockNewContext.mock.calls[0][0];
    expect(opts.viewport).toEqual({ width: 400, height: 300 });
    // Static defaults still present
    expect(opts.ignoreHTTPSErrors).toBe(true);
    expect(opts.colorScheme).toBe("dark");
  });
});
