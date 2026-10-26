/**
 * parseSandboxBackend — SANDBOX_BACKEND is a structural safety knob: an
 * unknown value must REFUSE at boot, never silently resolve to the
 * unrestricted-egress docker path (nanoclaw upstream v2.3.0 "An unknown
 * NANOCLAW_RUNTIME_DRIVER aborts startup"; adopted 2026-09-01).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, parseSandboxBackend } from "./config.js";

describe("parseSandboxBackend", () => {
  it.each([
    [undefined, "docker"],
    ["", "docker"],
    ["docker", "docker"],
    ["opensandbox", "opensandbox"],
  ] as const)("%j → %s", (raw, want) => {
    expect(parseSandboxBackend(raw)).toBe(want);
  });

  it.each([
    "opensandbox ", // trailing space — the typo that would silently downgrade
    "OpenSandbox",
    "Docker",
    "firecracker",
    "gvisor",
    "0",
    "false",
    "none",
  ])("throws on %j instead of falling back to docker", (raw) => {
    expect(() => parseSandboxBackend(raw)).toThrow(
      /SANDBOX_BACKEND must be "docker" or "opensandbox"/,
    );
  });
});

describe("promptDumpDir (PROMPT_DUMP_DIR)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function load(dumpDir: string | undefined) {
    vi.stubEnv("MC_API_KEY", "test");
    vi.stubEnv("INFERENCE_PRIMARY_PROVIDER", "claude-sdk");
    vi.stubEnv("SANDBOX_BACKEND", "");
    vi.stubEnv("PROMPT_DUMP_DIR", dumpDir);
    return loadConfig();
  }

  it("unset → null (dump off)", () => {
    expect(load(undefined).promptDumpDir).toBeNull();
  });

  it("set → the directory string", () => {
    expect(load("/tmp/dumps").promptDumpDir).toBe("/tmp/dumps");
  });
});

describe("inferenceSdkLastlineEnabled (INFERENCE_SDK_LASTLINE_ENABLED)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function load(raw: string | undefined) {
    vi.stubEnv("MC_API_KEY", "test");
    vi.stubEnv("INFERENCE_PRIMARY_PROVIDER", "claude-sdk");
    vi.stubEnv("SANDBOX_BACKEND", "");
    vi.stubEnv("INFERENCE_SDK_LASTLINE_ENABLED", raw);
    return loadConfig();
  }

  it("unset → false (last line off)", () => {
    expect(load(undefined).inferenceSdkLastlineEnabled).toBe(false);
  });

  it('"true" → true', () => {
    expect(load("true").inferenceSdkLastlineEnabled).toBe(true);
  });

  it('"1" → false (only the literal "true" arms it)', () => {
    expect(load("1").inferenceSdkLastlineEnabled).toBe(false);
  });
});
