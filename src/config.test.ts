/**
 * parseSandboxBackend — SANDBOX_BACKEND is a structural safety knob: an
 * unknown value must REFUSE at boot, never silently resolve to the
 * unrestricted-egress docker path (nanoclaw upstream v2.3.0 "An unknown
 * NANOCLAW_RUNTIME_DRIVER aborts startup"; adopted 2026-09-01).
 */

import { describe, it, expect } from "vitest";
import { parseSandboxBackend } from "./config.js";

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
