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

  it("rejects file:// URLs before launching Playwright", async () => {
    const { screenshotElementTool } = await import("./screenshot.js");
    const result = await screenshotElementTool.execute({
      url: "file:///etc/passwd",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/Blocked/);
    expect(parsed.url).toBe("file:///etc/passwd");
  });

  it("rejects private IP URLs before launching Playwright (SSRF guard)", async () => {
    const { screenshotElementTool } = await import("./screenshot.js");
    const result = await screenshotElementTool.execute({
      url: "http://127.0.0.1:3000/api/internal",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/Blocked/);
  });

  it("declares the describe and describe_prompt params for vision pass-through", async () => {
    const { screenshotElementTool } = await import("./screenshot.js");
    const params = screenshotElementTool.definition.function.parameters as {
      properties: Record<string, { type: string; description?: string }>;
    };
    expect(params.properties.describe).toBeDefined();
    expect(params.properties.describe.type).toBe("boolean");
    expect(params.properties.describe_prompt).toBeDefined();
    expect(params.properties.describe_prompt.type).toBe("string");
  });

  it("does not declare describe as required (opt-in only)", async () => {
    const { screenshotElementTool } = await import("./screenshot.js");
    const params = screenshotElementTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).not.toContain("describe");
    expect(params.required).not.toContain("describe_prompt");
  });
});
