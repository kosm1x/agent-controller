/**
 * Tests for the shutdown-grace env parsing helper. Extracted from index.ts
 * into its own module so tests don't drag in `main()`, which fails fast on
 * missing MC_API_KEY.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readShutdownGraceMs } from "./shutdown-grace.js";

const ORIGINAL = process.env.MC_SHUTDOWN_GRACE_MS;

describe("readShutdownGraceMs", () => {
  beforeEach(() => {
    delete process.env.MC_SHUTDOWN_GRACE_MS;
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.MC_SHUTDOWN_GRACE_MS;
    else process.env.MC_SHUTDOWN_GRACE_MS = ORIGINAL;
  });

  it("defaults to 30s when env var is unset", () => {
    expect(readShutdownGraceMs()).toBe(30_000);
  });

  it("defaults to 30s when env var is empty", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "";
    expect(readShutdownGraceMs()).toBe(30_000);
  });

  it("honors an explicit integer override", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "5000";
    expect(readShutdownGraceMs()).toBe(5_000);
  });

  it("allows 0 (skip grace period entirely)", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "0";
    expect(readShutdownGraceMs()).toBe(0);
  });

  it("clamps to 5 minutes so a typo can't stall systemd indefinitely", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "9999999";
    expect(readShutdownGraceMs()).toBe(300_000);
  });

  it("falls back to default on garbage input", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "abc";
    expect(readShutdownGraceMs()).toBe(30_000);
  });

  it("falls back to default on negative values (no -10s rewinds)", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "-1000";
    expect(readShutdownGraceMs()).toBe(30_000);
  });

  // W1 audit fold — parseInt is permissive about mixed/prefixed strings.
  it("falls back to default on floats (parseInt would silently truncate)", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "30.5";
    expect(readShutdownGraceMs()).toBe(30_000);
  });

  it("falls back to default on mixed prefix-numeric ('30000abc')", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "30000abc";
    expect(readShutdownGraceMs()).toBe(30_000);
  });

  it("accepts leading/trailing whitespace around an integer", () => {
    process.env.MC_SHUTDOWN_GRACE_MS = "  45000  ";
    expect(readShutdownGraceMs()).toBe(45_000);
  });
});
