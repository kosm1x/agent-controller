import { describe, it, expect } from "vitest";
import { calculateDSF } from "./screenshot.js";

describe("calculateDSF", () => {
  it("returns 2 for 1080px width (standard portrait)", () => {
    expect(calculateDSF(1080)).toBe(2);
  });

  it("returns 1 for 320px width (mobile)", () => {
    expect(calculateDSF(320)).toBe(1);
  });

  it("returns 1 for 599px width (just under threshold)", () => {
    expect(calculateDSF(599)).toBe(1);
  });

  it("returns 2 for 600px width (exact threshold)", () => {
    expect(calculateDSF(600)).toBe(2);
  });

  it("returns 2 for 1199px width", () => {
    expect(calculateDSF(1199)).toBe(2);
  });

  it("returns 3 for 1200px width", () => {
    expect(calculateDSF(1200)).toBe(3);
  });

  it("returns 4 for 1920px width (full HD)", () => {
    expect(calculateDSF(1920)).toBe(4);
  });
});

describe("screenshot_element tool definition", () => {
  it("has correct name and required params", async () => {
    const { screenshotElementTool } = await import("./screenshot.js");
    expect(screenshotElementTool.name).toBe("screenshot_element");
    const params = screenshotElementTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).toContain("url");
  });

  it("returns error when url is missing", async () => {
    const { screenshotElementTool } = await import("./screenshot.js");
    const result = await screenshotElementTool.execute({});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("url is required");
  });
});
