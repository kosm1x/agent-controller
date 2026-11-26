/**
 * The SDK helper resolver: exactly one existing candidate gives its path,
 * anything else gives undefined; computed once per process. Pure: every
 * filesystem and resolve fact is a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperPathDeps } from "./sdk-helper-path.js";

const GLIBC = "@anthropic-ai/claude-agent-sdk-linux-x64/claude";
const MUSL = "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude";
const at = (request: string) => `/synthetic/node_modules/${request}`;

/** Linux x64 stand-ins where `present` resolves and exists. */
function deps(
  present: string[],
  over: Partial<HelperPathDeps> = {},
): HelperPathDeps & { resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn((request: string) => {
    if (!present.includes(request)) throw new Error("Cannot find module");
    return at(request);
  });
  return {
    platform: "linux",
    arch: "x64",
    resolve,
    exists: (path: string) => present.some((r) => at(r) === path),
    ...over,
  } as HelperPathDeps & { resolve: ReturnType<typeof vi.fn> };
}

async function fresh() {
  vi.resetModules();
  return import("./sdk-helper-path.js");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findSdkHelperPath", () => {
  it("only the glibc candidate exists: its path", async () => {
    const { findSdkHelperPath } = await fresh();
    expect(findSdkHelperPath(deps([GLIBC]))).toBe(at(GLIBC));
  });

  it("only the musl candidate exists: its path", async () => {
    const { findSdkHelperPath } = await fresh();
    expect(findSdkHelperPath(deps([MUSL]))).toBe(at(MUSL));
  });

  it("none exists: undefined", async () => {
    const { findSdkHelperPath } = await fresh();
    expect(findSdkHelperPath(deps([]))).toBeUndefined();
  });

  it("both exist: undefined (the SDK decides by itself)", async () => {
    const { findSdkHelperPath } = await fresh();
    expect(findSdkHelperPath(deps([GLIBC, MUSL]))).toBeUndefined();
  });

  it("a resolve that throws is an absent candidate", async () => {
    const { findSdkHelperPath } = await fresh();
    const d = deps([MUSL]);
    expect(findSdkHelperPath(d)).toBe(at(MUSL));
    expect(d.resolve).toHaveBeenCalledWith(GLIBC);
  });

  it("a resolved path that does not exist is absent", async () => {
    const { findSdkHelperPath } = await fresh();
    const d = deps([GLIBC, MUSL], { exists: (p) => p === at(MUSL) });
    expect(findSdkHelperPath(d)).toBe(at(MUSL));
  });

  it("not linux: undefined, nothing resolved", async () => {
    const { findSdkHelperPath } = await fresh();
    for (const platform of ["darwin", "win32"] as const) {
      const d = deps([GLIBC], { platform });
      expect(findSdkHelperPath(d)).toBeUndefined();
      expect(d.resolve).not.toHaveBeenCalled();
    }
  });

  it("both candidate names carry the process arch", async () => {
    const { findSdkHelperPath } = await fresh();
    const d = deps([], { arch: "arm64" });
    findSdkHelperPath(d);
    expect(d.resolve.mock.calls.map((c) => c[0])).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude",
    ]);
  });
});

describe("sdkHelperPath (once per process)", () => {
  it("the second call does not resolve again", async () => {
    const { sdkHelperPath } = await fresh();
    const d = deps([GLIBC]);
    expect(sdkHelperPath(d)).toBe(at(GLIBC));
    const callsAfterFirst = d.resolve.mock.calls.length;
    expect(callsAfterFirst).toBe(2);
    expect(sdkHelperPath(d)).toBe(at(GLIBC));
    expect(d.resolve.mock.calls.length).toBe(callsAfterFirst);
  });

  it("linux, nothing resolved: one log line for the process", async () => {
    const { sdkHelperPath } = await fresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sdkHelperPath(deps([]))).toBeUndefined();
    expect(sdkHelperPath(deps([]))).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[claude-sdk\] /);
    expect(String(warn.mock.calls[0]![0])).not.toContain("/");
  });

  it("resolved, or not linux: no log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let m = await fresh();
    m.sdkHelperPath(deps([GLIBC]));
    m.sdkHelperPath(deps([GLIBC]));
    m = await fresh();
    m.sdkHelperPath(deps([GLIBC], { platform: "darwin" }));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("excludeNetworkFromReports", () => {
  const report = process.report as unknown as { excludeNetwork?: boolean };
  let previous: boolean | undefined;
  beforeEach(() => {
    previous = report.excludeNetwork;
    report.excludeNetwork = false;
  });
  afterEach(() => {
    report.excludeNetwork = previous;
  });

  it("sets the switch", async () => {
    const { excludeNetworkFromReports } = await fresh();
    excludeNetworkFromReports();
    expect(report.excludeNetwork).toBe(true);
  });
});
