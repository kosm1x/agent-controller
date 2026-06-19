import { describe, it, expect, afterEach } from "vitest";
import { isV82ProducerEnabled } from "./flags.js";

const ORIGINAL = process.env.V82_JUDGMENT_PRODUCER_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.V82_JUDGMENT_PRODUCER_ENABLED;
  else process.env.V82_JUDGMENT_PRODUCER_ENABLED = ORIGINAL;
});

describe("isV82ProducerEnabled", () => {
  it("defaults OFF when the env var is absent", () => {
    delete process.env.V82_JUDGMENT_PRODUCER_ENABLED;
    expect(isV82ProducerEnabled()).toBe(false);
  });

  it("is true ONLY for the literal string 'true' (opt-in polarity)", () => {
    process.env.V82_JUDGMENT_PRODUCER_ENABLED = "true";
    expect(isV82ProducerEnabled()).toBe(true);
    for (const v of ["false", "1", "yes", "TRUE", ""]) {
      process.env.V82_JUDGMENT_PRODUCER_ENABLED = v;
      expect(isV82ProducerEnabled()).toBe(false);
    }
  });
});
