import { describe, it, expect, afterEach } from "vitest";
import { isV82ProducerEnabled, isV82DeliveryEnabled } from "./flags.js";

const ORIGINAL = process.env.V82_JUDGMENT_PRODUCER_ENABLED;
const ORIGINAL_DELIVERY = process.env.V82_DELIVERY_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.V82_JUDGMENT_PRODUCER_ENABLED;
  else process.env.V82_JUDGMENT_PRODUCER_ENABLED = ORIGINAL;
  if (ORIGINAL_DELIVERY === undefined) delete process.env.V82_DELIVERY_ENABLED;
  else process.env.V82_DELIVERY_ENABLED = ORIGINAL_DELIVERY;
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

describe("isV82DeliveryEnabled", () => {
  it("defaults OFF when the env var is absent", () => {
    delete process.env.V82_DELIVERY_ENABLED;
    expect(isV82DeliveryEnabled()).toBe(false);
  });

  it("is true ONLY for the literal string 'true' (opt-in polarity)", () => {
    process.env.V82_DELIVERY_ENABLED = "true";
    expect(isV82DeliveryEnabled()).toBe(true);
    for (const v of ["false", "1", "yes", "TRUE", ""]) {
      process.env.V82_DELIVERY_ENABLED = v;
      expect(isV82DeliveryEnabled()).toBe(false);
    }
  });

  it("is independent of the producer flag", () => {
    process.env.V82_JUDGMENT_PRODUCER_ENABLED = "true";
    delete process.env.V82_DELIVERY_ENABLED;
    expect(isV82ProducerEnabled()).toBe(true);
    expect(isV82DeliveryEnabled()).toBe(false);
  });
});
