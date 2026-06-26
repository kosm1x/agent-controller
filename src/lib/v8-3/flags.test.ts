import { afterEach, describe, expect, it } from "vitest";
import { isV83Enabled } from "./flags.js";

const ORIGINAL = process.env.V83_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.V83_ENABLED;
  else process.env.V83_ENABLED = ORIGINAL;
});

describe("isV83Enabled", () => {
  it("defaults to false when unset", () => {
    delete process.env.V83_ENABLED;
    expect(isV83Enabled()).toBe(false);
  });

  it("is true for the literal string 'true'", () => {
    process.env.V83_ENABLED = "true";
    expect(isV83Enabled()).toBe(true);
  });

  it.each(["false", "1", "yes", "TRUE", "True", ""])(
    "is false for non-'true' value %j",
    (val) => {
      process.env.V83_ENABLED = val;
      expect(isV83Enabled()).toBe(false);
    },
  );
});
