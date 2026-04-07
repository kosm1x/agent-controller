import { describe, it, expect } from "vitest";
import { humanizeTextTool } from "./writing.js";

describe("humanize_text tool", () => {
  it("has correct name and required params", () => {
    expect(humanizeTextTool.name).toBe("humanize_text");
    const params = humanizeTextTool.definition.function.parameters as {
      required: string[];
    };
    expect(params.required).toContain("text");
  });

  it("returns error when text is missing", async () => {
    const result = await humanizeTextTool.execute({});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("text is required");
  });

  it("accepts mode parameter", () => {
    const params = humanizeTextTool.definition.function.parameters as {
      properties: { mode: { enum: string[] } };
    };
    expect(params.properties.mode.enum).toContain("detect");
    expect(params.properties.mode.enum).toContain("rewrite");
  });
});
