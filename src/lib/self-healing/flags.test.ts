import { describe, it, expect, afterEach } from "vitest";
import { isTriageMonitorEnabled } from "./flags.js";

describe("isTriageMonitorEnabled", () => {
  const orig = process.env.SELF_HEALING_TRIAGE_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.SELF_HEALING_TRIAGE_ENABLED;
    else process.env.SELF_HEALING_TRIAGE_ENABLED = orig;
  });

  it("defaults OFF (dormant) when the env var is unset", () => {
    delete process.env.SELF_HEALING_TRIAGE_ENABLED;
    expect(isTriageMonitorEnabled()).toBe(false);
  });

  it("stays OFF for any value other than exactly 'true' (fail-closed)", () => {
    process.env.SELF_HEALING_TRIAGE_ENABLED = "1";
    expect(isTriageMonitorEnabled()).toBe(false);
    process.env.SELF_HEALING_TRIAGE_ENABLED = "TRUE";
    expect(isTriageMonitorEnabled()).toBe(false);
    process.env.SELF_HEALING_TRIAGE_ENABLED = "yes";
    expect(isTriageMonitorEnabled()).toBe(false);
  });

  it("is ON only for exactly 'true'", () => {
    process.env.SELF_HEALING_TRIAGE_ENABLED = "true";
    expect(isTriageMonitorEnabled()).toBe(true);
  });
});
